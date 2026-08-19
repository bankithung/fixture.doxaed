"""A crest travels in the same dict as the team name it belongs to.

Owner 2026-08-19: a school's badge must show "anywhere a fixture is shown".
That only holds if the crest ships WITH the name — a surface that has to make a
second call for it is a surface that will forget to. So every team stub carries
``crest`` and every flat home/away pair carries ``home_crest``/``away_crest``.

Two rules the payloads must never break, both asserted below:

- the value is always a STRING ("" when there is no badge), never null, so a
  renderer can fall back to initials without a null check;
- it survives to an unauthenticated visitor, because the crest URL is a signed
  capability rather than a session-gated read.
"""
from __future__ import annotations

import uuid as _uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.matches.models import Match, MatchStatus
from apps.matches.serializers import MatchSerializer
from apps.matches.services.records import team_record
from apps.matches.services.standings import compute_standings
from apps.teams.models import Institution, Team
from apps.teams.services.registration import register_school
from apps.tournaments.models import Tournament, TournamentStatus
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _admin():
    u = User.objects.create_user(
        email=f"crestpay-{_uuid.uuid4().hex[:8]}@test.local",
        password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _cup():
    """One badged school and one bare one, meeting in a completed match.

    The badge sits on the INSTITUTION (where the team form puts it), not on the
    team, so this also proves the resolver walks team -> school.
    """
    admin = _admin()
    t = create_tournament(user=admin, name="Crest Payload Cup")
    Tournament.objects.filter(pk=t.pk).update(status=TournamentStatus.SCHEDULED)
    t.refresh_from_db()

    (badged,) = register_school(
        tournament=t, school_name="Badged High",
        teams=[{"name": "Badged High A", "players": []}],
    )
    (bare,) = register_school(
        tournament=t, school_name="Bare High",
        teams=[{"name": "Bare High A", "players": []}],
    )
    Institution.objects.filter(pk=badged.institution_id).update(
        logo_ref=_uuid.uuid4()
    )
    # Re-read through the FK the resolver walks: register_school handed back
    # teams holding the pre-update institution, and a cached relation would
    # hide the badge we just stored.
    badged, bare = (
        Team.objects.select_related("institution").get(pk=badged.pk),
        Team.objects.select_related("institution").get(pk=bare.pk),
    )
    match = Match.objects.create(
        organization=t.organization, tournament=t,
        home_team=badged, away_team=bare, match_no=1, group_label="A",
        scheduled_at=timezone.now(),
    )
    Match.objects.filter(pk=match.pk).update(
        home_score=2, away_score=0, status=MatchStatus.COMPLETED,
    )
    match.refresh_from_db()
    return t, badged, bare, match


def test_match_serializer_carries_the_school_crest_beside_the_team_name():
    _t, _badged, _bare, match = _cup()

    data = MatchSerializer(match).data

    assert data["home_team"]["crest"], "a badged school's team must ship a crest URL"
    assert data["home_team"]["crest"].startswith("/api/forms/uploads/")
    assert "?t=" in data["home_team"]["crest"], "the crest URL must be signed"


def test_a_team_without_a_badge_serialises_an_empty_string_never_null():
    _t, _badged, _bare, match = _cup()

    data = MatchSerializer(match).data

    assert data["away_team"]["crest"] == ""


def test_lineup_and_match_team_stubs_are_the_same_shape():
    """One helper builds both, so a key added to one can never miss the other."""
    from apps.matches.serializers import team_mini

    _t, badged, _bare, match = _cup()

    assert set(team_mini(badged)) == set(MatchSerializer(match).data["home_team"])
    assert team_mini(None) is None


def test_standings_rows_carry_the_crest_of_each_team():
    _t, badged, bare, _match = _cup()

    rows = {r["team_id"]: r for r in compute_standings(_t, group_label="A")}

    assert rows[str(badged.id)]["crest"].startswith("/api/forms/uploads/")
    assert rows[str(bare.id)]["crest"] == ""


def test_team_record_carries_its_own_crest_and_its_opponents():
    _t, badged, _bare, _match = _cup()

    rec = team_record(badged)

    assert rec["crest"].startswith("/api/forms/uploads/")
    # The opponent has no badge, so its crest is the empty string, not absent.
    assert rec["matches"][0]["opponent_crest"] == ""


def test_public_standings_serve_the_crest_to_a_signed_out_visitor():
    t, badged, _bare, _match = _cup()

    res = APIClient().get(
        f"/api/public/tournaments/{t.slug}/{t.id}/standings/"
    )

    assert res.status_code == 200
    rows = [r for g in res.json()["groups"] for r in g["rows"]]
    crests = {r["team_id"]: r["crest"] for r in rows}
    assert crests[str(badged.id)].startswith("/api/forms/uploads/")


def test_public_team_record_serves_the_crest_to_a_signed_out_visitor():
    t, badged, _bare, _match = _cup()

    res = APIClient().get(
        f"/api/public/tournaments/{t.slug}/{t.id}/teams/{badged.id}/"
    )

    assert res.status_code == 200
    body = res.json()
    assert body["crest"].startswith("/api/forms/uploads/")
    assert body["institution"]["crest"] == body["crest"], (
        "the team has no override, so it wears its school's badge"
    )
