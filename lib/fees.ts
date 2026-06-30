// Kalshi taker fee, ported exactly from fees.py.
//
//   fee = ceil( 0.07 * C * P * (1 - P) ) dollars, rounded up PER ORDER, P in dollars.
//
// In integer cents that is ceil( 7 * C * price_c * (100 - price_c) / 10000 ). Keeping it
// all-integer means a fee landing exactly on a cent boundary is never bumped up by float
// error (the gotcha the original module calls out).
const TAKER_NUMERATOR = 7; // 0.07 == 7 / 100

export function takerFeeCents(contracts: number, priceC: number): number {
  if (contracts <= 0) return 0;
  if (priceC <= 0 || priceC >= 100) return 0; // settled / certain: P*(1-P) == 0
  const num = TAKER_NUMERATOR * contracts * priceC * (100 - priceC); // exact integer
  return Math.floor((num + 9999) / 10000); // integer ceil of num / 10000
}
