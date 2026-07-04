"""P4 — the house-points engine (append-only season ledger + live table)."""
from __future__ import annotations

import uuid

import pytest
from django.core.exceptions import ValidationError as DjangoValidationError
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.teams.models import HousePointEntry, Season, TeamGroup
from apps.teams.services.house_points import award_house_points, season_house_table
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _season():
    u = User.objects.create_user(
        email="houses@test.local", password="FixtureDemo2026!", is_active=True
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    t = create_tournament(user=u, name="Sports Day")
    org = t.organization
    season = Season.objects.create(organization=org, label="2026-27", is_current=True)
    red = TeamGroup.objects.create(
        organization=org, season=season, name="Red House", colour="red"
    )
    blue = TeamGroup.objects.create(
        organization=org, season=season, name="Blue House", colour="blue"
    )
    return u, t, season, red, blue


def test_award_and_table_ranking():
    u, t, season, red, blue = _season()
    award_house_points(
        season=season, group=red, points=7, reason="100m U-14 boys, 1st place",
        by=u, source="result", tournament=t, event_id=uuid.uuid4(),
    )
    award_house_points(
        season=season, group=blue, points=5, reason="100m U-14 boys, 2nd place",
        by=u, source="result", tournament=t, event_id=uuid.uuid4(),
    )
    award_house_points(
        season=season, group=blue, points=10, reason="March past shield",
        by=u, event_id=uuid.uuid4(),  # judged injection
    )

    table = season_house_table(season)
    assert [(r["name"], r["points"]) for r in table] == [
        ("Blue House", 15), ("Red House", 7),
    ]
    row = AuditEvent.objects.filter(event_type="house_points_awarded").latest(
        "created_at"
    )
    assert row.reason == "March past shield"


def test_corrections_append_compensating_rows():
    u, t, season, red, blue = _season()
    award_house_points(
        season=season, group=red, points=7, reason="Relay, 1st",
        by=u, event_id=uuid.uuid4(),
    )
    # Wrong house credited: compensate red, credit blue — never edit.
    award_house_points(
        season=season, group=red, points=-7,
        reason="Correction: relay points were Blue House's", by=u,
        event_id=uuid.uuid4(),
    )
    award_house_points(
        season=season, group=blue, points=7, reason="Relay, 1st (corrected)",
        by=u, event_id=uuid.uuid4(),
    )
    table = {r["name"]: r for r in season_house_table(season)}
    assert table["Red House"]["points"] == 0
    assert table["Red House"]["entries"] == 2  # history preserved
    assert table["Blue House"]["points"] == 7


def test_idempotent_and_guarded():
    u, t, season, red, blue = _season()
    eid = uuid.uuid4()
    for _ in range(2):
        award_house_points(
            season=season, group=red, points=4, reason="Drill cup", by=u,
            event_id=eid,
        )
    assert HousePointEntry.objects.filter(event_id=eid).count() == 1

    with pytest.raises(DjangoValidationError, match="reason_required"):
        award_house_points(season=season, group=red, points=1, reason=" ", by=u)

    other_org_t = create_tournament(
        user=User.objects.create_user(
            email="other@test.local", password="FixtureDemo2026!",
            is_active=True,
        ),
        name="Other",
    )
    foreign_season = Season.objects.create(
        organization=other_org_t.organization, label="2026-27"
    )
    with pytest.raises(DjangoValidationError, match="group_not_in_season"):
        award_house_points(
            season=foreign_season, group=red, points=1, reason="x", by=u,
        )


def test_day_zero_table_shows_all_houses_at_zero():
    u, t, season, red, blue = _season()
    table = season_house_table(season)
    assert [(r["name"], r["points"], r["entries"]) for r in table] == [
        ("Blue House", 0, 0), ("Red House", 0, 0),
    ]


def test_house_api_end_to_end():
    """P4 API: seasons + groups + judged award + live table, org-scoped with
    no existence leak for outsiders."""
    from rest_framework.test import APIClient

    u, t, season, red, blue = _season()
    org = t.organization
    c = APIClient()
    c.force_authenticate(user=u)

    # Create a fresh season + a house through the API.
    r = c.post(f"/api/orgs/{org.id}/seasons/",
               {"label": "2027-28", "is_current": True}, format="json")
    assert r.status_code == 201
    sid = r.data["id"]
    r = c.post(f"/api/orgs/{org.id}/seasons/{sid}/groups/",
               {"name": "Green House", "colour": "green"}, format="json")
    assert r.status_code == 201
    gid = r.data["id"]

    r = c.post(
        f"/api/orgs/{org.id}/seasons/{sid}/house-points/",
        {"group_id": gid, "points": 10, "reason": "March past shield",
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 201

    r = c.get(f"/api/orgs/{org.id}/seasons/{sid}/house-table/")
    assert r.status_code == 200
    assert r.data["table"][0]["name"] == "Green House"
    assert r.data["table"][0]["points"] == 10

    # Outsider: 404, never 403 (no existence leak).
    outsider = User.objects.create_user(
        email="outsider-houses@test.local", password="FixtureDemo2026!",
        is_active=True,
    )
    c2 = APIClient()
    c2.force_authenticate(user=outsider)
    assert c2.get(f"/api/orgs/{org.id}/seasons/").status_code == 404


def test_meet_event_result_scores_the_ladder():
    """P4 meet mode: one entry of placements -> the whole ladder lands
    (7-5-4-3-2-1, x2 relays), idempotently."""
    from apps.teams.services.house_points import record_meet_event_result

    u, t, season, red, blue = _season()
    eid = uuid.uuid4()
    for _ in range(2):  # replayed sheet never double-scores
        record_meet_event_result(
            season=season, event_label="100m U-14 boys",
            placements=[red, blue], by=u, event_id=eid,
        )
    table = {r["name"]: r for r in season_house_table(season)}
    assert table["Red House"]["points"] == 7
    assert table["Blue House"]["points"] == 5

    record_meet_event_result(
        season=season, event_label="4x100m relay U-14",
        placements=[blue, red], by=u, relay=True, event_id=uuid.uuid4(),
    )
    table = {r["name"]: r for r in season_house_table(season)}
    assert table["Blue House"]["points"] == 5 + 14  # 7 x2 relay
    assert table["Red House"]["points"] == 7 + 10   # 5 x2

    # Custom ladder wins (presets, never prisons).
    record_meet_event_result(
        season=season, event_label="Tug of war",
        placements=[red], by=u, place_points=[10], event_id=uuid.uuid4(),
    )
    table = {r["name"]: r for r in season_house_table(season)}
    assert table["Red House"]["points"] == 17 + 10


def test_meet_result_api():
    from rest_framework.test import APIClient

    u, t, season, red, blue = _season()
    c = APIClient()
    c.force_authenticate(user=u)
    r = c.post(
        f"/api/orgs/{t.organization.id}/seasons/{season.id}/meet-results/",
        {"event_label": "Long jump U-17", "placements": [str(blue.id), str(red.id)],
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 201
    assert r.data["entries"] == 2
    assert r.data["table"][0]["name"] == "Blue House"
    assert r.data["table"][0]["points"] == 7
