"""Live Kalshi market data for the paper-trading terminal.

Reads are public (no key). Kalshi returns top-of-book under ``*_dollars`` fields on the
market object, so one ``/markets`` call per series gives tradeable prices; we hit a
single market again at execution time to fill against a fresh price.

The board is organized into **categories** (tabs). MLB is one series; the others are
Kalshi categories whose series we discover via ``/series?category=X`` and fetch in
parallel. Markets are grouped into **event cards** (an event's title + its outcomes),
which generalizes the MLB game card (two teams) to multi-outcome events (e.g. a nominee
race with many candidates).
"""

from __future__ import annotations

import concurrent.futures
from dataclasses import asdict, dataclass

from paperkalshi.kalshi import KalshiClient

# Category tabs, in display order. "series" categories pin explicit series; the rest are
# resolved from Kalshi's `category` field (with optional ticker-prefix / tag filters).
# source = how a tab's markets are sourced:
#   "series"   - explicit/scanned series fetched directly (MLB, World Cup, Mentions)
#   "trending" - bucketed out of Kalshi's trending /events feed by `category`
#                (the feed surfaces the *active* events; cold series scans mostly hit
#                 dead series, so big categories must come from here)
CATEGORIES: list[dict] = [
    {"key": "mlb", "label": "MLB", "source": "series", "series": ["KXMLBGAME"], "ttl": 8},
    {"key": "worldcup", "label": "World Cup", "source": "series", "category": "Sports",
     "series_prefix": "KXWC", "exclude_tags": ["Esports"], "series_scan": 400, "max_series": 18, "ttl": 90},
    {"key": "elections", "label": "Elections", "source": "trending", "category": "Elections", "ttl": 60},
    {"key": "politics", "label": "Politics", "source": "trending", "category": "Politics", "ttl": 60},
    {"key": "finance", "label": "Finance", "source": "trending", "category": "Financials", "ttl": 60},
    {"key": "tech", "label": "Tech & Science", "source": "trending", "category": "Science and Technology", "ttl": 60},
    # Mentions is sparse; KXMLBMENTION is the reliably-active series, plus a small scan.
    {"key": "mentions", "label": "Mentions", "source": "series", "series": ["KXMLBMENTION"],
     "category": "Mentions", "series_scan": 80, "max_series": 12, "ttl": 90},
]
CATEGORY_BY_KEY = {c["key"]: c for c in CATEGORIES}


def _cents(dollars: str | float | None) -> int | None:
    """'0.86' -> 86 cents; None/'' -> None."""
    if dollars in (None, ""):
        return None
    return round(float(dollars) * 100)


def _mid(bid: int | None, ask: int | None, last: int | None) -> int | None:
    if bid is not None and ask is not None:
        return round((bid + ask) / 2)
    return bid if bid is not None else (ask if ask is not None else last)


@dataclass(frozen=True)
class LiveMarket:
    ticker: str
    event_ticker: str
    matchup: str          # e.g. "Washington vs Baltimore"
    team: str             # the side a YES contract backs (yes_sub_title)
    yes_bid_c: int | None
    yes_ask_c: int | None
    no_bid_c: int | None
    no_ask_c: int | None
    last_c: int | None
    volume: int
    status: str
    result: str           # '' while active; 'yes'/'no' once settled
    close_time: str

    @property
    def yes_mid_c(self) -> int | None:
        return _mid(self.yes_bid_c, self.yes_ask_c, self.last_c)

    @property
    def no_mid_c(self) -> int | None:
        last_no = (100 - self.last_c) if self.last_c is not None else None
        return _mid(self.no_bid_c, self.no_ask_c, last_no)

    @property
    def is_resolved(self) -> bool:
        return self.result in ("yes", "no")

    @property
    def is_tradeable(self) -> bool:
        return self.status == "active" and not self.is_resolved and self.yes_ask_c is not None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["yes_mid_c"] = self.yes_mid_c
        d["no_mid_c"] = self.no_mid_c
        d["tradeable"] = self.is_tradeable
        return d


def _to_live(m: dict) -> LiveMarket:
    title = (m.get("title") or "").replace(" Winner?", "").strip()
    return LiveMarket(
        ticker=m["ticker"],
        event_ticker=m.get("event_ticker", ""),
        matchup=title,
        team=m.get("yes_sub_title") or "",
        yes_bid_c=_cents(m.get("yes_bid_dollars")),
        yes_ask_c=_cents(m.get("yes_ask_dollars")),
        no_bid_c=_cents(m.get("no_bid_dollars")),
        no_ask_c=_cents(m.get("no_ask_dollars")),
        last_c=_cents(m.get("last_price_dollars")),
        volume=int(float(m.get("volume_fp") or 0)),
        status=m.get("status") or "",
        result=m.get("result") or "",
        close_time=m.get("close_time") or "",
    )


def fetch_market(client: KalshiClient, ticker: str) -> LiveMarket:
    """A single market with a fresh quote (used at order execution / settlement check)."""
    return _to_live(client.get_market(ticker))


# --------------------------------------------------------------------------- #
# Category board (event cards)
# --------------------------------------------------------------------------- #
def _series_for(client: KalshiClient, cfg: dict) -> list[str]:
    """Resolve a category's series: explicit ``series`` first, then a scan of
    ``/series?category=`` (with optional ticker-prefix / tag filters), deduped."""
    out: list[str] = list(cfg.get("series", []))
    if cfg.get("category"):
        prefix = cfg.get("series_prefix")
        exclude = set(cfg.get("exclude_tags", []))
        try:
            payload = client.list_series(category=cfg["category"], limit=cfg.get("series_scan", 200))
        except Exception:  # noqa: BLE001
            payload = {}
        for s in payload.get("series", []):
            ticker = s.get("ticker", "")
            if prefix and not ticker.startswith(prefix):
                continue
            if exclude and exclude.intersection(set(s.get("tags") or [])):
                continue
            out.append(ticker)
    seen: set[str] = set()
    uniq = [t for t in out if not (t in seen or seen.add(t))]
    return uniq[: cfg.get("max_series", 30)]


def _markets_for_series(client: KalshiClient, series_ticker: str) -> list[LiveMarket]:
    try:
        payload = client.get_markets(series_ticker=series_ticker, status="open", limit=200)
        return [_to_live(m) for m in payload.get("markets", [])]
    except Exception:  # noqa: BLE001 - one bad series shouldn't sink the board
        return []


def _cards_from_markets(markets: list[LiveMarket], *, max_cards: int = 36, max_outcomes: int = 6) -> list[dict]:
    """Group markets into event cards: title + outcomes (priced sides), sorted by volume."""
    by_event: dict[str, list[LiveMarket]] = {}
    for m in markets:
        by_event.setdefault(m.event_ticker, []).append(m)
    cards: list[dict] = []
    for ev, mk in by_event.items():
        ordered = sorted(
            mk, key=lambda x: (x.yes_ask_c if x.yes_ask_c is not None else (x.last_c or -1)), reverse=True
        )
        cards.append({
            "id": ev,
            "title": mk[0].matchup,
            "vol": max((m.volume for m in mk), default=0),
            "market_count": len(mk),
            "close_time": min((m.close_time for m in mk if m.close_time), default=""),
            "outcomes": [m.to_dict() for m in ordered[:max_outcomes]],
        })
    cards.sort(key=lambda c: c["vol"], reverse=True)
    return cards[:max_cards]


def fetch_series_cards(client: KalshiClient, key: str) -> list[dict]:
    """Event cards for a series-sourced tab (MLB, World Cup, Mentions)."""
    cfg = CATEGORY_BY_KEY.get(key) or CATEGORY_BY_KEY["mlb"]
    series = _series_for(client, cfg)
    markets: list[LiveMarket] = []
    if series:
        # Keep concurrency modest to stay within Kalshi's read rate limit.
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(series))) as ex:
            for res in ex.map(lambda s: _markets_for_series(client, s), series):
                markets.extend(res)
    markets = [m for m in markets if m.yes_ask_c is not None or m.yes_bid_c is not None or m.last_c is not None]
    return _cards_from_markets(markets)


def fetch_trending_events(client: KalshiClient, *, pages: int = 4) -> list[dict]:
    """Kalshi's trending /events feed (with nested markets), paged. Surfaces active events
    across all categories; we bucket it per tab. Shared + cached by the server."""
    events: list[dict] = []
    cursor: str | None = None
    for _ in range(pages):
        payload = client.list_events(status="open", with_nested_markets=True, limit=200, cursor=cursor)
        events.extend(payload.get("events", []))
        cursor = payload.get("cursor")
        if not cursor:
            break
    return events


def _card_from_event(ev: dict) -> dict | None:
    markets = [_to_live(m) for m in ev.get("markets", [])]
    markets = [m for m in markets if m.yes_ask_c is not None or m.yes_bid_c is not None or m.last_c is not None]
    if not markets:
        return None
    ordered = sorted(
        markets, key=lambda x: (x.yes_ask_c if x.yes_ask_c is not None else (x.last_c or -1)), reverse=True
    )
    title = (ev.get("title") or markets[0].matchup).replace(" Winner?", "").strip()
    return {
        "id": ev.get("event_ticker", ""),
        "title": title,
        "vol": max((m.volume for m in markets), default=0),
        "market_count": len(markets),
        "close_time": min((m.close_time for m in markets if m.close_time), default=""),
        "outcomes": [m.to_dict() for m in ordered[:6]],
    }


def cards_from_events(events: list[dict], category: str, *, max_cards: int = 36) -> list[dict]:
    """Build cards for one category out of a shared trending-events list."""
    cards = [c for c in (_card_from_event(e) for e in events if e.get("category") == category) if c]
    cards.sort(key=lambda c: c["vol"], reverse=True)
    return cards[:max_cards]
