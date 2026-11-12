"""The HTTP header names taskwire reads."""

from __future__ import annotations

TOKEN_HEADER = "X-Taskwire-Token"
"""Carries the caller's token on the request that starts an operation.

A header, never a query parameter (TW-CELERY-011): a query parameter is written to access logs,
browser history and the `Referer` of later requests. A token is an address, not an authorisation
grant (TW-SEC-003).

The caller mints the token; the server never issues one. The client can therefore subscribe before
the request that starts the operation returns.
"""

CONNECTION_HEADER = "X-Taskwire-Connection"
"""Names the connection (TW-REST-002).

On a read it selects the connection for `progress_delivery`; on the request that starts an
operation it sets `origin_connection` (TW-PRIV-001). There is no tab header (TW-PROG-007): the
server never learns a tab id, so it keeps no per-tab index.
"""

CONNECTION_HEADER_BYTES = CONNECTION_HEADER.lower().encode("ascii")
"""The same name as a raw ASGI scope key, which is lower-cased bytes rather than a string."""
