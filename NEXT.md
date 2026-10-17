# What is next, and why

Read `CLAUDE.md` first for orientation; this file is only the queue. An item leaves it when it is
done, not when it is ticked.

---

## 1. `isStillOpen` is vacuous exactly when it matters

`DialogAdoption`'s re-check after `dialogAdoptDelay` reads the entries the client holds, and without
a socket those are a payload up to 5 s old - four times the 1200 ms delay it guards. Open a second
tab about a second before `hold`'s deadline: its first read sees the question open, its timer fires
half a second *after* the worker gave up, the re-check answers `true` from the stale payload, and a
modal goes up for a question the store withdrew. It now clears on the next read rather than staying,
so the cost is a few seconds of a modal about nothing.

## 2. Three things the end-to-end run walked past

Found while chasing the socket and the cancel, none of them the defect being chased. In descending
order of what they cost someone who hits them:

1. **An application's own axios interceptor silently disables the token workflow.** `use_taskwire`
   installs its interceptor `synchronous: true`, and axios honours that only when *every* request
   interceptor on the instance is synchronous. An ordinary async one - an auth header, a tracing
   span - pushes taskwire's into a microtask, by which time `run()` has unbound the ambient token:
   `X-Taskwire-Token` is never written, the server mints a token of its own, and the handle the
   caller holds polls an address nothing will ever write. Nothing reports it. The comment at
   `vue/client/taskwire.ts:132` and the module docstring at `vue/client/taskwire.ts:25` describe the
   mechanism; there is no guard and no diagnostic.
2. **A dropped push in the browser leaves no trace, and nothing re-reads.** Bare `catch {}` at
   `vue/muxws/muxws.ts:220` and `vue/register/register.ts:491`, and a silent return when no consumer is
   attached. The Python side logs every equivalent drop at debug (`contrib/muxws.py:86,125,127`). The consequence is
   larger than the silence: a socket that is attached and healthy holds every ladder (TW-TS-007), so
   a terminal envelope that is dropped rather than delivered is never asked for again - the operation
   stays `running` on screen with an open question behind it until the socket is lost. The store is
   the truth, and in that arrangement nothing ever asks it.
3. **A cancel is noticed one `settings.progress_interval` late for a job that does not ask.** The
   sticky flag is re-read inside `_commit` (`taskwire/reporter.py:385,401`), which runs only when the
   throttle window has elapsed - so `set()` called every 0.2 s still raises up to 0.25 s after the
   cancel landed. Bounded and small, but it is not "the next progress call" as TW-CANCEL-002 reads.

Two client-side symbols still have no caller outside the specs: `Taskwire.overrides` is pruned only
by an explicit `clearOverride()`, never when the operation it names ends - unlike
`MuxwsClientTransport.overrides`, which TW-DEL-023 does prune on its own copy - and
`Operation.setStreamId` (`vue/operation/operation.ts:552`) is written nowhere.

One more, which is a question rather than a defect: a client that renders only `tw.operations` never
starts the register loop (TW-REG-021), so `readOnce()` returns immediately and a push naming an
unknown token asks for nothing. Whether that client is entitled to TW-TS-009's guarantee at all is
the same question `GAPS.md` records under "when does the register poll start?".

## 3. The `result_ttl` backstop releases nothing

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
   actually for; and the TW-EVT-* entry, an expiry for the rev of an event topic without
   subscriptions.
