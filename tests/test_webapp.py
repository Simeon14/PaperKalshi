"""Tests for the FastAPI terminal routes (no network).

Live-data routes (``/api/markets``, ``/api/account``) hit Kalshi, so we don't call them
here; we cover the static page, health, the category list, and request validation.
"""

from __future__ import annotations

from starlette.testclient import TestClient

from paperkalshi.server import app

client = TestClient(app)


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_index_serves_terminal():
    r = client.get("/")
    assert r.status_code == 200 and "<title>" in r.text and "MLB markets" in r.text


def test_categories():
    keys = [c["key"] for c in client.get("/api/categories").json()["categories"]]
    for expected in ("mlb", "worldcup", "elections", "politics", "finance", "tech", "mentions"):
        assert expected in keys


def test_trade_request_validation():
    # Bad side / non-positive count are rejected by the request model (422) before any
    # network call, so this stays offline.
    assert client.post("/api/trade", json={"ticker": "X", "side": "maybe", "action": "buy", "count": 1}).status_code == 422
    assert client.post("/api/trade", json={"ticker": "X", "side": "yes", "action": "buy", "count": 0}).status_code == 422
