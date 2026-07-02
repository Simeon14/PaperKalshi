#!/usr/bin/env python3
"""
Plan 01 consistency experiment (historical-only): the 3-leg copula test.

For several same-game 3-leg combinations, compare the empirical joint hit rate to the joint a
pairwise Gaussian copula predicts from the three fitted tetrachoric rhos. The gap measures the
higher-order dependence the pairwise copula misses. This is the cross-check available without
sportsbook SGP quotes (complement-identity and vig-margin tests need source B/D).

All marginals, pairwise rhos, and the empirical triple are computed at the SAME fixed lines, so
the gap isolates copula error, not line-averaging.
"""
from __future__ import annotations
import os, sys
import numpy as np
from scipy.stats import norm, multivariate_normal
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from historical import load_games, team_event, game_event, tetrachoric, SEASONS

def ev(spec, g):
    kind, side, line = spec
    return game_event(kind, g, line) if side == "G" else team_event(kind, g, side, line)

def corr_from_pair(pi, pj, pij):
    r = tetrachoric(pi, pj, pij)
    return 0.0 if r is None else r

# each triple: label, [ (type, side/'G', line), x3 ]
TRIPLES = [
    ("ml(H) + spread(H) + team_total(H) o4.5",
     [("ml", "H", None), ("spread", "H", 1.5), ("team_total", "H", 4.5)]),
    ("ml(H) + total o8.5 + team_total(H) o4.5",
     [("ml", "H", None), ("total", "G", 8.5), ("team_total", "H", 4.5)]),
    ("f5_ml(H) + ml(H) + total o8.5",
     [("f5_ml", "H", None), ("ml", "H", None), ("total", "G", 8.5)]),
    ("team_total(H) o4.5 + team_total(A) o4.5 + total o8.5",
     [("team_total", "H", 4.5), ("team_total", "A", 4.5), ("total", "G", 8.5)]),
    ("rfi + total o8.5 + ml(H)",
     [("rfi", "G", None), ("total", "G", 8.5), ("ml", "H", None)]),
]

def main():
    games = load_games(SEASONS)
    n = len(games)
    print(f"games: {n}\n")
    print(f"{'triple':52s} {'emp':>7s} {'copula':>7s} {'gap':>7s} {'indep':>7s}")
    for label, specs in TRIPLES:
        cols = [np.array([ev(s, g) for g in games], bool) for s in specs]
        p = [c.mean() for c in cols]
        a = [norm.ppf(pi) for pi in p]
        R = np.eye(3)
        for i in range(3):
            for j in range(i + 1, 3):
                R[i, j] = R[j, i] = corr_from_pair(p[i], p[j], (cols[i] & cols[j]).mean())
        # nearest PSD nudge if needed
        w, V = np.linalg.eigh(R)
        if w.min() < 0:
            R = (V * np.clip(w, 1e-8, None)) @ V.T
            d = np.sqrt(np.diag(R)); R = R / np.outer(d, d)
        emp = float((cols[0] & cols[1] & cols[2]).mean())
        copula = float(multivariate_normal(mean=[0, 0, 0], cov=R, allow_singular=True).cdf(a))
        indep = float(p[0] * p[1] * p[2])
        print(f"{label:52s} {emp:7.4f} {copula:7.4f} {copula-emp:+7.4f} {indep:7.4f}")

if __name__ == "__main__":
    main()
