"""The book the night batch runs over: positions, trades, and the discrepancies that need a person.

No network and no clock. Every number comes from a generator seeded from the symbol and the
purpose, not from one shared stream, so a symbol's figures do not depend on the order in which jobs
run.
"""

from __future__ import annotations

import random

from dataclasses import dataclass

SYMBOLS: tuple[tuple[str, str, float], ...] = (
    ("ACME", "Acme Industrial", 128.40),
    ("BOLT", "Boltworks", 34.15),
    ("CIRQ", "Cirquit Systems", 212.80),
    ("DYNA", "Dynaflow Energy", 57.05),
    ("EMBR", "Ember Materials", 19.90),
    ("FLUX", "Fluxion Labs", 341.25),
    ("GRID", "Gridline Power", 88.60),
    ("HALO", "Halo Optics", 145.75),
    ("IRON", "Ironvale Mining", 42.30),
    ("JUNO", "Juno Logistics", 76.45),
    ("KITE", "Kite Aerospace", 263.10),
    ("LOOM", "Loomcraft Textiles", 11.85),
    ("MESA", "Mesa Foods", 63.70),
    ("NOVA", "Nova Biotics", 198.35),
    ("ORBX", "Orbex Telemetry", 29.55),
    ("PIER", "Pierpoint Shipping", 51.20),
    ("QUAR", "Quarry Cement", 24.65),
    ("RUNE", "Rune Software", 407.90),
    ("SAGE", "Sagewater Utilities", 95.05),
    ("TIDE", "Tidewater Marine", 38.75),
)
"""The universe, as `(symbol, name, reference price)`. Every other figure in this module is derived
from one of these symbols."""

SECTORS: dict[str, tuple[str, ...]] = {
    "Industrials": ("ACME", "BOLT", "IRON", "JUNO", "PIER", "QUAR", "TIDE"),
    "Technology": ("CIRQ", "FLUX", "HALO", "ORBX", "RUNE"),
    "Energy & Utilities": ("DYNA", "GRID", "SAGE"),
    "Materials & Consumer": ("EMBR", "LOOM", "MESA", "NOVA", "KITE"),
}
"""The sectors `revalue` splits its bar across, weighted by size."""

DEFAULT_SEED = 1_234_567
"""The seed every generator is built from, so two runs of the demo produce the same book."""


def _rng(symbol: str, purpose: str) -> random.Random:
    """One generator per (symbol, purpose), reproducible across runs."""
    # A fake market, not a key: the generator must be reproducible, so not `secrets`.
    return random.Random(f"{DEFAULT_SEED}:{symbol}:{purpose}")  # noqa: S311


@dataclass(frozen=True)
class Position:
    """One symbol's position in our book beside the custodian's figure; `reconcile` asks a person
    which stands when they disagree."""

    symbol: str
    name: str
    price: float
    ours: int
    custodian: int

    @property
    def disagrees(self) -> bool:
        return self.ours != self.custodian

    @property
    def value(self) -> float:
        return round(self.ours * self.price, 2)


CONFLICTS: dict[str, int] = {"CIRQ": -75, "GRID": 125, "MESA": -200, "RUNE": 50}
"""The symbols whose custodian figure differs, and by how much."""


def build_book() -> list[Position]:
    """The whole book, identical on every run."""
    return [
        Position(symbol, name, price, ours := _rng(symbol, "position").randrange(100, 25_000, 25), ours + drift)
        for symbol, name, price in SYMBOLS
        for drift in (CONFLICTS.get(symbol, 0),)
    ]


def trades_for(symbol: str) -> int:
    """How many blotter rows this symbol contributes. Drives the export's row count and its runtime."""
    return _rng(symbol, "trades").randrange(40, 400)


def blotter_rows(symbol: str) -> list[dict[str, object]]:
    """One symbol's fills, as the export writes them."""
    rng = _rng(symbol, "blotter")
    price = {s: p for s, _, p in SYMBOLS}[symbol]
    rows = []
    for index in range(trades_for(symbol)):
        rows.append(
            {
                "seq": index + 1,
                "symbol": symbol,
                "side": rng.choice(("buy", "sell")),
                "quantity": rng.randrange(25, 2_500, 25),
                "price": round(price * rng.uniform(0.985, 1.015), 2),
            }
        )
    return rows


def total_trades() -> int:
    """Blotter rows across the whole universe. The export's denominator for its percentage."""
    return sum(trades_for(symbol) for symbol, _, _ in SYMBOLS)
