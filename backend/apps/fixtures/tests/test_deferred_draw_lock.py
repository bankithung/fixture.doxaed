"""The deferred-draw guard is scoped to ONE competition (2026-08-27 incident).

``materialize_ready_stages`` needs a mutex so two group matches finalising at
the same instant cannot both draw the next knockout (the TOCTOU double-draw
guard — ``test_stage_runner`` covers that behaviour). It used to get that mutex
by taking ``select_for_update`` on the whole Tournament ROW, which is far wider
than the guard needs: it serialised every competition against every other, and
collided with every other writer of that row (state transitions, preview pins).
Under six concurrent scorers that produced a lock convoy 72 backends deep
behind one slow holder, which starved the ASGI workers until gunicorn SIGKILLed
them.

These pin the scope, not the behaviour: a transaction-scoped advisory lock, one
key per (tournament, competition), and the tournament row left alone.
"""
from __future__ import annotations

import uuid

import pytest
from django.db import connection, transaction

from apps.fixtures.services.stages import _lock_deferred_draw

pytestmark = pytest.mark.django_db


def _held_advisory_keys() -> set[int]:
    """The advisory lock keys this session currently holds.

    Postgres splits a 64-bit advisory key across ``classid``/``objid``; we only
    need identity, so recombine them into one comparable number.
    """
    with connection.cursor() as cur:
        cur.execute(
            """
            SELECT classid, objid FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
            """
        )
        return {(int(c) << 32) | int(o) for c, o in cur.fetchall()}


def _tournament_row_locks() -> int:
    """Row-level locks this session holds on the tournaments table."""
    with connection.cursor() as cur:
        cur.execute(
            """
            SELECT count(*) FROM pg_locks l
            JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid = pg_backend_pid()
              AND c.relname = 'tournaments_tournament'
              AND l.mode IN ('RowShareLock', 'ExclusiveLock', 'RowExclusiveLock')
            """
        )
        return int(cur.fetchone()[0])


def test_two_competitions_take_two_different_locks():
    """Table-tennis U-14 drawing its knockout must not block sepak U-16 — that
    is the whole reason the tournament-wide lock had to go."""
    tid = uuid.uuid4()
    with transaction.atomic():
        before = _held_advisory_keys()
        _lock_deferred_draw(tid, "table_tennis.u14.boys")
        after_one = _held_advisory_keys()
        _lock_deferred_draw(tid, "sepak_takraw.u16.boys")
        after_two = _held_advisory_keys()

    assert len(after_one - before) == 1, "first competition takes one lock"
    assert len(after_two - before) == 2, "a second competition takes its OWN lock"


def test_same_competition_is_one_lock():
    """Re-entering the same competition must be the SAME key, or the guard
    would not actually serialise a concurrent double-draw."""
    tid = uuid.uuid4()
    with transaction.atomic():
        before = _held_advisory_keys()
        _lock_deferred_draw(tid, "table_tennis.u14.boys")
        _lock_deferred_draw(tid, "table_tennis.u14.boys")
        held = _held_advisory_keys() - before

    assert len(held) == 1


def test_two_tournaments_take_two_different_locks():
    """A busy meet must not gate a quiet one sharing the process."""
    with transaction.atomic():
        before = _held_advisory_keys()
        _lock_deferred_draw(uuid.uuid4(), "")
        _lock_deferred_draw(uuid.uuid4(), "")
        held = _held_advisory_keys() - before

    assert len(held) == 2


def test_tournament_row_is_left_alone():
    """The regression itself: the guard must not touch the tournament row, or
    it goes straight back to serialising every writer of that row."""
    with transaction.atomic():
        _lock_deferred_draw(uuid.uuid4(), "table_tennis.u14.boys")
        assert _tournament_row_locks() == 0


def test_lock_releases_with_the_transaction():
    """``pg_advisory_xact_lock`` must be the transaction-scoped variant — a
    session-scoped lock would leak across pooled connections forever."""
    tid = uuid.uuid4()
    with transaction.atomic():
        before = _held_advisory_keys()
        with transaction.atomic():  # savepoint; the lock rides the OUTER xact
            _lock_deferred_draw(tid, "x")
        assert len(_held_advisory_keys() - before) == 1
