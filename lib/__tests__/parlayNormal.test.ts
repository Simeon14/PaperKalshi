import { describe, it, expect } from "vitest";
import {
  normCdf,
  normInv,
  phi2,
  nearestPSD,
  minEigenvalue,
} from "@/lib/parlay/normal";

describe("normCdf", () => {
  it("matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 12);
    expect(normCdf(1.959963985)).toBeCloseTo(0.975, 8);
    expect(normCdf(-1)).toBeCloseTo(0.15865525, 7);
    expect(normCdf(3)).toBeCloseTo(0.9986501, 7);
  });
});

describe("normInv / normCdf round trips", () => {
  it("normCdf(normInv(p)) == p", () => {
    for (const p of [0.001, 0.02, 0.1, 0.25, 0.5, 0.62, 0.9, 0.98, 0.999]) {
      expect(normCdf(normInv(p))).toBeCloseTo(p, 9);
    }
  });
  it("normInv(normCdf(x)) == x", () => {
    for (const x of [-3, -1.5, -0.4, 0, 0.4, 1.5, 3]) {
      expect(normInv(normCdf(x))).toBeCloseTo(x, 7);
    }
  });
});

describe("phi2 (bivariate normal cdf)", () => {
  // Exact identity: phi2(0,0,r) = 1/4 + asin(r)/(2*pi).
  it("matches the arcsin identity at the origin", () => {
    for (const r of [-0.9, -0.5, -0.2, 0, 0.2, 0.5, 0.8, 0.99]) {
      const expected = 0.25 + Math.asin(r) / (2 * Math.PI);
      expect(phi2(0, 0, r)).toBeCloseTo(expected, 8);
    }
  });
  it("factorizes to the product at rho = 0", () => {
    for (const [a, b] of [
      [0.3, -0.7],
      [1.2, 0.4],
      [-1, -2],
    ]) {
      expect(phi2(a, b, 0)).toBeCloseTo(normCdf(a) * normCdf(b), 10);
    }
  });
  it("hits the Frechet upper bound at rho = 1", () => {
    for (const [a, b] of [
      [0.3, -0.7],
      [1.2, 0.4],
      [-0.5, -0.5],
    ]) {
      expect(phi2(a, b, 1)).toBeCloseTo(Math.min(normCdf(a), normCdf(b)), 9);
    }
  });
  it("hits the Frechet lower bound at rho = -1", () => {
    for (const [a, b] of [
      [0.3, -0.7],
      [1.2, 0.4],
      [0.5, 0.5],
    ]) {
      expect(phi2(a, b, -1)).toBeCloseTo(Math.max(0, normCdf(a) + normCdf(b) - 1), 9);
    }
  });
  // The complement identity the copula sign flip relies on.
  it("obeys phi2(a,-b,-r) = Phi(a) - phi2(a,b,r)", () => {
    const a = 0.4;
    const b = -0.9;
    const r = 0.35;
    expect(phi2(a, -b, -r)).toBeCloseTo(normCdf(a) - phi2(a, b, r), 9);
  });
});

describe("nearestPSD (Higham)", () => {
  it("leaves an already-PSD matrix unchanged (repaired = false)", () => {
    const ok = [
      [1, 0.3, 0.1],
      [0.3, 1, 0.2],
      [0.1, 0.2, 1],
    ];
    const { repaired } = nearestPSD(ok);
    expect(repaired).toBe(false);
  });
  it("repairs a non-PSD matrix to PSD with unit diagonal", () => {
    // This matrix has a negative eigenvalue.
    const broken = [
      [1, 0.9, 0.9],
      [0.9, 1, -0.9],
      [0.9, -0.9, 1],
    ];
    expect(minEigenvalue(broken)).toBeLessThan(0);
    const { matrix, repaired } = nearestPSD(broken);
    expect(repaired).toBe(true);
    expect(minEigenvalue(matrix)).toBeGreaterThanOrEqual(-1e-9);
    for (let i = 0; i < 3; i++) expect(matrix[i][i]).toBeCloseTo(1, 9);
  });
});
