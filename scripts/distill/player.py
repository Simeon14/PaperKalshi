#!/usr/bin/env python3
"""
Plan 07 / Source A extension: player-prop correlation buckets (close the prior-only gaps).

Adds the genuinely statistical player dependence the engine still prices off hand-set priors:
  - same_player (different stats, no deterministic implication: Hits vs SB, Ks vs Outs, ...)
  - player_player_same_team / player_player_opp (two hitters, hitter+own starter, the two
    opposing starters' Ks, a batter vs the opposing pitcher, ...)
  - player_team / player_opp (a prop vs the player's own / the opponent team's game leg)
  - player vs a team-agnostic game leg (total / f5_total / rfi / extras): relation "game"

Data: Chadwick `cwdaily` over Retrosheet event files (2015-2024, same window as historical.py),
giving exact per-game per-player box stats. Player rows join to the game-log line scores (via
historical.load_games) so a prop correlates against the same game-scoped events historical.py
already defines. Same tetrachoric inversion, same JSONL row shape; aggregate.py merges as
source "historical", which outranks the priors with no engine change.

Same-stat ladders and deterministic implications (HR=>Hits, TB>=Hits, ...) are handled exactly by
the engine's logic layer (lib/parlay/logic.ts) and are NOT bucketed here. For same_player pairs
with a PARTIAL invariant, we measure rho only over line-grid points where neither leg implies the
other (mirroring reduceParlay), i.e. the points where the copula actually consults the bucket.
"""
from __future__ import annotations
import io, json, os, sys, subprocess, zipfile, urllib.request, datetime
from itertools import combinations, combinations_with_replacement
import numpy as np
import pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from historical import load_games, team_event, game_event, tetrachoric, SEASONS

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = os.path.join(ROOT, "Parlay", "data", "raw")
EVENTS = os.path.join(RAW, "retro_events")
CW = os.path.join(RAW, "cwdaily")
MIN_N = 2000  # minimum paired observations to emit a bucket

BAT_STATS = ["p_hits", "p_hr", "p_hrr", "p_rbi", "p_sb", "p_tb"]
PIT_STATS = ["p_ks", "p_outs"]
PLAYER_TYPES = BAT_STATS + PIT_STATS
TEAM_PARTNERS = ["ml", "spread", "team_total", "f3_ml", "f5_ml", "f5_spread", "f7_ml"]
GAME_PARTNERS = ["total", "f5_total", "rfi", "extras"]

# Kalshi-mirroring line grids (primary strikes; tetrachoric is line-stable so a few suffice).
PLINES = {
    "p_hits": [0.5, 1.5], "p_hr": [0.5], "p_hrr": [1.5, 2.5], "p_rbi": [0.5, 1.5],
    "p_sb": [0.5], "p_tb": [1.5, 2.5], "p_ks": [4.5, 5.5, 6.5], "p_outs": [15.5, 17.5],
}
TLINES = {
    "ml": [None], "spread": [1.5], "team_total": [3.5, 4.5],
    "f3_ml": [None], "f5_ml": [None], "f5_spread": [1.5], "f7_ml": [None],
    "total": [7.5, 8.5, 9.5], "f5_total": [4.5], "rfi": [None], "extras": [None],
}

# Same-player certain invariants stat[to] >= mult*stat[from] (mirrors logic.ts INVARIANTS), used
# to skip grid points where one leg deterministically implies the other (the copula never sees them).
INVARIANTS = {("p_hr", "p_hits"): 1, ("p_hr", "p_tb"): 4, ("p_hr", "p_rbi"): 1, ("p_hr", "p_hrr"): 3,
              ("p_hits", "p_tb"): 1, ("p_hits", "p_hrr"): 1, ("p_rbi", "p_hrr"): 1}

def implies(ta, la, tb, lb):
    """True if a yes-leg (ta > la) certainly forces (tb > lb), or vice versa, at these lines."""
    def one(f, lf, t, lt):
        m = INVARIANTS.get((f, t))
        return m is not None and m * (lf + 0.5) >= lt + 0.5
    return one(ta, la, tb, lb) or one(tb, lb, ta, la)

# --------------------------------------------------------------------------- ingest
def ensure_events():
    os.makedirs(EVENTS, exist_ok=True)
    for y in SEASONS:
        d = os.path.join(EVENTS, f"ev{y}")
        zp = os.path.join(EVENTS, f"{y}eve.zip")
        if os.path.isdir(d) and any(f.upper().endswith((".EVN", ".EVA")) for f in os.listdir(d)):
            continue
        if not os.path.exists(zp):
            url = f"https://www.retrosheet.org/events/{y}eve.zip"
            print(f"  downloading {url}", file=sys.stderr)
            with urllib.request.urlopen(url, timeout=90) as r:
                open(zp, "wb").write(r.read())
        os.makedirs(d, exist_ok=True)
        with zipfile.ZipFile(zp) as z:
            z.extractall(d)

def run_cwdaily(year):
    """Run cwdaily for a season, cached as a CSV. Returns the csv path."""
    os.makedirs(CW, exist_ok=True)
    out = os.path.join(CW, f"daily{year}.csv")
    if os.path.exists(out) and os.path.getsize(out) > 0:
        return out
    d = os.path.join(EVENTS, f"ev{year}")
    evs = [f for f in os.listdir(d) if f.upper().endswith((".EVN", ".EVA"))]
    print(f"  cwdaily {year} ({len(evs)} team files)", file=sys.stderr)
    with open(out, "w") as fout:
        subprocess.run(["cwdaily", "-y", str(year), *sorted(evs)], cwd=d, stdout=fout,
                       stderr=subprocess.DEVNULL, check=True)
    return out

def load_players():
    ensure_events()
    hdr = None
    frames = []
    for y in SEASONS:
        path = run_cwdaily(y)
        if hdr is None:
            d = os.path.join(EVENTS, f"ev{y}")
            any_ev = sorted(f for f in os.listdir(d) if f.upper().endswith((".EVN", ".EVA")))[0]
            out = subprocess.run(["cwdaily", "-n", "-y", str(y), any_ev], cwd=d,
                                 capture_output=True, text=True).stdout
            hdr = [c.strip().strip('"') for c in out.strip().splitlines()[0].split(",")]
        frames.append(pd.read_csv(path, header=None, names=hdr,
                                  dtype={"GAME_ID": str, "GAME_DT": str}))
    df = pd.concat(frames, ignore_index=True)
    df["home"] = df.GAME_ID.str[:3]
    df["gnum"] = df.GAME_ID.str[-1]
    df["date"] = df.GAME_DT.astype(str)
    df["side"] = np.where(df.HOME_FL == 1, "home", "away")
    is_bat = (df.SEQ_CT == 1) & (df.P_G == 0) & (df.B_PA >= 1)   # position-player starters
    is_pit = df.P_GS == 1                                        # starting pitchers
    out = pd.DataFrame({
        "date": df.date, "home": df.home, "gnum": df.gnum, "side": df.side,
        "team": df.TEAM_ID, "pid": df.PLAYER_ID,
    })
    out["p_hits"] = np.where(is_bat, df.B_H, np.nan)
    out["p_hr"] = np.where(is_bat, df.B_HR, np.nan)
    out["p_hrr"] = np.where(is_bat, df.B_H + df.B_R + df.B_RBI, np.nan)
    out["p_rbi"] = np.where(is_bat, df.B_RBI, np.nan)
    out["p_sb"] = np.where(is_bat, df.B_SB, np.nan)
    out["p_tb"] = np.where(is_bat, df.B_TB, np.nan)
    out["p_ks"] = np.where(is_pit, df.P_SO, np.nan)
    out["p_outs"] = np.where(is_pit, df.P_OUT, np.nan)
    for c in PLAYER_TYPES:
        out[c] = out[c].astype("float32")
    return out[out[PLAYER_TYPES].notna().any(axis=1)].reset_index(drop=True)

# --------------------------------------------------------------------------- game features
def game_feature_frame(games):
    """One row per (key, side) with every team-partner event (from that side) and game-partner
    event (side-independent), keyed for a fast merge onto player rows."""
    rows = []
    for g in games:
        for side in ("home", "away"):
            r = {"date": g["date"], "home": g["home"], "gnum": g["gamenum"], "side": side}
            for t in TEAM_PARTNERS:
                for L in TLINES[t]:
                    r[f"T::{t}::{L}"] = team_event(t, g, side, L)
            for t in GAME_PARTNERS:
                for L in TLINES[t]:
                    r[f"G::{t}::{L}"] = game_event(t, g, L)
            rows.append(r)
    return pd.DataFrame(rows)

# --------------------------------------------------------------------------- bucket helpers
def emit(rows, a, b, relation, la, lb, A, B):
    A = np.asarray(A, bool); B = np.asarray(B, bool)
    n = int(A.shape[0])
    if n < MIN_N:
        return
    pA, pB, pAB = A.mean(), B.mean(), (A & B).mean()
    rho = tetrachoric(float(pA), float(pB), float(pAB))
    if rho is None:
        return
    a2, b2 = sorted([a, b])
    rows.append({"source": "historical", "sport": "mlb", "ts_date": TODAY,
                 "a": a2, "b": b2, "relation": relation, "line_a": la if a2 == a else lb,
                 "line_b": lb if a2 == a else la, "pA": round(float(pA), 5),
                 "pB": round(float(pB), 5), "pAB": round(float(pAB), 5),
                 "rho": round(float(rho), 4), "n": n, "method": "tetrachoric"})

TODAY = datetime.date.today().isoformat()

def player_vs_game(rows, players, gfx):
    """same_player, player_team, player_opp, and player-vs-team-agnostic (relation game)."""
    # merge each player row to its own-side game features (player_team + game) and opp-side (player_opp)
    keys = ["date", "home", "gnum"]
    own = players.merge(gfx, on=keys + ["side"], how="inner")
    opp_gfx = gfx.rename(columns={"side": "oside"})
    players_o = players.assign(oside=np.where(players.side == "home", "away", "home"))
    opp = players_o.merge(opp_gfx, on=keys + ["oside"], how="inner")

    # player_team + game
    for p in PLAYER_TYPES:
        pv = own[p].to_numpy()
        ok = ~np.isnan(pv)
        for pl in PLINES[p]:
            Aall = pv > pl
            for t in TEAM_PARTNERS:
                for L in TLINES[t]:
                    col = own[f"T::{t}::{L}"].to_numpy(bool)
                    m = ok
                    emit(rows, p, t, "player_team", pl, L, Aall[m], col[m])
            for t in GAME_PARTNERS:
                for L in TLINES[t]:
                    col = own[f"G::{t}::{L}"].to_numpy(bool)
                    m = ok
                    emit(rows, p, t, "game", pl, L, Aall[m], col[m])
    # player_opp
    for p in PLAYER_TYPES:
        pv = opp[p].to_numpy()
        ok = ~np.isnan(pv)
        for pl in PLINES[p]:
            Aall = pv > pl
            for t in TEAM_PARTNERS:
                for L in TLINES[t]:
                    col = opp[f"T::{t}::{L}"].to_numpy(bool)
                    emit(rows, p, t, "player_opp", pl, L, Aall[ok], col[ok])

def same_player(rows, players):
    for ta, tb in combinations(PLAYER_TYPES, 2):
        va, vb = players[ta].to_numpy(), players[tb].to_numpy()
        ok = ~np.isnan(va) & ~np.isnan(vb)
        if ok.sum() < MIN_N:
            continue
        a, b = va[ok], vb[ok]
        for la in PLINES[ta]:
            for lb in PLINES[tb]:
                if implies(ta, la, tb, lb):
                    continue                      # copula never consults the bucket here
                emit(rows, ta, tb, "same_player", la, lb, a > la, b > lb)

def player_pairs(rows, players):
    """player_player_same_team and player_player_opp via directed partner rows."""
    keys = ["date", "home", "gnum"]
    cols = keys + ["side", "team", "pid"] + PLAYER_TYPES
    home = players[players.side == "home"][cols]
    away = players[players.side == "away"][cols]

    # opp: home x away, both directions (self=home|away)
    opp = home.merge(away, on=keys, suffixes=("_s", "_o"))
    _pairs_relation(rows, opp, "player_player_opp")

    # same team: self-merge within (key, team), keep pid_s < pid_o (unordered, distinct)
    for sd in ("home", "away"):
        s = players[players.side == sd][cols]
        st = s.merge(s, on=keys + ["team"], suffixes=("_s", "_o"))
        st = st[st.pid_s < st.pid_o]
        _pairs_relation(rows, st, "player_player_same_team")

def _pairs_relation(rows, pdf, relation):
    # pool both directional assignments (self has ta / partner has tb, and vice versa) so the
    # unordered bucket is symmetric
    for ta, tb in combinations_with_replacement(PLAYER_TYPES, 2):
        for la in PLINES[ta]:
            for lb in PLINES[tb]:
                A1, B1 = pdf[f"{ta}_s"].to_numpy(), pdf[f"{tb}_o"].to_numpy()
                A2, B2 = pdf[f"{ta}_o"].to_numpy(), pdf[f"{tb}_s"].to_numpy()
                m1 = ~np.isnan(A1) & ~np.isnan(B1)
                m2 = ~np.isnan(A2) & ~np.isnan(B2)
                A = np.concatenate([(A1[m1] > la), (A2[m2] > la)])
                B = np.concatenate([(B1[m1] > lb), (B2[m2] > lb)])
                emit(rows, ta, tb, relation, la, lb, A, B)

def main():
    print("Loading game logs + player game logs", SEASONS, file=sys.stderr)
    games = load_games(SEASONS)
    gfx = game_feature_frame(games)
    players = load_players()
    print(f"  {len(games)} games, {len(players)} player-game rows", file=sys.stderr)
    rows = []
    player_vs_game(rows, players, gfx)
    same_player(rows, players)
    player_pairs(rows, players)
    out_path = os.path.join(RAW, f"player-{TODAY}.jsonl")
    with open(out_path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"Wrote {len(rows)} rows to {out_path}", file=sys.stderr)

if __name__ == "__main__":
    main()
