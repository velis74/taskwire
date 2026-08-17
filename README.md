# taskwire

Progress reporting and awaitable dialogs for long-running operations, in Python and TypeScript.

A long-running job — an import, a report, a batch — needs to tell whoever started it what it is
doing while it is doing it, and sometimes needs to ask them something before it can continue.
taskwire is that conversation, and the four things it carries:

- **progress**, with nested subtasks whose percentages compose correctly rather than overwriting
  each other, and commits coalesced so a tight loop cannot flood anything;
- **awaitable dialogs** — the worker asks a question mid-job and blocks until the answer arrives,
  with the first answer winning across every tab that is looking;
- **cancellation**, cooperative and sticky, which raises in the worker at its next progress call;
- **collectable results** — the job parks a file or a value for later collection and *exits*,
  holding no worker while the record waits.

## The one idea worth knowing

**The store is the truth; a push is only an accelerator.** Every state change is written before
anything is sent anywhere, so a dropped, coalesced or suppressed push never changes what the next
read returns. There is no event log, no sequence numbers and no replay: a client is entitled to
current state, and asking for it is always enough.

## One protocol, three implementations

The layering is deliberate and is the shape of the source tree, not just of the prose:

```
             protocol            documents, envelopes, the six kinds, the state
                 │               machines, validation.  Knows of no transport.
     ┌───────────┼───────────┐
   local        REST         WS         three independent implementations of it
     │           │           │
  (none)   fastapi / asgi   muxws       one adapter each, to the world outside
```

The **protocol** is specified once and depends on nothing. Each **implementation** carries it over
one medium and is written against the protocol layer alone, never against another implementation.
Each **adapter** is the thin piece that binds an implementation to a particular framework, and is
the only place that framework is imported.

| Implementation | Carries the protocol over | Adapter | Needs |
|---|---|---|---|
| **local** | the process itself — no wire, no socket, no serialization | none | nothing |
| **REST** | request/response polling; the baseline everywhere | `contrib.fastapi`, `contrib.asgi` | nothing in core |
| **WS** | one push per envelope down, the six calls up, lowest latency | `contrib.muxws` | [muxws](https://docs.velis.si/muxws/) |

Swapping one for another changes latency and nothing else — no feature, no state, no document.
Both languages ship all of it, so a browser-only application and a back-end-only service are the
same deployment seen from two sides.

## Install

```bash
pip install taskwire                 # core: no runtime dependencies at all
pip install "taskwire[redis]"        # cross-process store and backplane
pip install "taskwire[fastapi]"      # the REST adapter
pip install "taskwire[viewsets]"     # the REST API as a fastapi-viewsets viewset
pip install "taskwire[celery]"       # the worker entry point
pip install "taskwire[muxws]"        # the WebSocket transport
```

```bash
npm install taskwire
```

## The demo

```bash
pip install -e ".[fastapi,viewsets,demo]" && npm install
python demo.py                       # then open http://127.0.0.1:5174
```

A night batch over one book: three back-office jobs that between them exercise progress, nested
progress, awaitable dialogs, cancellation and collectable results. See [`demo/README.md`](demo/README.md).

## Status

Pre-1.0 and under active construction. The wire format is versioned independently of the package
(`Envelope.v`), so package semver says nothing about it.

## Links

- [Documentation](https://docs.velis.si/taskwire/)
- [Repository](https://github.com/velis74/taskwire)

## License

MIT. Copyright (c) 2026 Jure Erznožnik.
