"""Tournament-wide live tick fan-out (control room spec 2026-06-12 §2.c).

ONE narrow publish path: after a mutation commits (invariant #4 — publish
post-commit only; callers wrap in ``transaction.on_commit``), a thin "tick"
— ids + a kind, no payload data — fans out to the channel-layer group
``tournament_<id>``. Clients (the control room, the public schedule page via
the SSE stream in ``apps.live.sse``) refetch on tick, the same contract the
``match_<id>`` WS room already uses. Best-effort: delivery failure never
affects the committed write.

Deviation from v1Live §2 [MED]: we fan out via the channel layer (InMemory in
dev, channels_redis in prod), not a second raw Redis pub/sub client — one
publish path for WS + SSE. Topic naming follows the shipped ``match_<id>``
convention.

**Rapid-scoring coalescing (2026-08-27).** A tick is tournament-WIDE, and every
scoring event publishes one. With six scorers tapping points at once that is
six broadcasts a second to every connected client, and every client answers a
tick by refetching a tournament-wide aggregate — so the cost is
``scorers x clients``, not ``scorers``. Two of the consumers (the court overlay
and the venue display) had no client-side debounce at all, so each of those
refetched on every single tap. The tick carries no data — it only says
"something changed" — so collapsing a burst into one tick loses nothing a
refetch would not pick up anyway.

``LIVE_TICK_COALESCE_MS`` (0 = off, the default and what tests run under) turns
on a **leading-edge + trailing-edge** window per tournament: the first tick of
a burst goes out immediately, so the board still moves the instant a point is
scored, and any ticks during the window collapse into ONE trailing tick sent as
the window closes. Leading edge alone would drop the last tap of a rally and
leave the board stale until the next one; that is the whole reason the trailing
flush exists. Coalescing is per-process (each gunicorn worker keeps its own
window) — with N workers the worst case is N ticks per window instead of one
per event, which is still the reduction that matters and needs no cross-worker
coordination.

Only ``score``/``event`` kinds coalesce. ``state``, ``schedule``, ``called``
and ``stream`` are rare and structural (a match went live, a fixture moved), so
they always go out immediately and additionally flush any pending tick, keeping
their ordering behind the burst they follow.
"""
from __future__ import annotations

import logging
import threading
import time

from django.conf import settings

logger = logging.getLogger(__name__)

#: Tick kinds (spec §2.c): what changed, so clients can invalidate narrowly.
#: ``"stream"`` joined the set on 2026-08-05: a watch link is part of the public
#: schedule payload, and writing one used to publish nothing at all — see
#: ``apps.streaming.views._publish_stream_tick`` for the incident.
TICK_KINDS = ("state", "score", "event", "schedule", "called", "stream")

#: The high-frequency kinds — the ones a scorer emits per point. Everything
#: else is structural and always sent immediately.
COALESCING_KINDS = frozenset({"score", "event"})


def tournament_group(tournament_id) -> str:
    return f"tournament_{tournament_id}"


def _coalesce_window_ms() -> int:
    """Read the window per call so a test (or a live settings override) can flip
    it without re-importing the module."""
    try:
        return max(0, int(getattr(settings, "LIVE_TICK_COALESCE_MS", 0) or 0))
    except (TypeError, ValueError):
        return 0


# --------------------------------------------------------------- coalescer
# Guarded by _LOCK, keyed by tournament id (str):
#   _last_sent  monotonic timestamp of the last tick actually put on the wire
#   _pending    the tick payload waiting for the window to close (or None)
#   _timers     the single in-flight flush timer for that tournament
_LOCK = threading.Lock()
_last_sent: dict[str, float] = {}
_pending: dict[str, dict] = {}
_timers: dict[str, threading.Timer] = {}


def _send(group: str, data: dict) -> None:
    """Put one tick on the channel layer. Best-effort by contract."""
    try:
        from asgiref.sync import async_to_sync
        from channels.layers import get_channel_layer

        layer = get_channel_layer()
        if layer is not None:
            async_to_sync(layer.group_send)(
                group, {"type": "tournament.tick", "data": data}
            )
    except Exception:  # pragma: no cover - delivery is best-effort
        logger.exception("publish_tournament_tick fan-out failed")


def _merge(prior: dict | None, incoming: dict) -> dict:
    """Fold a tick into the one already waiting for this tournament.

    Two taps on the SAME match collapse to that match. Taps on DIFFERENT
    matches collapse to ``match_id=None``, which the group's contract already
    defines as "a batch change — refetch the whole day"; naming just one of
    them would tell a client the other match had not moved.
    """
    if prior is None:
        return dict(incoming)
    merged = dict(prior)
    if prior.get("match_id") != incoming.get("match_id"):
        merged["match_id"] = None
    merged["kind"] = incoming.get("kind", prior.get("kind"))
    return merged


def _flush(key: str, group: str) -> None:
    """Window closed — send whatever accumulated, if anything."""
    with _LOCK:
        _timers.pop(key, None)
        data = _pending.pop(key, None)
        if data is None:
            return
        _last_sent[key] = time.monotonic()
    _send(group, data)


def _schedule_flush(key: str, group: str, delay_s: float) -> None:
    """Arm the single trailing flush for this tournament. Caller holds _LOCK."""
    if key in _timers:
        return
    timer = threading.Timer(max(0.0, delay_s), _flush, args=(key, group))
    timer.daemon = True  # a pending tick must never hold up a worker shutdown
    _timers[key] = timer
    timer.start()


def flush_pending_ticks() -> None:
    """Send every tick still waiting on a window. For tests and shutdown."""
    with _LOCK:
        keys = list(_pending.keys())
        for key in keys:
            timer = _timers.pop(key, None)
            if timer is not None:
                timer.cancel()
        items = [(k, _pending.pop(k)) for k in keys]
        now = time.monotonic()
        for key, _data in items:
            _last_sent[key] = now
    for key, data in items:
        _send(tournament_group(key), data)


def reset_tick_coalescing() -> None:
    """Drop all coalescing state without sending. Test isolation only."""
    with _LOCK:
        for timer in _timers.values():
            timer.cancel()
        _timers.clear()
        _pending.clear()
        _last_sent.clear()


def publish_tournament_tick(tournament_id, match_id, kind: str) -> None:
    """Best-effort post-commit fan-out of a thin tick (ids only) to the
    ``tournament_<id>`` group. ``match_id=None`` means a batch change (e.g. a
    cascade that moved more than 10 matches) — clients refetch the whole day.

    High-frequency kinds are coalesced into a leading + trailing tick per
    ``LIVE_TICK_COALESCE_MS`` window; see the module docstring."""
    key = str(tournament_id)
    group = tournament_group(key)
    data = {
        "tournament_id": key,
        "match_id": str(match_id) if match_id else None,
        "kind": kind,
    }

    window_ms = _coalesce_window_ms()
    if window_ms <= 0:
        # Coalescing off: a pure passthrough, byte-for-byte the original path.
        # It records NOTHING — keeping a per-tournament timestamp here would
        # grow a dict that nothing ever evicts, for no benefit.
        _send(group, data)
        return

    if kind not in COALESCING_KINDS:
        # Structural ticks jump the queue but must not overtake the burst they
        # follow, so anything pending goes out first.
        with _LOCK:
            timer = _timers.pop(key, None)
            if timer is not None:
                timer.cancel()
            pending = _pending.pop(key, None)
            _last_sent[key] = time.monotonic()
        if pending is not None:
            _send(group, pending)
        _send(group, data)
        return

    window_s = window_ms / 1000.0
    now = time.monotonic()
    with _LOCK:
        last = _last_sent.get(key)
        if last is None or (now - last) >= window_s:
            # Leading edge — the board moves the instant the point lands.
            _last_sent[key] = now
            send_now = True
        else:
            # Inside the window: fold into the trailing tick.
            _pending[key] = _merge(_pending.get(key), data)
            _schedule_flush(key, group, window_s - (now - last))
            send_now = False
    if send_now:
        _send(group, data)
