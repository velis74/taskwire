"""The four night-batch jobs: async functions that report through a `Reporter` and use no transport.

| job | shows |
|---|---|
| `reconcile` | dialogs: work stops, a person decides, work resumes; four times |
| `export_blotter` | cancellation, and a collectable download at the end |
| `revalue` | nested progress: four sector subtasks filling one bar by weight |
| `hold_the_line` | an unanswered question under the application's own deadline |

Every job sleeps in small slices instead of doing real work.
"""

from __future__ import annotations

import asyncio

from typing import Any

from taskwire import Button, DIALOG_TIMEOUT, OperationCancelled, Reporter, Result, t

from .market import blotter_rows, build_book, SECTORS, SYMBOLS, total_trades

SYMBOL_STEP = 0.35
"""Seconds per symbol in `reconcile`: about seven seconds end to end, before any question, well above
`progressUi.delay` (250 ms)."""

EXPORT_CHUNK = 40
"""Blotter rows per progress report: about 100 steps over the book."""

EXPORT_STEP = 0.22

SECTOR_STEP = 0.5
"""Seconds per symbol in `revalue`, the slowest step, so the four sectors visibly interleave."""

HOLD_STEP = 0.4
"""Seconds per pre-flight check in `hold_the_line`; three checks put the question on screen in about a
second."""

HOLD_DEADLINE = 15.0
"""Seconds `hold_the_line` waits for an answer. The application's own deadline: `ask()` has none
(TW-DLG-005)."""


async def reconcile(reporter: Reporter) -> None:
    """Walk the book and ask which figure stands wherever ours and the custodian's disagree.

    `ask()` blocks until the store arbitrates a reply (TW-STORE-003) and has no timeout (TW-DLG-005);
    the operation reads `waiting_input` while it waits. Every tab of the namespace sees the question
    and any of them may answer it (TW-REG-001). Parks a reconciliation report.
    """
    book = build_book()
    await reporter.set(
        title=t("demo.reconcile.title", text="Reconciling positions"),
        percent=0,
        data={"symbols_done": 0, "symbols_total": len(book), "conflicts": 0, "resolved": {}},
    )

    resolved: dict[str, str] = {}
    conflicts = 0

    for index, position in enumerate(book):
        await asyncio.sleep(SYMBOL_STEP)

        if position.disagrees:
            conflicts += 1
            # `params` carries the values the frontend renders; the texts are a key and a fallback
            # (TW-TXT-001).
            answer = await reporter.ask(
                "demo.position_conflict",
                buttons=[
                    Button(id="ours", label=t("demo.keep_ours", text=f"Keep ours ({position.ours:,})")),
                    Button(
                        id="custodian",
                        label=t("demo.keep_custodian", text=f"Keep custodian ({position.custodian:,})"),
                    ),
                ],
                params={
                    "symbol": position.symbol,
                    "name": position.name,
                    "ours": position.ours,
                    "custodian": position.custodian,
                    "difference": position.custodian - position.ours,
                },
                text=t(
                    "demo.position_conflict.text",
                    text=f"{position.symbol} does not reconcile. Which figure stands?",
                ),
            )
            resolved[position.symbol] = answer.button

        await reporter.set(
            percent=100 * (index + 1) / len(book),
            label=t("demo.reconcile.symbol", symbol=position.symbol, text=f"Checking {position.symbol}"),
            data={
                "symbols_done": index + 1,
                "symbols_total": len(book),
                "conflicts": conflicts,
                "resolved": dict(resolved),
            },
        )

    # The row stays in the register until the result is collected or dismissed (TW-RES-010).
    await reporter.set_result(
        Result.panel(
            "demo.reconciliation_report",
            value={
                "checked": len(book),
                "conflicts": conflicts,
                "resolved": resolved,
            },
            label=t("demo.reconcile.done", text=f"{conflicts} conflicts resolved"),
        )
    )


async def export_blotter(reporter: Reporter) -> None:
    """Write every fill to a file and park a download; a long, cancellable job.

    A cancel stops it at the next `set()`, which raises `OperationCancelled` by default
    (TW-CANCEL-002).
    """
    rows_total = total_trades()
    await reporter.set(
        title=t("demo.export.title", text="Exporting trade blotter"),
        percent=0,
        data={"rows_done": 0, "rows_total": rows_total},
    )

    written = 0
    try:
        for symbol, _, _ in SYMBOLS:
            rows = blotter_rows(symbol)
            # One report per `EXPORT_CHUNK` rows.
            for offset in range(0, len(rows), EXPORT_CHUNK):
                written += len(rows[offset : offset + EXPORT_CHUNK])
                await asyncio.sleep(EXPORT_STEP)
                # Raises `OperationCancelled` once a cancel is requested (TW-CANCEL-002).
                await reporter.set(
                    percent=100 * written / rows_total,
                    label=t("demo.export.symbol", symbol=symbol, text=f"Writing {symbol} ({len(rows)} fills)"),
                    data={"rows_done": written, "rows_total": rows_total},
                )
    except OperationCancelled:
        # Clean-up of a partial export goes here; re-raised so `operation()` writes `cancelled`
        # (TW-CANCEL-006).
        raise

    await reporter.set_result(
        Result.download(
            href=f"/demo/artefacts/blotter.csv?rows={written}",
            mime="text/csv",
            bytes=written * 48,
            label=t("demo.export.ready", rows=written, text=f"blotter.csv - {written:,} fills"),
        )
    )


async def revalue(reporter: Reporter) -> None:
    """Revalue the book with one child reporter per sector, run concurrently, and park the valuation.

    `split()` weights each child by its sector's size, and the parent sums the children's
    contributions (TW-NEST-004).
    """
    await reporter.set(title=t("demo.revalue.title", text="Revaluing portfolio"), percent=0)

    total = sum(len(members) for members in SECTORS.values())
    children = reporter.split(*[len(members) / total for members in SECTORS.values()])

    async def one_sector(child: Reporter, sector: str, members: tuple[str, ...]) -> float:
        value = 0.0
        prices = {symbol: price for symbol, _, price in SYMBOLS}
        book = {position.symbol: position for position in build_book()}
        for index, symbol in enumerate(members):
            await asyncio.sleep(SECTOR_STEP)
            value += book[symbol].ours * prices[symbol]
            await child.set(
                percent=100 * (index + 1) / len(members),
                label=t("demo.revalue.sector", sector=sector, text=f"{sector}: {symbol}"),
            )
        return value

    # The children report interleaved, in an order that changes between runs.
    values = await asyncio.gather(
        *[
            one_sector(child, sector, members)
            for child, (sector, members) in zip(children, SECTORS.items(), strict=True)
        ]
    )

    await reporter.set(
        label=t("demo.revalue.done", text="Revaluation complete"),
        data={"book_value": round(sum(values), 2)},
    )
    await reporter.set_result(
        Result.panel(
            "demo.valuation",
            value={
                "book_value": round(sum(values), 2),
                "by_sector": {sector: round(value, 2) for sector, value in zip(SECTORS, values, strict=True)},
            },
            label=t("demo.revalue.total", text=f"Book value {sum(values):,.2f}"),
        )
    )


async def hold_the_line(reporter: Reporter) -> None:
    """Ask a question under the application's own `HOLD_DEADLINE`.

    An answer within the deadline parks the decision. Otherwise `asyncio.wait_for` ends the wait and
    the operation ends `failed` with `taskwire.dialog_timeout`, `retryable: true`, the code an
    executor's time limit writes too (TW-DLG-006). The terminal write withdraws the open dialog in
    every tab (TW-CANCEL-011); a late reply gets 410 while the terminal document is readable and 404
    after it (TW-DLG-011).
    """
    checks = (
        t("demo.hold.balances", text="Matching cash balances"),
        t("demo.hold.instructions", text="Building settlement instructions"),
        t("demo.hold.channel", text="Opening the custodian channel"),
    )
    await reporter.set(
        title=t("demo.hold.title", text="Releasing the settlement file"),
        percent=0,
        data={"deadline_seconds": HOLD_DEADLINE},
    )

    for index, check in enumerate(checks):
        await asyncio.sleep(HOLD_STEP)
        # The checks fill three quarters of the bar; the decision is the last quarter.
        await reporter.set(percent=100 * (index + 1) / (len(checks) + 1), label=check)

    # On expiry `wait_for` cancels the pending `ask()` and raises; `operation()` then writes `failed`
    # and withdraws the dialog.
    try:
        answer = await asyncio.wait_for(
            reporter.ask(
                "demo.release_window",
                buttons=[
                    Button(id="release", label=t("demo.hold.release", text="Release now")),
                    Button(id="hold", label=t("demo.hold.wait", text="Hold until morning")),
                ],
                params={"deadline_seconds": HOLD_DEADLINE, "instructions": total_trades()},
                text=t(
                    "demo.release_window.text",
                    text=f"Release tonight's settlement file? This worker waits {HOLD_DEADLINE:.0f} s.",
                ),
            ),
            HOLD_DEADLINE,
        )
    except (TimeoutError, asyncio.TimeoutError):
        # Names the terminal error `taskwire.dialog_timeout` instead of `taskwire.unhandled_exception`.
        # `asyncio.TimeoutError` differs from the builtin before Python 3.11.
        reporter.name_error(
            DIALOG_TIMEOUT,
            t(DIALOG_TIMEOUT, text=f"Nobody answered within {HOLD_DEADLINE:.0f} s."),
            True,
        )
        raise

    await reporter.set(percent=100, label=t("demo.hold.decided", text="Decision recorded"))
    await reporter.set_result(
        Result.panel(
            "demo.release_decision",
            value={"decision": answer.button, "instructions": total_trades()},
            label=t("demo.hold.done", text=f"Settlement file: {answer.button}"),
        )
    )


JOBS: dict[str, Any] = {
    "reconcile": reconcile,
    "export": export_blotter,
    "revalue": revalue,
    "hold": hold_the_line,
}
"""The jobs the frontend may start, by name."""
