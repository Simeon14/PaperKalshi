"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { takerFeeCents } from "@/lib/fees";
import { hasLiveBook, type Outcome } from "@/lib/kalshi/market";
import type { AccountState, PositionState } from "@/lib/account";
import type { ParlayQuoteResponse } from "@/lib/parlayTypes";
import { computeParlayHolds, PARLAY_HOLD_INFO } from "@/lib/parlayHold";
import { eventStart } from "@/lib/kalshi/eventTime";
import {
  mergeBoards,
  patchOutcomes,
  sortCards,
  type BoardCard,
  type BoardOutcome,
} from "@/lib/boardMerge";

// Refresh cadences (ms) and the per-tick ticker cap (bounds a huge / zoomed-out viewport).
const FAST_MS = 1500; // viewport-scoped price refresh
const MODAL_MS = 500; // open buy-ticket's single market
const STRUCTURE_MS = 30000; // full board: which cards exist (rarely changes; quotes stay live)
const ACCOUNT_MS = 6000; // account / positions
const MAX_VISIBLE_TICKERS = 40;

const money = (v: number) =>
  (v < 0 ? "-$" : "$") +
  Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cls = (v: number) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
const signed = (v: number) => (v >= 0 ? "+" : "") + money(v);
// P&L for the dense position/blotter tables: keep full cents under $10 (rounding a small loss to
// "+$0" would misreport it), round to whole dollars at $10+ (cents would only widen the column).
const signedAdaptive = (v: number) => {
  if (Math.abs(v) < 10) return v === 0 ? "$0.00" : signed(v);
  const r = Math.round(v);
  return (r >= 0 ? "+$" : "-$") + Math.abs(r).toLocaleString();
};
// Dollar size (unsigned): full cents under $10, whole dollars at $10+.
const dollarsAdaptive = (v: number) =>
  Math.abs(v) < 10 ? money(v) : (v < 0 ? "-$" : "$") + Math.abs(Math.round(v)).toLocaleString();
const fmtVol = (v: number) =>
  v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(v);

// The market-type header already conveys the market, so drop the noisy "... Reg Time:" prefix
// from each outcome label inside a match view: "Reg Time: England" -> "England",
// "Goal Diff Reg Time: England wins by more than 1.5 goals" -> "England wins by more than 1.5 goals".
const wcLabel = (s: string) =>
  (s || "")
    .replace(/^.*?Reg(?:ulation)?\s*Time:\s*/i, "")
    .replace(/\s+advances\b.*$/i, "") // "Argentina advances" -> "Argentina"
    .trim();

// Split a match card's outcomes into [marketTypeLabel, outcomes][] preserving the server order
// (primary market first). The primary group (index 0) is the "match odds" shown inline.
function groupOutcomes(outcomes: Outcome[]): [string, Outcome[]][] {
  const map = new Map<string, Outcome[]>();
  for (const o of outcomes) {
    const k = o.group ?? "Markets";
    const arr = map.get(k);
    if (arr) arr.push(o);
    else map.set(k, [o]);
  }
  return [...map.entries()];
}

type Side = "yes" | "no";
type Action = "buy" | "sell";
type Unit = "contracts" | "dollars"; // how the quantity field is entered

// A leg captured into the parlay slip. Display fields are snapshotted at add-time (so a leg row
// renders immediately) and refreshed from the live quote response when it arrives.
interface SelectedLeg {
  ticker: string;
  side: Side;
  team: string;
  matchup: string;
  group?: string;
  mid_c: number | null;
}

const PARLAY_MS = 1500; // combined-quote refresh while the builder has 2+ legs
const PARLAY_TOLERANCE_C = 2; // max_price_c headroom over the shown price (absorbs a small tick)
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
  const [category, setCategory] = useState("worldcup");
  const [catLabel, setCatLabel] = useState("World Cup");
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [connected, setConnected] = useState(true);
  const [loadingMarkets, setLoadingMarkets] = useState(true);
  const [collapsed, setCollapsed] = useState(true);
  const [sizeUnit, setSizeUnit] = useState<"qty" | "size">("qty"); // Qty (contracts) vs Size ($)
  // Cached "realistic fills" for instant display on reload (the DB value is authoritative once the
  // account loads; this only avoids a flash of the default while that fetch is in flight).
  const [realisticPref, setRealisticPref] = useState(false);
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
  const [outcomesId, setOutcomesId] = useState<string | null>(null);

  // Parlay builder state. `legs` is the source of truth for the slip; `parlayQuote` is the live
  // correlation-aware price. The slip survives category switches and toggling parlay mode off.
  const [parlayMode, setParlayMode] = useState(false);
  const [legs, setLegs] = useState<SelectedLeg[]>([]);
  const [parlayQuote, setParlayQuote] = useState<ParlayQuoteResponse | null>(null);
  const [parlayQty, setParlayQty] = useState("10");
  const [parlayUnit, setParlayUnit] = useState<Unit>("contracts");
  const [parlayBusy, setParlayBusy] = useState(false);
  const [parlayErr, setParlayErr] = useState("");
  const [parlayNotice, setParlayNotice] = useState(""); // transient info (pruned/blocked legs)
  const [flashParlayId, setFlashParlayId] = useState<string | null>(null);
  const parlayReq = useRef(0); // drops stale quote responses (mirrors categoryRef's technique)
  // Open-parlay detail modal (opened from the Positions row) + cash-out state.
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState("");
  const [cashingOut, setCashingOut] = useState(false);
  const detailOpenRef = useRef(false);

  const realistic = account?.realistic ?? realisticPref;
  // The position behind an open Add/Trim ticket (source of the held count + avg cost).
  const heldPos =
    modal.position && account
      ? account.positions.find((p) => p.ticker === modal.ticker && p.side === modal.side)
      : undefined;
  const held = heldPos?.contracts ?? 0;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = modal.open;
  detailOpenRef.current = detailId !== null;
  const overlayMouseDown = useRef(false);
  const cardsRef = useRef<BoardCard[]>(cards);
  cardsRef.current = cards;
  const sortByRef = useRef(sortBy);
  sortByRef.current = sortBy;
  // Which category the user is CURRENTLY on, written synchronously on switch so that an
  // in-flight response for a previous tab can be recognized as stale and dropped.
  const categoryRef = useRef(category);
  // Synchronous re-entry lock for confirmTrade: a second click can land before the async
  // `busy` state re-renders the disabled button.
  const submitRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const visibleIds = useRef<Set<string>>(new Set());

  // On-demand outcome lookup (only needed while a ticket is open, as the fallback before its
  // own quote poll answers); a memoized map here would rebuild on every price tick instead.
  function findOutcome(ticker: string): BoardOutcome | undefined {
    for (const c of cards) {
      const o = c.outcomes.find((x) => x.ticker === ticker);
      if (o) return o;
    }
    return undefined;
  }

  // The card whose full-outcomes menu is open (looked up live so its prices keep refreshing).
  const outcomesCard = outcomesId ? cards.find((c) => c.id === outcomesId) ?? null : null;
  // Match popup: one column per market, capped at 3, so its width tracks the number of markets
  // (a 1-market card is skinny; a full match with ~15 markets fills 3 columns).
  const matchSections = outcomesCard?.grouped ? groupOutcomes(outcomesCard.outcomes) : null;
  const matchCols = matchSections ? Math.min(Math.max(matchSections.length, 1), 3) : 1;
  const matchWidth = matchCols * 320 + (matchCols - 1) * 24 + 36; // col*320 + gaps + modal padding

  const posqty = useMemo(() => {
    const m = new Map<string, number>();
    account?.positions.forEach((p) => m.set(p.ticker + ":" + p.side, p.contracts));
    return m;
  }, [account]);

  // Per-card start time + label (memoized so the rendered date matches the sort key).
  const timing = useMemo(() => {
    const m = new Map<string, { ts: number; label: string }>();
    cards.forEach((c) => m.set(c.id, eventStart(c.id, c.close_time, c.start_time)));
    return m;
  }, [cards]);

  // The board's membership/order fingerprint: effects that only care about which cards exist
  // (not their prices) key on this so the 1.5s quote ticks don't churn them.
  const cardIdsKey = useMemo(() => cards.map((c) => c.id).join("|"), [cards]);

  const loadCategories = useCallback(async () => {
    try {
      const d = await (await fetch("/api/categories")).json();
      setCategories(d.categories || []);
    } catch {
      /* ignore */
    }
  }, []);

  // `replace` = re-sort from scratch (first load, category switch, sort toggle). Otherwise the
  // periodic refetch MERGES (see lib/boardMerge.ts): surviving cards keep their on-screen
  // position but adopt the fresh data, closed cards drop out, and genuinely-new markets are
  // appended at the bottom. Responses for a category the user has since left are dropped.
  const loadMarkets = useCallback(async (cat: string, replace = false) => {
    if (replace) setLoadingMarkets(true);
    try {
      const d = await (await fetch("/api/markets?category=" + encodeURIComponent(cat))).json();
      if (cat !== categoryRef.current) return; // stale response from a previous tab
      const apiCards: BoardCard[] = d.cards || [];
      // The server reports the board's age; anything we live-patched after it was assembled
      // is fresher than what it says (clock-skew-free because only durations cross the wire).
      const bornAt = Date.now() - (typeof d.ageMs === "number" ? d.ageMs : 0);
      setCards((prev) =>
        replace
          ? sortCards(apiCards, sortByRef.current)
          : mergeBoards(prev, apiCards, bornAt, sortByRef.current),
      );
      setConnected(true);
    } catch {
      if (cat === categoryRef.current) setConnected(false);
    } finally {
      if (replace && cat === categoryRef.current) setLoadingMarkets(false);
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

  // Merge fresh quotes into the existing cards. patchOutcomes clones only what actually
  // changed and returns the previous array untouched when nothing did, so a quiet tick
  // costs no render at all.
  const patchPrices = useCallback((quotes: Record<string, Outcome>) => {
    if (!quotes || !Object.keys(quotes).length) return;
    setCards((prev) => patchOutcomes(prev, quotes, Date.now()));
  }, []);

  // initial load
  useEffect(() => {
    loadCategories();
    loadMarkets(category, true);
    loadAccount();
    try {
      const stored = localStorage.getItem("paperCollapsed");
      // Hidden by default; only an explicit "show" choice un-collapses it.
      setCollapsed(stored === null ? true : stored === "1");
      const su = localStorage.getItem("posSizeUnit");
      if (su === "size" || su === "qty") setSizeUnit(su);
      const rf = localStorage.getItem("realisticFills");
      if (rf === "1" || rf === "0") setRealisticPref(rf === "1");
      const sb = localStorage.getItem("sortBy");
      if (sb === "vol" || sb === "date") setSortBy(sb);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the cached "realistic fills" in sync with the authoritative DB value, so the next reload
  // shows the right toggle state instantly (no flash of the default while the account loads).
  const acctRealistic = account?.realistic;
  useEffect(() => {
    if (acctRealistic === undefined) return;
    setRealisticPref(acctRealistic);
    try {
      localStorage.setItem("realisticFills", acctRealistic ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [acctRealistic]);

  // Full board structure (which cards exist) on a slow cadence; the fast tick keeps prices live.
  useEffect(() => {
    const id = setInterval(() => {
      if (!modalOpenRef.current && !document.hidden) loadMarkets(category);
    }, STRUCTURE_MS);
    return () => clearInterval(id);
  }, [category, loadMarkets]);

  // Re-sort the visible board only when the user flips the Vol/Date toggle (not on refresh).
  useEffect(() => {
    setCards((prev) => (prev.length ? sortCards(prev, sortBy) : prev));
  }, [sortBy]);

  // Account / positions.
  useEffect(() => {
    const id = setInterval(() => {
      if (!modalOpenRef.current && !document.hidden) loadAccount();
    }, ACCOUNT_MS);
    return () => clearInterval(id);
  }, [loadAccount]);

  // A hidden tab stops polling entirely (the interval guards above); snap everything fresh
  // the moment the user comes back.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) return;
      loadMarkets(categoryRef.current);
      loadAccount();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [loadMarkets, loadAccount]);

  // Escape closes the top-most layer: the trade ticket first, else the markets popup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modalOpenRef.current) setModal((m) => ({ ...m, open: false }));
      else if (detailOpenRef.current) setDetailId(null);
      else setOutcomesId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Track which cards are actually in the scroll viewport. Keyed on the board's id
  // fingerprint: price patches leave the observer alone; only membership/order changes
  // (load, merge additions/drops, re-sort) re-observe.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardIdsKey]);

  // Fast, viewport-scoped price refresh: ONE batched Kalshi call for just the visible markets.
  useEffect(() => {
    const id = setInterval(async () => {
      if (modalOpenRef.current || document.hidden) return; // ticket polls itself; hidden tabs idle
      const ids = visibleIds.current;
      const tickers: string[] = [];
      for (const c of cardsRef.current) {
        if (!ids.has(c.id)) continue;
        // A match card only shows its primary market inline, so only refresh that (its other
        // markets refresh via the popup's own poll); otherwise one match card's ~80 outcomes
        // would blow the whole per-tick budget and starve the rest of the board.
        const g = c.grouped && c.outcomes.length ? c.outcomes[0].group : undefined;
        for (const o of c.outcomes) if (!g || o.group === g) tickers.push(o.ticker);
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
      if (document.hidden) return;
      try {
        const r = await fetch("/api/quotes?tickers=" + encodeURIComponent(ticker));
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

  // While a markets popup is open, keep ALL of that card's markets live (the board tick only
  // refreshes each card's primary market).
  useEffect(() => {
    if (!outcomesId) return;
    const card = cardsRef.current.find((c) => c.id === outcomesId);
    const tickers = card?.outcomes.map((o) => o.ticker) ?? [];
    if (!tickers.length) return;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch("/api/quotes?tickers=" + encodeURIComponent(tickers.slice(0, 50).join(",")));
        if (r.ok && !cancelled) patchPrices((await r.json()).quotes || {});
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = setInterval(tick, FAST_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [outcomesId, patchPrices]);

  function switchCategory(key: string, label: string) {
    if (key === category) return;
    categoryRef.current = key; // synchronously: in-flight responses for other tabs are stale now
    setCategory(key);
    setCatLabel(label);
    setCards([]);
    loadMarkets(key, true);
  }

  function openTicket(ticker: string, side: Side, qty = "10") {
    setTicketQuote(null);
    setOutcomesId(null);
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
    if (submitRef.current) return;
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
    submitRef.current = true;
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
      submitRef.current = false;
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
    const next = !collapsed;
    setCollapsed(next);
    if (next) setParlayMode(false); // closing the sidebar also exits the parlay builder
    try {
      localStorage.setItem("paperCollapsed", next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  // Choose the board sort (volume vs date) and remember it for next login.
  function chooseSort(next: "vol" | "date") {
    setSortBy(next);
    try {
      localStorage.setItem("sortBy", next);
    } catch {
      /* ignore */
    }
  }

  // Toggle the Qty/Size columns (contracts vs dollar size) across the position + blotter tables,
  // and remember the choice for next login.
  function toggleSizeUnit() {
    setSizeUnit((u) => {
      const next = u === "qty" ? "size" : "qty";
      try {
        localStorage.setItem("posSizeUnit", next);
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

  // ---- parlay builder ----
  const parlaySelected = useMemo(
    () => new Set(legs.map((l) => l.ticker + ":" + l.side)),
    [legs],
  );
  // TEMPORARY hold (lib/parlayHold.ts): non-empty means the slip can be built but not placed.
  // The trade route enforces the same rule server-side.
  const parlayHoldList = useMemo(() => computeParlayHolds(legs.map((l) => l.ticker)), [legs]);

  // Toggle a leg in/out of the slip. Blocks both sides of one market and caps at 10 legs.
  function toggleLeg(ticker: string, side: Side) {
    const i = legs.findIndex((l) => l.ticker === ticker && l.side === side);
    if (i >= 0) {
      setLegs(legs.filter((_, j) => j !== i));
      setParlayNotice("");
      return;
    }
    if (legs.some((l) => l.ticker === ticker)) {
      setParlayNotice("A parlay can't take both sides of the same market.");
      return;
    }
    if (legs.length >= 10) {
      setParlayNotice("A parlay can have at most 10 legs.");
      return;
    }
    let o: BoardOutcome | undefined;
    let matchup = "";
    for (const c of cards) {
      const hit = c.outcomes.find((x) => x.ticker === ticker);
      if (hit) {
        o = hit;
        // Grouped match cards: the card title is the clean game name ("France vs England");
        // the outcome-level matchup can be a raw market question ("Will the final score be...").
        matchup = c.grouped ? c.title : hit.matchup ?? "";
        break;
      }
    }
    const mid = o ? (side === "yes" ? o.yes_mid_c : o.no_mid_c) : null;
    setParlayNotice("");
    setLegs([
      ...legs,
      { ticker, side, team: o?.team ?? ticker, matchup, group: o?.group, mid_c: mid },
    ]);
  }

  function clearParlay() {
    setLegs([]);
    setParlayQuote(null);
    setParlayErr("");
    setParlayNotice("");
  }

  // Cash out an open parlay at its current marked value (the server recomputes it from fresh
  // quotes; a leg that already resolved settles normally instead).
  async function cashOut(id: string) {
    if (cashingOut) return;
    setCashingOut(true);
    setDetailErr("");
    try {
      const r = await fetch("/api/parlay/cashout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "HTTP " + r.status);
      }
      const d = await r.json();
      setAccount(d.account);
      setDetailId(null);
    } catch (e) {
      setDetailErr(e instanceof Error ? e.message : "Cash out failed.");
    } finally {
      setCashingOut(false);
    }
  }

  function toggleParlayMode() {
    const next = !parlayMode;
    setParlayMode(next); // keep the slip when leaving parlay mode
    // Opening the builder brings the whole sidebar in, so Positions + Trade History load too.
    if (next && collapsed) {
      setCollapsed(false);
      try {
        localStorage.setItem("paperCollapsed", "0");
      } catch {
        /* ignore */
      }
    }
  }

  // Switch the parlay quantity field between contracts and dollars at the live combined price.
  function setParlayUnitConv(unit: Unit) {
    if (unit === parlayUnit) return;
    const priceC = parlayQuote?.price_c ?? null;
    if (priceC && priceC > 0) {
      setParlayQty((cur) => {
        if (unit === "dollars") {
          const c = parseInt(cur || "0", 10) || 0;
          return c > 0 ? (Math.round(c * priceC) / 100).toFixed(2) : "";
        }
        const dollars = parseFloat(cur || "0") || 0;
        const c = Math.floor((dollars * 100) / priceC);
        return c > 0 ? String(c) : "";
      });
    }
    setParlayUnit(unit);
  }

  async function placeParlay() {
    if (parlayBusy || !parlayQuote || parlayHoldList.length > 0) return;
    const priceC = parlayQuote.price_c;
    // Contracts: fixed integer count. Dollars: fixed stake, count is the implied contract number.
    let count: number;
    let costC: number;
    if (parlayUnit === "dollars") {
      costC = Math.round((parseFloat(parlayQty || "0") || 0) * 100);
      count = Math.max(1, Math.round(costC / priceC));
      if (costC < 1) {
        setParlayErr("Enter an amount.");
        return;
      }
    } else {
      count = Math.max(0, parseInt(parlayQty || "0", 10) || 0);
      costC = count * priceC;
      if (count < 1) {
        setParlayErr("Enter a quantity.");
        return;
      }
    }
    setParlayBusy(true);
    setParlayErr("");
    try {
      const r = await fetch("/api/parlay/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legs: legs.map((l) => ({ ticker: l.ticker, side: l.side })),
          unit: parlayUnit,
          count,
          cost_c: costC,
          max_price_c: priceC + PARLAY_TOLERANCE_C,
        }),
      });
      if (r.status === 409) {
        // Reprice: show the fresh price inline; the Place button becomes the one-click accept.
        const e = await r.json().catch(() => ({}));
        if (e.quote) setParlayQuote(e.quote);
        setParlayErr(`Price moved to ${e.quote?.price_c ?? "?"}¢. Place again to accept.`);
        return;
      }
      if (r.status === 400) {
        const e = await r.json().catch(() => ({}));
        if (Array.isArray(e.invalid) && e.invalid.length) {
          const bad = new Set(e.invalid);
          setLegs((prev) => prev.filter((l) => !bad.has(l.ticker)));
          setParlayNotice(`Removed ${e.invalid.length} leg(s) no longer available.`);
          return;
        }
        throw new Error(e.error || "Parlay rejected.");
      }
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "HTTP " + r.status);
      }
      const d = await r.json();
      setAccount(d.account);
      clearParlay();
      if (d.parlay?.id) {
        const newId: string = d.parlay.id;
        setFlashParlayId(newId);
        window.setTimeout(() => setFlashParlayId((id) => (id === newId ? null : id)), 1600);
      }
    } catch (e) {
      setParlayErr(e instanceof Error ? e.message : "Parlay failed.");
    } finally {
      setParlayBusy(false);
    }
  }

  // Live combined quote while the builder has 2+ legs: POST every 1.5s, pause when the tab is
  // hidden, snap on return, and drop stale responses. A single leg shows its own mid (no call).
  useEffect(() => {
    if (!parlayMode || legs.length < 2) {
      setParlayQuote(null);
      return;
    }
    const body = JSON.stringify({ legs: legs.map((l) => ({ ticker: l.ticker, side: l.side })) });
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      const myReq = ++parlayReq.current;
      try {
        const r = await fetch("/api/parlay/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (cancelled || myReq !== parlayReq.current) return; // a newer request superseded this one
        if (r.status === 400) {
          const e = await r.json().catch(() => ({}));
          if (Array.isArray(e.invalid) && e.invalid.length) {
            const bad = new Set(e.invalid);
            setLegs((prev) => prev.filter((l) => !bad.has(l.ticker)));
            setParlayNotice(`Removed ${e.invalid.length} leg(s) no longer available.`);
          } else {
            setParlayErr(e.error || "Couldn't price that parlay.");
          }
          return;
        }
        if (!r.ok) return;
        const q = (await r.json()) as ParlayQuoteResponse;
        if (!cancelled && myReq === parlayReq.current) {
          setParlayQuote(q);
          setParlayErr("");
        }
      } catch {
        /* ignore a dropped tick */
      }
    };
    tick();
    const id = setInterval(tick, PARLAY_MS);
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [parlayMode, legs]);

  // ---- render helpers ----
  function pill(o: Outcome, side: Side) {
    const ask = side === "yes" ? o.yes_ask_c : o.no_ask_c;
    const px = realistic ? ask : side === "yes" ? o.yes_mid_c : o.no_mid_c;
    // Mid prices are fiction on a one-sided book; the board filters dead books at build time,
    // and this guard catches one dying between structure refreshes (quote patches carry the
    // live bid/ask). Realistic mode shows the real ask, which is always honest.
    if (o.tradeable && px != null && px >= 1 && px <= 99 && (realistic || hasLiveBook(o))) {
      const inParlay = parlayMode && parlaySelected.has(o.ticker + ":" + side);
      return (
        <button
          type="button"
          className={"gc-price" + (inParlay ? " inparlay" : "")}
          title={parlayMode ? (inParlay ? "Remove from parlay" : "Add to parlay") : undefined}
          onClick={(e) => {
            e.stopPropagation(); // bet / add-leg, don't also open the match popup on grouped cards
            if (parlayMode) toggleLeg(o.ticker, side);
            else openTicket(o.ticker, side);
          }}
        >
          {px}¢
        </button>
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
  const boardOutcome = modal.ticker ? findOutcome(modal.ticker) : undefined;
  const ticket = ticketQuote ?? boardOutcome;
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

  // Netting preview: a board buy on the side opposite a held position first CLOSES that
  // holding (the server nets, like Kalshi); only the remainder opens new contracts.
  const oppSide: Side = modal.side === "yes" ? "no" : "yes";
  const oppHeld =
    modal.open && !modal.position && modal.ticker
      ? posqty.get(modal.ticker + ":" + oppSide) ?? 0
      : 0;
  const closeCount = Math.min(qtyNum, oppHeld);
  const openCount = qtyNum - closeCount;
  let closePrice: number | null = null;
  if (ticket && closeCount > 0) {
    // The closing leg sells the opposite side: its mid in perfect-liquidity mode, its bid when realistic.
    if (!realistic) closePrice = oppSide === "yes" ? ticket.yes_mid_c : ticket.no_mid_c;
    else closePrice = oppSide === "yes" ? ticket.yes_bid_c : ticket.no_bid_c;
  }
  const closeFee = realistic && closePrice != null ? takerFeeCents(closeCount, closePrice) : 0;
  const closeProceeds = closePrice != null ? closeCount * closePrice - closeFee : 0;
  const openFee = realistic && tPrice != null ? takerFeeCents(openCount, tPrice) : 0;

  const tFee = closeCount > 0 ? closeFee + openFee : tPrice != null && realistic ? takerFeeCents(qtyNum, tPrice) : 0;
  const tCost = tPrice != null ? (closeCount > 0 ? openCount * tPrice + openFee : qtyNum * tPrice + tFee) : 0;
  const tProceeds = tPrice != null ? qtyNum * tPrice - tFee : 0;
  const tBasis = heldPos ? Math.round(heldPos.avg_price_c * qtyNum) : 0;
  const tRealized = tProceeds - tBasis;
  const priceLabel = !realistic ? "mid" : isTrim ? "bid" : "ask";
  const ticketLabel = wcLabel(ticket?.team || "") || "Trade";
  // The event date shown on the ticket comes from the market ticker (close_time lies for
  // games: World Cup ~2 weeks late, MLB start + 3 days), same source as the board cards.
  const ticketWhen = modal.ticker && ticket ? eventStart(modal.ticker, ticket.close_time).label : "";

  // Parlay builder sizing. Contracts mode: integer contracts, cost = count*price, win = count*$1.
  // Dollars mode: the entered amount is the exact stake, win = stake*multiple (fractional cents),
  // and the contract count is the implied number of $1-payout contracts.
  const parlayPriceC = parlayQuote?.price_c ?? null;
  let parlayCount = 0;
  let parlayCostC = 0;
  let parlayWinC = 0;
  if (parlayPriceC != null && parlayPriceC > 0) {
    if (parlayUnit === "dollars") {
      parlayCostC = Math.round((parseFloat(parlayQty || "0") || 0) * 100);
      parlayWinC = Math.round((parlayCostC * 100) / parlayPriceC);
      parlayCount = Math.round(parlayCostC / parlayPriceC);
    } else {
      parlayCount = Math.max(0, parseInt(parlayQty || "0", 10) || 0);
      parlayCostC = parlayCount * parlayPriceC;
      parlayWinC = parlayCount * 100;
    }
  }
  const parlayValid = parlayCostC >= 1 && parlayCount >= 1;
  const parlayIndepC = parlayQuote
    ? Math.min(99, Math.max(1, Math.round(parlayQuote.independent_q * 100)))
    : 0;
  // Return multiple for a price (a 2c parlay pays 50x = 100c payout / 2c paid).
  const fmtMult = (priceC: number) => {
    const m = priceC > 0 ? 100 / priceC : 0;
    return m >= 10 ? String(Math.round(m)) : (Math.round(m * 10) / 10).toString();
  };
  const parlayMultLabel = parlayQuote ? fmtMult(parlayQuote.price_c) : "0";
  // Correlation indicator: shown when the model moved the price a visible cent off the
  // independence product. Positive correlation shortens the odds (payout reduced); negative
  // lengthens them (payout boosted).
  const parlayCorrShown = !!parlayQuote && parlayIndepC !== parlayQuote.price_c;
  const parlayCorrReduced = !!parlayQuote && parlayQuote.price_c > parlayIndepC;
  const parlayCorrPct =
    parlayQuote && parlayQuote.price_c > 0
      ? Math.round(Math.abs(parlayIndepC / parlayQuote.price_c - 1) * 100)
      : 0;
  const openParlays = account?.parlays ?? [];
  // Looked up live so the modal's value/P&L keep updating from the account poll while it's open.
  const detailParlay = detailId ? openParlays.find((p) => p.id === detailId) ?? null : null;
  const positionsOpen = (account?.positions.length ?? 0) + openParlays.length;
  // The sidebar toggle fully controls its visibility. Enabling parlay mode un-collapses it so the
  // builder is visible; collapsing then hides the whole sidebar (builder + positions + history).
  const rightShown = !collapsed;

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
        <div className="catbar-actions">
          <div className="sortseg" title="Sort markets by volume or date">
            <button className={sortBy === "vol" ? "active" : ""} onClick={() => chooseSort("vol")}>
              Vol
            </button>
            <button className={sortBy === "date" ? "active" : ""} onClick={() => chooseSort("date")}>
              Date
            </button>
          </div>
          <button
            className={"btn hd-btn parlay-toggle" + (parlayMode ? " on" : "")}
            onClick={toggleParlayMode}
            title="Build a same-game parlay: in parlay mode, clicking market prices adds them as legs"
          >
            {parlayMode ? "Exit parlay" : "Parlay builder"}
          </button>
          <button
            className={"btn hd-btn icon-btn" + (collapsed ? "" : " on")}
            onClick={toggleCollapsed}
            title={collapsed ? "Show positions & parlays" : "Hide positions & parlays"}
            aria-label={collapsed ? "Show positions" : "Hide positions"}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
              <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
              <line x1="10" y1="3" x2="10" y2="13" />
            </svg>
          </button>
        </div>
      </div>

      <div className={"layout" + (rightShown ? "" : " solo")}>
        <div className="card">
          <div className="boardwrap" ref={scrollRef}>
            <div className="board-grid">
              {cards.length === 0 ? (
                <div className="empty">
                  {loadingMarkets
                    ? `Loading ${catLabel}…`
                    : "No open markets in this category right now."}
                </div>
              ) : (
                cards.map((c) => {
                  const sub = timing.get(c.id)?.label ?? "—";
                  // Match card: show ONLY the primary market (the match odds) inline, like a
                  // normal card; clicking the card body opens the full-markets popup (Kalshi-style).
                  if (c.grouped) {
                    const primary = groupOutcomes(c.outcomes)[0]?.[1] ?? [];
                    return (
                      <div
                        className="game-card match-card"
                        key={c.id}
                        data-card-id={c.id}
                        onClick={() => setOutcomesId(c.id)}
                        title="View all markets for this match"
                      >
                        <div className="gc-head">{catLabel}</div>
                        <div className="gc-title">{c.title}</div>
                        <div className="gc-status">{sub}</div>
                        {primary
                          .slice(0, 4)
                          .map((o) => teamRow(o, "yes", wcLabel(o.team) || "Yes", c.id + ":" + o.ticker))}
                        <div className="gc-foot">
                          <span>{fmtVol(c.vol)} vol</span>
                          <span className="match-cta">
                            {c.market_count} market{c.market_count > 1 ? "s" : ""} ›
                          </span>
                        </div>
                      </div>
                    );
                  }
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
                    const hidden = c.outcomes.length - shown.length;
                    if (hidden > 0) {
                      more = (
                        <button className="gc-more" onClick={() => setOutcomesId(c.id)}>
                          +{hidden} more outcome{hidden > 1 ? "s" : ""}
                        </button>
                      );
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

        {rightShown && (
          <div className="right">
            {parlayMode && (
              <div className="card parlay-builder" style={{ marginBottom: 14 }}>
                <div className="hd">
                  <h3>Parlay builder</h3>
                  <span className="sub">
                    {legs.length ? `${legs.length} leg${legs.length === 1 ? "" : "s"}` : ""}
                  </span>
                </div>
                <div className="pb-body">
                  {parlayNotice && <div className="pb-notice">{parlayNotice}</div>}
                  {legs.length === 0 ? (
                    <div className="pb-empty">Click market prices to add legs.</div>
                  ) : (
                    <>
                      <div className="pb-legs">
                        {legs.map((l) => {
                          const q = parlayQuote?.legs.find(
                            (x) => x.ticker === l.ticker && x.side === l.side,
                          );
                          const mid = q?.mid_c ?? l.mid_c;
                          const grp = q?.group || l.group || "";
                          // Prefer the add-time capture (the grouped card's clean game name);
                          // the server matchup covers legs restored without board context.
                          const matchup = l.matchup || q?.matchup || "";
                          return (
                            <div className="pb-leg" key={l.ticker + ":" + l.side}>
                              <div className="pb-leg-main">
                                <span className="pb-leg-team">{wcLabel(q?.team || l.team) || "Leg"}</span>
                                <span className={"badge " + l.side}>{l.side.toUpperCase()}</span>
                                <div className="pb-leg-right">
                                  <span className="pb-leg-mid">{mid != null ? mid + "¢" : "—"}</span>
                                  <button
                                    className="pb-leg-x"
                                    title="Remove leg"
                                    onClick={() => toggleLeg(l.ticker, l.side)}
                                  >
                                    ×
                                  </button>
                                </div>
                              </div>
                              {(grp || matchup) && (
                                <div className="pb-leg-sub">
                                  {grp}
                                  {grp && matchup ? " · " : ""}
                                  {matchup}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="pb-tools">
                        {parlayHoldList.length > 0 ? (
                          <div className="pb-tool-notes">
                            {parlayHoldList.map((h) => (
                              <span className="pb-corr blocked" tabIndex={0} key={h}>
                                <span className="pb-corr-i">i</span> {PARLAY_HOLD_INFO[h].label}
                                <span className="pb-corr-tip" role="tooltip">
                                  <div className="note">{PARLAY_HOLD_INFO[h].tip}</div>
                                </span>
                              </span>
                            ))}
                          </div>
                        ) : parlayCorrShown && parlayQuote ? (
                          <span className="pb-corr" tabIndex={0}>
                            <span className="pb-corr-i">i</span> Correlated legs
                            <span className="pb-corr-tip" role="tooltip">
                              <div className="note">
                                {parlayCorrReduced
                                  ? "Some of these legs tend to hit together, so the combined odds are shorter than the legs multiplied out."
                                  : "Some of these legs rarely hit together, so the combined odds are longer than the legs multiplied out."}
                              </div>
                              <div className="r">
                                <span>If independent</span>
                                <span>
                                  {parlayIndepC}¢ · {fmtMult(parlayIndepC)}x
                                </span>
                              </div>
                              <div className="r">
                                <span>With correlation</span>
                                <span>
                                  {parlayQuote.price_c}¢ · {parlayMultLabel}x
                                </span>
                              </div>
                              <div className="r">
                                <span>Payout {parlayCorrReduced ? "reduced" : "boosted"}</span>
                                <span>{parlayCorrPct}%</span>
                              </div>
                            </span>
                          </span>
                        ) : (
                          <span />
                        )}
                        <button className="pb-clear" onClick={clearParlay}>
                          Clear all
                        </button>
                      </div>

                      {legs.length === 1 && (
                        <div className="pb-single">Add at least one more leg to build a parlay.</div>
                      )}

                      {legs.length >= 2 &&
                        (!parlayQuote ? (
                          <div className="pb-hero muted">Pricing…</div>
                        ) : (
                          <>
                            <div className="pb-hero">
                              <span className="pb-price">{parlayMultLabel}x</span>
                              <span className="pb-price-lbl">return</span>
                            </div>
                            {parlayQuote.warnings.map((w, i) => (
                              <div className="pb-warn" key={i}>
                                {w}
                              </div>
                            ))}
                            <div className="field">
                              <div className="field-hd">
                                <label>
                                  {parlayUnit === "dollars" ? "Amount (dollars)" : "Quantity (contracts)"}
                                </label>
                                <div className="unitseg" title="Enter the size in contracts or in dollars">
                                  <button
                                    className={parlayUnit === "contracts" ? "active" : ""}
                                    onClick={() => setParlayUnitConv("contracts")}
                                  >
                                    Contracts
                                  </button>
                                  <button
                                    className={parlayUnit === "dollars" ? "active" : ""}
                                    onClick={() => setParlayUnitConv("dollars")}
                                  >
                                    Dollars
                                  </button>
                                </div>
                              </div>
                              <input
                                type="number"
                                min={parlayUnit === "dollars" ? "0" : "1"}
                                step={parlayUnit === "dollars" ? "0.01" : "1"}
                                value={parlayQty}
                                onChange={(e) => setParlayQty(e.target.value)}
                              />
                            </div>
                            <div className="summary">
                              <div className="r">
                                <span>Combined price</span>
                                <span>{parlayQuote.price_c}¢</span>
                              </div>
                              {parlayUnit === "contracts" && (
                                <div className="r">
                                  <span>Contracts</span>
                                  <span>{parlayCount}</span>
                                </div>
                              )}
                            </div>
                            <div className="pb-payline">
                              Pay <b>{money(parlayCostC / 100)}</b> to win <b>{money(parlayWinC / 100)}</b>
                            </div>
                            {parlayErr && <div className="err pb-err">{parlayErr}</div>}
                            <button
                              className="confirm btn pb-place"
                              disabled={parlayBusy || !parlayValid || parlayHoldList.length > 0}
                              onClick={placeParlay}
                            >
                              {parlayBusy ? "Placing…" : "Place parlay"}
                            </button>
                          </>
                        ))}
                    </>
                  )}
                </div>
              </div>
            )}

            {!collapsed && (
              <>
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="hd">
                <h3>Positions</h3>
                <span className="sub">{positionsOpen ? `${positionsOpen} open` : ""}</span>
              </div>
              <div className="poswrap">
                <table>
                  <thead>
                    <tr>
                      <th className="l">Market</th>
                      <th className="th-toggle" onClick={toggleSizeUnit} title="Toggle contracts / dollar size">
                        {sizeUnit === "size" ? "Size" : "Qty"}
                      </th>
                      <th>Avg</th>
                      <th>Mark</th>
                      <th>uP&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openParlays.map((p) => {
                      const avgC = p.count ? Math.round((p.cost * 100 / p.count) * 10) / 10 : 0;
                      const markC = p.count ? Math.round((p.value * 100) / p.count) : 0;
                      return (
                        <tr
                          key={"parlay:" + p.id}
                          className={"pos-row parlay-pos" + (flashParlayId === p.id ? " flash" : "")}
                          title="View legs and cash out"
                          onClick={() => {
                            setDetailErr("");
                            setDetailId(p.id);
                          }}
                        >
                          <td className="l">
                            <div className="mkt">
                              <span className="team">{p.legs.length}-leg parlay</span>{" "}
                              <span className="badge parlay">PARLAY</span>
                              <div className="sub2">
                                {p.price_c}¢ → 100¢ · win {money(p.potential_payout)}
                              </div>
                            </div>
                          </td>
                          <td>{sizeUnit === "size" ? dollarsAdaptive(p.value) : p.count}</td>
                          <td>{avgC}¢</td>
                          <td>{markC}¢</td>
                          <td className={cls(p.unrealized)}>{signedAdaptive(p.unrealized)}</td>
                        </tr>
                      );
                    })}
                    {account?.positions.map((p) => (
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
                        <td>{sizeUnit === "size" ? dollarsAdaptive(p.value) : p.contracts}</td>
                        <td>{p.avg_price_c}¢</td>
                        <td>{p.mark_c == null ? "–" : p.mark_c + "¢"}</td>
                        <td className={cls(p.unrealized)}>{signedAdaptive(p.unrealized)}</td>
                      </tr>
                    ))}
                    {!positionsOpen && (
                      <tr>
                        <td colSpan={5} className="empty">
                          No open positions or parlays. Click a price to back a team.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card hist-card">
              <div className="hd">
                <h3>Trade History</h3>
                <span className="sub">recent fills</span>
              </div>
              <div className="blotwrap">
                <table>
                  <thead>
                    <tr>
                      <th className="l">Action</th>
                      <th className="l">Market</th>
                      <th className="th-toggle" onClick={toggleSizeUnit} title="Toggle contracts / dollar size">
                        {sizeUnit === "size" ? "Size" : "Qty"}
                      </th>
                      <th>Odds</th>
                      <th>P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {account?.fills.length ? (
                      account.fills.map((f, i) => (
                        <tr key={i}>
                          <td className="l">
                            {f.action === "settle" ? (
                              <span className="badge settle">settled</span>
                            ) : f.action === "cashout" ? (
                              <span className="badge settle">cashed</span>
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
                          <td>{sizeUnit === "size" ? dollarsAdaptive((f.count * f.price_c) / 100) : f.count}</td>
                          <td>{f.price_c}%</td>
                          <td className={cls(f.realized)}>
                            {f.action === "buy" ? "–" : signedAdaptive(f.realized)}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5} className="empty">
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

      <div
        className={"overlay" + (outcomesCard ? " show" : "")}
        onMouseDown={(e) => {
          overlayMouseDown.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && overlayMouseDown.current) setOutcomesId(null);
        }}
      >
        {outcomesCard &&
          (outcomesCard.grouped ? (
            <div className="modal match-modal" style={{ width: `min(${matchWidth}px, 94vw)` }}>
              <div className="pf-head">
                <div>
                  <h3>{outcomesCard.title}</h3>
                  <div className="mk">
                    {outcomesCard.market_count} market{outcomesCard.market_count > 1 ? "s" : ""}
                    {" · " + (timing.get(outcomesCard.id)?.label ?? "—")}
                  </div>
                </div>
                <button className="btn" onClick={() => setOutcomesId(null)}>
                  Close
                </button>
              </div>
              <div className="match-sections">
                {(matchSections ?? []).map(([label, outs]) => (
                  <div className="mkt-group" key={label}>
                    <div className="mkt-group-hd">{label}</div>
                    {outs.map((o) => teamRow(o, "yes", wcLabel(o.team) || "Yes", "menu:" + o.ticker))}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="modal outcomes-modal">
              <h3>{outcomesCard.title}</h3>
              <div className="mk">
                {outcomesCard.market_count} outcomes
                {" · " + (timing.get(outcomesCard.id)?.label ?? "—")}
              </div>
              <div className="outcomes-list">
                {outcomesCard.outcomes.map((o) =>
                  teamRow(o, "yes", o.team || "Yes", "menu:" + o.ticker),
                )}
              </div>
              <div className="actions">
                <button className="btn" onClick={() => setOutcomesId(null)}>
                  Close
                </button>
              </div>
            </div>
          ))}
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
                  : (boardOutcome?.group ? boardOutcome.group + " · " : "") +
                    ticket.matchup +
                    (ticketWhen ? " · " + ticketWhen : "")}
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
            {oppHeld > 0 && (
              <div className="netnote">
                You hold {oppHeld} {oppSide === "yes" ? "Yes" : "No"}. Buying{" "}
                {modal.side === "yes" ? "Yes" : "No"} closes that first.
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
                  ) : closeCount > 0 ? (
                    <>
                      <div className="r">
                        <span>
                          Closes {oppSide === "yes" ? "Yes" : "No"} ×{closeCount}
                        </span>
                        <span>{closePrice != null ? closePrice + "¢" : "—"}</span>
                      </div>
                      {openCount > 0 && (
                        <div className="r">
                          <span>
                            Opens {modal.side === "yes" ? "Yes" : "No"} ×{openCount}
                          </span>
                          <span>{tPrice}¢</span>
                        </div>
                      )}
                      <div className="r">
                        <span>
                          <b>{closeProceeds >= tCost ? "Est. net credit" : "Est. net cost"}</b>
                        </span>
                        <span>
                          <b>{money(Math.abs(tCost - closeProceeds) / 100)}</b>
                        </span>
                      </div>
                      {openCount > 0 && (
                        <div className="r muted">
                          <span>Max payout if it wins</span>
                          <span>{money(openCount)}</span>
                        </div>
                      )}
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
                disabled={modal.busy || !ticket || tPrice == null || (closeCount > 0 && closePrice == null)}
                onClick={() => confirmTrade(qtyNum)}
              >
                {modal.position
                  ? (modal.action === "sell" ? "Trim " : "Add ") + qtyNum
                  : closeCount > 0 && openCount === 0
                    ? `Close ${closeCount} ${oppSide === "yes" ? "Yes" : "No"}`
                    : "Buy " + (modal.side === "yes" ? "Yes" : "No")}
              </button>
            </div>
          </div>
        )}
      </div>

      <div
        className={"overlay" + (detailParlay ? " show" : "")}
        onMouseDown={(e) => {
          overlayMouseDown.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && overlayMouseDown.current) setDetailId(null);
        }}
      >
        {detailParlay && (
          <div className="modal parlay-detail">
            <div className="pf-head">
              <div>
                <h3>{detailParlay.legs.length}-leg parlay</h3>
                <div className="mk">
                  {detailParlay.price_c}¢ → 100¢ · pay {money(detailParlay.cost)} · win{" "}
                  {money(detailParlay.potential_payout)}
                </div>
              </div>
              <button className="btn" onClick={() => setDetailId(null)}>
                Close
              </button>
            </div>
            <div className="pd-value">
              <div>
                <div className="pd-k">Current value</div>
                <div className="pd-val">{money(detailParlay.value)}</div>
              </div>
              <div className="pd-pnl-wrap">
                <div className="pd-k">P&amp;L</div>
                <div className={"pd-val " + cls(detailParlay.unrealized)}>
                  {signed(detailParlay.unrealized)}
                </div>
              </div>
            </div>
            <div className="pd-legs">
              {detailParlay.legs.map((l, i) => (
                <div className="pr-leg" key={i}>
                  <span className={"pr-dot " + l.status} title={l.status} />
                  <span className="pr-leg-team">{wcLabel(l.team) || "Leg"}</span>
                  <span className={"badge " + l.side}>{l.side.toUpperCase()}</span>
                  <span className="pr-leg-grp">{l.group}</span>
                </div>
              ))}
            </div>
            {detailErr && <div className="err pb-err">{detailErr}</div>}
            <div className="actions">
              <button className="btn" onClick={() => setDetailId(null)}>
                Close
              </button>
              <button
                className="confirm btn"
                disabled={cashingOut}
                onClick={() => cashOut(detailParlay.id)}
              >
                {cashingOut ? "Cashing out…" : `Cash out for ${money(detailParlay.value)}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
