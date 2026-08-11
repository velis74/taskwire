"""The M1 acceptance demo: a single-process FastAPI app with **no** Redis and **no** WebSocket.

Run it:

    pip install "taskwire[fastapi]" uvicorn
    uvicorn examples.demo_fastapi:app --reload

Then, as one "user":

    curl -s localhost:8000/start                  # shared - lands in the register
    curl -s localhost:8000/start?private=1        # private - in nobody's register, still readable
    curl -s localhost:8000/taskwire/operations    # the register, with its percentage-free aggregate
    curl -s localhost:8000/taskwire/<token>       # one snapshot

What this demonstrates, and what to look for:

- a rising `percent` on the register entry, with `[fastapi]` as the only extra installed;
- an `aggregate` carrying counts and a dominated state and **no `percent` key** (TW-REG-011);
- a second caller of the same namespace seeing the shared operation without having started it - and
  seeing nothing at all of the private one (TW-PRIV-002);
- the moment an operation finishes, the very next register read no longer contains it, and neither
  does its per-token GET: there is no linger, no `terminal_ttl` and no tombstone (TW-REG-007).
"""

from __future__ import annotations

import asyncio

from fastapi import FastAPI, Request

import taskwire

from taskwire.contrib.fastapi import router

app = FastAPI(title="taskwire demo")


def session_resolver(request: Request) -> str | None:
    """The only producer of a namespace (TW-AMB-008).

    A real application returns the account when a user is logged in and the session otherwise - an
    identity that is *always present*, since an anonymous visitor still has a session (TW-AMB-009).
    Here a query parameter stands in for that, so two shells can act as two users.
    """
    return request.query_params.get("user", "demo-user")


taskwire.configure(
    store=taskwire.MemoryStore(),
    transport=taskwire.NullTransport(),  # polling does all the work; swapping this changes latency only
    session_resolver=session_resolver,
)

app.include_router(router())


async def slow_import(token: str, session: str, *, rows: int = 3000) -> None:
    """A thirty-second job that reports as it goes.

    Note what is *not* here: no `state=` anywhere (TW-PROG-012 - the state comes from the lifecycle),
    no flush calls (the throttle is inline), and no cleanup of the register entry on the way out
    (leaving the block writes the terminal state and drops the entry in one step).
    """
    async with taskwire.operation(
        token,
        session=session,
        title=taskwire.t("demo.import", text="Importing customers"),
        result_kind="taskwire.panel",
    ) as reporter:
        for row in range(rows):
            await reporter.set(
                percent=100.0 * row / rows,
                label=taskwire.t("demo.row", text=f"row {row} of {rows}", row=row),
                data={"rows_done": row},
            )
            await asyncio.sleep(0.01)


async def private_job(token: str, session: str) -> None:
    """The same thing with **no** `result_kind`, which is the whole of being private (TW-PRIV-001).

    It is in nobody's register, including its own starter's, and is still readable by token.
    """
    async with taskwire.operation(token, session=session, title=taskwire.t(text="Loading page")) as reporter:
        for row in range(200):
            await reporter.set(percent=row / 2.0)
            await asyncio.sleep(0.01)


@app.get("/start")
async def start(request: Request, private: int = 0) -> dict[str, str]:
    """Mint a token, start the work, and return immediately.

    The token is minted here and handed back; no endpoint of taskwire's ever creates one
    (TW-REST-005).
    """
    session = session_resolver(request)
    token = taskwire.new_token()
    job = private_job if private else slow_import
    asyncio.create_task(job(token, session))  # noqa: RUF006 - fire and forget is the demo's point
    return {"token": token, "poll": f"/taskwire/{token}", "register": "/taskwire/operations"}
