# Several operations at once

The case the register exists for: one user, three operations running, a question outstanding on one
of them, and a report waiting to be collected from another.

```bash
pip install "taskwire[fastapi]" uvicorn
uvicorn examples.several-operations.app:app --reload
```

Then, in one shell:

```bash
curl -s 'localhost:8000/start?kind=import'   # asks a question halfway through
curl -s 'localhost:8000/start?kind=report'   # parks a downloadable result
curl -s 'localhost:8000/start?kind=cleanup'  # private: in nobody's register
curl -s localhost:8000/taskwire/operations | python3 -m json.tool
```

What to look for in that register payload:

- `aggregate.state` is **`waiting_input`** as soon as the import asks, even though two other
  operations are running — domination, not majority, because the blocked one is the one needing a
  human;
- `aggregate` has **no `percent` key at all**, and never will;
- the entry holding the question sorts **first**;
- the `cleanup` operation is in **nobody's** register, including its own starter's — it declared no
  `result_kind`, so it is private from start to finish;
- the moment the report parks its result the entry stays in `waiting_input` while **no worker is
  held**, which the log line prints.

Answer the question and collect the report:

```bash
TOKEN=...   # from the register payload
DID=...     # snapshot.dialogs[0].id
curl -s -X POST localhost:8000/taskwire/$TOKEN/dialogs/$DID -H 'content-type: application/json' \
     -d '{"button":"overwrite","values":{}}'
curl -s -X POST localhost:8000/taskwire/$REPORT_TOKEN/collect -i | head -1
```

A second collect answers `404`: collect is not idempotent, because an application that fires
`result_released` twice deletes its artefact twice. A second *dismiss* answers `204`.
