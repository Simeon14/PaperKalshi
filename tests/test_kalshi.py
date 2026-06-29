import base64

import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from paperkalshi.kalshi import (
    API_PREFIX,
    KalshiClient,
    KalshiEnv,
    auth_headers,
    normalize_candlesticks,
    sign_pss,
)


@pytest.fixture(scope="module")
def keypair():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key, key.public_key()


def _verify(public_key, message: str, signature_b64: str) -> None:
    public_key.verify(
        base64.b64decode(signature_b64),
        message.encode(),
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )


def test_signature_verifies(keypair):
    priv, pub = keypair
    msg = "1700000000000GET/trade-api/v2/portfolio/balance"
    _verify(pub, msg, sign_pss(priv, msg))  # raises if invalid


def test_auth_headers_shape_and_signature(keypair):
    priv, pub = keypair
    path = "/trade-api/v2/portfolio/balance"
    h = auth_headers("key-123", priv, "GET", path, 1700000000000)
    assert h["KALSHI-ACCESS-KEY"] == "key-123"
    assert h["KALSHI-ACCESS-TIMESTAMP"] == "1700000000000"
    _verify(pub, f"1700000000000GET{path}", h["KALSHI-ACCESS-SIGNATURE"])


def test_auth_endpoint_signs_correct_path(keypair):
    priv, pub = keypair
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        return httpx.Response(200, json={"balance": 4200})

    client = KalshiClient(
        KalshiEnv.DEMO, key_id="k", private_key=priv, transport=httpx.MockTransport(handler)
    )
    assert client.get_balance() == {"balance": 4200}
    req = seen["request"]
    assert req.url.path == API_PREFIX + "/portfolio/balance"
    ts = req.headers["KALSHI-ACCESS-TIMESTAMP"]
    _verify(pub, f"{ts}GET{req.url.path}", req.headers["KALSHI-ACCESS-SIGNATURE"])


def test_public_endpoint_unsigned():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        return httpx.Response(200, json={"market": {"ticker": "X"}})

    client = KalshiClient(KalshiEnv.PROD, transport=httpx.MockTransport(handler))
    client.get_market("KXMLBGAME-25JUN27SFAZ-SF")
    assert "KALSHI-ACCESS-KEY" not in seen["request"].headers


def test_none_query_params_dropped():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        return httpx.Response(200, json={"orderbook": {}})

    client = KalshiClient(KalshiEnv.PROD, transport=httpx.MockTransport(handler))
    client.get_orderbook("T", depth=None)
    assert "depth" not in seen["request"].url.params


def test_auth_required_without_credentials():
    client = KalshiClient(KalshiEnv.DEMO, transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    with pytest.raises(PermissionError):
        client.get_balance()


def test_refuses_orders_on_prod(keypair):
    priv, _ = keypair
    client = KalshiClient(KalshiEnv.PROD, key_id="k", private_key=priv,
                          transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    with pytest.raises(PermissionError):
        client.create_order(ticker="T", action="buy", side="yes", count=1, yes_price=1)


def test_normalize_candlesticks():
    raw = [
        {
            "end_period_ts": 1700000000,
            "yes_bid": {"open": 38, "close": 39},
            "yes_ask": {"open": 41, "close": 42},
            "price": {"open": 40, "close": 41},
            "volume": 10,
            "open_interest": 100,
        }
    ]
    rows = normalize_candlesticks(raw)
    assert rows[0]["ts"] == 1700000000 * 1000
    assert rows[0]["yes_ask_open"] == 41 and rows[0]["yes_bid_close"] == 39
