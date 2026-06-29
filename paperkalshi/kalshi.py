"""Kalshi trade-api v2 client: REST + WebSocket, RSA-PSS request signing.

Thin, dependency-light client (httpx + websockets + cryptography). We sign our own
requests rather than depend on an SDK whose currency we can't verify. Market-data
reads (markets, orderbook, trades, candlesticks, series, events) are public and work
without a key; portfolio and order endpoints require a signed key.

Signing (per Kalshi docs): for each request build the message

    message = f"{timestamp_ms}{HTTP_METHOD}{request_path}"

where ``request_path`` is the path component including the ``/trade-api/v2`` prefix
and **excluding** the query string, sign it with RSA-PSS (SHA-256, salt length =
digest length), base64-encode, and send::

    KALSHI-ACCESS-KEY:       <key id>
    KALSHI-ACCESS-TIMESTAMP: <ms epoch>
    KALSHI-ACCESS-SIGNATURE: <base64 signature>

Paper/demo only: the only writes used here are demo-sandbox place + cancel to
prove the signed write path. Never point this at prod for orders.
"""

from __future__ import annotations

import base64
import enum
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Iterator

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey

API_PREFIX = "/trade-api/v2"
WS_PATH = "/trade-api/ws/v2"


class KalshiEnv(enum.Enum):
    PROD = ("https://api.elections.kalshi.com", "wss://api.elections.kalshi.com")
    DEMO = ("https://demo-api.kalshi.co", "wss://demo-api.kalshi.co")

    @property
    def rest_host(self) -> str:
        return self.value[0]

    @property
    def ws_host(self) -> str:
        return self.value[1]


# --------------------------------------------------------------------------- #
# Signing
# --------------------------------------------------------------------------- #
def load_private_key_pem(pem: str | bytes) -> RSAPrivateKey:
    data = pem.encode() if isinstance(pem, str) else pem
    key = serialization.load_pem_private_key(data, password=None)
    if not isinstance(key, RSAPrivateKey):
        raise TypeError("Kalshi API key must be an RSA private key")
    return key


def load_private_key_from_path(path: str) -> RSAPrivateKey:
    with open(path, "rb") as fh:
        return load_private_key_pem(fh.read())


def sign_pss(private_key: RSAPrivateKey, message: str) -> str:
    """RSA-PSS(SHA-256, salt=digest length) signature of ``message``, base64."""
    sig = private_key.sign(
        message.encode("utf-8"),
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )
    return base64.b64encode(sig).decode("ascii")


def auth_headers(
    key_id: str, private_key: RSAPrivateKey, method: str, path: str, ts_ms: int
) -> dict[str, str]:
    """Build the three Kalshi auth headers for one request.

    ``path`` must be the signing path (``/trade-api/v2/...``) with no query string.
    """
    message = f"{ts_ms}{method.upper()}{path}"
    return {
        "KALSHI-ACCESS-KEY": key_id,
        "KALSHI-ACCESS-TIMESTAMP": str(ts_ms),
        "KALSHI-ACCESS-SIGNATURE": sign_pss(private_key, message),
    }


# --------------------------------------------------------------------------- #
# REST client
# --------------------------------------------------------------------------- #
class KalshiClient:
    """Synchronous Kalshi REST client.

    Inject ``transport`` (an ``httpx.MockTransport``) to unit-test request building
    and signing without network. Pass ``key_id`` + ``private_key`` to enable signed
    (portfolio/order) endpoints; omit them for public market-data reads.
    """

    def __init__(
        self,
        env: KalshiEnv = KalshiEnv.DEMO,
        *,
        key_id: str | None = None,
        private_key: RSAPrivateKey | None = None,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 20.0,
    ) -> None:
        self.env = env
        self._key_id = key_id
        self._private_key = private_key
        self._client = httpx.Client(base_url=env.rest_host, transport=transport, timeout=timeout)

    # lifecycle ----------------------------------------------------------- #
    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "KalshiClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    @property
    def has_credentials(self) -> bool:
        return self._key_id is not None and self._private_key is not None

    # core request -------------------------------------------------------- #
    def _request(
        self,
        method: str,
        endpoint: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
        auth: bool = False,
    ) -> dict[str, Any]:
        path = API_PREFIX + endpoint
        headers: dict[str, str] = {}
        if auth:
            if not self.has_credentials:
                raise PermissionError(f"{method} {endpoint} requires Kalshi credentials")
            ts = int(time.time() * 1000)
            headers.update(auth_headers(self._key_id, self._private_key, method, path, ts))  # type: ignore[arg-type]
        r = self._client.request(method, path, params=_clean(params), json=json, headers=headers)
        r.raise_for_status()
        return r.json() if r.content else {}

    # public market data -------------------------------------------------- #
    def get_market(self, ticker: str) -> dict[str, Any]:
        return self._request("GET", f"/markets/{ticker}").get("market", {})

    def get_markets(
        self,
        *,
        series_ticker: str | None = None,
        event_ticker: str | None = None,
        status: str | None = None,
        tickers: list[str] | None = None,
        limit: int = 200,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "GET",
            "/markets",
            params={
                "series_ticker": series_ticker,
                "event_ticker": event_ticker,
                "status": status,
                "tickers": ",".join(tickers) if tickers else None,
                "limit": limit,
                "cursor": cursor,
            },
        )

    def iter_markets(
        self, *, series_ticker: str | None = None, status: str | None = None, page: int = 200
    ) -> Iterator[dict[str, Any]]:
        """Page through ``/markets`` following the cursor until exhausted."""
        cursor: str | None = None
        while True:
            payload = self.get_markets(
                series_ticker=series_ticker, status=status, limit=page, cursor=cursor
            )
            yield from payload.get("markets", [])
            cursor = payload.get("cursor") or None
            if not cursor:
                return

    def get_orderbook(self, ticker: str, *, depth: int | None = None) -> dict[str, Any]:
        return self._request(
            "GET", f"/markets/{ticker}/orderbook", params={"depth": depth}
        ).get("orderbook", {})

    def get_trades(
        self,
        ticker: str,
        *,
        limit: int = 100,
        cursor: str | None = None,
        min_ts: int | None = None,
        max_ts: int | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "GET",
            "/markets/trades",
            params={
                "ticker": ticker,
                "limit": limit,
                "cursor": cursor,
                "min_ts": min_ts,
                "max_ts": max_ts,
            },
        )

    def get_series(self, series_ticker: str) -> dict[str, Any]:
        return self._request("GET", f"/series/{series_ticker}").get("series", {})

    def list_series(
        self, *, category: str | None = None, limit: int = 200, cursor: str | None = None
    ) -> dict[str, Any]:
        """List series (optionally filtered by ``category``, e.g. 'Politics')."""
        return self._request(
            "GET", "/series", params={"category": category, "limit": limit, "cursor": cursor}
        )

    def get_events(
        self, *, series_ticker: str | None = None, status: str | None = None
    ) -> dict[str, Any]:
        return self._request(
            "GET", "/events", params={"series_ticker": series_ticker, "status": status}
        )

    def list_events(
        self,
        *,
        status: str | None = None,
        with_nested_markets: bool = False,
        limit: int = 200,
        cursor: str | None = None,
        series_ticker: str | None = None,
    ) -> dict[str, Any]:
        """Page through ``/events``; with ``with_nested_markets`` each event carries its markets."""
        return self._request(
            "GET",
            "/events",
            params={
                "status": status,
                "with_nested_markets": "true" if with_nested_markets else None,
                "limit": limit,
                "cursor": cursor,
                "series_ticker": series_ticker,
            },
        )

    def get_candlesticks(
        self,
        series_ticker: str,
        ticker: str,
        *,
        start_ts: int,
        end_ts: int,
        period_interval: int = 1,
    ) -> list[dict[str, Any]]:
        """Historical OHLC candles. ``start_ts``/``end_ts`` are **unix seconds**;
        ``period_interval`` is minutes (Kalshi supports 1, 60, 1440)."""
        payload = self._request(
            "GET",
            f"/series/{series_ticker}/markets/{ticker}/candlesticks",
            params={"start_ts": start_ts, "end_ts": end_ts, "period_interval": period_interval},
        )
        return payload.get("candlesticks", [])

    def get_historical(self, endpoint: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Generic GET against ``/historical/*`` (e.g. ``/historical/cutoff``).

        Kalshi gates bulk historical reads behind a per-resource cutoff. Call
        :meth:`historical_cutoff` first to learn the available range, then read the
        specific historical resource. Candlesticks above are the primary historical
        price source; this is the escape hatch for the rest.
        """
        ep = endpoint if endpoint.startswith("/historical") else f"/historical{endpoint}"
        return self._request("GET", ep, params=params)

    def historical_cutoff(self) -> dict[str, Any]:
        return self.get_historical("/cutoff")

    # signed portfolio / orders ------------------------------------------- #
    def get_balance(self) -> dict[str, Any]:
        return self._request("GET", "/portfolio/balance", auth=True)

    def get_positions(self) -> dict[str, Any]:
        return self._request("GET", "/portfolio/positions", auth=True)

    def get_fills(self, *, ticker: str | None = None) -> dict[str, Any]:
        return self._request("GET", "/portfolio/fills", params={"ticker": ticker}, auth=True)

    def create_order(
        self,
        *,
        ticker: str,
        action: str,  # "buy" | "sell"
        side: str,  # "yes" | "no"
        count: int,
        type: str = "limit",  # "limit" | "market"
        yes_price: int | None = None,
        no_price: int | None = None,
        client_order_id: str | None = None,
    ) -> dict[str, Any]:
        """Place an order (DEMO ONLY in this project). Returns the order payload."""
        if self.env is KalshiEnv.PROD:
            raise PermissionError("refusing to place orders against PROD (paper/demo only)")
        body: dict[str, Any] = {
            "ticker": ticker,
            "action": action,
            "side": side,
            "count": count,
            "type": type,
            "client_order_id": client_order_id or str(uuid.uuid4()),
        }
        if yes_price is not None:
            body["yes_price"] = yes_price
        if no_price is not None:
            body["no_price"] = no_price
        return self._request("POST", "/portfolio/orders", json=body, auth=True).get("order", {})

    def cancel_order(self, order_id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/portfolio/orders/{order_id}", auth=True)


def _clean(params: dict[str, Any] | None) -> dict[str, Any] | None:
    """Drop None-valued query params so we don't send ``?x=None``."""
    if not params:
        return None
    return {k: v for k, v in params.items() if v is not None}


# --------------------------------------------------------------------------- #
# Candlestick normalization (Kalshi-specific shape -> flat rows for fills)
# --------------------------------------------------------------------------- #
def normalize_candlesticks(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flatten Kalshi candlesticks into rows the fill model consumes.

    Output rows carry ``ts`` in **UTC ms** and the open/close of ``yes_bid`` and
    ``yes_ask`` (top-of-book), plus last-trade ``price`` open/close and volume. We
    intentionally keep open/close only - the fill model must use the worse of
    open/close and never the within-bar favorable extreme.
    """
    rows: list[dict[str, Any]] = []
    for c in raw:
        end_s = c.get("end_period_ts") or c.get("ts")
        if end_s is None:
            continue
        bid = c.get("yes_bid") or {}
        ask = c.get("yes_ask") or {}
        price = c.get("price") or {}
        rows.append(
            {
                "ts": int(end_s) * 1000,
                "yes_bid_open": _g(bid, "open"),
                "yes_bid_close": _g(bid, "close"),
                "yes_ask_open": _g(ask, "open"),
                "yes_ask_close": _g(ask, "close"),
                "price_open": _g(price, "open"),
                "price_close": _g(price, "close"),
                "volume": c.get("volume", 0),
                "open_interest": c.get("open_interest", 0),
            }
        )
    return rows


def _g(d: dict[str, Any], k: str) -> int | None:
    v = d.get(k)
    return int(v) if v is not None else None


# --------------------------------------------------------------------------- #
# WebSocket client (used by the live recorder)
# --------------------------------------------------------------------------- #
@dataclass
class KalshiWSClient:
    """Async Kalshi WS client. Yields raw message dicts from subscribed channels."""

    env: KalshiEnv = KalshiEnv.PROD
    key_id: str | None = None
    private_key: RSAPrivateKey | None = None

    async def stream(
        self, channels: list[str], market_tickers: list[str]
    ) -> AsyncIterator[dict[str, Any]]:
        import json as _json

        import websockets

        url = self.env.ws_host + WS_PATH
        headers: dict[str, str] = {}
        if self.key_id and self.private_key:
            ts = int(time.time() * 1000)
            headers = auth_headers(self.key_id, self.private_key, "GET", WS_PATH, ts)

        async with websockets.connect(url, additional_headers=headers) as ws:
            await ws.send(
                _json.dumps(
                    {
                        "id": 1,
                        "cmd": "subscribe",
                        "params": {"channels": channels, "market_tickers": market_tickers},
                    }
                )
            )
            async for raw in ws:
                yield _json.loads(raw)
