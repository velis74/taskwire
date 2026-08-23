# What is next, and why

Read `CLAUDE.md` first for orientation; this file is only the queue. An item leaves it when it is
done, not when it is ticked.

---

## 1. Wire `celery_viewset_client`/`server` to taskwire, through a hook fastapi-viewsets owns

taskwire's half is built (`wrap_sync_runner`, TW-CELERY-007). What is missing is not taskwire code
inside fastapi-viewsets — that repository must not gain a dependency on this one — but two hook
slots fastapi-viewsets exposes and taskwire's own `contrib` wires itself into, by name, from this
side only:

1. `decorators/celery_viewset/server.py` gains a module-level settable slot, e.g.
   `set_celery_kwargs_hook(hook: Callable[[Callable, dict], tuple[Callable, dict]] | None)`, called
   in `sync_wrapper` in this order — before `_reconstruct_kwargs`, which passes through any key it
   has no type hint for, so a key the hook did not consume reaches the action as an argument it
   never declared:

   ```python
   run = loop.run_until_complete
   if _celery_kwargs_hook is not None:
       run, kwargs = _celery_kwargs_hook(run, kwargs)
   kwargs = _reconstruct_kwargs(original_endpoint, kwargs, cls)
   result = run(lifecycle_runner(original_endpoint, instance, cls, lifecycle, *args, **kwargs))
   ```

   `taskwire.contrib.celery.wrap_sync_runner` already has exactly this signature — a call with no
   hook installed, or a hook returning its input unchanged, is today's behaviour.
2. `decorators/celery_viewset/client.py` gains the dispatch-side twin, e.g.
   `set_celery_dispatch_hook(hook: Callable[[], Awaitable[dict]] | None)`, awaited in
   `async_client_wrapper` just before `send_task` and merged into its `kwargs`:

   ```python
   extra = await _celery_dispatch_hook() if _celery_dispatch_hook is not None else {}
   celery_app.send_task(
       task_name,
       args=serializable_args,
       kwargs={**serializable_kwargs, "_correlation_id": correlation_id, "_result_queue_key": queue_key, **extra},
   )
   ```

   The hook taskwire registers here reads its own ambient token/session — the same contextvars its
   REST dispatch already reads — and calls `mark_queued` itself; when nothing is bound it returns
   `{}` (TW-AMB-009), so a viewset that never heard of taskwire pays for none of this.

Neither slot is Celery-specific to *taskwire* by name: `hook` is a plain callable fastapi-viewsets
never imports taskwire to type, and a project with no taskwire installed simply never calls
`set_celery_*_hook`. Once both slots exist, taskwire's side is one `taskwire/contrib/celery.py`
addition (the dispatch-side hook function) plus one registration call an application makes at
startup — no `try`/`except ImportError` anywhere, in either repository.

A *generic*, automatic `operation()` middleware that would wrap every viewset action without this
decorator pair is a separate, larger extension point — the one CLAUDE.md already describes as later
work — and is not required for these two hooks.

## 2. A fastapi-viewsets integration page in `docs/`

`getting-started.md` and `websockets.md` both name it, but there is no page that says what taskwire
declares as a viewset, which of the library's mechanisms therefore apply to taskwire's endpoints
(middleware, `@action_configuration`, the context processors), and what `register_muxws` decides.

## 3. Two questions the tab rule cannot answer

Both are `DialogAdoption` reasoning over a register payload that is up to one ceiling interval old,
and both are visible in the demo with two tabs open and no transport.

1. **`isStillOpen` is vacuous exactly when it matters.** The re-check after `dialogAdoptDelay` reads
   the entries the client holds, and without a socket those are a payload up to 5 s old - four times
   the 1200 ms delay it guards. Open a second tab about a second before `hold`'s deadline: its first
   read sees the question open, its timer fires half a second *after* the worker gave up, the
   re-check answers `true` from the stale payload, and a modal goes up for a question the store
   withdrew. It now clears on the next read rather than staying, so the cost is a few seconds of a
   modal about nothing.
2. **The adopt delay governs the first question only.** `DialogAdoption` is keyed by dialog id and
   `App.vue` holds an `Operation`, whose `dialog` is the *oldest open* one - so when `reconcile`'s
   q1 is answered elsewhere and q2 opens, the watching tab's modal never closes and silently becomes
   q2's, with no delay and no `present()` call. TW-TAB-003's rule is skipped rather than delayed. The
   fix is in the page: hold the dialog **id** that was adopted, not the operation.

## 4. Four things the end-to-end run walked past

Found while chasing the socket and the cancel, none of them the defect being chased. In descending
order of what they cost someone who hits them:

1. **An application's own axios interceptor silently disables the token workflow.** `use_taskwire`
   installs its interceptor `synchronous: true`, and axios honours that only when *every* request
   interceptor on the instance is synchronous. An ordinary async one - an auth header, a tracing
   span - pushes taskwire's into a microtask, by which time `run()` has unbound the ambient token:
   `X-Taskwire-Token` is never written, the server mints a token of its own, and the handle the
   caller holds polls an address nothing will ever write. Nothing reports it. The docstring at
   `ts/taskwire.ts:603` describes the mechanism; there is no guard and no diagnostic.
2. **`mute()` / `unmute()` reach no socket.** `Taskwire.overrides` and
   `MuxwsClientTransport.overrides` are two unconnected maps: only the transport's is ever sent, and
   only `watch()` sends it. So the client-side half of TW-DEL-006 is inert, and TW-DEL-023's pruning
   is implemented on the transport's copy alone. Three more client-side symbols have no caller
   outside the specs and belong to the same hole: `ClientTransport.watch`, the transport's own
   `forget()` — TW-DEL-023's client half — and `Operation.setStreamId`, which nothing writes.
3. **A dropped push in the browser leaves no trace, and nothing re-reads.** Bare `catch {}` at
   `ts/muxws.ts:150` and `ts/register.ts:440`, and a silent return when no consumer is attached. The
   Python side logs every equivalent drop at debug (`contrib/muxws.py:86,125,127`). The consequence is
   larger than the silence: a socket that is attached and healthy holds every ladder (TW-TS-007), so
   a terminal envelope that is dropped rather than delivered is never asked for again - the operation
   stays `running` on screen with an open question behind it until the socket is lost. The store is
   the truth, and in that arrangement nothing ever asks it.
4. **A cancel is noticed one `settings.progress_interval` late for a job that does not ask.** The
   sticky flag is re-read inside `_commit` (`taskwire/reporter.py:385,401`), which runs only when the
   throttle window has elapsed - so `set()` called every 0.2 s still raises up to 0.25 s after the
   cancel landed. Bounded and small, but it is not "the next progress call" as TW-CANCEL-002 reads.

A fifth, which is a question rather than a defect: a client that renders only `tw.operations` never
starts the register loop (TW-REG-021), so `readOnce()` returns immediately and a push naming an
unknown token asks for nothing. Whether that client is entitled to TW-TS-009's guarantee at all is
the same question `GAPS.md` records under "when does the register poll start?".

## 5. The `result_ttl` backstop releases nothing

TW-RES-010 names three release paths and says all three are arbitrated by `store.release_result`, so
that `result_released` fires exactly once per artefact. Two of them are: collect and dismiss. The
third is not implemented at all - an uncollected result reaching `result_ttl` is a key expiring,
which fires no hook, writes no `done` and leaves no tombstone. An application that deletes its own
artefact in that hook therefore never hears about the results nobody collected.

Whoever implements it needs a sweeper, and a sweeper is a timer over the keyspace - which is the
shape TW-RET-001 keeps out of the retention rules. The alternative is to strike the third path from
TW-RES-010 and say plainly that an uncollected result expires unreleased.

## Open questions for the author

1. **The OPEN entries in `GAPS.md`**: the Node-only ambient proxy, the `operation()` callback form vs
   `await using`, the TS conformance import path, TW-STORE-014's one-round-trip requirement against
   the port's `-> int` signature, whether `Client` should enforce exactly one of peer/request, the
   `Text.params` vs `Result.params` empty-dict inconsistency, and what the conformance corpus is
   actually for.
