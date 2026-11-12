# <img src="taskwire-icon.svg" alt="" width="40" height="40" style="vertical-align: middle"> taskwire

Progress reporting and awaitable dialogs for long-running operations, in Python and TypeScript.

A long-running job — an import, a report, a batch — needs to tell whoever started it what it is
doing while it is doing it, and sometimes needs to ask them something before it can continue.
taskwire provides:

- **progress**, with nested subtasks whose percentages compose rather than overwrite
  each other, and commits coalesced to one per interval;
- **awaitable dialogs** — the worker asks a question mid-job and blocks until the answer arrives,
  with the first answer winning across every open tab;
- **cancellation**, cooperative and sticky, which raises in the worker at its next progress call;
- **collectable results** — the job parks a file or a value for later collection and exits,
  holding no worker while the record waits.

## The store holds the state

Every state change is written to the store before anything is pushed, so a dropped, coalesced or
suppressed push never changes what the next read returns. There is no event log, no sequence
numbers and no replay: a client reads current state.

## One protocol, three implementations

| Implementation | Carries the protocol over | Adapter | Needs |
|---|---|---|---|
| local | the process itself, no serialisation | none | nothing |
| REST | request/response polling | `contrib.viewsets`, `contrib.fastapi`, `contrib.asgi` | nothing in core |
| WS | one push per envelope down, the six calls up | `contrib.muxws` | [muxws](https://docs.velis.si/muxws/) |

Swapping one for another changes latency only. Both languages ship the protocol and the operating
half, so a browser-only application runs operations as well as watching them; the adapters, the
Redis store and the Celery entry are Python's, and the polling client and the register are
TypeScript's. See [Transports](https://docs.velis.si/taskwire/guide/transports.html).

## Install

```bash
pip install taskwire                 # core: no runtime dependencies
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
uv sync && npm ci
uv run python demo.py                # then open http://127.0.0.1:5174
```

A night batch over one book: four back-office jobs that between them exercise progress, nested
progress, awaitable dialogs, cancellation and collectable results. See [`demo/README.md`](demo/README.md).

## Status

Pre-1.0. The wire format is versioned independently of the package
(`Envelope.v`), so package semver says nothing about it.

## Links

- [Documentation](https://docs.velis.si/taskwire/)
- [Repository](https://github.com/velis74/taskwire)

## License

MIT. Copyright (c) 2026 Jure Erznožnik.
