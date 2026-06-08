"""Gunicorn config for the Fixture Platform ASGI app.

Run with: gunicorn -c deploy/gunicorn.conf.py fixture.asgi:application
(working directory = backend/). Uses the Uvicorn worker so a single server
handles both HTTP and Channels WebSocket traffic. Cross-worker live fan-out
goes through the Redis channel layer (REDIS_URL), so multiple workers are safe.
"""
from __future__ import annotations

import multiprocessing

# Bind to a Unix socket that nginx proxies to (group-readable for www-data).
bind = "unix:/run/fixture/gunicorn.sock"
umask = 0o007

# ASGI worker (HTTP + WebSocket).
worker_class = "uvicorn.workers.UvicornWorker"
# 2 vCPU box: (2*cores)+1 is the classic formula; keep modest for an async stack.
workers = max(2, multiprocessing.cpu_count() * 2 + 1)

# Recycle workers periodically to bound memory growth.
max_requests = 1000
max_requests_jitter = 100

timeout = 60
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
