# PaperKalshi

**Paper-trade live [Kalshi](https://kalshi.com) prediction markets with a fake $100,000 account.**

PaperKalshi is a multi-user web app for practicing on **real Kalshi markets** without risking
real money. Sign up with a username and password, get a fresh $100,000 account, and buy YES/NO
contracts against Kalshi's live, public prices. It can charge the real Kalshi taker fee, tracks
your positions, P&L, and settlements, and ranks everyone on a public leaderboard.

**Live:** <https://paperkalshi.vercel.app>

> [!IMPORTANT]
> PaperKalshi is an independent project and is **not affiliated with, endorsed by, or connected
> to Kalshi**. It only reads Kalshi's public market data. **No real orders are ever placed and no
> real money is involved** — every trade is simulated. This is for educational and entertainment
> purposes only and is not financial advice.

## Features

- **Live markets, real prices** — event cards across World Cup, MLB, Elections, Politics,
  Finance, Tech & Science, and Mentions, each showing Kalshi's live top-of-book.
- **World Cup by match** — matches are grouped into a single card showing the match odds; click a
  card to open a full "match page" popup with every market for that game (moneyline, spread,
  totals, corners, correct score, and more), grouped by type.
- **Binary and multi-outcome events** — single-market props render both Yes and No; multi-outcome
  fields list their tradeable outcomes highest-odds first, with a roll-up for the rest.
- **Two fill models** — by default the simulator assumes perfect liquidity: buys and sells fill
  at the mid with no spread and no fees. Flip on **Realistic fills** to model real execution: buys
  lift the ask, closes hit the bid, and the real Kalshi taker fee (`ceil(0.07 · C · P · (1 − P))`)
  applies. The choice is persisted per account.
- **Manage positions** — buy from the board, then **Add** to or **Trim** (sell) a position, in
  contracts or in dollars, with a one-click "Sell all".
- **Live account** — cash, equity, realized and unrealized P&L, a positions panel with
  mark-to-market, and a trade history blotter.
- **Automatic settlement** — open positions settle to $1/$0 when a market resolves.
- **Public leaderboard** — ranked by equity; click any player to see their full portfolio, P&L,
  and trade history.

## Stack

- **Next.js 16** (App Router, Turbopack), **React 19**, **TypeScript**
- **Supabase** — Postgres + Auth
- **Vercel** — hosting + a daily leaderboard-refresh cron
- Live market data from Kalshi's public REST API (`api.elections.kalshi.com/trade-api/v2`, no key)

## How it works

- **Market data** is read from Kalshi's public REST API; no account or key is required. Category
  boards are assembled server-side and cached briefly, and fetches are concurrency-capped to stay
  within Kalshi's read rate limits.
- **Trading is server-authoritative.** The browser can only read its own account and the public
  leaderboard — it can never write cash, positions, or fills. Every order goes through a trusted
  Next.js route that re-fetches a fresh Kalshi quote, computes the fill price and fee itself, and
  applies the result atomically in Postgres (`SECURITY DEFINER` functions behind row-level
  security). This keeps the money integrity that a public leaderboard depends on.
- **Auth is username-only.** Usernames map to a synthetic internal email; nothing is ever emailed.
- **Settlement** is lazy: when the server sees a held market has resolved, the position pays
  $1/contract if it won else $0.

## Local development

Requires [Node.js](https://nodejs.org/) 20+ and a [Supabase](https://supabase.com/) project.

```bash
npm install
npm run dev        # http://localhost:3000
```

Create a `.env.local` with your Supabase project's values:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...        # server-only; bypasses RLS. Never expose to the browser.
CRON_SECRET=<any-random-string>          # guards the leaderboard-refresh cron route
```

Apply the schema in `supabase/migrations/` to your Supabase project (it defines the tables, RLS
policies, the `apply_trade` / `settle_market` functions, and the leaderboard table).

Other scripts:

```bash
npm run build      # full production build + type-check
npm test           # vitest: fee + fill-price unit tests
npx tsc --noEmit   # type-check only
```

## Project layout

```
app/
  trade/            the trading terminal (auth-gated)
  leaderboard/      public leaderboard + player breakdown
  login/ signup/    username + password auth
  api/              route handlers: trade, account, markets, quotes, portfolio, auth, cron
  globals.css       all styling (dark theme)
lib/
  kalshi/           Kalshi REST client + board/card builders + market model + MLB nicknames
  supabase/         browser / server / admin clients + session handling
  broker.ts fees.ts fill-price selection and the exact-cent taker fee
  account.ts        account snapshot, mark-to-market, settlement, leaderboard refresh
components/
  TradeTerminal.tsx the main client component (board, tickets, popups, refresh timers)
  LeaderboardTable.tsx  clickable leaderboard rows + portfolio modal
supabase/migrations/  database schema (source of truth)
proxy.ts              route auth gating (Next 16 middleware convention)
```

## License

No open-source license is granted. The source is publicly viewable but **all rights are
reserved** — please ask before reusing it.
