"""The two HTTP header names, in one place.

Four modules read these names: `contrib.celery`, `contrib.fastapi`, `contrib.asgi` and
`contrib.viewsets`. A misspelled header is simply an absent header - the operation runs, reports
nothing to the socket that asked for it, and logs nothing anywhere - so the spelling exists once.

Core, not `contrib`, because they are strings and cost no dependency, and because the integration
layer that wraps every viewset action needs to read them without importing a Celery adapter to do it.
"""

from __future__ import annotations

TOKEN_HEADER = "X-Taskwire-Token"
"""Where the caller's token travels on the request that **starts** an operation.

A **header**, never a query parameter (TW-CELERY-011). A query parameter lands in access logs, in
browser history and in the `Referer` of every subsequent request. A token is an address rather than
an authorization grant (TW-SEC-003), so that is not a confidentiality disaster - but an address in a
log is still an address somebody can poll.

The caller mints the token and sends it; the server does not issue one. That ordering is the whole
workflow: a client that had to wait for the server to name the operation could not subscribe until
the reply came back, and would miss whatever happened in between.
"""

CONNECTION_HEADER = "X-Taskwire-Connection"
"""One header serving two purposes, and there must not be a second (TW-REST-002).

It names the connection for `progress_delivery` on a read, and it is where `origin_connection` comes
from on the request that starts an operation (TW-PRIV-001). The tab header that would have been the
second one is forbidden outright (TW-PROG-007): the server never learns a tab id, because a server
that did would grow a per-tab index nobody could bound.
"""

CONNECTION_HEADER_BYTES = CONNECTION_HEADER.lower().encode("ascii")
"""The same name as a raw ASGI scope key, which is lower-cased bytes rather than a string."""
