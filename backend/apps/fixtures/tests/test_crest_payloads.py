"""Crests travel with every fixture payload, not just the Teams tab.

Owner 2026-08-19: "when fixture is generated we should also show logos … not
just generated but all other fixtures, be it in matches pages or anywhere a
fixture is shown". The badge is resolved in ONE place
(``apps.teams.services.crest``) and carried by the public schedule, the public
match hub, the dry-run preview and the teams list — so these tests pin the
CONTRACT those surfaces share: a ``crest`` key that is always a string, and a
public page that spends a bounded number of queries on it.
"""
from __future__ import annotations

import io
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from PIL import Image as PILImage
from rest_framework.test import APIClient

from apps.fixtures.services.generate import generate_round_robin
from apps.fixtures.services.preview import preview_fixtures
from apps.forms.models import FormFileUpload
from apps.forms.services.generation import generate_team_form_template
from apps.live.cards import render_match_card
from apps.matches.models import Match
from apps.teams.models import Institution, Team
from apps.teams.services.registration import register_school
from apps.tournaments.models import TournamentStatus
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()
pytestmark = pytest.mark.django_db

LEAF = "football.u15"
SCHEDULE = {
    "date_start": "2026-08-01", "date_end": "2026-08-07",
    "daily_start": "09:00", "daily_end": "18:00", "slot_minutes": 60,
    "venues": ["G"], "rest_minutes": 0, "max_per_team_per_day": 4,
}

# The school that HAS a badge, and the one that does not. Both play, because
# the interesting assertion is that they answer with the same SHAPE.
BADGED = "Holy Cross"
PLAIN = "No Crest School"
# A colour no part of the share card's own palette uses, so counting it on the
# rendered PNG proves the crest itself was painted.
_CREST_RGB = (220, 30, 30)


def _verified(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _cup(tag: str):
    admin = _verified(f"crest-{tag}@test.local")
    t = create_tournament(user=admin, name="Crest Cup")
    t.sports = normalize_sports([{"name": "Football", "nodes": [{"name": "U15"}]}])
    t.save(update_fields=["sports"])
    return admin, t


def _register(t, school: str, n: int):
    register_school(
        tournament=t, school_name=school,
        teams=[
            {"name": f"{school} T{i + 1}", "leaf_key": LEAF, "sport": "football",
             "players": []}
            for i in range(n)
        ],
    )


def _seed(t, *, badged: int = 2, plain: int = 2) -> uuid.UUID:
    """Two schools, only one of them badged; returns its ``logo_ref``."""
    _register(t, BADGED, badged)
    _register(t, PLAIN, plain)
    ref = uuid.uuid4()
    Institution.objects.filter(tournament=t, name=BADGED).update(logo_ref=ref)
    return ref


def _wears(url, ref) -> bool:
    """Is this the crest capability for ``ref``?

    Compared by subject rather than by whole string: the signed ``?t=`` token
    carries a timestamp that changes every second, so an equality check
    against a freshly minted URL is a clock race.
    """
    return isinstance(url, str) and url.startswith(f"/api/forms/uploads/{ref}/?t=")


def _publish_schedule(t, status=TournamentStatus.SCHEDULED):
    generate_round_robin(tournament=t, group_size=8, leaf_key=LEAF)
    tz = ZoneInfo(t.time_zone)
    for i, m in enumerate(Match.objects.filter(tournament=t).order_by("match_no")):
        m.scheduled_at = datetime(2026, 8, 1, 9 + (i % 8), 0, tzinfo=tz)
        m.venue = "Main Ground"
        m.save(update_fields=["scheduled_at", "venue"])
    t.status = status
    t.save(update_fields=["status"])


def _public_schedule(t):
    return APIClient().get(f"/api/public/tournaments/{t.slug}/{t.id}/schedule/")


def _badged_ids(t) -> set[str]:
    return {
        str(i) for i in Team.objects.filter(
            tournament=t, institution__name=BADGED,
        ).values_list("id", flat=True)
    }


def _sides(body) -> list[dict]:
    return [
        side
        for m in body["matches"]
        for side in (m["home"], m["away"])
        if side is not None
    ]


# ------------------------------------------------------- the public schedule
def test_the_public_schedule_shows_a_crest_to_a_visitor_with_no_session():
    """The whole point of a signed capability URL: a spectator who never logs
    in still sees the badge beside the team name."""
    _admin, t = _cup("public")
    ref = _seed(t)
    _publish_schedule(t)

    r = _public_schedule(t)
    assert r.status_code == 200, r.content
    badged = _badged_ids(t)
    wearing = [s for s in _sides(r.json()) if s["id"] in badged]
    assert wearing, "the badged school never appeared in the draw"
    assert all(_wears(s["crest"], ref) for s in wearing)


def test_a_team_with_no_crest_answers_with_an_empty_string_never_null():
    """The client renders initials on a falsy value; a null would force every
    reader to branch on None instead."""
    _admin, t = _cup("empty")
    _seed(t)
    _publish_schedule(t)

    badged = _badged_ids(t)
    bare = [s for s in _sides(_public_schedule(t).json()) if s["id"] not in badged]
    assert bare, "the school without a badge never appeared in the draw"
    assert all(s["crest"] == "" for s in bare)


def test_the_public_schedule_does_not_load_an_institution_per_team():
    """This endpoint lists a WHOLE tournament and every spectator refetches it,
    so resolving crests has to cost a bounded number of queries. Under an N+1
    the institution loads alone would run once per side of every match."""
    _admin, t = _cup("nplus1")
    _seed(t, badged=4, plain=4)
    _publish_schedule(t)
    n_sides = 2 * Match.objects.filter(tournament=t).count()
    assert n_sides >= 40, "the fixture is too small to expose an N+1"

    with CaptureQueriesContext(connection) as ctx:
        assert _public_schedule(t).status_code == 200
    # A STANDALONE institution select is the N+1 signature: the ones this
    # endpoint needs ride in on the match query's join (FROM matches_match
    # JOIN teams_institution), so a query whose FROM is the institution table
    # is a crest resolving itself one row at a time.
    lazy = [q for q in ctx.captured_queries if 'FROM "teams_institution"' in q["sql"]]
    assert not lazy, f"{len(lazy)} institution loads for {n_sides} sides: N+1"


# --------------------------------------------------------------- the preview
def test_the_preview_carries_one_crest_map_at_the_top_level():
    """A preview match side carries only a ``team_id``, the same team appears in
    many matches, and the court grid has no match row to hang a badge on — so
    the crests ship once, keyed by team id."""
    _admin, t = _cup("preview")
    ref = _seed(t)

    out = preview_fixtures(
        tournament=t, leaf_key=LEAF, schedule=SCHEDULE, include_schedule=True,
    )
    crests = out["crests"]
    assert set(crests) == _badged_ids(t)
    assert all(_wears(url, ref) for url in crests.values())
    # A team with no crest is simply ABSENT, so a reader writes
    # crests.get(tid, "") and never stores an empty placeholder.
    assert all(url for url in crests.values())


def test_the_preview_fairness_rows_wear_the_same_badge():
    """The fairness table names teams, so it badges them the same way the sheet
    does — and an unbadged team still answers with a string."""
    _admin, t = _cup("fairness")
    ref = _seed(t)

    out = preview_fixtures(
        tournament=t, leaf_key=LEAF, schedule=SCHEDULE, include_schedule=True,
    )
    rows = out["fairness"]["teams"]
    assert rows
    badged = _badged_ids(t)
    for row in rows:
        if row["team_id"] in badged:
            assert _wears(row["crest"], ref)
        else:
            assert row["crest"] == ""


def test_the_preview_carries_crests_even_when_it_skips_scheduling():
    """A draw-only preview lists the same team names, so it needs the same
    badges: the map is built outside the scheduling branch."""
    _admin, t = _cup("drawonly")
    _seed(t)

    out = preview_fixtures(tournament=t, leaf_key=LEAF, include_schedule=False)
    assert set(out["crests"]) == _badged_ids(t)


# ------------------------------------------------------- the other surfaces
def test_the_public_match_hub_dresses_both_teams():
    _admin, t = _cup("hub")
    ref = _seed(t)
    _publish_schedule(t, status=TournamentStatus.LIVE)
    m = Match.objects.filter(
        tournament=t, home_team__institution__name=BADGED,
    ).first()
    assert m is not None

    body = APIClient().get(f"/api/live/match/{m.id}/").json()
    assert _wears(body["match"]["home_team"]["crest"], ref)
    # Whoever the draw paired it with, the away side answers with a string.
    assert isinstance(body["match"]["away_team"]["crest"], str)


def test_the_teams_list_carries_the_crest_for_the_preview_page():
    admin, t = _cup("teamlist")
    ref = _seed(t)
    c = APIClient()
    c.force_authenticate(user=admin)

    rows = c.get(f"/api/tournaments/{t.id}/teams/").json()
    assert rows
    for row in rows:
        if row["school"] == BADGED:
            assert _wears(row["crest"], ref)
        else:
            assert row["crest"] == ""


def test_the_share_card_still_renders_when_a_crest_file_is_missing():
    """The card is what WhatsApp unfurls for a forwarded link. A logo_ref
    pointing at a file that is not there is a decoration failure, never a 500."""
    _admin, t = _cup("card")
    _seed(t)  # logo_ref is a bare uuid: no FormFileUpload row behind it
    _publish_schedule(t)
    m = Match.objects.filter(
        tournament=t, home_team__institution__name=BADGED,
    ).first()
    assert m is not None

    r = APIClient().get(f"/api/live/match-card/{m.id}.png")
    assert r.status_code == 200
    assert r["Content-Type"] == "image/png"


@override_settings(MEDIA_ROOT="/tmp/fixture-test-media")
def test_the_share_card_paints_the_crest_it_can_read():
    """Read from the upload row's own file, not over HTTP from the signed URL:
    the renderer runs inside the process that would serve it."""
    admin, t = _cup("cardpaint")
    _register(t, BADGED, 2)
    _register(t, PLAIN, 2)
    form = generate_team_form_template(tournament=t, created_by=admin)
    buf = io.BytesIO()
    PILImage.new("RGB", (200, 200), _CREST_RGB).save(buf, format="PNG")
    upload = FormFileUpload.objects.create(
        organization=t.organization, form=form, field_key="",
        file=SimpleUploadedFile("crest.png", buf.getvalue(), content_type="image/png"),
        original_name="crest.png", content_type="image/png", size=buf.tell(),
    )
    Institution.objects.filter(tournament=t, name=BADGED).update(
        logo_ref=upload.upload_ref,
    )
    _publish_schedule(t)
    m = Match.objects.filter(
        tournament=t, home_team__institution__name=BADGED,
    ).first()
    assert m is not None

    png = PILImage.open(io.BytesIO(render_match_card(m)))
    painted = sum(1 for px in png.convert("RGB").getdata() if px == _CREST_RGB)
    # A 72px box of solid colour; the resample softens only its edges.
    assert painted > 1000, f"only {painted} crest pixels on the card"
