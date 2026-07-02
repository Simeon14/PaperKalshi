import { describe, it, expect } from "vitest";
import {
  BASE_PMF,
  tiltPmf,
  simulateGame,
  simStats,
  calibrate,
  mergeCorrelationTable,
  parseTableEntries,
  OWNED_SOURCES,
} from "@/lib/parlay/mlbModel";
import type { CorrelationEntry } from "@/lib/parlay/types";

// Local deterministic PRNG so the statistical sanity checks are reproducible.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pmfMean(pmf: number[]): number {
  return pmf.reduce((s, p, k) => s + k * p, 0);
}

describe("tiltPmf", () => {
  it("normalizes and hits the target mean", () => {
    for (const target of [0.3, 0.5, 0.7]) {
      const pmf = tiltPmf(BASE_PMF, target);
      expect(pmf.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      expect(pmfMean(pmf)).toBeCloseTo(target, 3);
    }
  });
});

describe("simulateGame + rfi sanity", () => {
  it("YRFI (a run in the 1st) is roughly 50% at league-average scoring", () => {
    const rng = makeRng(12345);
    let yrfi = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const g = simulateGame(4.5, 4.5, rng);
      if ((g.home[0] ?? 0) + (g.away[0] ?? 0) >= 1) yrfi++;
    }
    const p = yrfi / N;
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.6);
  });
});

describe("mergeCorrelationTable (generator never clobbers foreign sources)", () => {
  const historical: CorrelationEntry = {
    a: "ml", b: "total", relation: "game", rho: 0.14, source: "historical", n: 400,
  };
  const oldStructural: CorrelationEntry = {
    a: "ml", b: "total", relation: "game", rho: -0.08, source: "structural", n: 120000,
  };
  const oldPrior: CorrelationEntry = {
    a: "ml", b: "p_hr", relation: "player_team", rho: 0.15, source: "prior",
  };
  const newStructural: CorrelationEntry = {
    a: "ml", b: "total", relation: "game", rho: -0.05, source: "structural", n: 120000,
  };
  const newPrior: CorrelationEntry = {
    a: "ml", b: "p_hr", relation: "player_team", rho: 0.18, source: "prior",
  };

  it("preserves the historical entry and swaps in the fresh owned entries", () => {
    const existing = [historical, oldStructural, oldPrior];
    const merged = mergeCorrelationTable(existing, [newStructural, newPrior]);
    // historical is preserved verbatim...
    expect(merged).toContainEqual(historical);
    // ...the fresh owned entries are present...
    expect(merged).toContainEqual(newStructural);
    expect(merged).toContainEqual(newPrior);
    // ...and the old owned entries are gone.
    expect(merged).not.toContainEqual(oldStructural);
    expect(merged).not.toContainEqual(oldPrior);
    expect(merged.length).toBe(3);
    expect(merged.filter((e) => e.source === "historical").length).toBe(1);
  });

  it("keeps every foreign entry (231-entry fixture -> 83 foreign preserved)", () => {
    const foreign = Array.from({ length: 83 }, (_, i) => ({
      a: "ml" as const, b: "total" as const, relation: "game" as const,
      rho: 0.1, source: "historical" as const, n: i + 1,
    }));
    const owned = Array.from({ length: 86 + 62 }, (_, i) => ({
      a: "ml" as const, b: "total" as const, relation: "game" as const,
      rho: 0.2, source: i < 86 ? ("structural" as const) : ("prior" as const),
    }));
    const merged = mergeCorrelationTable([...foreign, ...owned], owned);
    expect(merged.length).toBe(83 + 86 + 62);
    expect(merged.filter((e) => e.source === "historical").length).toBe(83);
  });

  it("treats null existing as a fresh table", () => {
    expect(mergeCorrelationTable(null, [newStructural])).toEqual([newStructural]);
  });

  it("refuses to accept a non-owned source among the generated entries", () => {
    expect(() => mergeCorrelationTable(null, [historical])).toThrow(/non-owned source/);
    expect(OWNED_SOURCES.has("historical")).toBe(false);
    expect(OWNED_SOURCES.has("structural")).toBe(true);
    expect(OWNED_SOURCES.has("prior")).toBe(true);
  });
});

describe("parseTableEntries", () => {
  it("parses a valid table and rejects malformed input", () => {
    const ok = { version: 1, sport: "mlb", updated: "x", entries: [
      { a: "ml", b: "total", relation: "game", rho: 0.1, source: "historical" },
    ] };
    expect(parseTableEntries(ok).length).toBe(1);
    expect(() => parseTableEntries({ version: 1 })).toThrow(/no entries array/);
    expect(() => parseTableEntries({ entries: [{ a: "ml", b: "total", relation: "game" }] })).toThrow(/malformed/);
    expect(() => parseTableEntries("nope")).toThrow(/not an object/);
  });
});

describe("calibration round trip", () => {
  it(
    "recovers the lambdas from prices the sim produced",
    () => {
      const trueHome = 5.0;
      const trueAway = 4.0;
      const { pHome, meanTotal } = simStats(trueHome, trueAway, 20000, "truth");
      const { lambdaHome, lambdaAway } = calibrate(pHome, meanTotal, 4000, "cal");
      expect(lambdaHome).toBeCloseTo(trueHome, 0); // within ~0.5
      expect(lambdaAway).toBeCloseTo(trueAway, 0);
      // And the recovered lambdas reproduce the input prices.
      const check = simStats(lambdaHome, lambdaAway, 20000, "check");
      expect(check.pHome).toBeCloseTo(pHome, 1);
      expect(check.meanTotal).toBeCloseTo(meanTotal, 0);
    },
    30000,
  );
});
