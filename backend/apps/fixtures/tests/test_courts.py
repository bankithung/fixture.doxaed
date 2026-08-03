"""Court as a first-class entity (2026-08-03).

``Match.venue`` used to be the ONLY record of which surface a match is played
on — a synthesised string ("Hall · T3") with no row behind it. ``Court`` gives
it a row (so a stream URL / overlay key / per-court crew can hang off it) while
``Match.venue`` stays as the denormalised display string every existing reader
still keys off. These tests pin the three things that can rot:

* the Court row's identity + soft-delete-aware uniqueness, and tenant isolation
  (invariant 2) on the read API;
* the backfill that derives courts from already-scheduled matches — including
  the court-suffixed and bare-venue shapes, idempotency, ``--dry-run`` and the
  "no Venue row → skip, never invent one" rule;
* the FOUR writers of ``Match.venue`` keeping ``venue == court.name``, and
  ``reflow_from_actual`` continuing to move only the clock, never the court.
"""
from __future__ import annotations

import io
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.models import Court, Venue
from apps.fixtures.services.courts import court_index_of, resolve_court
from apps.fixtures.services.repair import reflow_from_actual, swap_slots
from apps.fixtures.services.scheduler import apply_schedule
from apps.matches.models import Match, MatchStatus
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(prefix: str = "court"):
    u = User.objects.create_user(
        email=f"{prefix}-{uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _tournament(admin=None, *, name="Court Cup", n_teams: int = 6):
    """A tournament with ``n_teams`` teams and a "Hall" (4 courts) + "Main
    Ground" (1 court) venue pool — the two real-world shapes."""
    admin = admin or _verified()
    t = create_tournament(user=admin, name=name)
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i}", "players": []} for i in range(n_teams)],
    )
    Venue.objects.create(organization=t.organization, name="Hall", count=4)
    Venue.objects.create(organization=t.organization, name="Main Ground", count=1)
    t.scheduling_config = {
        "date_start": "2026-08-01", "date_end": "2026-08-03",
        "venues": ["Hall", "Main Ground"], "slot_minutes": 60,
        "rest_minutes": 0, "max_per_team_per_day": 9,
    }
    t.save(update_fields=["scheduling_config"])
    return admin, t


def _matches(t, venues: list[str], *, day: int = 1):
    """One SCHEDULED match per entry in ``venues``, hourly from 09:00, each
    between its own pair of teams (no shared-team coupling)."""
    tz = ZoneInfo(t.time_zone)
    teams = list(Team.objects.filter(tournament=t).order_by("name"))
    out = []
    for i, v in enumerate(venues):
        out.append(Match.objects.create(
            organization=t.organization, tournament=t, round_no=1, match_no=i + 1,
            home_team=teams[2 * i], away_team=teams[2 * i + 1],
            status=MatchStatus.SCHEDULED,
            scheduled_at=datetime(2026, 8, day, 9 + i, 0, tzinfo=tz), venue=v,
        ))
    return out


# --------------------------------------------------------------- the Court row
def test_court_name_and_index_round_trip_the_scheduler_format():
    _admin, t = _tournament()
    hall = Venue.objects.get(organization=t.organization, name="Hall")
    c = Court.objects.create(
        organization=t.organization, venue=hall, name="Hall · T3", index=3
    )
    assert str(c) == "Hall · T3"
    assert c.venue.courts.count() == 1
    assert court_index_of("Hall · T3", "Hall") == 3
    assert court_index_of("Main Ground", "Main Ground") == 1


def test_duplicate_court_name_under_one_venue_is_rejected():
    _admin, t = _tournament()
    hall = Venue.objects.get(organization=t.organization, name="Hall")
    Court.objects.create(
        organization=t.organization, venue=hall, name="Hall · T1", index=1
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        Court.objects.create(
            organization=t.organization, venue=hall, name="Hall · T1", index=1
        )


def test_same_name_is_allowed_again_after_a_soft_delete():
    _admin, t = _tournament()
    hall = Venue.objects.get(organization=t.organization, name="Hall")
    first = Court.objects.create(
        organization=t.organization, venue=hall, name="Hall · T1", index=1
    )
    first.deleted_at = timezone.now()
    first.save(update_fields=["deleted_at"])
    again = Court.objects.create(
        organization=t.organization, venue=hall, name="Hall · T1", index=1
    )
    assert again.id != first.id
    # ...and the same name under a DIFFERENT venue was never blocked.
    ground = Venue.objects.get(organization=t.organization, name="Main Ground")
    Court.objects.create(
        organization=t.organization, venue=ground, name="Hall · T1", index=1
    )


# ----------------------------------------------------------- resolve_court seam
def test_resolve_court_creates_once_and_derives_the_index():
    _admin, t = _tournament()
    first = resolve_court(t.organization, "Hall · T2")
    second = resolve_court(t.organization, "Hall · T2")
    assert first is not None and first.id == second.id
    assert (first.name, first.index, first.venue.name) == ("Hall · T2", 2, "Hall")
    bare = resolve_court(t.organization, "Main Ground")
    assert bare is not None and (bare.index, bare.venue.name) == (1, "Main Ground")
    assert Court.objects.filter(organization=t.organization).count() == 2


def test_resolve_court_never_invents_a_venue_row():
    _admin, t = _tournament()
    assert resolve_court(t.organization, "Nowhere Field") is None
    assert resolve_court(t.organization, "") is None
    assert Court.objects.filter(organization=t.organization).count() == 0
    assert Venue.objects.filter(organization=t.organization).count() == 2


def test_resolve_court_keeps_a_stranded_court_on_its_hall():
    """"Hall · T9" after ``count`` dropped to 4 still belongs to the hall —
    the same rule ``court_base_of`` gives the scheduler/validator."""
    _admin, t = _tournament()
    c = resolve_court(t.organization, "Hall · T9")
    assert c is not None and (c.venue.name, c.index) == ("Hall", 9)


# ------------------------------------------------------------------- read API
def test_courts_listing_and_detail():
    admin, t = _tournament()
    resolve_court(t.organization, "Hall · T2")
    resolve_court(t.organization, "Main Ground")
    c = _client(admin)

    r = c.get(f"/api/tournaments/{t.id}/courts/")
    assert r.status_code == 200, r.content
    rows = r.json()["courts"]
    assert [x["name"] for x in rows] == ["Hall · T2", "Main Ground"]
    assert rows[0]["venue_name"] == "Hall" and rows[0]["index"] == 2

    hall = Venue.objects.get(organization=t.organization, name="Hall")
    r2 = c.get(f"/api/tournaments/{t.id}/courts/?venue={hall.id}")
    assert [x["name"] for x in r2.json()["courts"]] == ["Hall · T2"]

    r3 = c.get(f"/api/tournaments/{t.id}/courts/{rows[0]['id']}/")
    assert r3.status_code == 200
    assert r3.json()["name"] == "Hall · T2"


def test_courts_read_requires_authentication():
    _admin, t = _tournament()
    r = APIClient().get(f"/api/tournaments/{t.id}/courts/")
    assert r.status_code in (401, 403)


def test_courts_are_isolated_across_organizations():
    """Invariant 2: a user in workspace A can neither list nor retrieve
    workspace B's courts, and gets 404 (never 403) — no existence leak."""
    admin_a, t_a = _tournament(name="A Cup")
    admin_b, t_b = _tournament(name="B Cup")
    assert t_a.organization_id != t_b.organization_id
    court_a = resolve_court(t_a.organization, "Hall · T1")
    court_b = resolve_court(t_b.organization, "Hall · T1")
    assert court_a is not None and court_b is not None

    ca, cb = _client(admin_a), _client(admin_b)

    # A's listing shows only A's court.
    ids_a = {x["id"] for x in ca.get(f"/api/tournaments/{t_a.id}/courts/").json()["courts"]}
    assert ids_a == {str(court_a.id)}

    # A cannot reach B's tournament at all...
    assert ca.get(f"/api/tournaments/{t_b.id}/courts/").status_code == 404
    assert ca.get(
        f"/api/tournaments/{t_b.id}/courts/{court_b.id}/"
    ).status_code == 404
    # ...nor smuggle B's court id through A's own tournament.
    assert ca.get(
        f"/api/tournaments/{t_a.id}/courts/{court_b.id}/"
    ).status_code == 404
    # Symmetric for B.
    assert cb.get(f"/api/tournaments/{t_a.id}/courts/").status_code == 404


def test_soft_deleted_court_disappears_from_the_api():
    admin, t = _tournament()
    c = resolve_court(t.organization, "Hall · T1")
    assert c is not None
    c.deleted_at = timezone.now()
    c.save(update_fields=["deleted_at"])
    client = _client(admin)
    assert client.get(f"/api/tournaments/{t.id}/courts/").json()["courts"] == []
    assert client.get(
        f"/api/tournaments/{t.id}/courts/{c.id}/"
    ).status_code == 404


# -------------------------------------------------------------------- backfill
def _backfill(*args) -> str:
    out = io.StringIO()
    call_command("backfill_courts", *args, stdout=out)
    return out.getvalue()


def test_backfill_creates_courts_from_real_venue_strings():
    _admin, t = _tournament()
    m_court, m_bare, m_other = _matches(
        t, ["Hall · T3", "Main Ground", "Hall · T3"]
    )
    out = _backfill()
    assert "courts created: 2" in out
    assert "matches linked: 3" in out
    assert "matches skipped: 0" in out

    for m in (m_court, m_bare, m_other):
        m.refresh_from_db()
        assert m.court is not None
        assert m.venue == m.court.name

    m_court.refresh_from_db()
    m_other.refresh_from_db()
    assert m_court.court_id == m_other.court_id       # one row per court
    assert (m_court.court.venue.name, m_court.court.index) == ("Hall", 3)
    m_bare.refresh_from_db()
    assert (m_bare.court.venue.name, m_bare.court.index) == ("Main Ground", 1)


def test_backfill_is_idempotent():
    _admin, t = _tournament()
    _matches(t, ["Hall · T3", "Main Ground"])
    _backfill()
    courts = {(c.id, c.name) for c in Court.objects.all()}
    links = {
        (m.id, m.court_id)
        for m in Match.objects.filter(tournament=t)
    }
    out = _backfill()
    assert "courts created: 0" in out
    assert "matches linked: 0" in out
    assert {(c.id, c.name) for c in Court.objects.all()} == courts
    assert {
        (m.id, m.court_id) for m in Match.objects.filter(tournament=t)
    } == links


def test_backfill_dry_run_writes_nothing():
    _admin, t = _tournament()
    _matches(t, ["Hall · T3", "Main Ground"])
    out = _backfill("--dry-run")
    assert out.startswith("[dry-run] ")
    assert "courts created: 2" in out
    assert "matches linked: 2" in out
    assert Court.objects.count() == 0
    assert Match.objects.filter(tournament=t, court__isnull=False).count() == 0
    # The real run then does exactly what the dry run promised.
    assert "courts created: 2" in _backfill()
    assert Court.objects.count() == 2


def test_backfill_skips_matches_whose_base_venue_has_no_row():
    _admin, t = _tournament()
    known, unknown = _matches(t, ["Hall · T1", "Rented Pitch · T2"])
    out = _backfill()
    assert "courts created: 1" in out
    assert "matches linked: 1" in out
    assert "matches skipped: 1" in out
    assert "'Rented Pitch · T2': 1 match(es)" in out
    known.refresh_from_db()
    unknown.refresh_from_db()
    assert known.court is not None
    assert unknown.court is None
    assert unknown.venue == "Rented Pitch · T2"   # string untouched
    assert Venue.objects.filter(organization=t.organization).count() == 2


def test_backfill_ignores_unscheduled_and_deleted_matches():
    _admin, t = _tournament()
    blank, gone = _matches(t, ["", "Hall · T1"])
    gone.deleted_at = timezone.now()
    gone.save(update_fields=["deleted_at"])
    out = _backfill()
    assert "courts created: 0" in out
    assert "matches linked: 0" in out
    blank.refresh_from_db()
    gone.refresh_from_db()
    assert blank.court is None and gone.court is None


def test_backfill_scopes_to_one_tournament():
    admin, t1 = _tournament(name="Scoped Cup")
    _admin2, t2 = _tournament(admin, name="Other Cup")
    in_scope = _matches(t1, ["Hall · T1"])[0]
    out_scope = _matches(t2, ["Hall · T2"])[0]
    out = _backfill("--tournament", str(t1.id))
    assert "matches linked: 1" in out
    in_scope.refresh_from_db()
    out_scope.refresh_from_db()
    assert in_scope.court is not None
    assert out_scope.court is None


# ------------------------------------------------------------ the four writers
def test_reschedule_endpoint_sets_the_court_and_keeps_venue_in_sync():
    admin, t = _tournament()
    m = _matches(t, ["Hall · T1"])[0]
    r = _client(admin).patch(
        f"/api/matches/{m.id}/schedule/",
        {"venue": "Hall · T4", "force": True},
        format="json",
    )
    assert r.status_code == 200, r.content
    m.refresh_from_db()
    assert m.venue == "Hall · T4"
    assert m.court is not None and m.court.name == m.venue
    assert m.court.index == 4


def test_reschedule_leaves_the_court_null_for_an_unknown_venue():
    """Back-compat: an off-grid venue string still writes, the FK just stays
    null — the string remains authoritative."""
    admin, t = _tournament()
    m = _matches(t, ["Hall · T1"])[0]
    _client(admin).patch(
        f"/api/matches/{m.id}/schedule/",
        {"venue": "Rented Pitch", "force": True},
        format="json",
    )
    m.refresh_from_db()
    assert m.venue == "Rented Pitch"
    assert m.court is None


def test_swap_slots_swaps_the_court_alongside_the_string():
    admin, t = _tournament()
    a, b = _matches(t, ["Hall · T1", "Hall · T2"])
    _backfill()
    a.refresh_from_db()
    b.refresh_from_db()
    court_a, court_b = a.court_id, b.court_id
    assert court_a != court_b

    swap_slots(tournament=t, match_a=a.id, match_b=b.id, by=admin, force=True)
    a.refresh_from_db()
    b.refresh_from_db()
    assert (a.venue, b.venue) == ("Hall · T2", "Hall · T1")
    assert (a.court_id, b.court_id) == (court_b, court_a)
    assert a.venue == a.court.name and b.venue == b.court.name


def test_swap_slots_backfills_a_null_court_it_meets():
    """A slot written before the FK existed still ends up consistent."""
    admin, t = _tournament()
    a, b = _matches(t, ["Hall · T1", "Hall · T2"])
    assert a.court_id is None and b.court_id is None
    swap_slots(tournament=t, match_a=a.id, match_b=b.id, by=admin, force=True)
    a.refresh_from_db()
    b.refresh_from_db()
    assert a.court is not None and a.venue == a.court.name == "Hall · T2"
    assert b.court is not None and b.venue == b.court.name == "Hall · T1"


def test_apply_schedule_writes_the_court_with_the_slot():
    admin, t = _tournament(n_teams=4)
    _matches(t, ["", ""])
    res = apply_schedule(
        tournament=t, config=dict(t.scheduling_config), by=admin
    )
    assert res.assignments
    for m in Match.objects.filter(tournament=t):
        assert m.venue
        assert m.court is not None, m.venue
        assert m.court.name == m.venue
        assert m.court.organization_id == t.organization_id
    # One Court row per distinct surface, however many matches land on it.
    names = set(Match.objects.filter(tournament=t).values_list("venue", flat=True))
    assert Court.objects.filter(organization=t.organization).count() == len(names)


def test_apply_schedule_leaves_the_court_null_for_unconfigured_venues():
    admin, t = _tournament(n_teams=4)
    _matches(t, ["", ""])
    cfg = dict(t.scheduling_config)
    cfg["venues"] = ["Borrowed Field"]      # no Venue row for this name
    apply_schedule(tournament=t, config=cfg, by=admin)
    rows = list(Match.objects.filter(tournament=t))
    assert any(m.venue == "Borrowed Field" for m in rows)
    assert all(m.court_id is None for m in rows)
    assert Court.objects.count() == 0


def test_reflow_from_actual_never_reassigns_the_court():
    """R11 re-timing moves the clock only — the court FK (and its string) must
    come out of a reflow byte-identical."""
    _admin, t = _tournament()
    tz = ZoneInfo(t.time_zone)
    cfg = dict(t.scheduling_config)
    cfg["auto_reflow"] = True
    cfg["venues"] = ["Hall"]
    t.scheduling_config = cfg
    t.save(update_fields=["scheduling_config"])
    m1, m2, m3 = _matches(t, ["Hall · T1", "Hall · T1", "Hall · T1"])
    _backfill()
    before = {
        m.id: (m.court_id, m.venue)
        for m in Match.objects.filter(tournament=t)
    }
    assert all(c is not None for c, _v in before.values())

    m1.refresh_from_db()
    m1.ended_at = datetime(2026, 8, 1, 10, 30, tzinfo=tz)   # 30' over
    m1.save(update_fields=["ended_at"])
    moved = reflow_from_actual(m1.id)
    assert {x["match_id"] for x in moved} == {str(m2.id), str(m3.id)}

    after = {
        m.id: (m.court_id, m.venue)
        for m in Match.objects.filter(tournament=t)
    }
    assert after == before
    m2.refresh_from_db()
    assert m2.scheduled_at.astimezone(tz).hour == 10   # the clock DID move
    assert m2.scheduled_at.astimezone(tz).minute == 30
