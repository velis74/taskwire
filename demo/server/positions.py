"""An application viewset whose calls taskwire tracks with no code of the application's own.

`register_taskwire_rest` lists `TaskwireMiddleware`, so every call a fastapi-viewsets proxy makes to
this viewset carries an `Idempotency-Key` that names an operation, and `reprice` reports into it
through `taskwire.progress`. The browser follows the call with `tw.trackCall(call, handler)`.

No `from __future__ import annotations`: `route_viewset` reads the return annotations as objects.
"""

import asyncio

from fastapi import APIRouter

import taskwire

from .market import SYMBOLS

STEP_SECONDS = 0.1
"""The pause per symbol; with the book's symbols it makes a call that runs for a couple of seconds."""


class PositionsViewSet:
    """`POST /demo/positions/reprice`: reprices the book in place, one symbol at a time."""

    __router = APIRouter()

    @__router.post("reprice")
    async def reprice(self) -> dict:
        """The operation is private: no result decorator declares a kind, so only the connection that
        made the call sees its progress (TW-PRIV-001)."""
        symbols = [symbol for symbol, _, _ in SYMBOLS]
        for index, symbol in enumerate(symbols, start=1):
            await asyncio.sleep(STEP_SECONDS)
            await taskwire.progress.set(percent=100 * index / len(symbols), label=taskwire.Text(text=symbol))
        return {"repriced": len(symbols)}
