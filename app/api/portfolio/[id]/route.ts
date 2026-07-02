import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAccountState, type AccountState } from "@/lib/account";
import { rateLimit, clientIp } from "@/lib/ratelimit";

// Public breakdown for a leaderboard player: their marked-to-market portfolio, P&L, and trade
// history. The leaderboard itself is public, so this deliberately exposes the same game state
// for any player (read-only; the admin client reads their private rows on the server). Each
// build costs Kalshi calls and DB reads and has no auth, so responses are cached for 30s
// (storing the promise also dedupes concurrent hits) and per-IP rate limited.

interface Payload {
  username: string;
  account: AccountState;
}

const cache = new Map<string, { at: number; data: Promise<Payload | null> }>();
const TTL_MS = 30_000;
const MAX_ENTRIES = 1000;

async function load(id: string): Promise<Payload | null> {
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("username")
    .eq("id", id)
    .single();
  if (!profile) return null;
  const account = await getAccountState(id);
  return { username: profile.username, account };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  if (!rateLimit("portfolio:" + clientIp(req), 30, 60_000)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429 });
  }

  const now = Date.now();
  let hit = cache.get(id);
  if (!hit || now - hit.at >= TTL_MS) {
    if (cache.size >= MAX_ENTRIES) {
      for (const [k, v] of cache) if (now - v.at >= TTL_MS) cache.delete(k);
    }
    hit = { at: now, data: load(id) };
    cache.set(id, hit);
    hit.data.catch(() => cache.delete(id)); // don't pin a transient failure
  }

  try {
    const payload = await hit.data;
    if (!payload) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
