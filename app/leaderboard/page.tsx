import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import LeaderboardTable from "@/components/LeaderboardTable";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("leaderboard")
    .select("id, username, equity_c, realized_pnl_c, total_pnl_c")
    .order("equity_c", { ascending: false })
    .limit(100);
  const list = rows ?? [];

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 20px" }}>
      <div className="topbar" style={{ position: "static", borderRadius: 12, marginBottom: 16 }}>
        <h1>
          <span className="dot" />
          PaperKalshi
        </h1>
        <div className="spacer" />
        <Link className="btn" href="/trade">
          Back to trading
        </Link>
      </div>
      <div className="card">
        <div className="hd">
          <h3>Leaderboard</h3>
          <span className="sub">by equity · tap a player</span>
        </div>
        <LeaderboardTable rows={list} />
      </div>
    </div>
  );
}
