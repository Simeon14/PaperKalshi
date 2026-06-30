"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { takerFeeCents } from "@/lib/fees";
import type { Card } from "@/lib/kalshi/board";
import type { Outcome } from "@/lib/kalshi/market";
import type { AccountState, PositionState } from "@/lib/account";

// Refresh cadences (ms) and the per-tick ticker cap (bounds a huge / zoomed-out viewport).
const FAST_MS = 1500; // viewport-scoped price refresh
const MODAL_MS = 500; // open buy-ticket's single market
const STRUCTURE_MS = 12000; // full board: which cards exist
const ACCOUNT_MS = 6000; // account / positions
const MAX_VISIBLE_TICKERS = 40;

const money = (v: number) =>
  (v < 0 ? "-$" : "$") +
  Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cls = (v: number) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
const signed = (v: number) => (v >= 0 ? "+" : "") + money(v);
const fmtVol = (v: number) =>
  v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(v);

// MLB game time is encoded in the event ticker: KXMLBGAME-26JUN271905<AWAY><HOME>.
function gameTime(ev: string): string {
  const m = (ev || "").match(/KXMLBGAME-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/);
  if (!m) return "";
  const mon = m[2][0] + m[2].slice(1).toLowerCase();
  let h = parseInt(m[4], 10);
  const mm = m[5];
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${mon} ${parseInt(m[3], 10)} · ${h}:${mm} ${ap}`;
}
function fmtDate(s: string): string {
  if (!s) return "";
  try {
    const dte = new Date(s);
    const now = new Date();
    const o: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    if (dte.getFullYear() !== now.getFullYear()) o.year = "numeric";
    return dte.toLocaleDateString(undefined, o);
  } catch {
    return "";
  }
}

type Side = "yes" | "no";
type Action = "buy" | "sell";
type Unit = "contracts" | "dollars"; // how the quantity field is entered
interface ModalState {
  open: boolean;
  ticker: string | null;
  side: Side;
  qty: string; // the raw field value, interpreted in `unit`
  unit: Unit;
  err: string;
  busy: boolean;
  position: boolean; // opened from a held position (Add / Trim) vs the board (buy Yes / No)
  action: Action; // Add = buy, Trim = sell; only meaningful when position is true
}

export default function TradeTerminal({ username }: { username: string }) {
  const router = useRouter();
  const [categories, setCategories] = useState<{ key: string; label: string }[]>([]);
  const [category, setCategory] = useState("mlb");
  const [catLabel, setCatLabel] = useState("MLB");
  const [cards, setCards] = useState<Card[]>([]);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [connected, setConnected] = useState(true);
  const [loadingMarkets, setLoadingMarkets] = useState(true);
  const [collapsed, setCollapsed] = useState(true);
  const [sortBy, setSortBy] = useState<"vol" | "date">("vol");
  const [modal, setModal] = useState<ModalState>({
    open: false,
    ticker: null,
    side: "yes",
    qty: "10",
    unit: "contracts",
    err: "",
    busy: false,
    position: false,
    action: "buy",
  });
  const [ticketQuote, setTicketQuote] = useState<Outcome | null>(null);

  const realistic = account?.realistic ?? false;
  // The position behind an open Add/Trim ticket (source of the held count + avg cost).
  const heldPos =
    modal.position && account
      ? account.positions.find((p) => p.ticker === modal.ticker && p.side === modal.side)
      : undefined;
  const held = heldPos?.contracts ?? 0;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = modal.open;
  const overlayMouseDown = useRef(false);
  const cardsRef = useRef<Card[]>(cards);
  cardsRef.current = cards;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const visibleIds = useRef<Set<string>>(new Set());

  const boardMap = useMemo(() => {
    const m = new Map<string, Outcome>();
    cards.forEach((c) => c.outcomes.forEach((o) => m.set(o.ticker, o)));
    return m;
  }, [cards]);

  const posqty = useMemo(() => {
    const m = new Map<string, number>();
    account?.positions.forEach((p) => m.set(p.ticker + ":" + p.side, p.contracts));
    return m;
  }, [account]);

  const sortedCards = useMemo(() => {
    const cs = [...cards];
    if (sortBy === "date") {
      // soonest close first; cards without a close time sink to the bottom
      cs.sort((a, b) => {
        if (!a.close_time) return 1;
        if (!b.close_time) return -1;
        return a.close_time < b.close_time ? -1 : a.close_time > b.close_time ? 1 : 0;
      });
    } else {
      cs.sort((a, b) => b.vol - a.vol);
    }
    return cs;
  }, [cards, sortBy]);

  const loadCategories = useCallback(async () => {
    try {
      const d = await (await fetch("/api/categories")).json();
      setCategories(d.categories || []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadMarkets = useCallback(async (cat: string) => {
    setLoadingMarkets(true);
    try {
      const d = await (await fetch("/api/markets?category=" + encodeURIComponent(cat))).json();
      setCards(d.cards || []);
      setConnected(true);
    } catch {
      setConnected(false);
    } finally {
      setLoadingMarkets(false);
    }
  }, []);

  const loadAccount = useCallback(async () => {
    try {
      const r = await fetch("/api/account");
      if (r.ok) setAccount(await r.json());
    } catch {
      /* ignore */
    }
  }, []);

  // Merge fresh quotes into the existing cards, touching only the markets that changed.
  const patchPrices = useCallback((quotes: Record<string, Outcome>) => {
    if (!quotes || !Object.keys(quotes).length) return;
    setCards((prev) =>
      prev.map((c) => ({
        ...c,
        outcomes: c.outcomes.map((o) => (quotes[o.ticker] ? { ...o, ...quotes[o.ticker] } : o)),
      })),
    );
  }, []);

  // initial load
  useEffect(() => {
    loadCategories();
    loadMarkets(category);
    loadAccount();
    try {
      const stored = localStorage.getItem("paperCollapsed");
      // Hidden by default; only an explicit "show" choice un-collapses it.
      setCollapsed(stored === null ? true : stored === "1");
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Full board structure (which cards exist) on a slow cadence; the fast tick keeps prices live.
  useEffect(() => {
    const id = setInterval(() => {
      if (!modalOpenRef.current) loadMarkets(category);
    }, STRUCTURE_MS);
    return () => clearInterval(id);
  }, [category, loadMarkets]);

  // Account / positions.
  useEffect(() => {
    const id = setInterval(() => {
      if (!modalOpenRef.current) loadAccount();
    }, ACCOUNT_MS);
    return () => clearInterval(id);
  }, [loadAccount]);

  // Track which cards are actually in the scroll viewport (re-synced when the board changes).
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    visibleIds.current = new Set();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.cardId;
          if (!id) continue;
          if (e.isIntersecting) visibleIds.current.add(id);
          else visibleIds.current.delete(id);
        }
      },
      { root, threshold: 0.01 },
    );
    root.querySelectorAll<HTMLElement>("[data-card-id]").forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [cards]);

  // Fast, viewport-scoped price refresh: ONE batched Kalshi call for just the visible markets.
  useEffect(() => {
    const id = setInterval(async () => {
      if (modalOpenRef.current) return; // board is hidden behind the ticket, which polls itself
      const ids = visibleIds.current;
      const tickers: string[] = [];
      for (const c of cardsRef.current) {
        if (ids.has(c.id)) for (const o of c.outcomes) tickers.push(o.ticker);
      }
      if (!tickers.length) return;
      try {
        const r = await fetch(
          "/api/quotes?tickers=" +
            encodeURIComponent(tickers.slice(0, MAX_VISIBLE_TICKERS).join(",")),
        );
        if (r.ok) patchPrices((await r.json()).quotes || {});
      } catch {
        /* ignore a dropped tick */
      }
    }, FAST_MS);
    return () => clearInterval(id);
  }, [patchPrices]);

  // Continuous price refresh for the open ticket's single market. Keeps its own quote so the
  // ticket works even when that market isn't on the current board (e.g. selling a position
  // held in another category).
  useEffect(() => {
    if (!modal.open || !modal.ticker) {
      setTicketQuote(null);
      return;
    }
    const ticker = modal.ticker;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/quotes?fresh=1&tickers=" + encodeURIComponent(ticker));
        if (!r.ok) return;
        const quotes = (await r.json()).quotes || {};
        patchPrices(quotes);
        if (!cancelled && quotes[ticker]) setTicketQuote(quotes[ticker]);
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = setInterval(tick, MODAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [modal.open, modal.ticker, patchPrices]);

  function switchCategory(key: string, label: string) {
    if (key === category) return;
    setCategory(key);
    setCatLabel(label);
    setCards([]);
    loadMarkets(key);
  }

  function openTicket(ticker: string, side: Side, qty = "10") {
    setTicketQuote(null);
    setModal({ open: true, ticker, side, qty, unit: "contracts", err: "", busy: false, position: false, action: "buy" });
  }
  // Clicking a held position opens an Add / Trim ticket on that exact side (defaults to Add).
  function openPosition(p: PositionState) {
    setTicketQuote(null);
    setModal({
      open: true,
      ticker: p.ticker,
      side: p.side as Side,
      qty: "10",
      unit: "contracts",
      err: "",
      busy: false,
      position: true,
      action: "buy",
    });
  }
  function closeModal() {
    setModal((m) => ({ ...m, open: false }));
  }

  // Switch the quantity field between contracts and dollars, converting the current value at
  // the live price so the order's economic size is preserved across the toggle.
  function setUnit(unit: Unit, priceC: number | null) {
    setModal((m) => {
      if (m.unit === unit) return m;
      let qty = m.qty;
      if (priceC && priceC > 0) {
        if (unit === "dollars") {
          const c = parseInt(m.qty || "0", 10) || 0;
          qty = c > 0 ? (Math.round(c * priceC) / 100).toFixed(2) : "";
        } else {
          const dollars = parseFloat(m.qty || "0") || 0;
          const c = Math.floor((dollars * 100) / priceC);
          qty = c > 0 ? String(c) : "";
        }
      }
      return { ...m, unit, qty, err: "" };
    });
  }

  // qty is always a resolved contract count (dollars-mode entry is converted before this).
  async function confirmTrade(qty: number) {
    if (!(qty > 0)) {
      setModal((m) => ({
        ...m,
        err: modal.unit === "dollars" ? "Enter an amount." : "Enter a quantity.",
      }));
      return;
    }
    const action: Action = modal.position ? modal.action : "buy";
    if (action === "sell" && qty > held) {
      setModal((m) => ({ ...m, err: `You only hold ${held}.` }));
      return;
    }
    setModal((m) => ({ ...m, busy: true, err: "" }));
    try {
      const r = await fetch("/api/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: modal.ticker,
          side: modal.side,
          action,
          count: qty,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "HTTP " + r.status);
      }
      const d = await r.json();
      setAccount(d.account);
      closeModal();
      loadMarkets(category);
    } catch (e) {
      setModal((m) => ({ ...m, err: e instanceof Error ? e.message : "Trade failed." }));
    } finally {
      setModal((m) => ({ ...m, busy: false }));
    }
  }

  async function toggleRealistic(on: boolean) {
    // optimistic
    setAccount((a) => (a ? { ...a, realistic: on } : a));
    try {
      const r = await fetch("/api/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ realistic: on }),
      });
      if (r.ok) setAccount(await r.json());
    } catch {
      setAccount((a) => (a ? { ...a, realistic: !on } : a));
    }
  }

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("paperCollapsed", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  // ---- render helpers ----
  function pill(o: Outcome, side: Side) {
    const ask = side === "yes" ? o.yes_ask_c : o.no_ask_c;
    const px = realistic ? ask : side === "yes" ? o.yes_mid_c : o.no_mid_c;
    if (o.tradeable && px != null && px >= 1 && px <= 99) {
      return (
        <span className="gc-price" onClick={() => openTicket(o.ticker, side)}>
          {px}¢
        </span>
      );
    }
    const last = side === "yes" ? o.last_c : o.last_c != null ? 100 - o.last_c : null;
    return <span className="gc-price closed">{last != null ? last + "¢" : "—"}</span>;
  }
  function heldTag(o: Outcome, side: Side) {
    const n = posqty.get(o.ticker + ":" + side) || 0;
    return n ? <span className="held">×{n}</span> : null;
  }
  function teamRow(o: Outcome, side: Side, label: string, key: string) {
    return (
      <div className="gc-team" key={key}>
        <span className="nm">
          {label}
          {heldTag(o, side)}
        </span>
        {pill(o, side)}
      </div>
    );
  }

  const chips = account
    ? [
        { k: "Cash", v: money(account.cash) },
        { k: "Equity", v: money(account.equity) },
        { k: "Total P&L", v: signed(account.total_pnl), c: cls(account.total_pnl) },
        { k: "Realized", v: signed(account.realized_pnl), c: cls(account.realized_pnl) },
        { k: "Unrealized", v: signed(account.unrealized_pnl), c: cls(account.unrealized_pnl) },
      ]
    : [];

  // trade-ticket summary (the live quote comes from the modal poll, falling back to the board)
  const ticket = ticketQuote ?? (modal.ticker ? boardMap.get(modal.ticker) : undefined);
  const isTrim = modal.position && modal.action === "sell";
  let tPrice: number | null = null;
  if (ticket) {
    // Mirror lib/broker.fillPriceC: mid in perfect-liquidity mode; ask to buy / bid to sell when realistic.
    if (!realistic) tPrice = modal.side === "yes" ? ticket.yes_mid_c : ticket.no_mid_c;
    else if (isTrim) tPrice = modal.side === "yes" ? ticket.yes_bid_c : ticket.no_bid_c;
    else tPrice = modal.side === "yes" ? ticket.yes_ask_c : ticket.no_ask_c;
  }
  // Resolve the field to a contract count: in dollars mode, that's floor(amount / price-per-contract).
  let qtyNum: number;
  if (modal.unit === "dollars") {
    const dollars = parseFloat(modal.qty || "0") || 0;
    qtyNum = tPrice && tPrice > 0 ? Math.floor((dollars * 100) / tPrice) : 0;
  } else {
    qtyNum = Math.max(0, parseInt(modal.qty || "0", 10) || 0);
  }
  if (isTrim) qtyNum = Math.min(qtyNum, held);
  const tFee = tPrice != null && realistic ? takerFeeCents(qtyNum, tPrice) : 0;
  const tCost = tPrice != null ? qtyNum * tPrice + tFee : 0;
  const tProceeds = tPrice != null ? qtyNum * tPrice - tFee : 0;
  const tBasis = heldPos ? Math.round(heldPos.avg_price_c * qtyNum) : 0;
  const tRealized = tProceeds - tBasis;
  const priceLabel = !realistic ? "mid" : isTrim ? "bid" : "ask";
  const ticketLabel = ticket?.team || "Trade";

  return (
    <>
      <div className="topbar">
        <div className="brand">
          <h1>
            <span className="dot" style={{ background: connected ? "var(--green)" : "var(--red)" }} />
            PaperKalshi
          </h1>
          <span className="username">@{username}</span>
        </div>
        <div className="chips">
          {chips.map((c) => (
            <div className="chip" key={c.k}>
              <div className="k">{c.k}</div>
              <div className={"v " + (c.c || "")}>{c.v}</div>
            </div>
          ))}
        </div>
        <div className="spacer" />
        <label className={"switch" + (realistic ? " on" : "")} title="Realistic fills: buys lift the ask, closes hit the bid, and the Kalshi taker fee applies. Off (the default) assumes perfect liquidity: fills at the mid with no spread or fees.">
          <span className="lbl">Realistic fills</span>
          <input type="checkbox" checked={realistic} onChange={(e) => toggleRealistic(e.target.checked)} />
          <span className="track" aria-hidden="true" />
        </label>
        <button className="btn" onClick={toggleCollapsed}>
          {collapsed ? "Show positions" : "Hide positions"}
        </button>
        <Link className="btn" href="/leaderboard">
          Leaderboard
        </Link>
        <button className="btn" onClick={logout}>
          Log out
        </button>
      </div>

      <div className="catbar">
        {categories.map((c) => (
          <button
            key={c.key}
            className={"cat" + (c.key === category ? " active" : "")}
            onClick={() => switchCategory(c.key, c.label)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className={"layout" + (collapsed ? " solo" : "")}>
        <div className="card">
          <div className="hd">
            <h3>{catLabel === "MLB" ? "MLB markets" : catLabel}</h3>
            <div className="hd-right">
              <span className="sub">
                {loadingMarkets && cards.length === 0
                  ? "loading…"
                  : connected
                    ? `${cards.length} markets · live`
                    : "market data unavailable"}
              </span>
              <div className="sortseg" title="Sort markets by volume or date">
                <button
                  className={sortBy === "vol" ? "active" : ""}
                  onClick={() => setSortBy("vol")}
                >
                  Vol
                </button>
                <button
                  className={sortBy === "date" ? "active" : ""}
                  onClick={() => setSortBy("date")}
                >
                  Date
                </button>
              </div>
            </div>
          </div>
          <div className="boardwrap" ref={scrollRef}>
            <div className="board-grid">
              {sortedCards.length === 0 ? (
                <div className="empty">
                  {loadingMarkets
                    ? `Loading ${catLabel}…`
                    : "No open markets in this category right now."}
                </div>
              ) : (
                sortedCards.map((c) => {
                  const sub = gameTime(c.id) || fmtDate(c.close_time) || "—";
                  const shown = c.outcomes.slice(0, 4);
                  let rows: React.ReactNode;
                  let more: React.ReactNode = null;
                  if (c.market_count === 1 && shown.length === 1) {
                    const o = shown[0];
                    const yesLabel = o.team && o.team.toLowerCase() !== "yes" ? o.team : "Yes";
                    rows = [
                      teamRow(o, "yes", yesLabel, c.id + ":yes"),
                      teamRow(o, "no", "No", c.id + ":no"),
                    ];
                  } else {
                    rows = shown.map((o) => teamRow(o, "yes", o.team || "Yes", c.id + ":" + o.ticker));
                    if (c.market_count > shown.length) {
                      more = <div className="gc-more">+{c.market_count - shown.length} more outcomes</div>;
                    }
                  }
                  return (
                    <div className="game-card" key={c.id} data-card-id={c.id}>
                      <div className="gc-head">{catLabel}</div>
                      <div className="gc-title">{c.title}</div>
                      <div className="gc-status">{sub}</div>
                      {rows}
                      {more}
                      <div className="gc-foot">
                        <span>{fmtVol(c.vol)} vol</span>
                        <span>
                          {c.market_count} market{c.market_count > 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {!collapsed && (
          <div className="right">
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="hd">
                <h3>Positions</h3>
                <span className="sub">{account?.positions.length ? `${account.positions.length} open` : ""}</span>
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
                    {account?.positions.length ? (
                      account.positions.map((p) => (
                        <tr
                          key={p.ticker + ":" + p.side}
                          className="pos-row"
                          title="Add to or trim this position"
                          onClick={() => openPosition(p)}
                        >
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
                          No open positions. Click a price to back a team.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="hd">
                <h3>Trade History</h3>
                <span className="sub">recent fills</span>
              </div>
              <div className="blotwrap" style={{ maxHeight: 300 }}>
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
                    {account?.fills.length ? (
                      account.fills.map((f, i) => (
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
          </div>
        )}
      </div>

      <div
        className={"overlay" + (modal.open ? " show" : "")}
        onMouseDown={(e) => {
          // Only treat it as an outside-click if the press STARTED on the backdrop. A
          // text-selection drag that begins inside the modal and releases out here should not close it.
          overlayMouseDown.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && overlayMouseDown.current) closeModal();
        }}
      >
        {modal.open && (
          <div className="modal">
            <h3>{ticketLabel}</h3>
            <div className="mk">
              {!ticket
                ? "Fetching market…"
                : modal.position
                  ? `${ticket.matchup} · ${modal.side === "no" ? "No" : "Yes"} ×${held}`
                  : ticket.matchup +
                    (ticket.close_time ? " · closes " + fmtDate(ticket.close_time) : "")}
            </div>
            {modal.position ? (
              <div className="seg">
                <button
                  className={"add" + (modal.action === "buy" ? " active" : "")}
                  onClick={() => setModal((m) => ({ ...m, action: "buy", err: "" }))}
                >
                  Add
                </button>
                <button
                  className={"trim" + (modal.action === "sell" ? " active" : "")}
                  onClick={() =>
                    setModal((m) => {
                      // Default a fresh Trim to the full holding; keep a valid partial qty if set.
                      const cur = parseInt(m.qty || "0", 10) || 0;
                      const qty = cur > 0 && cur <= held ? m.qty : String(held);
                      return { ...m, action: "sell", qty, err: "" };
                    })
                  }
                >
                  Trim
                </button>
              </div>
            ) : (
              <div className="seg">
                <button
                  className={"yes" + (modal.side === "yes" ? " active" : "")}
                  onClick={() => setModal((m) => ({ ...m, side: "yes" }))}
                >
                  Yes
                </button>
                <button
                  className={"no" + (modal.side === "no" ? " active" : "")}
                  onClick={() => setModal((m) => ({ ...m, side: "no" }))}
                >
                  No
                </button>
              </div>
            )}
            <div className="field">
              <div className="field-hd">
                <label>
                  {modal.unit === "dollars" ? "Amount (dollars)" : "Quantity (contracts)"}
                  {isTrim && held ? ` · holding ${held}` : ""}
                </label>
                <div className="unitseg" title="Enter the size in contracts or in dollars">
                  <button
                    className={modal.unit === "contracts" ? "active" : ""}
                    onClick={() => setUnit("contracts", tPrice)}
                  >
                    Contracts
                  </button>
                  <button
                    className={modal.unit === "dollars" ? "active" : ""}
                    onClick={() => setUnit("dollars", tPrice)}
                  >
                    Dollars
                  </button>
                </div>
              </div>
              <input
                type="number"
                min={modal.unit === "dollars" ? "0" : "1"}
                step={modal.unit === "dollars" ? "0.01" : "1"}
                max={modal.unit === "contracts" && isTrim && held ? held : undefined}
                value={modal.qty}
                onChange={(e) =>
                  setModal((m) => {
                    let v = e.target.value;
                    // In contracts mode a Trim can't exceed the holding; clamp as the user types.
                    if (m.unit === "contracts" && isTrim && held) {
                      const n = parseInt(v || "0", 10);
                      if (n > held) v = String(held);
                    }
                    return { ...m, qty: v };
                  })
                }
              />
            </div>
            {isTrim && (
              <button
                className="sellall"
                disabled={modal.busy || !held || !ticket || tPrice == null}
                onClick={() => confirmTrade(held)}
              >
                Sell all {held} contract{held === 1 ? "" : "s"}
              </button>
            )}
            <div className="summary">
              {!ticket || tPrice == null ? (
                <div className="r">
                  <span>{ticket ? "No price on that side." : "Fetching price…"}</span>
                </div>
              ) : (
                <>
                  <div className="r">
                    <span>Price ({priceLabel})</span>
                    <span>{tPrice}¢</span>
                  </div>
                  <div className="r">
                    <span>Quantity</span>
                    <span>{qtyNum}</span>
                  </div>
                  <div className="r">
                    <span>Est. fee</span>
                    <span>{money(tFee / 100)}</span>
                  </div>
                  {isTrim ? (
                    <>
                      <div className="r">
                        <span>
                          <b>Est. proceeds</b>
                        </span>
                        <span>
                          <b>{money(tProceeds / 100)}</b>
                        </span>
                      </div>
                      <div className="r">
                        <span>Est. realized P&amp;L</span>
                        <span className={cls(tRealized)}>{signed(tRealized / 100)}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="r">
                        <span>
                          <b>Est. cost</b>
                        </span>
                        <span>
                          <b>{money(tCost / 100)}</b>
                        </span>
                      </div>
                      <div className="r muted">
                        <span>Max payout if it wins</span>
                        <span>{money(qtyNum)}</span>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
            <div className="err">{modal.err}</div>
            <div className="actions">
              <button className="btn" onClick={closeModal}>
                Cancel
              </button>
              <button
                className={
                  "confirm btn" +
                  (modal.position
                    ? modal.action === "sell"
                      ? " trim"
                      : " add"
                    : modal.side === "no"
                      ? " no"
                      : "")
                }
                disabled={modal.busy || !ticket || tPrice == null}
                onClick={() => confirmTrade(qtyNum)}
              >
                {modal.position
                  ? (modal.action === "sell" ? "Trim " : "Add ") + qtyNum
                  : "Buy " + (modal.side === "yes" ? "Yes" : "No")}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
