// Minimal fixed-window rate limiter held in process memory. On serverless this bounds abuse
// per warm instance rather than globally, which is the right cost/benefit for this app today:
// it stops the realistic threat (a dumb loop hammering one warm function and burning the
// shared 20 req/s Kalshi budget) with zero infrastructure. If the app ever needs a global
// limit, swap the Map for a shared store (Upstash/Vercel KV) behind this same function.

const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 10_000;

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size >= MAX_BUCKETS) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    // Still full after sweeping (a flood of live keys): evict oldest-inserted first.
    if (buckets.size >= MAX_BUCKETS) {
      for (const k of buckets.keys()) {
        buckets.delete(k);
        if (buckets.size < MAX_BUCKETS * 0.9) break;
      }
    }
  }
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

// Client IP for rate-limit keys. x-real-ip is set by Vercel's proxy and is not client
// spoofable; the x-forwarded-for LAST hop is the connecting address (clients can prepend
// their own entries, so never trust the first hop).
export function clientIp(req: { headers: Headers }): string {
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",");
    return hops[hops.length - 1].trim() || "unknown";
  }
  return "unknown";
}
