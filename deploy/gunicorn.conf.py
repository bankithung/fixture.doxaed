"""Gunicorn config for the Fixture Platform ASGI app.

Run with: gunicorn -c deploy/gunicorn.conf.py fixture.asgi:application
(working directory = backend/). Uses the Uvicorn worker so a single server
handles both HTTP and Channels WebSocket traffic. Cross-worker live fan-out
goes through the Redis channel layer (REDIS_URL), so multiple workers are safe.
"""
from __future__ import annotations

import multiprocessing
import os
import sys

# Bind to a Unix socket that nginx proxies to (group-readable for www-data).
bind = "unix:/run/fixture/gunicorn.sock"
umask = 0o007

# ASGI worker (HTTP + WebSocket).
# Bounded ASGI worker (deploy/uvicorn_worker.py). Plain UvicornWorker accepts
# unlimited simultaneous requests, and under Django's ASGI path each in-flight
# request costs a thread AND a Postgres connection — six concurrent scorers
# exhausted all 100 slots and crash-looped the workers (2026-08-27). The
# subclass caps in-flight work so overload degrades to a fast 503 instead.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
worker_class = "uvicorn_worker.BoundedUvicornWorker"
# (2*cores)+1 is the SYNC-worker formula and is wrong here: a uvicorn worker
# multiplexes many connections on one event loop, so extra workers buy no
# concurrency and each costs a full resident Django process (~150MB). On the
# 2 vCPU / 1.9GB box that overshoot pushed workers into swap, and every request
# then paid an EBS page-in (measured 2026-08-19: 7-30s responses under load).
# cores+1 keeps a spare for a worker stuck in the sync threadpool.
# cores+1 was still one worker too many for the RAM: measured 475+448+247MB
# resident on a 1.9GB box, which is what pushed Postgres and the workers into
# swap together. Two workers keep ~450MB free for the connection pool.
workers = int(os.environ.get("WEB_CONCURRENCY") or max(2, multiprocessing.cpu_count()))

# Recycle workers periodically to bound memory growth.
max_requests = 1000
max_requests_jitter = 100

# For an ASGI worker this is a HEARTBEAT deadline, not a request deadline: miss
# it and the arbiter SIGKILLs the worker, taking every in-flight request with
# it. A brief event-loop stall under load must not cost six scorers their taps,
# so the ceiling is generous — per-request deadlines belong to nginx
# (proxy_read_timeout) and Postgres (statement_timeout/lock_timeout), which cut
# one request instead of a whole worker.
timeout = 180
graceful_timeout = 30
keepalive = 5

# Trust the X-Forwarded-* set by nginx on the loopback socket.
forwarded_allow_ips = "*"
proxy_protocol = False

# Logging to stdout/stderr -> captured by systemd journal.
accesslog = "-"
errorlog = "-"
loglevel = "info"

proc_name = "fixture-asgi"
