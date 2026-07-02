#!/usr/bin/env python3
"""
Plan 01 / Phase 2: aggregate raw distillation rows into lib/parlay/data/mlb-correlations.json.

Reads every Parlay/data/raw/*.jsonl (historical-*, and future distilled sources like dk-*,
kalshi-*), groups rows into (a, b, relation) buckets, takes the median rho, records n and
spread (MAD across the line grid / observations), and merges into the shared correlations file.

Merge rules (from 00-overview.md shared contract 2):
  - Entries are keyed by (a, b, relation, source). This run only rewrites the source rows it
    recomputes (e.g. historical); it PRESERVES structural/prior entries owned by the engine
    agent (02) and any other source's entries already in the file.
  - distilled entries are emitted only when n >= 30 for the bucket; historical entries carry
    their own n and are not gated.
  - a/b sorted alphabetically; rho clamped to [-1, 1]; relation validated.

Also runs a standalone PSD check: assembles a representative same-game parlay's correlation
matrix from the buckets and confirms Higham nearest-correlation repair yields a valid PSD matrix
close to the input (this is what the engine does before sampling the copula).
"""
from __future__ import annotations
import glob, json, os, statistics as st
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = os.path.join(ROOT, "Parlay", "data", "raw")
OUT = os.path.join(ROOT, "lib", "parlay", "data", "mlb-correlations.json")

VALID_RELATIONS = {"same_team", "opp_team", "game", "same_player", "player_team",
                   "player_opp", "player_player_same_team", "player_player_opp"}
MIN_N_DISTILLED = 30

def load_rows():
    rows = []
    for path in sorted(glob.glob(os.path.join(RAW, "*.jsonl"))):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
    return rows

def mad(xs, med):
    return st.median([abs(x - med) for x in xs]) if len(xs) > 1 else 0.0

def build_entries(rows):
    by_key = {}
    for r in rows:
        key = (r["a"], r["b"], r["relation"], r["source"])
        by_key.setdefault(key, []).append(r)
    entries = []
    for (a, b, relation, source), rs in sorted(by_key.items()):
        assert a <= b, f"unsorted bucket {a},{b}"
        assert relation in VALID_RELATIONS, f"bad relation {relation}"
        rhos = [x["rho"] for x in rs]
        med = st.median(rhos)
        n = max(x["n"] for x in rs)
        if source == "distilled" and n < MIN_N_DISTILLED:
            continue
        rho = max(-1.0, min(1.0, med))
        note = {
            "historical": f"Retrosheet 2015-2024, tetrachoric, median over {len(rhos)} line-grid point(s)",
        }.get(source, f"{source}, median over {len(rhos)} obs")
        entries.append({
            "a": a, "b": b, "relation": relation, "rho": round(rho, 4),
            "source": source, "n": int(n), "spread": round(mad(rhos, med), 4), "notes": note,
        })
    return entries

def merge(existing_entries, new_entries):
    """Key by (a,b,relation,source); new rows overwrite same-source, others preserved."""
    keyed = {(e["a"], e["b"], e["relation"], e["source"]): e for e in existing_entries}
    for e in new_entries:
        keyed[(e["a"], e["b"], e["relation"], e["source"])] = e
    return [keyed[k] for k in sorted(keyed)]

# ---- Higham (2002) nearest correlation matrix, alternating projections ----
def nearest_corr(A, iters=100):
    n = A.shape[0]
    Y = A.copy(); dS = np.zeros_like(A)
    for _ in range(iters):
        R = Y - dS
        w, V = np.linalg.eigh((R + R.T) / 2)
        X = (V * np.clip(w, 0, None)) @ V.T          # project to PSD
        dS = X - R
        Y = X.copy(); np.fill_diagonal(Y, 1.0)       # project to unit diagonal
    return Y

def rho_lookup(entries, a, b, relation):
    a, b = sorted([a, b])
    for e in entries:
        if e["a"] == a and e["b"] == b and e["relation"] == relation:
            return e["rho"]
    return 0.0

def psd_check(entries):
    """Assemble a realistic 6-leg same-game parlay matrix and confirm PSD repair works."""
    # legs: 0 ml(H) 1 spread(H) 2 team_total(H) 3 f5_ml(H) 4 total(over) 5 team_total(A)
    legs = [("ml", "H"), ("spread", "H"), ("team_total", "H"), ("f5_ml", "H"),
            ("total", "G"), ("team_total", "A")]
    m = len(legs)
    M = np.eye(m)
    for i in range(m):
        for j in range(i + 1, m):
            (ta, sa), (tb, sb) = legs[i], legs[j]
            if "G" in (sa, sb):
                rel = "game"
            elif sa == sb:
                rel = "same_team"
            else:
                rel = "opp_team"
            r = rho_lookup(entries, ta, tb, rel)
            M[i, j] = M[j, i] = r
    eig_min = float(np.linalg.eigvalsh(M).min())
    repaired = nearest_corr(M)
    eig_min_r = float(np.linalg.eigvalsh(repaired).min())
    drift = float(np.abs(repaired - M).max())
    return eig_min, eig_min_r, drift

def main():
    rows = load_rows()
    new_entries = build_entries(rows)
    existing = []
    if os.path.exists(OUT):
        existing = json.load(open(OUT)).get("entries", [])
    merged = merge(existing, new_entries)

    doc = {"version": 1, "sport": "mlb",
           "updated": max((r.get("ts_date", "2026-07-02") for r in rows), default="2026-07-02"),
           "entries": merged}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")

    by_src = {}
    for e in merged:
        by_src[e["source"]] = by_src.get(e["source"], 0) + 1
    print(f"Wrote {len(merged)} entries to {OUT}")
    print("  by source:", by_src)
    eig_min, eig_min_r, drift = psd_check(merged)
    print(f"  PSD check on representative 6-leg parlay matrix:")
    print(f"    input min eigenvalue = {eig_min:+.4f} ({'PSD' if eig_min >= -1e-9 else 'NOT PSD -> Higham repair needed'})")
    print(f"    repaired min eigenvalue = {eig_min_r:+.4f} (max element drift {drift:.4f})")

if __name__ == "__main__":
    main()
