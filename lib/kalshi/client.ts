// Public Kalshi REST reader (production base, no key needed), ported from kalshi.py.
// Server-side only. Caching is handled by Next's fetch cache: a short revalidate for board
// data, and an explicit no-store for the fresh quote pulled at order-execution time.
const REST_HOST = "https://api.elections.kalshi.com";
const API_PREFIX = "/trade-api/v2";

type Params = Record<string, string | number | boolean | undefined | null>;
type CacheOpt = { revalidate?: number; noStore?: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function kget(endpoint: string, params: Params = {}, cache: CacheOpt = {}): Promise<any> {
  const url = new URL(REST_HOST + API_PREFIX + endpoint);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const headers = { accept: "application/json" };
  const r = await fetch(
    url.toString(),
    cache.noStore
      ? { headers, cache: "no-store" }
      : { headers, next: { revalidate: cache.revalidate ?? 30 } },
  );
  if (!r.ok) throw new Error(`Kalshi ${r.status} for ${endpoint}`);
  return r.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getMarketRaw(ticker: string, fresh = false): Promise<any> {
  const j = await kget(`/markets/${ticker}`, {}, fresh ? { noStore: true } : { revalidate: 5 });
  return j.market ?? {};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getMarketsRaw(params: Params, cache: CacheOpt): Promise<any> {
  return kget("/markets", params, cache);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listSeriesRaw(category: string | undefined, limit = 200): Promise<any> {
  return kget("/series", { category, limit }, { revalidate: 300 });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listEventsRaw(params: Params, cache: CacheOpt): Promise<any> {
  return kget("/events", params, cache);
}
