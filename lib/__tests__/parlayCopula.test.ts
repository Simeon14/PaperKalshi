import { describe, it, expect } from "vitest";
import { jointProbability } from "@/lib/parlay/copula";
import { normInv, phi2 } from "@/lib/parlay/normal";
import type { Matrix } from "@/lib/parlay/types";

const I3: Matrix = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

describe("jointProbability n<=2 (exact)", () => {
  it("n=2 equals phi2 of the latent thresholds", () => {
    const p = [0.6, 0.4];
    const r = 0.3;
    const got = jointProbability(p, [[1, r], [r, 1]], "seed").q;
    expect(got).toBeCloseTo(phi2(normInv(0.6), normInv(0.4), 0.3), 12);
  });
  it("obeys the complement identity through the API", () => {
    const pA = 0.6;
    const pB = 0.4;
    const r = 0.35;
    const both = jointProbability([pA, pB], [[1, r], [r, 1]], "s").q;
    const aNotB = jointProbability([pA, 1 - pB], [[1, -r], [-r, 1]], "s").q;
    expect(both + aNotB).toBeCloseTo(pA, 10);
  });
});

describe("jointProbability n>=3 (Monte Carlo)", () => {
  it("matches the independent product under an identity matrix", () => {
    const p = [0.6, 0.5, 0.4];
    const { q, method } = jointProbability(p, I3, "indep", 200000);
    expect(method).toBe("mc");
    expect(q).toBeCloseTo(0.6 * 0.5 * 0.4, 2); // within ~0.005
  });
  it("matches exact phi2 on the 2-var subproblem (third leg near-certain, independent)", () => {
    const p = [0.6, 0.4, 0.9999];
    const rho: Matrix = [
      [1, 0.3, 0],
      [0.3, 1, 0],
      [0, 0, 1],
    ];
    const { q } = jointProbability(p, rho, "sub", 200000);
    const expected = phi2(normInv(0.6), normInv(0.4), 0.3) * 0.9999;
    expect(Math.abs(q - expected)).toBeLessThan(0.005);
  });
  it("is deterministic: same seed -> identical result", () => {
    const p = [0.5, 0.5, 0.5];
    const rho: Matrix = [
      [1, 0.4, 0.2],
      [0.4, 1, 0.3],
      [0.2, 0.3, 1],
    ];
    const a = jointProbability(p, rho, "same-seed", 50000);
    const b = jointProbability(p, rho, "same-seed", 50000);
    expect(a.q).toBe(b.q);
    expect(a.stderr).toBe(b.stderr);
  });
  it("stays at or below the Frechet upper bound (min marginal)", () => {
    const p = [0.5, 0.5, 0.5];
    const high: Matrix = [
      [1, 0.95, 0.95],
      [0.95, 1, 0.95],
      [0.95, 0.95, 1],
    ];
    const { q } = jointProbability(p, high, "hi", 200000);
    expect(q).toBeLessThanOrEqual(0.5 + 0.005);
    expect(q).toBeGreaterThan(0.5 * 0.5 * 0.5); // well above independence
  });
});
