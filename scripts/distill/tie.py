#!/usr/bin/env python3
"""
Plan 07 / TIE buckets: the F3/F5/F7 "tie after N innings" outcome vs other legs.

A KXMLBF{3,5,7} market has a team outcome AND a TIE outcome. classify.ts maps both to the same
LegType (f3_ml/f5_ml/f7_ml); a TIE leg is that type with NO teamRef, so resolveRelation returns
`game` when it meets any other leg.

CONSEQUENCE (documented for the engine agent): the TIE shares its bucket key with a real-team
leg of the same type whenever that real-team leg also resolves to `game` (i.e. paired with a
team-AGNOSTIC leg: total / f5_total / rfi / extras). So (f5_ml, total, game) is ALREADY the
real-team "leads after 5 vs total" bucket from historical.py; a TIE value cannot be stored there
without corrupting it. Those TIE partners need a distinct `f{3,5,7}_tie` LegType in the engine.

We therefore EMIT only the collision-free TIE buckets: TIE vs a TEAM-scoped partner
(ml / spread / team_total), where a distinct-team f_ml leg never resolves to `game`, so the key
is TIE-only. We MEASURE the rest (vs total / f5_total / rfi) for the report + engine follow-up.

Event: tied after k = cumulative home runs == cumulative away runs through inning k. Partner team
legs are pooled over the reference team (home/away), matching the historical convention.
"""
from __future__ import annotations
import json, os, sys, datetime
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from historical import load_games, team_event, game_event, tetrachoric, cum, SEASONS

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = os.path.join(ROOT, "Parlay", "data", "raw")
TODAY = datetime.date.today().isoformat()

TIE_TYPES = {"f3_ml": 3, "f5_ml": 5, "f7_ml": 7}
# collision-free partners (team-scoped: a distinct-team f_ml never makes relation `game`)
EMIT_PARTNERS = {"ml": [None], "spread": [1.5], "team_total": [3.5, 4.5]}
# measured-only partners (collide with the real-team historical bucket; need an engine tie type)
REPORT_PARTNERS = {"total": [7.5, 8.5, 9.5], "f5_total": [4.5], "rfi": [None]}

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

def main():
    games = load_games(SEASONS)
    emit_rows, report_rows = [], []
    for tie_type, k in TIE_TYPES.items():
        for partner, lines in EMIT_PARTNERS.items():
            for r in bucket(tie_type, k, partner, lines, games, True):
                emit_rows.append({"source": "historical", "sport": "mlb", "ts_date": TODAY,
                                  "a": r["a"], "b": r["b"], "relation": "game",
                                  "line_a": None, "line_b": r["line"], "pA": None, "pB": None,
                                  "pAB": None, "rho": r["rho"], "n": r["n"],
                                  "method": "tetrachoric",
                                  "note": f"TIE outcome ({tie_type} tied after {k}) vs {partner}; "
                                          "TIE-only bucket key (distinct-team f_ml never => game)"})
        for partner, lines in REPORT_PARTNERS.items():
            report_rows.extend([{**r, "tie": tie_type} for r in
                                bucket(tie_type, k, partner, lines, games, False)])
    out_path = os.path.join(RAW, f"tie-{TODAY}.jsonl")
    with open(out_path, "w") as f:
        for r in emit_rows:
            f.write(json.dumps(r) + "\n")
    print(f"Wrote {len(emit_rows)} collision-free TIE rows to {out_path}", file=sys.stderr)
    print("\n=== EMITTED (TIE vs team-scoped, collision-free) ===", file=sys.stderr)
    import statistics as st, collections
    byk = collections.defaultdict(list)
    for r in emit_rows:
        byk[(r["a"], r["b"])].append(r["rho"])
    for k2, v in sorted(byk.items()):
        print(f"  {str(k2):26s} median_rho={st.median(v):+.3f} n_grid={len(v)}", file=sys.stderr)
    print("\n=== MEASURED-ONLY (TIE vs total/f5_total/rfi; NOT emitted, needs engine tie type) ===",
          file=sys.stderr)
    for r in report_rows:
        print(f"  {r['tie']:6s} vs {r['b'] if r['a']==r['tie'] else r['a']:9s} "
              f"line={r['line']} rho={r['rho']:+.3f}", file=sys.stderr)

if __name__ == "__main__":
    main()
