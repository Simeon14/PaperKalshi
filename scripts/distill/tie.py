#!/usr/bin/env python3
"""
Plan 09 / TIE buckets: the F3/F5/F7 "tied after N innings" outcome vs other legs.

A KXMLBF{3,5,7} market has a team outcome AND a TIE outcome. Plan 09 gives the TIE outcome its own
LegType (f3_tie / f5_tie / f7_tie) in the engine (classify.ts / types.ts / correlations.ts), so a
TIE leg no longer shares a correlation-bucket key with a real-team f_ml leg. A TIE leg is
team-agnostic (no teamRef), so resolveRelation still returns `game` when it meets any other leg,
but the bucket is now keyed on f{N}_tie -- distinct from the real-team (f{N}_ml, ..., game) bucket
that historical.py owns. That removes the collision plan 07 had to work around.

Consequence: we can now EMIT every tie-vs-partner bucket, including the higher-value tie-vs-total /
f5_total / rfi / extras ones plan 07 could only measure-and-withhold. Two partner families:
  - team-scoped (ml / spread / team_total): pooled over the reference team (home/away), matching
    the historical convention,
  - team-agnostic (total / f5_total / rfi / extras): one observation per game.
All key relation `game`. None collide with a real-team bucket anymore, because the tie type is
distinct from f{N}_ml.

Event: tied after k = cumulative home runs == cumulative away runs through inning k.
Emitted rows go into Parlay/data/raw/tie-<date>.jsonl; aggregate.py merges them as
source: "historical", which the engine's lookup priority picks up with no code change.
"""
from __future__ import annotations
import json, os, sys, datetime
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from historical import load_games, team_event, game_event, tetrachoric, cum, SEASONS, LINES

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = os.path.join(ROOT, "Parlay", "data", "raw")
TODAY = datetime.date.today().isoformat()

# tie leg type -> inning cutoff k (the "tied after k innings" event).
TIE_TYPES = {"f3_tie": 3, "f5_tie": 5, "f7_tie": 7}

# Every partner is emitted now (the distinct tie type removes the old f_ml collision). Line grids
# mirror historical.py's realistic Kalshi strikes; None = an unlined binary partner.
# team-scoped partners pool over the reference team (home/away); team-agnostic partners are one
# observation per game.
TEAM_PARTNERS = {"ml": [None], "spread": LINES["spread"], "team_total": LINES["team_total"]}
GAME_PARTNERS = {"total": LINES["total"], "f5_total": LINES["f5_total"],
                 "rfi": [None], "extras": [None]}

def tied_after(g, k):
    return cum(g["home_line"], k) == cum(g["away_line"], k)

def bucket(tie_type, k, partner, lines, games, team_scoped):
    out = []
    for L in lines:
        A, B = [], []
        for g in games:
            t = tied_after(g, k)
            if team_scoped:
                for ref in ("home", "away"):
                    A.append(t); B.append(team_event(partner, g, ref, L))
            else:
                A.append(t); B.append(game_event(partner, g, L))
        A = np.array(A, bool); B = np.array(B, bool)
        rho = tetrachoric(float(A.mean()), float(B.mean()), float((A & B).mean()))
        if rho is None:
            continue
        a, b = sorted([tie_type, partner])
        out.append({"a": a, "b": b, "relation": "game", "line": L,
                    "rho": round(float(rho), 4), "n": int(len(A))})
    return out

def to_raw(r, tie_type, k, partner):
    # line lives on whichever of a/b is the (lined) partner; the tie leg never has a line.
    return {"source": "historical", "sport": "mlb", "ts_date": TODAY,
            "a": r["a"], "b": r["b"], "relation": "game",
            "line_a": r["line"] if r["a"] == partner else None,
            "line_b": r["line"] if r["b"] == partner else None,
            "pA": None, "pB": None, "pAB": None,
            "rho": r["rho"], "n": r["n"], "method": "tetrachoric",
            "note": f"TIE outcome ({tie_type}, tied after {k}) vs {partner}; "
                    "team-agnostic bucket keyed on the tie type (no real-team collision)"}

def main():
    games = load_games(SEASONS)
    rows = []
    for tie_type, k in TIE_TYPES.items():
        for partner, lines in TEAM_PARTNERS.items():
            for r in bucket(tie_type, k, partner, lines, games, True):
                rows.append(to_raw(r, tie_type, k, partner))
        for partner, lines in GAME_PARTNERS.items():
            for r in bucket(tie_type, k, partner, lines, games, False):
                rows.append(to_raw(r, tie_type, k, partner))
    out_path = os.path.join(RAW, f"tie-{TODAY}.jsonl")
    with open(out_path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"Wrote {len(rows)} TIE rows to {out_path}", file=sys.stderr)

    import statistics as st, collections
    byk = collections.defaultdict(list)
    for r in rows:
        byk[(r["a"], r["b"])].append(r["rho"])
    print("\n=== EMITTED TIE buckets (all keyed on f{N}_tie, relation game) ===", file=sys.stderr)
    for k2, v in sorted(byk.items()):
        print(f"  {str(k2):28s} median_rho={st.median(v):+.4f} n_grid={len(v)}", file=sys.stderr)

if __name__ == "__main__":
    main()
