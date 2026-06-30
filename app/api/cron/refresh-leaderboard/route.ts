import { NextRequest, NextResponse } from "next/server";
import { refreshLeaderboard } from "@/lib/account";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Re-marks every account against live quotes and refreshes the leaderboard. Triggered by
// Vercel Cron (see vercel.json), which sends `Authorization: Bearer ${CRON_SECRET}`.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const refreshed = await refreshLeaderboard();
  return NextResponse.json({ refreshed });
}
