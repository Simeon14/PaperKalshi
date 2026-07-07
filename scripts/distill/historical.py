#!/usr/bin/env python3
"""
Plan 01 / Source A: historical ground-truth correlation harvester (MLB, game-scoped).

Reads Retrosheet season game logs (free, unlimited, no ToS), reconstructs the canonical
binary event behind every game-scoped LegType at realistic Kalshi lines, and measures the
tetrachoric correlation (rho) for every (a, b, relation) bucket in the plan taxonomy.

Output: one JSONL row per (bucket, line-grid point) to Parlay/data/raw/historical-<date>.jsonl.
scripts/distill/aggregate.py medians those into lib/parlay/data/mlb-correlations.json.

Why tetrachoric: the engine models each leg as a latent normal and prices with a Gaussian
copula. rho is exactly the latent-normal correlation whose orthant probability reproduces the
observed joint hit rate, so historical numbers drop straight into the engine.

Canonical orientations (a "no"/under negates rho downstream, so we only store the yes/over side):
  ml         referenced team wins
  spread     referenced team wins by > 1.5 (covers -1.5)
  team_total referenced team scores > L runs
  f3_ml      referenced team leads after 3 innings
  f5_ml      referenced team leads after 5 innings
  f5_spread  referenced team leads by > 1.5 after 5 innings
  f7_ml      referenced team leads after 7 innings
  total      game total runs > M
  f5_total   total runs through 5 innings > M
  rfi        >= 1 run scored in the 1st inning (either team)
  extras     game goes past 9 innings

Reference-team convention: for team-scoped legs we pool BOTH perspectives (reference = home,
reference = away) so the bucket rho is team-agnostic. A consequence, which is correct for a
single-rho bucket model: pairs that mix a team-scoped leg with a non-team leg (e.g. ml vs total)
average toward ~0, because "a generic team winning" carries no fixed sign against the total once
favorite identity is pooled out. The strong, well-defined structure lives in the team-scoped
same_team / opp_team buckets, which this pooling preserves.
"""
from __future__ import annotations
import io, json, os, sys, zipfile, urllib.request, datetime
from itertools import combinations
import numpy as np
from scipy.stats import norm

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = os.path.join(ROOT, "Parlay", "data", "raw")
RETRO = os.path.join(RAW, "retrosheet")
SEASONS = list(range(2015, 2025))  # 2015-2024 inclusive (10 seasons, ~24k games)

# ---------------------------------------------------------------------------
# Fast, accurate bivariate normal CDF via Gauss-Legendre on the correlation
# integral:  Phi2(a,b,rho) = Phi(a)Phi(b) + integral_0^rho phi2(a,b,r) dr
# ---------------------------------------------------------------------------
_GL_X, _GL_W = np.polynomial.legendre.leggauss(48)

def phi2(a: float, b: float, rho: float) -> float:
    """P(U<=a, V<=b) for standard bivariate normal with correlation rho."""
    if rho == 0.0:
        return norm.cdf(a) * norm.cdf(b)
    r = 0.5 * rho * (_GL_X + 1.0)          # map nodes from [-1,1] to [0,rho]
    w = 0.5 * rho * _GL_W
    denom = 1.0 - r * r
    dens = np.exp(-(a * a + b * b - 2.0 * r * a * b) / (2.0 * denom)) / (2.0 * np.pi * np.sqrt(denom))
    return float(norm.cdf(a) * norm.cdf(b) + np.dot(w, dens))

def tetrachoric(pA: float, pB: float, pAB: float) -> float | None:
    """Latent-normal correlation rho with Phi2(a,b,rho)=pAB, a=Phi^-1(pA), b=Phi^-1(pB).
    Returns None if a marginal is degenerate. Clamps the joint to the Frechet bounds."""
    eps = 1e-6
    if pA <= eps or pA >= 1 - eps or pB <= eps or pB >= 1 - eps:
        return None
    lo_b, hi_b = max(0.0, pA + pB - 1.0), min(pA, pB)          # Frechet bounds on the joint
    pAB = min(max(pAB, lo_b + 1e-9), hi_b - 1e-9)
    a, b = norm.ppf(pA), norm.ppf(pB)
    lo, hi = -0.9999, 0.9999
    for _ in range(60):                                        # bisection; Phi2 is monotone in rho
        mid = 0.5 * (lo + hi)
        if phi2(a, b, mid) < pAB:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)

# ---------------------------------------------------------------------------
# Retrosheet game-log ingest
# ---------------------------------------------------------------------------
def fetch_season(year: int) -> str:
    os.makedirs(RETRO, exist_ok=True)
    txt = os.path.join(RETRO, f"GL{year}.TXT")
    if os.path.exists(txt) and os.path.getsize(txt) > 0:
        return txt
    url = f"https://www.retrosheet.org/gamelogs/gl{year}.zip"
    print(f"  downloading {url}", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=60) as r:
        data = r.read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        name = [n for n in z.namelist() if n.upper().endswith(".TXT")][0]
        with z.open(name) as f, open(txt, "wb") as out:
            out.write(f.read())
    return txt

def parse_line(s: str) -> list[int]:
    """Parse a Retrosheet line-score string ('00400000x', '020(10)0000') to per-inning runs.
    'x' = team did not bat that inning (home team leading); it contributes no inning token."""
    runs, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "(":
            j = s.index(")", i)
            runs.append(int(s[i + 1:j])); i = j + 1
        elif c in "xX":
            i += 1                                   # skipped inning (home didn't bat)
        else:
            runs.append(int(c)); i += 1
    return runs

def load_games(years: list[int]) -> list[dict]:
    import csv
    games = []
    for y in years:
        path = fetch_season(y)
        with open(path, newline="") as f:
            for g in csv.reader(f):
                try:
                    av, hv = int(g[9]), int(g[10])
                except (ValueError, IndexError):
                    continue
                if av == hv:
                    continue                          # drop ties (rare; break moneyline)
                al, hl = parse_line(g[19]), parse_line(g[20])
                if not al or not hl:
                    continue
                games.append({
                    "date": g[0], "gamenum": g[1], "away": g[3], "home": g[6],  # join keys
                    "away_r": av, "home_r": hv,
                    "away_line": al, "home_line": hl,
                    "innings": len(al),               # away bats every inning => true inning count
                })
    return games

def cum(line: list[int], k: int) -> int:
    return sum(line[:k])

# ---------------------------------------------------------------------------
# Canonical events. Each returns a bool given the game and (for the referenced team)
# which side is the reference ('home' or 'away'), plus a line where relevant.
# ---------------------------------------------------------------------------
TEAM_TYPES = ["ml", "spread", "team_total", "f3_ml", "f5_ml", "f5_spread", "f7_ml"]
GAME_TYPES = ["total", "f5_total", "rfi", "extras"]

# realistic Kalshi line grids
LINES = {
    "spread": [1.5], "f5_spread": [1.5],
    "team_total": [2.5, 3.5, 4.5, 5.5],
    "total": [6.5, 7.5, 8.5, 9.5, 10.5],
    "f5_total": [3.5, 4.5, 5.5],
}

def team_event(kind: str, g: dict, ref: str, line: float | None) -> bool:
    rf, ra = (g["home_r"], g["away_r"]) if ref == "home" else (g["away_r"], g["home_r"])
    lf = g["home_line"] if ref == "home" else g["away_line"]
    la = g["away_line"] if ref == "home" else g["home_line"]
    if kind == "ml":
        return rf > ra
    if kind == "spread":
        return (rf - ra) > line
    if kind == "team_total":
        return rf > line
    if kind == "f3_ml":
        return cum(lf, 3) > cum(la, 3)
    if kind == "f5_ml":
        return cum(lf, 5) > cum(la, 5)
    if kind == "f7_ml":
        return cum(lf, 7) > cum(la, 7)
    if kind == "f5_spread":
        return (cum(lf, 5) - cum(la, 5)) > line
    raise ValueError(kind)

def game_event(kind: str, g: dict, line: float | None) -> bool:
    if kind == "total":
        return (g["home_r"] + g["away_r"]) > line
    if kind == "f5_total":
        return (cum(g["home_line"], 5) + cum(g["away_line"], 5)) > line
    if kind == "rfi":
        return (g["home_line"][0] + g["away_line"][0]) >= 1
    if kind == "extras":
        return g["innings"] > 9
    raise ValueError(kind)

# ---------------------------------------------------------------------------
# Bucket construction. For each bucket we build paired boolean arrays (A, B) across
# all games (with the correct reference-team pooling), then invert to a tetrachoric rho.
# ---------------------------------------------------------------------------
def pair_arrays(a_type, b_type, relation, la, lb, games):
    """Return (A, B) boolean lists for a bucket at fixed lines la/lb."""
    A, B = [], []
    a_team, b_team = a_type in TEAM_TYPES, b_type in TEAM_TYPES
    for g in games:
        if a_team and b_team:
            if relation == "same_team":
                for ref in ("home", "away"):
                    A.append(team_event(a_type, g, ref, la)); B.append(team_event(b_type, g, ref, lb))
            elif relation == "opp_team":
                if a_type == b_type:                 # symmetric pair -> one obs/game avoids double count
                    A.append(team_event(a_type, g, "home", la)); B.append(team_event(b_type, g, "away", lb))
                else:
                    for ref in ("home", "away"):
                        opp = "away" if ref == "home" else "home"
                        A.append(team_event(a_type, g, ref, la)); B.append(team_event(b_type, g, opp, lb))
        elif a_team and not b_team:                  # relation == 'game'
            for ref in ("home", "away"):
                A.append(team_event(a_type, g, ref, la)); B.append(game_event(b_type, g, lb))
        elif b_team and not a_team:                  # relation == 'game'
            for ref in ("home", "away"):
                A.append(game_event(a_type, g, la)); B.append(team_event(b_type, g, ref, lb))
        else:                                        # both game-level, relation == 'game'
            A.append(game_event(a_type, g, la)); B.append(game_event(b_type, g, lb))
    return A, B

def relations_for(a_type, b_type):
    a_team, b_team = a_type in TEAM_TYPES, b_type in TEAM_TYPES
    if a_team and b_team:
        return ["same_team", "opp_team"]
    return ["game"]

def main():
    print("Loading Retrosheet seasons", SEASONS, file=sys.stderr)
    games = load_games(SEASONS)
    print(f"  {len(games)} games", file=sys.stderr)
    today = datetime.date.today().isoformat()
    out_path = os.path.join(RAW, f"historical-{today}.jsonl")
    rows = []
    all_types = TEAM_TYPES + GAME_TYPES
    # distinct-type pairs, plus same-type opposite-team pairs (two legs of one type on the two
    # teams of a game, e.g. team_total(home over) + team_total(away over)).
    type_pairs = [tuple(sorted(p)) for p in combinations(all_types, 2)]
    type_pairs += [(t, t) for t in TEAM_TYPES]
    for a_type, b_type in type_pairs:
        a, b = sorted([a_type, b_type])              # store alphabetically
        rels = ["opp_team"] if a == b else relations_for(a, b)
        for relation in rels:
            grid_a = LINES.get(a, [None])
            grid_b = LINES.get(b, [None])
            for la in grid_a:
                for lb in grid_b:
                    A, B = pair_arrays(a, b, relation, la, lb, games)
                    A = np.array(A, bool); B = np.array(B, bool)
                    n = len(A)
                    pA, pB, pAB = A.mean(), B.mean(), (A & B).mean()
                    rho = tetrachoric(pA, pB, pAB)
                    if rho is None:
                        continue
                    rows.append({
                        "source": "historical", "sport": "mlb", "ts_date": today,
                        "a": a, "b": b, "relation": relation,
                        "line_a": la, "line_b": lb,
                        "pA": round(float(pA), 5), "pB": round(float(pB), 5),
                        "pAB": round(float(pAB), 5),
                        "rho": round(float(rho), 4), "n": int(n), "method": "tetrachoric",
                    })
    with open(out_path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"Wrote {len(rows)} rows to {out_path}", file=sys.stderr)

if __name__ == "__main__":
    main()
