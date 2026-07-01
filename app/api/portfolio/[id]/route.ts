import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAccountState } from "@/lib/account";

// Public breakdown for a leaderboard player: their marked-to-market portfolio, P&L, and trade
// history. The leaderboard itself is public, so this deliberately exposes the same game state
// for any player (read-only; the admin client reads their private rows on the server). It reuses
// getAccountState, which also refreshes marks and lazily settles resolved holdings.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("username")
    .eq("id", id)
    .single();
  if (!profile) return NextResponse.json({ error: "not found" }, { status: 404 });

  const account = await getAccountState(id);
  return NextResponse.json({ username: profile.username, account });
}
