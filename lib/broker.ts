import { LiveMarket, yesMidC, noMidC } from "@/lib/kalshi/market";
import { takerFeeCents } from "@/lib/fees";

export type Side = "yes" | "no";
export type Action = "buy" | "sell";

// Port of PaperBroker._fill_price_c: realistic mode is marketable (buys lift the ask, sells
// hit the bid); the default perfect-liquidity mode fills both sides at the mid.
export function fillPriceC(
  m: LiveMarket,
  side: Side,
  action: Action,
  realistic: boolean,
): number | null {
  if (!realistic) return side === "yes" ? yesMidC(m) : noMidC(m);
  if (action === "buy") return side === "yes" ? m.yes_ask_c : m.no_ask_c;
  return side === "yes" ? m.yes_bid_c : m.no_bid_c;
}

// What the server hands to the apply_trade RPC: the fill price and fee it computed from a
// fresh quote. Returns null when there's no usable price on that side (1..99c).
export function computeFill(
  m: LiveMarket,
  side: Side,
  action: Action,
  count: number,
  realistic: boolean,
): { priceC: number; feeC: number } | null {
  const priceC = fillPriceC(m, side, action, realistic);
  if (priceC === null || priceC < 1 || priceC > 99) return null;
  return { priceC, feeC: realistic ? takerFeeCents(count, priceC) : 0 };
}
