"use client";

import { useState } from "react";
import type { AccountState } from "@/lib/account";

interface Row {
  id: string;
  username: string;
  equity_c: number;
  realized_pnl_c: number;
  total_pnl_c: number;
}

// Leaderboard rows are integer cents; the portfolio breakdown (AccountState) is in dollars.
const moneyC = (c: number) =>
  (c < 0 ? "-$" : "$") +
  Math.abs(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedC = (c: number) => (c >= 0 ? "+" : "") + moneyC(c);
const money = (v: number) =>
  (v < 0 ? "-$" : "$") +
  Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number) => (v >= 0 ? "+" : "") + money(v);
const cls = (v: number) => (v > 0 ? "pos" : v < 0 ? "neg" : "");

export default function LeaderboardTable({ rows }: { rows: Row[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [data, setData] = useState<{ username: string; account: AccountState } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function openPlayer(id: string) {
    setOpenId(id);
    setData(null);
    setErr("");
    setLoading(true);
    try {
      const r = await fetch("/api/portfolio/" + id);
      if (!r.ok) throw new Error("Could not load this player.");
      setData(await r.json());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load this player.");
    } finally {
      setLoading(false);
    }
  }
  function close() {
    setOpenId(null);
    setData(null);
    setErr("");
  }

  const a = data?.account;
  const chips = a
    ? [
        { k: "Equity", v: money(a.equity) },
        { k: "Cash", v: money(a.cash) },
        { k: "Total P&L", v: signed(a.total_pnl), c: cls(a.total_pnl) },
        { k: "Realized", v: signed(a.realized_pnl), c: cls(a.realized_pnl) },
        { k: "Unrealized", v: signed(a.unrealized_pnl), c: cls(a.unrealized_pnl) },
      ]
    : [];

  return (
    <>
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
          {rows.length ? (
            rows.map((r, i) => (
              <tr
                key={r.id}
                className="pos-row"
                title="View this player's portfolio"
                onClick={() => openPlayer(r.id)}
              >
                <td className="l">{i + 1}</td>
                <td className="l">
                  <span className="team">@{r.username}</span>
                </td>
                <td>{moneyC(r.equity_c)}</td>
                <td className={cls(r.total_pnl_c)}>{signedC(r.total_pnl_c)}</td>
                <td className={cls(r.realized_pnl_c)}>{signedC(r.realized_pnl_c)}</td>
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

      <div
        className={"overlay" + (openId ? " show" : "")}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        {openId && (
          <div className="modal portfolio-modal">
            <div className="pf-head">
              <h3>{data ? "@" + data.username : "Player"}</h3>
              <button className="btn" onClick={close}>
                Close
              </button>
            </div>

            {loading && <div className="empty">Loading…</div>}
            {err && <div className="err">{err}</div>}

            {a && (
              <>
                <div className="chips pf-chips">
                  {chips.map((c) => (
                    <div className="chip" key={c.k}>
                      <div className="k">{c.k}</div>
                      <div className={"v " + (c.c || "")}>{c.v}</div>
                    </div>
                  ))}
                </div>

                <div className="card pf-card">
                  <div className="hd">
                    <h3>Positions</h3>
                    <span className="sub">
                      {a.positions.length ? `${a.positions.length} open` : ""}
                    </span>
                  </div>
                  <div className="poswrap">
                    <table>
                      <thead>
                        <tr>
                          <th className="l">Market</th>
                          <th>Qty</th>
                          <th>Avg</th>
                          <th>Mark</th>
                          <th>uP&amp;L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.positions.length ? (
                          a.positions.map((p) => (
                            <tr key={p.ticker + ":" + p.side}>
                              <td className="l">
                                <div className="mkt">
                                  <span className="team">{p.team}</span>{" "}
                                  <span className={"badge " + p.side}>{p.side.toUpperCase()}</span>
                                  <div className="sub2">{p.matchup}</div>
                                </div>
                              </td>
                              <td>{p.contracts}</td>
                              <td>{p.avg_price_c}¢</td>
                              <td>{p.mark_c == null ? "–" : p.mark_c + "¢"}</td>
                              <td className={cls(p.unrealized)}>{signed(p.unrealized)}</td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={5} className="empty">
                              No open positions.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="card pf-card">
                  <div className="hd">
                    <h3>Trade History</h3>
                    <span className="sub">recent fills</span>
                  </div>
                  <div className="blotwrap" style={{ maxHeight: 220 }}>
                    <table>
                      <thead>
                        <tr>
                          <th className="l">Action</th>
                          <th className="l">Market</th>
                          <th>Qty</th>
                          <th>Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.fills.length ? (
                          a.fills.map((f, i) => (
                            <tr key={i}>
                              <td className="l">
                                {f.action === "settle" ? (
                                  <span className="badge settle">settled</span>
                                ) : (
                                  <span className={"badge " + f.side}>{f.side.toUpperCase()}</span>
                                )}
                              </td>
                              <td className="l">
                                <div className="mkt">
                                  <span className="team">{f.team}</span>
                                  <div className="sub2">{f.matchup}</div>
                                </div>
                              </td>
                              <td>{f.count}</td>
                              <td>{f.price_c}¢</td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={4} className="empty">
                              No fills yet.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
