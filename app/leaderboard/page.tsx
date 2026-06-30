import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const money = (c: number) =>
  (c < 0 ? "-$" : "$") +
  Math.abs(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (c: number) => (c >= 0 ? "+" : "") + money(c);
const cls = (c: number) => (c > 0 ? "pos" : c < 0 ? "neg" : "");

export default async function LeaderboardPage() {
  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("leaderboard")
    .select("username, equity_c, realized_pnl_c, total_pnl_c")
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
          <span className="sub">by equity</span>
        </div>
        <table>
          <thead>
            <tr>
              <th className="l">#</th>
              <th className="l">Player</th>
              <th>Equity</th>
              <th>Total P&amp;L</th>
              <th>Realized</th>
            </tr>
          </thead>
          <tbody>
            {list.length ? (
              list.map((r, i) => (
                <tr key={r.username}>
                  <td className="l">{i + 1}</td>
                  <td className="l">
                    <span className="team">@{r.username}</span>
                  </td>
                  <td>{money(r.equity_c)}</td>
                  <td className={cls(r.total_pnl_c)}>{signed(r.total_pnl_c)}</td>
                  <td className={cls(r.realized_pnl_c)}>{signed(r.realized_pnl_c)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="empty">
                  No players yet. Be the first to sign up.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
