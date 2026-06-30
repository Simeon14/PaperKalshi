"""FastAPI server + ``paperkalshi`` entrypoint.

The paper-trading terminal: live Kalshi markets across categories, traded with a fake
$100k account. Live market data is public (no Kalshi key); trading is simulated locally
and persisted to SQLite, so the account survives restarts. No real orders are ever placed.
"""

from __future__ import annotations

import os
import pathlib
import threading
import time

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from paperkalshi.kalshi import KalshiClient, KalshiEnv
from paperkalshi.kalshi_live import (
    CATEGORIES,
    CATEGORY_BY_KEY,
    LiveMarket,
    cards_from_events,
    fetch_market,
    fetch_series_cards,
    fetch_trending_events,
)
from paperkalshi.paper import PaperBroker, TradeError

_STATIC = pathlib.Path(__file__).parent / "static"
_ROOT = pathlib.Path(__file__).resolve().parents[1]  # the project root
_DB_PATH = os.environ.get("PAPERKALSHI_DB", str(_ROOT / "data" / "paper.db"))

app = FastAPI(title="PaperKalshi — Kalshi Paper Trading", docs_url=None, redoc_url=None)

_client = KalshiClient(KalshiEnv.PROD)        # public market-data reads only
_broker = PaperBroker(_DB_PATH)
_lock = threading.Lock()
_TICKER_TTL = 5.0
_TRENDING_TTL = 90.0
_cat_cache: dict[str, tuple[list, float]] = {}   # category key -> (cards, monotonic ts)
_trending_cache: dict = {"events": [], "ts": 0.0}
_ticker_cache: dict[str, tuple[LiveMarket, float]] = {}


def _trending() -> list[dict]:
    if time.monotonic() - _trending_cache["ts"] <= _TRENDING_TTL and _trending_cache["events"]:
        return _trending_cache["events"]
    events = fetch_trending_events(_client)
    with _lock:
        _trending_cache["events"] = events
        _trending_cache["ts"] = time.monotonic()
    return events


def _cards(key: str) -> list[dict]:
    cfg = CATEGORY_BY_KEY.get(key) or CATEGORIES[0]
    ttl = cfg.get("ttl", 45)
    ent = _cat_cache.get(key)
    if ent and time.monotonic() - ent[1] <= ttl:
        return ent[0]
    if cfg.get("source") == "trending":
        cards = cards_from_events(_trending(), cfg["category"])
    else:
        cards = fetch_series_cards(_client, key)
    with _lock:
        _cat_cache[key] = (cards, time.monotonic())
    return cards


def _market(ticker: str, *, force: bool = False) -> LiveMarket:
    if not force:
        with _lock:
            ent = _ticker_cache.get(ticker)
        if ent and time.monotonic() - ent[1] <= _TICKER_TTL:
            return ent[0]
    m = fetch_market(_client, ticker)
    with _lock:
        _ticker_cache[ticker] = (m, time.monotonic())
    return m


def _marks_and_settle() -> dict[str, LiveMarket]:
    """Fresh quotes for held tickers; settle any that have resolved."""
    marks: dict[str, LiveMarket] = {}
    for ticker in _broker.held_tickers():
        m = _market(ticker)
        if m.is_resolved:
            _broker.settle(m)
        else:
            marks[ticker] = m
    return marks


class TradeRequest(BaseModel):
    ticker: str
    side: str = Field(pattern="^(yes|no)$")
    action: str = Field(pattern="^(buy|sell)$")
    count: int = Field(ge=1, le=100_000)


class ModeRequest(BaseModel):
    realistic: bool


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (_STATIC / "trade.html").read_text(encoding="utf-8")


@app.get("/api/categories")
def categories() -> dict:
    return {"categories": [{"key": c["key"], "label": c["label"]} for c in CATEGORIES]}


@app.get("/api/markets")
def markets(category: str = "mlb") -> dict:
    return {"category": category, "cards": _cards(category)}


@app.get("/api/account")
def account() -> dict:
    return _broker.state(_marks_and_settle())


@app.post("/api/trade")
def trade(req: TradeRequest) -> dict:
    market = _market(req.ticker, force=True)  # fill against a fresh price
    if market.is_resolved:
        _broker.settle(market)
        raise HTTPException(status_code=409, detail="market has resolved")
    try:
        fill = _broker.trade(
            ticker=req.ticker, side=req.side, action=req.action, count=req.count, market=market
        )
    except TradeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"fill": fill, "account": _broker.state(_marks_and_settle())}


@app.post("/api/mode")
def set_mode(req: ModeRequest) -> dict:
    """Choose realistic fills (ask/bid + fee) or the default perfect-liquidity mode.
    Returns the refreshed account state."""
    _broker.set_mode(req.realistic)
    return _broker.state(_marks_and_settle())


@app.post("/api/account/reset")
def reset() -> dict:
    _broker.reset()
    return _broker.state({})


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def main() -> None:
    """Launch the terminal and open a browser (``paperkalshi``).

    Env: ``PAPERKALSHI_PORT`` overrides the port; ``PAPERKALSHI_NO_BROWSER=1``
    skips the browser (useful for headless/scripted runs).
    """
    import webbrowser

    import uvicorn

    host = "127.0.0.1"
    port = int(os.environ.get("PAPERKALSHI_PORT", "8137"))
    url = f"http://{host}:{port}"
    if not os.environ.get("PAPERKALSHI_NO_BROWSER"):
        threading.Timer(0.9, lambda: webbrowser.open(url)).start()
    print(f"\n  PaperKalshi paper-trading terminal  ->  {url}\n  (Ctrl-C to stop)\n")
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
