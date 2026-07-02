// Gaussian-copula joint probability of all legs hitting. n=2 is exact via the bivariate
// normal cdf; n>=3 is deterministic antithetic Monte Carlo over latent normals. Determinism
// is a hard requirement: settlement reprices void subsets from the stored seed and must
// reproduce the price exactly, so the PRNG is seeded from a hash of the seed string and never
// touches Math.random.

import { normInv, phi2 } from "@/lib/parlay/normal";
import type { Matrix } from "@/lib/parlay/types";

export interface JointResult {
  q: number; // joint probability that every leg hits
  stderr: number; // Monte Carlo standard error (0 for the exact n<=2 path)
  method: "exact" | "mc";
}

const DEFAULT_PAIRS = 200_000;

// xmur3 string hash -> 32-bit seed for mulberry32. Deterministic across runs/platforms.
function xmur3(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

// mulberry32: tiny, fast, fully deterministic PRNG in [0,1).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lower-triangular Cholesky factor (L L^T = A). A is expected PSD (the quote layer runs
// nearest-PSD repair first); a tiny floor on the pivot keeps a semidefinite input from
// producing NaN.
export function cholesky(a: Matrix): Matrix {
  const n = a.length;
  const l: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i][j];
      for (let k = 0; k < j; k++) sum -= l[i][k] * l[j][k];
      if (i === j) l[i][j] = Math.sqrt(Math.max(sum, 1e-12));
      else l[i][j] = sum / l[j][j];
    }
  }
  return l;
}

// Draw one n-vector of independent standard normals from `rng` via Box-Muller (both outputs
// used).
function drawNormals(rng: () => number, n: number, out: number[]): void {
  for (let i = 0; i < n; i += 2) {
    const u1 = rng();
    const u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1 > 0 ? u1 : Number.MIN_VALUE));
    const theta = 2 * Math.PI * u2;
    out[i] = r * Math.cos(theta);
    if (i + 1 < n) out[i + 1] = r * Math.sin(theta);
  }
}

// Joint probability that leg i hits (latent U_i <= z_i, z_i = Phi^-1(p_i)) for all i, under
// correlation matrix `rho`. Marginals are clamped to (0,1). Exact for n<=2, MC otherwise.
export function jointProbability(
  marginals: number[],
  rho: Matrix,
  seed: string,
  pairs: number = DEFAULT_PAIRS,
): JointResult {
  const n = marginals.length;
  const p = marginals.map((m) => Math.max(1e-9, Math.min(1 - 1e-9, m)));

  if (n === 0) return { q: 1, stderr: 0, method: "exact" };
  if (n === 1) return { q: p[0], stderr: 0, method: "exact" };

  const z = p.map(normInv);

  if (n === 2) {
    return { q: phi2(z[0], z[1], rho[0][1]), stderr: 0, method: "exact" };
  }

  const l = cholesky(rho);
  const rng = mulberry32(xmur3(seed));
  const g = new Array(n).fill(0);
  let sum = 0; // sum of per-pair means a_k in {0, 0.5, 1}
  let sumsq = 0;
  for (let k = 0; k < pairs; k++) {
    drawNormals(rng, n, g);
    // U = L g (antithetic partner uses -g, i.e. -U), one hit-test each.
    let hitPos = 1;
    let hitNeg = 1;
    for (let i = 0; i < n; i++) {
      let u = 0;
      for (let j = 0; j <= i; j++) u += l[i][j] * g[j];
      if (u > z[i]) hitPos = 0;
      if (-u > z[i]) hitNeg = 0;
      if (!hitPos && !hitNeg) break;
    }
    const a = (hitPos + hitNeg) / 2;
    sum += a;
    sumsq += a * a;
  }
  const q = sum / pairs;
  const variance = Math.max(0, sumsq / pairs - q * q);
  const stderr = Math.sqrt(variance / pairs);
  return { q, stderr, method: "mc" };
}
