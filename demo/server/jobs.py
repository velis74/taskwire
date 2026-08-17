"""The four night-batch jobs. Between them they exercise everything taskwire does.

Each one is an ordinary async function that happens to hold a `Reporter`. None of them knows what a
transport is, whether anybody is watching, or whether the answer to a question will arrive over
HTTP or over a socket - which is the property the whole library exists to provide.

| job | what it is here to show |
|---|---|
| `reconcile` | dialogs: work stops, a person decides, work resumes. Four times. |
| `export_blotter` | cancellation, and a collectable download at the end |
| `revalue` | nested progress: four sector subtasks filling one bar by weight |
| `hold_the_line` | a question nobody answers, under a deadline that is the application's |

**The pacing is deliberate.** Every job sleeps in small slices rather than doing real work, because
the point is the reporting, and a demo that pegged a core for forty seconds would be measuring the
reader's laptop instead.
"""

from __future__ import annotations

import asyncio

from typing import Any

from taskwire import Button, OperationCancelled, Reporter, Result, t

from .market import blotter_rows, build_book, SECTORS, SYMBOLS, total_trades

SYMBOL_STEP = 0.35
"""Seconds per symbol in `reconcile` - about seven seconds end to end, before any question.

Fast enough not to bore, and comfortably longer than the 250 ms an operation must live to appear on
screen at all (`progressUi.delay`). A job shorter than that delay never shows a bar, which is by
design - most operations finish in a blink and a bar that flashes up and vanishes reads as a glitch -
but it would make for a poor demonstration.
"""

EXPORT_CHUNK = 40
"""Blotter rows per progress report. ~100 steps over the book, so the bar moves smoothly and there
is real time in which to press cancel."""

EXPORT_STEP = 0.22

SECTOR_STEP = 0.5
"""Deliberately the slowest, so four sectors visibly interleave rather than finishing in one tick."""

HOLD_STEP = 0.4
"""Seconds per pre-flight check in `hold_the_line` - three of them, so the question is on screen in
about a second. The waiting after the question is the demonstration; the work before it is there
only to show that a job was running when it stopped."""

HOLD_DEADLINE = 15.0
"""Seconds this application will hold a worker waiting for an answer.

Not a taskwire setting. There is no `settings.dialog_timeout` and `ask()` takes no deadline
(TW-DLG-005), so the number lives at the layer that knows what the worker costs - here, and in a
deployment in the queue configuration."""


async def reconcile(reporter: Reporter) -> None:
    """Walk the book; where our position and the custodian's disagree, **ask a person**.

    This is the job the library was designed around. `ask()` blocks until the store arbitrates a
    reply (TW-STORE-003) and there is **no timeout** (TW-DLG-005) - the operation waits as long as
    the user does, its state reads `waiting_input`, and the worker really is held. That last part is
    not hidden: it is the honest cost of asking a human something, and the demo shows it rather than
    papering over it.

    Every tab of the namespace sees the question and any of them may answer it (TW-REG-001). Open a
    second tab while one of these is waiting: the same question is there, and answering in either
    releases the job.
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
            # `params` is the whole of what the frontend needs to render this question. taskwire
            # never composes a sentence: it carries a key, the values, and a fallback string
            # (TW-TXT-001), and the application decides what that looks like on screen.
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

    # A result parks the operation in the register until somebody collects or dismisses it
    # (TW-RES-010). Until then the row stays, which is the point: a report nobody saw is a report
    # nobody can act on.
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
    """Write every fill to a file. Long, boring, and **cancellable** - which is the point.

    There is no cancellation code in this function. `set()` raises `OperationCancelled` by default
    (TW-CANCEL-002), so a loop that reports progress stops when asked without its author having
    written anything for it. The `except` below is not what stops the work; it is what decides what
    a half-written export leaves behind.
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
            # Reported every `EXPORT_CHUNK` rows rather than every row: a report per row would be
            # four thousand store writes for a bar the eye cannot follow, and the throttle would
            # coalesce them anyway.
            for offset in range(0, len(rows), EXPORT_CHUNK):
                written += len(rows[offset : offset + EXPORT_CHUNK])
                await asyncio.sleep(EXPORT_STEP)
                # This is where a cancel lands. Nothing below is written for it: `set()` raises by
                # default (TW-CANCEL-002), so the loop stops whether or not its author thought about it.
                await reporter.set(
                    percent=100 * written / rows_total,
                    label=t("demo.export.symbol", symbol=symbol, text=f"Writing {symbol} ({len(rows)} fills)"),
                    data={"rows_done": written, "rows_total": rows_total},
                )
    except OperationCancelled:
        # Six minutes of successfully written rows are not discarded because the user cancelled the
        # seventh: the partial file is kept and named as partial. Whether that is right is the
        # operation author's call and nobody else's, which is exactly why `raise_on_cancel` is
        # switchable rather than a library-wide policy.
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
    """Revalue the book sector by sector, with one child reporter per sector.

    The bar is filled by **four independent children**, each owning a slice of it. taskwire keeps a
    per-child contribution map rather than last-write-wins (TW-NEST-004), which is the difference
    between a bar that ends at 100 % and one that jumps to 100 % the moment the fastest sector
    finishes and then sits there while three others are still running.

    The sectors here are deliberately unequal in size, so the weights are visible: Technology's five
    symbols move the bar less than Industrials' seven.
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

    # Concurrently, because that is when the contribution map earns its keep: four children reporting
    # interleaved, in an order that changes between runs.
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
    """Ask a question, then let the worker's own deadline expire before anybody answers it.

    **Start it, watch the question arrive, and then leave it alone.** Fifteen seconds later the
    question disappears from every tab of the namespace and the operation leaves the register,
    `failed` with a `TimeoutError`; a tab that was part-way through answering gets 410 while the
    document is still there and 404 once it is dropped, and closes its modal without a word either
    way (TW-DLG-011).

    Those fifteen seconds belong to **this function**. `ask()` has no timeout and must never grow
    one (TW-DLG-005), so a deadline has to be written where the cost of waiting is actually known:
    around the call, by the application. Here that is `asyncio.wait_for`, because the demo is a
    single asyncio process with no Celery anywhere in it. In a deployment it is the worker's own
    execution limit killing the task instead (TW-CELERY-010), which `contrib/celery.py` renders as
    `failed` with code `dialog_timeout` and `retryable: true`. What happens to the operation is the
    same in both: one terminal write, which withdraws every open dialog in the same step
    (TW-CANCEL-011), so no question is ever left on screen pointing at a worker that is gone.

    Answer inside the fifteen seconds and the job finishes normally and parks its decision. Both
    endings are the demonstration - taskwire holds the worker for exactly as long as the user takes,
    and how long that may be is the application's sentence to finish.
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
        # The last quarter of the bar is the decision, so a reader can see the job stop short of
        # finishing rather than at a round 100 %.
        await reporter.set(percent=100 * (index + 1) / (len(checks) + 1), label=check)

    # The deadline is the application's, applied from outside `ask()` and known to nothing inside
    # taskwire. When it expires, `wait_for` cancels the pending `ask()` and raises; the exception
    # walks out of `operation()`, which writes `failed` and withdraws this dialog on the way.
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
"""What the frontend may start, by name. An unknown name is a 404 rather than an import."""
