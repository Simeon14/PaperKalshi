"""Offline tests for the paper-trading broker (no network).

We construct ``LiveMarket`` snapshots by hand so buy/sell/settle/mark-to-market and the
guard rails (insufficient funds, can't oversell, no liquidity) are deterministic.
"""

from __future__ import annotations

import pytest

from paperkalshi.kalshi_live import LiveMarket
from paperkalshi.paper import STARTING_CASH_C, PaperBroker, TradeError


def _mkt(ticker="KXMLBGAME-T-WSH", *, yb=84, ya=86, nb=14, na=16, last=85, result=""):
    return LiveMarket(
        ticker=ticker, event_ticker="KXMLBGAME-T", matchup="Washington vs Baltimore",
        team="Washington", yes_bid_c=yb, yes_ask_c=ya, no_bid_c=nb, no_ask_c=na,
        last_c=last, volume=1000, status="active", result=result, close_time="2026-06-30T23:05:00Z",
    )


@pytest.fixture()
def broker(tmp_path):
    return PaperBroker(tmp_path / "paper.db")


def test_starts_with_100k(broker):
    s = broker.state({})
    assert s["cash"] == 100_000.0 and s["equity"] == 100_000.0 and s["total_pnl"] == 0.0


def test_buy_then_mark_and_close(broker):
    m = _mkt()
    fill = broker.trade(ticker=m.ticker, side="yes", action="buy", count=10, market=m)
    assert fill["price_c"] == 86 and fill["fee_c"] > 0
    s = broker.state({m.ticker: m})
    assert s["cash"] == round((STARTING_CASH_C - (10 * 86 + fill["fee_c"])) / 100, 2)
    assert len(s["positions"]) == 1
    p = s["positions"][0]
    assert p["side"] == "yes" and p["contracts"] == 10 and p["mark_c"] == 85  # mid of 84/86
    # mark (85) below entry (86 + fee) -> small unrealized loss
    assert p["unrealized"] < 0

    close = broker.trade(ticker=m.ticker, side="yes", action="sell", count=10, market=m)
    assert close["price_c"] == 84  # sells hit the bid
    assert broker.state({})["positions"] == []


def test_settle_win_and_loss(broker):
    win = _mkt("KXMLBGAME-T-WSH")
    broker.trade(ticker=win.ticker, side="yes", action="buy", count=10, market=win)
    n = broker.settle(LiveMarket(**{**win.__dict__, "result": "yes"}))
    assert n == 1
    s = broker.state({})
    assert s["positions"] == [] and s["realized_pnl"] > 0  # YES won -> +$1.00/contract

    loss = _mkt("KXMLBGAME-T-BAL")
    broker.trade(ticker=loss.ticker, side="yes", action="buy", count=10, market=loss)
    broker.settle(LiveMarket(**{**loss.__dict__, "result": "no"}))
    assert broker.state({})["realized_pnl"] < s["realized_pnl"]  # YES lost -> negative


def test_guard_rails(broker):
    m = _mkt(na=None, ya=99)
    # can't sell something you don't hold
    with pytest.raises(TradeError):
        broker.trade(ticker=m.ticker, side="yes", action="sell", count=1, market=m)
    # buying NO with no ask -> no liquidity
    with pytest.raises(TradeError):
        broker.trade(ticker=m.ticker, side="no", action="buy", count=1, market=m)
    # insufficient funds: 100k account can't buy 2,000,000 contracts at 99c
    with pytest.raises(TradeError):
        broker.trade(ticker=m.ticker, side="yes", action="buy", count=2_000_000, market=m)


def test_reset(broker):
    m = _mkt()
    broker.trade(ticker=m.ticker, side="yes", action="buy", count=50, market=m)
    broker.reset()
    s = broker.state({})
    assert s["cash"] == 100_000.0 and s["positions"] == [] and s["fills"] == []
