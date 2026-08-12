"""Three operations at once, in one process, with nothing but `taskwire[fastapi]` installed.

Run it:

    uvicorn examples.several-operations.app:app --reload

The point of this example is not any one operation - it is what the *register* looks like while
three of them are in different states at the same time, which is the case a single-operation demo
never shows.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI, Request

import taskwire

from taskwire.contrib.fastapi import router

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("several-operations")

app = FastAPI(title="taskwire - several operations")


def session_resolver(request: Request) -> str | None:
    """The only producer of a namespace (TW-AMB-008).

    A real application returns the account when a user is logged in and the session otherwise - an
    identity that is always present, since an anonymous visitor still has a session. Here a query
    parameter stands in, so two shells can act as two users of the same account.
    """
    return request.query_params.get("user", "demo-account")


def result_released(snapshot: taskwire.Snapshot) -> None:
    """Where an application deletes its own artefact (TW-RES-011).

    taskwire stores a pointer and never a file, so this is the only place that knows how. It cannot
    prevent the release - it runs after the fact, and an exception out of it is swallowed.
    """
    result = snapshot.progress.result
    log.info("released %s -> %s", snapshot.token[:8], result.kind if result else None)


taskwire.configure(
    store=taskwire.MemoryStore(),
    transport=taskwire.NullTransport(),  # polling does all the work; swapping this changes latency
    session_resolver=session_resolver,
    result_released=result_released,
)
app.include_router(router())


async def an_import(token: str, session: str) -> None:
    """Runs, asks a question halfway through, then finishes.

    While it is asking, the register's aggregate reports `waiting_input` even though two other
    operations are running - domination, not majority (TW-REG-012).
    """
    async with taskwire.operation(
        token,
        session=session,
        title=taskwire.t("demo.import", text="Importing customers"),
        result_kind="demo.import_report",
    ) as reporter:
        loading, writing = reporter.split(1, 3)

        for row in range(300):
            await loading.set(percent=row / 3.0)
            await asyncio.sleep(0.01)

        answer = await reporter.ask(
            "demo.overwrite",
            buttons=["overwrite", "skip"],
            title=taskwire.t("demo.conflict", text="Some rows already exist"),
        )
        log.info("import %s answered %r", token[:8], answer.button)

        for row in range(300):
            await writing.set(percent=row / 3.0)
            await asyncio.sleep(0.01)


async def a_report(token: str, session: str) -> None:
    """Runs, then parks a downloadable result and **exits**.

    The operation stays in `waiting_input` holding the result, and no worker is held while it does -
    that is TW-RES-005, and the log line below is written before anybody has collected anything.
    """
    async with taskwire.operation(
        token,
        session=session,
        title=taskwire.t("demo.report", text="Generating report"),
        result_kind="taskwire.download",
    ) as reporter:
        for step in range(200):
            await reporter.set(percent=step / 2.0)
            await asyncio.sleep(0.01)
        await reporter.set_result(
            taskwire.Result.download(
                href="https://cdn.example.test/report.csv",
                mime="text/csv",
                label=taskwire.t("demo.download", text="customers.csv"),
            )
        )
    log.info("report %s: worker free, result still uncollected", token[:8])


async def a_private_cleanup(token: str, session: str) -> None:
    """No `result_kind`, so **private from start to finish** (TW-PRIV-001).

    It is in nobody's register, including its own starter's, and it is still readable by token -
    privacy governs listing and fan-out, never reach (TW-SEC-003).
    """
    async with taskwire.operation(token, session=session, title=taskwire.t(text="Tidying up")) as reporter:
        # Deliberately the longest of the three, so it is still running while you look at the
        # register. A terminal operation with nothing to collect is dropped in the same step it
        # becomes terminal (TW-REG-007), so a short private job is gone before you can observe that
        # it was unlisted - which looks like the same 404 as "never existed".
        for step in range(900):
            await reporter.set(percent=step / 9.0)
            await asyncio.sleep(0.01)


JOBS = {"import": an_import, "report": a_report, "cleanup": a_private_cleanup}


@app.get("/start")
async def start(request: Request, kind: str = "import") -> dict[str, str]:
    """Mint a token, start the work, return immediately.

    The token is minted here and handed back; no taskwire endpoint ever creates one (TW-REST-005).
    """
    session = session_resolver(request)
    token = taskwire.new_token()
    job = JOBS.get(kind, an_import)
    asyncio.create_task(job(token, session))  # noqa: RUF006 - fire and forget is the demo's point
    return {"token": token, "kind": kind, "register": "/taskwire/operations"}


@app.get("/start-all")
async def start_all(request: Request) -> dict[str, str]:
    """All three at once - the state the register exists to render."""
    session = session_resolver(request)
    tokens = {}
    for kind, job in JOBS.items():
        token = taskwire.new_token()
        tokens[kind] = token
        asyncio.create_task(job(token, session))  # noqa: RUF006
    return tokens
