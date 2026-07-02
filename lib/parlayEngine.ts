// Parlay pricing engine indirection (plan 03 owns this file; plan 02 owns the real engine).
//
// This now exports the real Gaussian-copula engine. MLB legs price with measured correlations
// (lib/parlay/data/mlb-correlations.json); any ticker the classifier does not recognize (e.g.
// World Cup, deliberately unmodeled for now) resolves to rho 0 and prices as the independence
// product, so non-MLB parlays behave exactly like the old stub.
//
// `marginals[i]` is the probability that leg i's chosen side hits, in 0..1 (already
// mode-selected: mid in default mode, executable ask in realistic mode).

export { quoteParlay } from "@/lib/parlay/quote";
