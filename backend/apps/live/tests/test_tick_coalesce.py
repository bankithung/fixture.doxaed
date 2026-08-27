"""Rapid-scoring tick coalescing (2026-08-27 incident).

Six scorers tapping points at once published six tournament-WIDE ticks a
second, and every connected client answers a tick by refetching a
tournament-wide aggregate — so the load was ``scorers x clients``. These pin
the contract that makes a burst cheap without making the board stale:

  * the FIRST tick of a burst goes out immediately (the board moves on the tap),
  * ticks inside the window collapse into ONE trailing tick (the last tap is
    never lost — that is the whole point of the trailing edge),
  * ticks for different matches collapse to ``match_id=None``, the group's
    existing "batch change, refetch the day" contract,
  * structural kinds (state/schedule/called/stream) never coalesce, and never
    overtake a burst they follow,
  * with the window off (the default, and what every other test runs under)
    the path is byte-for-byte what it always was.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.test import override_settings

from apps.live.publish import (
    flush_pending_ticks,
    publish_tournament_tick,
    reset_tick_coalescing,
    tournament_group,
)


@pytest.fixture(autouse=True)
def _clean_coalescer():
    reset_tick_coalescing()
    yield
    reset_tick_coalescing()


def _subscribe(group: str):
    layer = get_channel_layer()
    channel = async_to_sync(layer.new_channel)()
    async_to_sync(layer.group_add)(group, channel)
    return layer, channel


def _ticks(layer, channel) -> list[dict]:
    msgs: list[dict] = []

    async def pull():
        while True:
            try:
                msgs.append(
                    await asyncio.wait_for(layer.receive(channel), timeout=0.2)
                )
            except TimeoutError:
                return

    async_to_sync(pull)()
    return [m["data"] for m in msgs if m["type"] == "tournament.tick"]


@override_settings(LIVE_TICK_COALESCE_MS=0)
def test_window_off_publishes_every_tick():
    """The default. Every other test in the suite depends on this staying true."""
    tid, mid = uuid.uuid4(), uuid.uuid4()
    layer, chan = _subscribe(tournament_group(tid))

    for _ in range(4):
        publish_tournament_tick(tid, mid, "score")

    assert _ticks(layer, chan) == [
        {"tournament_id": str(tid), "match_id": str(mid), "kind": "score"}
    ] * 4


@override_settings(LIVE_TICK_COALESCE_MS=10_000)
def test_burst_sends_leading_tick_immediately():
    """A scored point must move the board at once — not after the window."""
    tid, mid = uuid.uuid4(), uuid.uuid4()
    layer, chan = _subscribe(tournament_group(tid))

    for _ in range(6):  # six scorers, one window
        publish_tournament_tick(tid, mid, "score")

    # Exactly one on the wire: the leading edge. The other five are pending.
    assert _ticks(layer, chan) == [
        {"tournament_id": str(tid), "match_id": str(mid), "kind": "score"}
    ]


@override_settings(LIVE_TICK_COALESCE_MS=10_000)
def test_trailing_tick_is_never_lost():
    """The last tap of a rally must still reach clients, or the board goes
    stale until whenever the next point happens to be scored."""
    tid, mid = uuid.uuid4(), uuid.uuid4()
    layer, chan = _subscribe(tournament_group(tid))

    publish_tournament_tick(tid, mid, "score")  # leading
    for _ in range(5):
        publish_tournament_tick(tid, mid, "score")  # collapse into one trailing
    assert len(_ticks(layer, chan)) == 1

    flush_pending_ticks()  # window closes
    assert _ticks(layer, chan) == [
        {"tournament_id": str(tid), "match_id": str(mid), "kind": "score"}
    ]


@override_settings(LIVE_TICK_COALESCE_MS=10_000)
def test_different_matches_collapse_to_batch():
    """Naming one of two moved matches would tell a client the other had not
    moved; ``match_id=None`` is the existing "refetch the day" contract."""
    tid = uuid.uuid4()
    a, b = uuid.uuid4(), uuid.uuid4()
    layer, chan = _subscribe(tournament_group(tid))

    publish_tournament_tick(tid, a, "score")  # leading
    publish_tournament_tick(tid, a, "score")
    publish_tournament_tick(tid, b, "score")  # a different match joins
    _ticks(layer, chan)

    flush_pending_ticks()
    assert _ticks(layer, chan) == [
        {"tournament_id": str(tid), "match_id": None, "kind": "score"}
    ]


@override_settings(LIVE_TICK_COALESCE_MS=10_000)
def test_structural_kind_flushes_burst_then_sends():
    """A match going live is rare and important: it is sent at once, and it
    must not overtake the score burst it follows."""
    tid, mid = uuid.uuid4(), uuid.uuid4()
    layer, chan = _subscribe(tournament_group(tid))

    publish_tournament_tick(tid, mid, "score")  # leading
    publish_tournament_tick(tid, mid, "score")  # pending
    assert len(_ticks(layer, chan)) == 1

    publish_tournament_tick(tid, mid, "state")
    assert _ticks(layer, chan) == [
        {"tournament_id": str(tid), "match_id": str(mid), "kind": "score"},
        {"tournament_id": str(tid), "match_id": str(mid), "kind": "state"},
    ]


@override_settings(LIVE_TICK_COALESCE_MS=10_000)
def test_one_tournament_does_not_gate_another():
    """The window is per tournament — a busy meet must not silence a quiet one
    running on the same worker."""
    t1, t2, mid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    layer, c1 = _subscribe(tournament_group(t1))
    _, c2 = _subscribe(tournament_group(t2))

    publish_tournament_tick(t1, mid, "score")
    publish_tournament_tick(t1, mid, "score")
    publish_tournament_tick(t2, mid, "score")

    assert len(_ticks(layer, c1)) == 1
    assert len(_ticks(layer, c2)) == 1


@override_settings(LIVE_TICK_COALESCE_MS=50)
def test_window_reopens_after_it_elapses():
    """A later tap is a new burst, not part of the old one."""
    import time

    tid, mid = uuid.uuid4(), uuid.uuid4()
    layer, chan = _subscribe(tournament_group(tid))

    publish_tournament_tick(tid, mid, "score")
    assert len(_ticks(layer, chan)) == 1
    time.sleep(0.12)
    publish_tournament_tick(tid, mid, "score")
    assert len(_ticks(layer, chan)) == 1
