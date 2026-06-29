"""Kalshi trading fees.

Kalshi's general trading fee is

    fee = ceil( multiplier * C * P * (1 - P) )  dollars,   rounded up per order

where ``C`` is the contract count and ``P`` is the price *in dollars*. The default
``multiplier`` is ``0.07`` but it varies by series, so production code pulls each
series' multiplier/fee type live from the API (see :meth:`KalshiTakerFeeModel.from_series`)
rather than hardcoding it.

The rounding is **up, per order** (not per contract), so the fee is *not* linear in
size. The classic gotcha the spec calls out: a single contract at P=0.50 costs

    ceil(0.07 * 1 * 0.50 * 0.50 * 100c) = ceil(1.75c) = **2c**

The 1.75c figure is only the large-C asymptote (per-contract fee as C->inf). We must
compute at the *actual* contract count, which this module does.

We also model a **maker (often zero-fee) scenario** (:class:`MakerFeeModel`) as an
alternative. Caveat: resting maker orders are not guaranteed to fill, so any
maker-fee estimate must be read alongside an explicit fill-probability assumption
(a resting bid at the touch fills far less often than a marketable taker order).

Everything is computed with :class:`~decimal.Decimal` so a fee that lands on an
exact cent boundary (e.g. 2.00c) is never bumped up by binary float error.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal
from typing import Any, Protocol, runtime_checkable

DEFAULT_TAKER_MULTIPLIER = Decimal("0.07")
_HUNDRED = Decimal(100)


@runtime_checkable
class FeeModel(Protocol):
    """A fee schedule. ``fee_cents`` is the whole-cent fee for an order of ``contracts``
    filled at ``price_c`` (per-contract price in cents), rounded up per order; ``model_id``
    is a stable string stored on fills. The models below implement it structurally."""

    @property
    def model_id(self) -> str: ...

    def fee_cents(self, contracts: int, price_c: int) -> int: ...


def _ceil_to_int(x: Decimal) -> int:
    return int(x.quantize(Decimal(1), rounding=ROUND_CEILING))


@dataclass(frozen=True)
class KalshiTakerFeeModel:
    """Taker fee: ``ceil(multiplier * C * P * (1-P))`` dollars, rounded up per order.

    ``multiplier`` is stored as a :class:`~decimal.Decimal` (built from ``str`` so
    ``0.07`` is exact). Implements the :class:`parta.contract.FeeModel` protocol.
    """

    multiplier: Decimal = DEFAULT_TAKER_MULTIPLIER

    def __post_init__(self) -> None:
        # Allow float/str/Decimal in; normalize to an exact Decimal.
        if not isinstance(self.multiplier, Decimal):
            object.__setattr__(self, "multiplier", Decimal(str(self.multiplier)))
        if self.multiplier < 0:
            raise ValueError(f"fee multiplier must be >= 0, got {self.multiplier}")

    @property
    def model_id(self) -> str:
        # e.g. "kalshi_taker_0.070" - stable and human-readable for ledgers.
        return f"kalshi_taker_{self.multiplier.normalize():.3f}"

    def fee_cents(self, contracts: int, price_c: int) -> int:
        if contracts <= 0:
            return 0
        if not 0 <= price_c <= 100:
            raise ValueError(f"price_c out of range 0..100: {price_c}")
        if price_c in (0, 100):
            return 0  # settled / certain: P*(1-P) == 0
        # fee_dollars * 100 = multiplier * C * price_c * (100 - price_c) / 100
        raw_cents = (
            self.multiplier * contracts * price_c * (100 - price_c) / _HUNDRED
        )
        return _ceil_to_int(raw_cents)

    @classmethod
    def from_series(cls, series: dict[str, Any]) -> "KalshiTakerFeeModel":
        """Build from a Kalshi ``/series/{ticker}`` (or market) payload.

        Looks for a multiplier under the keys Kalshi has used across API revisions;
        falls back to the 0.07 default if none is present. Pulling this live is what
        keeps us from hardcoding 0.07 for series that price fees differently.
        """
        for key in ("fee_multiplier", "trading_fee_multiplier", "maker_fee_multiplier"):
            if key in series and series[key] is not None:
                try:
                    return cls(Decimal(str(series[key])))
                except (ArithmeticError, ValueError):
                    break
        return cls()


@dataclass(frozen=True)
class MakerFeeModel:
    """Maker scenario: zero fee.

    Kalshi typically charges no fee on resting (maker) liquidity. Use this only as
    an *alternative* scenario in a sensitivity sweep, and always pair it with an
    explicit fill-probability assumption - a resting order may never fill, so its
    realized PnL is not comparable to the taker path one-for-one.
    """

    @property
    def model_id(self) -> str:
        return "kalshi_maker_0"

    def fee_cents(self, contracts: int, price_c: int) -> int:  # noqa: ARG002
        return 0


# Convenient defaults used when no per-series fee override is available. Pulling the real
# multiplier per series is preferred.
DEFAULT_TAKER = KalshiTakerFeeModel()
DEFAULT_MAKER = MakerFeeModel()


def get_fee_model(model_id: str) -> "KalshiTakerFeeModel | MakerFeeModel":
    """Resolve a ``fee_model_id`` string (as stored on quotes) back to a model."""
    if model_id == DEFAULT_MAKER.model_id:
        return DEFAULT_MAKER
    if model_id.startswith("kalshi_taker_"):
        mult = model_id.rsplit("_", 1)[-1]
        return KalshiTakerFeeModel(Decimal(mult))
    raise KeyError(f"unknown fee_model_id: {model_id!r}")
