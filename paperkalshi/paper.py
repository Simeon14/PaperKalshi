"""Paper-trading broker: a fake $100k Kalshi account, persisted to SQLite.

Models the part of Kalshi a trader actually touches: cash, per-(market, side) positions,
a fill blotter, realized/unrealized P&L, and settlement to $1/$0 when a market resolves.
Buys are marketable (fill at the ask), sells/closes hit the bid, and the real Kalshi taker
fee applies. All mutations are serialized by a lock and committed, so the account survives
restarts and concurrent requests.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

from paperkalshi.fees import DEFAULT_TAKER, FeeModel
from paperkalshi.kalshi_live import LiveMarket

STARTING_CASH_C = 10_000_000  # $100,000.00
PAYOUT_C = 100  # a winning contract settles at $1.00

_SCHEMA = """
CREATE TABLE IF NOT EXISTS account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cash_c INTEGER NOT NULL,
    starting_c INTEGER NOT NULL,
    realized_pnl_c INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
    ticker TEXT NOT NULL,
    team TEXT NOT NULL,
    side TEXT NOT NULL,                 -- 'yes' | 'no'
    contracts INTEGER NOT NULL,
    cost_c INTEGER NOT NULL,            -- total cash paid to open (incl fees)
    matchup TEXT NOT NULL,
    PRIMARY KEY (ticker, side)
);
CREATE TABLE IF NOT EXISTS fills (
    ts INTEGER, ticker TEXT, matchup TEXT, team TEXT, side TEXT, action TEXT,
    count INTEGER, price_c INTEGER, fee_c INTEGER, realized_c INTEGER, cash_after_c INTEGER
);
"""


def _now_ms() -> int:
    return int(time.time() * 1000)


class TradeError(Exception):
    """A rejected paper order (insufficient funds, no liquidity, nothing to close...)."""


class PaperBroker:
    def __init__(self, db_path: str | Path, fee_model: FeeModel = DEFAULT_TAKER) -> None:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._fee = fee_model
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)
        self._ensure_account()

    # ------------------------------------------------------------------ #
    def _ensure_account(self) -> None:
        with self._lock:
            row = self._conn.execute("SELECT 1 FROM account WHERE id=1").fetchone()
            if row is None:
                self._conn.execute(
                    "INSERT INTO account (id, cash_c, starting_c, realized_pnl_c) VALUES (1,?,?,0)",
                    (STARTING_CASH_C, STARTING_CASH_C),
                )
                self._conn.commit()

    def reset(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM positions")
            self._conn.execute("DELETE FROM fills")
            self._conn.execute(
                "UPDATE account SET cash_c=?, starting_c=?, realized_pnl_c=0 WHERE id=1",
                (STARTING_CASH_C, STARTING_CASH_C),
            )
            self._conn.commit()

    # ------------------------------------------------------------------ #
    def _account(self) -> sqlite3.Row:
        return self._conn.execute("SELECT * FROM account WHERE id=1").fetchone()

    def _position(self, ticker: str, side: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM positions WHERE ticker=? AND side=?", (ticker, side)
        ).fetchone()

    def held_tickers(self) -> list[str]:
        with self._lock:
            return [r["ticker"] for r in self._conn.execute("SELECT DISTINCT ticker FROM positions")]

    # ------------------------------------------------------------------ #
    @staticmethod
    def _fill_price_c(action: str, side: str, m: LiveMarket) -> int | None:
        """Marketable price: buys lift the ask, sells hit the bid."""
        if action == "buy":
            return m.yes_ask_c if side == "yes" else m.no_ask_c
        return m.yes_bid_c if side == "yes" else m.no_bid_c

    def trade(self, *, ticker: str, side: str, action: str, count: int, market: LiveMarket) -> dict:
        side, action = side.lower(), action.lower()
        if side not in ("yes", "no") or action not in ("buy", "sell"):
            raise TradeError("invalid side/action")
        if count <= 0:
            raise TradeError("count must be positive")
        if market.is_resolved:
            raise TradeError("market has resolved")
        price = self._fill_price_c(action, side, market)
        if price is None or not (1 <= price <= 99):
            raise TradeError("no liquidity at the touch for that side")

        with self._lock:
            acct = self._account()
            cash = acct["cash_c"]
            realized_total = acct["realized_pnl_c"]
            fee = self._fee.fee_cents(count, price)
            realized = 0

            if action == "buy":
                cost = count * price + fee
                if cost > cash:
                    raise TradeError(
                        f"insufficient cash: need ${cost/100:,.2f}, have ${cash/100:,.2f}"
                    )
                cash -= cost
                pos = self._position(ticker, side)
                if pos is None:
                    self._conn.execute(
                        "INSERT INTO positions (ticker,team,side,contracts,cost_c,matchup) VALUES (?,?,?,?,?,?)",
                        (ticker, market.team, side, count, cost, market.matchup),
                    )
                else:
                    self._conn.execute(
                        "UPDATE positions SET contracts=?, cost_c=? WHERE ticker=? AND side=?",
                        (pos["contracts"] + count, pos["cost_c"] + cost, ticker, side),
                    )
            else:  # sell / close
                pos = self._position(ticker, side)
                if pos is None or pos["contracts"] < count:
                    held = pos["contracts"] if pos else 0
                    raise TradeError(f"can't sell {count}; you hold {held} {side.upper()}")
                avg = pos["cost_c"] / pos["contracts"]
                proceeds = count * price - fee
                basis = round(avg * count)
                realized = proceeds - basis
                cash += proceeds
                realized_total += realized
                remaining = pos["contracts"] - count
                if remaining == 0:
                    self._conn.execute(
                        "DELETE FROM positions WHERE ticker=? AND side=?", (ticker, side)
                    )
                else:
                    self._conn.execute(
                        "UPDATE positions SET contracts=?, cost_c=? WHERE ticker=? AND side=?",
                        (remaining, pos["cost_c"] - basis, ticker, side),
                    )

            self._conn.execute(
                "UPDATE account SET cash_c=?, realized_pnl_c=? WHERE id=1", (cash, realized_total)
            )
            self._conn.execute(
                "INSERT INTO fills (ts,ticker,matchup,team,side,action,count,price_c,fee_c,realized_c,cash_after_c)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (_now_ms(), ticker, market.matchup, market.team, side, action, count, price, fee,
                 realized, cash),
            )
            self._conn.commit()
            return {"ticker": ticker, "side": side, "action": action, "count": count,
                    "price_c": price, "fee_c": fee, "realized_c": realized}

    def settle(self, market: LiveMarket) -> int:
        """Settle any open positions on a resolved market to $1/$0. Returns count settled."""
        if not market.is_resolved:
            return 0
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM positions WHERE ticker=?", (market.ticker,)
            ).fetchall()
            if not rows:
                return 0
            acct = self._account()
            cash, realized_total = acct["cash_c"], acct["realized_pnl_c"]
            n = 0
            for pos in rows:
                won = pos["side"] == market.result
                payout = pos["contracts"] * PAYOUT_C if won else 0
                pnl = payout - pos["cost_c"]
                cash += payout
                realized_total += pnl
                self._conn.execute(
                    "DELETE FROM positions WHERE ticker=? AND side=?", (market.ticker, pos["side"])
                )
                self._conn.execute(
                    "INSERT INTO fills (ts,ticker,matchup,team,side,action,count,price_c,fee_c,realized_c,cash_after_c)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (_now_ms(), market.ticker, pos["matchup"], pos["team"], pos["side"],
                     "settle", pos["contracts"], PAYOUT_C if won else 0, 0, pnl, cash),
                )
                n += 1
            self._conn.execute(
                "UPDATE account SET cash_c=?, realized_pnl_c=? WHERE id=1", (cash, realized_total)
            )
            self._conn.commit()
            return n

    # ------------------------------------------------------------------ #
    def state(self, marks: dict[str, LiveMarket]) -> dict:
        """Account snapshot, marking open positions to market (mid of the held side)."""
        with self._lock:
            acct = self._account()
            cash = acct["cash_c"]
            positions = []
            positions_value_c = 0
            for pos in self._conn.execute("SELECT * FROM positions ORDER BY ticker, side"):
                m = marks.get(pos["ticker"])
                mark = None
                if m is not None:
                    mark = m.yes_mid_c if pos["side"] == "yes" else m.no_mid_c
                value = (mark * pos["contracts"]) if mark is not None else pos["cost_c"]
                positions_value_c += value
                avg = pos["cost_c"] / pos["contracts"]
                positions.append({
                    "ticker": pos["ticker"],
                    "matchup": pos["matchup"],
                    "team": pos["team"],
                    "side": pos["side"],
                    "contracts": pos["contracts"],
                    "avg_price_c": round(avg, 1),
                    "mark_c": mark,
                    "cost": round(pos["cost_c"] / 100, 2),
                    "value": round(value / 100, 2),
                    "unrealized": round((value - pos["cost_c"]) / 100, 2),
                })
            equity = cash + positions_value_c
            fills = [dict(r) for r in self._conn.execute(
                "SELECT * FROM fills ORDER BY ts DESC LIMIT 40")]
            return {
                "cash": round(cash / 100, 2),
                "starting": round(acct["starting_c"] / 100, 2),
                "positions_value": round(positions_value_c / 100, 2),
                "equity": round(equity / 100, 2),
                "realized_pnl": round(acct["realized_pnl_c"] / 100, 2),
                "unrealized_pnl": round((positions_value_c - sum(p["cost"] * 100 for p in positions)) / 100, 2),
                "total_pnl": round((equity - acct["starting_c"]) / 100, 2),
                "positions": positions,
                "fills": [
                    {
                        "ts": f["ts"], "matchup": f["matchup"], "team": f["team"],
                        "side": f["side"], "action": f["action"], "count": f["count"],
                        "price_c": f["price_c"], "fee": round(f["fee_c"] / 100, 2),
                        "realized": round(f["realized_c"] / 100, 2),
                    }
                    for f in fills
                ],
            }
