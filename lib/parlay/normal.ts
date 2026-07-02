// Normal-distribution primitives for the Gaussian copula: standard normal pdf/cdf, inverse
// cdf, the bivariate normal cdf phi2, and nearest-PSD repair. All battle-tested algorithms,
// ported and cited below. Pure math, no dependencies. n <= 10 everywhere, so the O(n^3)
// eigen routines are fine.

import type { Matrix } from "@/lib/parlay/types";

const SQRT_2PI = 2.5066282746310002;

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

// Standard normal CDF. Graeme West's port of W.J. Cody's rational-Chebyshev algorithm;
// accurate to full double precision (abs error < 1e-15 across the range).
export function normCdf(x: number): number {
  const xa = Math.abs(x);
  let c: number;
  if (xa > 37) {
    c = 0;
  } else {
    const e = Math.exp((-xa * xa) / 2);
    if (xa < 7.07106781186547) {
      let b = 3.52624965998911e-2 * xa + 0.700383064443688;
      b = b * xa + 6.37396220353165;
      b = b * xa + 33.912866078383;
      b = b * xa + 112.079291497871;
      b = b * xa + 221.213596169931;
      b = b * xa + 220.206867912376;
      let num = e * b;
      b = 8.83883476483184e-2 * xa + 1.75566716318264;
      b = b * xa + 16.064177579207;
      b = b * xa + 86.7807322029461;
      b = b * xa + 296.564248779674;
      b = b * xa + 637.333633378831;
      b = b * xa + 793.826512519948;
      b = b * xa + 440.413735824752;
      c = num / b;
    } else {
      let b = xa + 0.65;
      b = xa + 4 / b;
      b = xa + 3 / b;
      b = xa + 2 / b;
      b = xa + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

// Inverse standard normal CDF. Peter Acklam's rational approximation (rel. error ~1.1e-9),
// refined with one Halley step to full double precision.
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let x: number;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  // Halley refinement.
  const e = normCdf(x) - p;
  const u = e * SQRT_2PI * Math.exp((x * x) / 2);
  x = x - u / (1 + (x * u) / 2);
  return x;
}

// Gauss-Legendre nodes/weights used by Genz's BVND, indexed by |r| band.
const GL_X: number[][] = [
  [-0.9324695142031522, -0.6612093864662647, -0.238619186083197],
  [
    -0.9815606342467191, -0.904117256370475, -0.769902674194305, -0.5873179542866171,
    -0.3678314989981802, -0.1252334085114692,
  ],
  [
    -0.9931285991850949, -0.9639719272779138, -0.9122344282513259, -0.8391169718222188,
    -0.7463319064601508, -0.636053680726515, -0.5108670019508271, -0.3737060887154196,
    -0.2277858511416451, -0.07652652113349733,
  ],
];
const GL_W: number[][] = [
  [0.1713244923791705, 0.3607615730481384, 0.4679139345726904],
  [
    0.04717533638651177, 0.1069393259953183, 0.1600783285433464, 0.2031674267230659,
    0.2334925365383547, 0.2491470458134029,
  ],
  [
    0.01761400713915212, 0.04060142980038694, 0.06267204833410906, 0.08327674157670475,
    0.1019301198172404, 0.1181945319615184, 0.1316886384491766, 0.1420961093183821,
    0.1491729864726037, 0.1527533871307259,
  ],
];
const TWOPI = 6.283185307179586;

// P(X > dh, Y > dk) for standard bivariate normal with correlation r. Yihong Ge & Alan Genz's
// BVND (from tvpack/mvndst); handles the full r range including |r| -> 1.
function bvnd(dh: number, dk: number, r: number): number {
  let band: number;
  if (Math.abs(r) < 0.3) band = 0;
  else if (Math.abs(r) < 0.75) band = 1;
  else band = 2;
  const gx = GL_X[band];
  const gw = GL_W[band];
  const lg = gx.length;

  let h = dh;
  let k = dk;
  let hk = h * k;
  let bvn = 0;

  if (Math.abs(r) < 0.925) {
    if (Math.abs(r) > 0) {
      const hs = (h * h + k * k) / 2;
      const asr = Math.asin(r);
      for (let i = 0; i < lg; i++) {
        for (let is = -1; is <= 1; is += 2) {
          const sn = Math.sin((asr * (is * gx[i] + 1)) / 2);
          bvn += gw[i] * Math.exp((sn * hk - hs) / (1 - sn * sn));
        }
      }
      bvn = (bvn * asr) / (2 * TWOPI);
    }
    bvn += normCdf(-h) * normCdf(-k);
  } else {
    if (r < 0) {
      k = -k;
      hk = -hk;
    }
    if (Math.abs(r) < 1) {
      const as = (1 - r) * (1 + r);
      let a = Math.sqrt(as);
      const bs = (h - k) * (h - k);
      const c = (4 - hk) / 8;
      const d = (12 - hk) / 16;
      bvn =
        a *
        Math.exp(-(bs / as + hk) / 2) *
        (1 - (c * (bs - as) * (1 - (d * bs) / 5)) / 3 + (c * d * as * as) / 5);
      if (hk > -160) {
        const b = Math.sqrt(bs);
        bvn -=
          Math.exp(-hk / 2) *
          Math.sqrt(TWOPI) *
          normCdf(-b / a) *
          b *
          (1 - (c * bs * (1 - (d * bs) / 5)) / 3);
      }
      a = a / 2;
      for (let i = 0; i < lg; i++) {
        for (let is = -1; is <= 1; is += 2) {
          const xs = (a * (is * gx[i] + 1)) ** 2;
          const rs = Math.sqrt(1 - xs);
          bvn +=
            a *
            gw[i] *
            (Math.exp(-bs / (2 * xs) - hk / (1 + rs)) / rs -
              Math.exp(-(bs / xs + hk) / 2) * (1 + c * xs * (1 + d * xs)));
        }
      }
      bvn = -bvn / TWOPI;
    }
    if (r > 0) {
      bvn += normCdf(-Math.max(h, k));
    } else {
      bvn = -bvn;
      if (k > h) bvn += normCdf(k) - normCdf(h);
    }
  }
  return Math.min(1, Math.max(0, bvn));
}

// Bivariate normal CDF: P(X <= a, Y <= b) with correlation rho. Uses the identity
// phi2(a,b,rho) = P(-X >= -a, -Y >= -b) = bvnd(-a, -b, rho).
export function phi2(a: number, b: number, rho: number): number {
  const r = Math.max(-1, Math.min(1, rho));
  if (a === Infinity) return normCdf(b);
  if (b === Infinity) return normCdf(a);
  if (a === -Infinity || b === -Infinity) return 0;
  return bvnd(-a, -b, r);
}

// --- symmetric-matrix helpers (Jacobi eigen + nearest correlation matrix) ---

function symmetrize(a: Matrix): Matrix {
  const n = a.length;
  const out: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) out[i][j] = (a[i][j] + a[j][i]) / 2;
  return out;
}

// Cyclic Jacobi eigenvalue algorithm for a symmetric matrix. Eigenvectors are columns of
// `vectors`. Robust and simple; ideal for the small (n <= 10) matrices here.
export function jacobiEigen(ain: Matrix): { values: number[]; vectors: Matrix } {
  const n = ain.length;
  const a = ain.map((r) => r.slice());
  const v: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let m = 0; m < n; m++) {
          const amp = a[m][p];
          const amq = a[m][q];
          a[m][p] = c * amp - s * amq;
          a[m][q] = s * amp + c * amq;
        }
        for (let m = 0; m < n; m++) {
          const apm = a[p][m];
          const aqm = a[q][m];
          a[p][m] = c * apm - s * aqm;
          a[q][m] = s * apm + c * aqm;
        }
        for (let m = 0; m < n; m++) {
          const vmp = v[m][p];
          const vmq = v[m][q];
          v[m][p] = c * vmp - s * vmq;
          v[m][q] = s * vmp + c * vmq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}

export function minEigenvalue(a: Matrix): number {
  if (a.length === 0) return 0;
  return Math.min(...jacobiEigen(symmetrize(a)).values);
}

// Project onto the PSD cone by clipping eigenvalues up to `floor`.
function projPSD(a: Matrix, floor: number): Matrix {
  const { values, vectors } = jacobiEigen(a);
  const n = a.length;
  const out: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += vectors[i][k] * Math.max(values[k], floor) * vectors[j][k];
      out[i][j] = sum;
      out[j][i] = sum;
    }
  }
  return out;
}

// Nearest correlation matrix (Higham 2002 alternating projections with Dykstra correction):
// projects between the PSD cone and the unit-diagonal set until convergence. Returns the
// repaired matrix and whether any repair was actually needed. A tiny eigenvalue floor keeps
// the result strictly PD so a later Cholesky cannot fail.
export function nearestPSD(ain: Matrix, floor = 1e-8): { matrix: Matrix; repaired: boolean } {
  const n = ain.length;
  let y = symmetrize(ain);
  if (n <= 1 || minEigenvalue(y) >= floor) return { matrix: y, repaired: false };

  let ds: Matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  let x = y.map((r) => r.slice());
  let prev = x;
  for (let iter = 0; iter < 200; iter++) {
    const r: Matrix = y.map((row, i) => row.map((val, j) => val - ds[i][j])); // R = Y - dS
    x = projPSD(r, floor);
    ds = x.map((row, i) => row.map((val, j) => val - r[i][j])); // dS = X - R
    y = x.map((row) => row.slice());
    for (let i = 0; i < n; i++) y[i][i] = 1; // project onto unit diagonal
    let diff = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) diff += (y[i][j] - prev[i][j]) ** 2;
    prev = y.map((row) => row.slice());
    if (diff < 1e-16) break;
  }
  return { matrix: y, repaired: true };
}
