"""Bounded ASGI worker for the Fixture Platform.

Why this exists (2026-08-27 incident: six scorers, backend crash loop).

Django's ASGI handler runs each sync view under ``sync_to_async``, and asgiref
gives every ``ThreadSensitiveContext`` — i.e. every in-flight request — its own
single-thread executor. Each of those threads gets its own thread-local Django
connection, and with ``ATOMIC_REQUESTS`` that connection holds an open
transaction for the request's whole life. So concurrency was bounded by
NOTHING: in-flight requests = threads = Postgres connections. Measured under
six concurrent scorers: ~95 threads and all 100 Postgres slots taken, at ~20MB
of Postgres backend each — 2GB of connection overhead on a 1.9GB box. The box
went to swap, requests that take 0.06s idle went to 80s, and the event loop
stopped answering gunicorn's heartbeat:

    [CRITICAL] WORKER TIMEOUT (pid:1789971)
    [ERROR] Worker (pid:1789971) was sent SIGKILL! Perhaps out of memory?

SIGKILL drops every in-flight request on that worker, so all six scorers'
requests died together, all six clients retried at once, refilled the fresh
worker, and it repeated. Self-sustaining — it did not recover on its own.

``limit_concurrency`` puts the ceiling back. Past it uvicorn answers 503
immediately instead of accepting work it cannot run: one scorer gets a fast,
retryable error rather than all six losing a worker. Keep it comfortably below
the database's per-app connection budget — the point is that Postgres slots can
never be the thing that runs out first.
"""
from __future__ import annotations

import os

from uvicorn.workers import UvicornWorker


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name) or default))
    except (TypeError, ValueError):
        return default


class BoundedUvicornWorker(UvicornWorker):
    """UvicornWorker with a hard ceiling on simultaneous requests.

    ``WEB_MAX_CONCURRENCY`` is per worker, so the fleet total is that times
    ``WEB_CONCURRENCY``. Default 25 x 2 workers = 50 in-flight, against a
    Postgres ``max_connections`` of 100 — headroom for the SSE streams (which
    hand their connection back before streaming, see apps/live/sse.py), the
    admin, and the superuser reserve.
    """

    CONFIG_KWARGS = {
        **UvicornWorker.CONFIG_KWARGS,
        "limit_concurrency": _int_env("WEB_MAX_CONCURRENCY", 25),
        # Bound how long a kept-alive idle connection ties up a slot.
        "timeout_keep_alive": _int_env("WEB_KEEPALIVE", 5),
    }
