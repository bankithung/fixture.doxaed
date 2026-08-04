"""The manager API for scoped watch links.

    GET/POST         /api/tournaments/{id}/stream-links/
    GET/PATCH/DELETE /api/tournaments/{id}/stream-links/{link_id}/

One endpoint, three scopes — match, court+day, category — because that is how
the organiser described the job: *"per court and per day there will be one live
stream link… there can also be one per sport category, or even per match."* The
API's whole responsibility is to write the right row for the right target and
to refuse a URL that cannot address a court; deciding which row a spectator
gets is ``services.links``' job (``test_stream_links.py``).

Pinned here alongside CRUD: the manager gate (writing a link publishes it on
the public schedule), cross-org isolation in both directions (invariant 2), and
``event_id`` replay (invariant 3).

Days are derived from the fixture under test, never written as "whatever today
happens to be". The one test that has to talk about today
(``test_the_public_court_payload_shows_the_courts_link_for_today``) derives
BOTH its day and its assertion from ``timezone.now()`` — mixing a hardcoded
date with "today" is how this suite acquired tests that only agreed with the
calendar on one day of the year.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from django.core.cache import cache

from apps.streaming.models import StreamLink, StreamLinkScope
from apps.streaming.services.links import local_day
from apps.streaming.tests.support import (
    CHANNEL_LIVE_URL,
    COURT_DAY_LINK_URL,
    COURT_STREAM_URL,
    MATCH_LINK_URL,
    SHORT_URL,
    WATCH_URL,
    api,
    make_match,
    make_stream,
    make_tournament,
    tz_of,
    verified,
    with_categories,
)
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)

pytestmark = pytest.mark.django_db

#: The fixed instant every fixture in this file plays at.
KICKOFF = datetime(2026, 8, 3, 11, 0)


@pytest.fixture(autouse=True)
def _reset_throttle():
    cache.clear()
    yield
    cache.clear()


def _list_url(t) -> str:
    return f"/api/tournaments/{t.id}/stream-links/"


def _detail_url(t, link_id) -> str:
    return f"/api/tournaments/{t.id}/stream-links/{link_id}/"


def _kickoff(t) -> datetime:
    return KICKOFF.replace(tzinfo=tz_of(t))


def _day(t) -> str:
    """The local day the fixtures are played on, as the API takes it."""
    return local_day(_kickoff(t), tz_of(t)).isoformat()


# --------------------------------------------------------------------- create
def test_paste_a_link_for_a_court_and_a_day():
    admin, t, courts = make_tournament()
    r = api(admin).post(
        _list_url(t),
        {
            "scope": "court_day",
            "court_id": str(courts[0].id),
            "day": _day(t),
            "watch_url": COURT_DAY_LINK_URL,
            "event_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert r.status_code == 201, r.content
    body = r.json()
    assert body["scope"] == "court_day"
    assert body["court_id"] == str(courts[0].id)
    assert body["day"] == _day(t)
    assert body["watch_url"] == COURT_DAY_LINK_URL
    # Pasting a link is switching it on — there is no second toggle to find.
    assert body["enabled"] is True
    assert StreamLink.objects.filter(deleted_at__isnull=True).count() == 1


def test_paste_a_link_for_one_match():
    admin, t, courts = make_tournament()
    m = make_match(t, courts[0], scheduled_at=_kickoff(t))
    r = api(admin).post(
        _list_url(t),
        {"scope": "match", "match_id": str(m.id), "watch_url": MATCH_LINK_URL},
        format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["match_id"] == str(m.id)
    assert r.json()["day"] is None


def test_paste_a_link_for_a_sport_category():
    admin, t, _courts = make_tournament()
    leaf, _other = with_categories(t)
    r = api(admin).post(
        _list_url(t),
        {"scope": "category", "leaf_key": leaf, "watch_url": WATCH_URL},
        format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["leaf_key"] == leaf


def test_posting_the_same_target_twice_updates_in_place():
    admin, t, courts = make_tournament()
    payload = {
        "scope": "court_day",
        "court_id": str(courts[0].id),
        "day": _day(t),
        "watch_url": COURT_DAY_LINK_URL,
    }
    c = api(admin)
    first = c.post(_list_url(t), payload, format="json")
    assert first.status_code == 201
    second = c.post(_list_url(t), {**payload, "watch_url": SHORT_URL}, format="json")
    assert second.status_code == 200, second.content
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["watch_url"] == SHORT_URL
    assert StreamLink.objects.filter(deleted_at__isnull=True).count() == 1


def test_the_same_court_takes_one_link_per_day():
    admin, t, courts = make_tournament()
    tz = tz_of(t)
    c = api(admin)
    for offset in range(2):
        day = local_day(_kickoff(t) + timedelta(days=offset), tz).isoformat()
        r = c.post(
            _list_url(t),
            {
                "scope": "court_day",
                "court_id": str(courts[0].id),
                "day": day,
                "watch_url": COURT_DAY_LINK_URL,
            },
            format="json",
        )
        assert r.status_code == 201, r.content
    assert StreamLink.objects.filter(
        court=courts[0], deleted_at__isnull=True
    ).count() == 2


# ----------------------------------------------------------------- list/edit
def test_the_listing_covers_all_three_scopes():
    admin, t, courts = make_tournament()
    leaf, _other = with_categories(t)
    m = make_match(t, courts[0], scheduled_at=_kickoff(t), leaf_key=leaf)
    c = api(admin)
    for payload in (
        {"scope": "match", "match_id": str(m.id), "watch_url": MATCH_LINK_URL},
        {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
         "watch_url": COURT_DAY_LINK_URL},
        {"scope": "category", "leaf_key": leaf, "watch_url": WATCH_URL},
    ):
        assert c.post(_list_url(t), payload, format="json").status_code == 201
    rows = c.get(_list_url(t)).json()["stream_links"]
    assert {row["scope"] for row in rows} == {"match", "court_day", "category"}


def test_patch_edits_the_url_without_restating_the_target():
    admin, t, courts = make_tournament()
    c = api(admin)
    created = c.post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
         "watch_url": COURT_DAY_LINK_URL},
        format="json",
    ).json()
    r = c.patch(
        _detail_url(t, created["id"]),
        {"watch_url": SHORT_URL, "enabled": False},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["watch_url"] == SHORT_URL
    assert r.json()["enabled"] is False
    assert r.json()["day"] == _day(t)


def test_delete_clears_the_link_and_is_idempotent():
    admin, t, courts = make_tournament()
    c = api(admin)
    created = c.post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
         "watch_url": COURT_DAY_LINK_URL},
        format="json",
    ).json()
    assert c.delete(_detail_url(t, created["id"])).status_code == 204
    assert StreamLink.objects.filter(deleted_at__isnull=True).count() == 0
    assert StreamLink.objects.count() == 1  # the row survives, for the audit
    assert c.delete(_detail_url(t, created["id"])).status_code == 204  # replay
    assert c.get(_list_url(t)).json()["stream_links"] == []


def test_a_target_can_be_re_bound_after_a_delete():
    admin, t, courts = make_tournament()
    c = api(admin)
    payload = {
        "scope": "court_day",
        "court_id": str(courts[0].id),
        "day": _day(t),
        "watch_url": COURT_DAY_LINK_URL,
    }
    created = c.post(_list_url(t), payload, format="json").json()
    assert c.delete(_detail_url(t, created["id"])).status_code == 204
    again = c.post(_list_url(t), {**payload, "watch_url": SHORT_URL}, format="json")
    assert again.status_code == 201, again.content
    assert again.json()["id"] != created["id"]
    assert StreamLink.objects.filter(deleted_at__isnull=True).count() == 1


# -------------------------------------------------------------- idempotency
def test_post_replay_returns_200_and_writes_once():
    admin, t, courts = make_tournament()
    event_id = str(uuid.uuid4())
    payload = {
        "scope": "court_day",
        "court_id": str(courts[0].id),
        "day": _day(t),
        "watch_url": COURT_DAY_LINK_URL,
        "event_id": event_id,
    }
    c = api(admin)
    assert c.post(_list_url(t), payload, format="json").status_code == 201
    second = c.post(_list_url(t), payload, format="json")
    assert second.status_code == 200, second.content
    assert StreamLink.objects.count() == 1


def test_post_replay_does_not_reapply_a_later_edit():
    admin, t, courts = make_tournament()
    event_id = str(uuid.uuid4())
    payload = {
        "scope": "court_day",
        "court_id": str(courts[0].id),
        "day": _day(t),
        "watch_url": COURT_DAY_LINK_URL,
        "event_id": event_id,
    }
    c = api(admin)
    created = c.post(_list_url(t), payload, format="json").json()
    c.patch(
        _detail_url(t, created["id"]),
        {"watch_url": SHORT_URL, "event_id": str(uuid.uuid4())},
        format="json",
    )
    # The stale retry of the original create must not stamp the old URL back.
    replay = c.post(_list_url(t), payload, format="json")
    assert replay.status_code == 200
    assert StreamLink.objects.get(id=created["id"]).watch_url == SHORT_URL


def test_post_without_an_event_id_still_works():
    admin, t, courts = make_tournament()
    r = api(admin).post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
         "watch_url": COURT_DAY_LINK_URL},
        format="json",
    )
    assert r.status_code == 201, r.content


# ---------------------------------------------------------------- validation
def test_a_channel_level_live_url_is_rejected_and_explains_why():
    admin, t, courts = make_tournament()
    r = api(admin).post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
         "watch_url": CHANNEL_LIVE_URL},
        format="json",
    )
    assert r.status_code == 400, r.content
    assert r.json()["detail"] == "channel_live_url"
    assert "court" in r.json()["message"].lower()
    assert StreamLink.objects.count() == 0


def test_a_non_youtube_url_is_rejected():
    admin, t, courts = make_tournament()
    r = api(admin).post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
         "watch_url": "https://example.com/live"},
        format="json",
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "not_a_youtube_video_url"


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        ({"scope": "nonsense"}, "scope_invalid"),
        ({}, "scope_invalid"),
        ({"scope": "court_day"}, "court_id_required"),
        ({"scope": "match"}, "match_id_required"),
        ({"scope": "category"}, "leaf_key_required"),
    ],
)
def test_the_target_must_identify_something(payload, detail):
    admin, t, _courts = make_tournament()
    r = api(admin).post(
        _list_url(t), {**payload, "watch_url": WATCH_URL}, format="json"
    )
    assert r.status_code == 400, r.content
    assert r.json()["detail"] == detail


@pytest.mark.parametrize(("day", "detail"), [("", "day_required"), ("today", "day_invalid")])
def test_a_court_link_needs_a_real_day(day, detail):
    """The day is the key the whole scope hangs on — a missing or unparseable
    one would write a row no match can ever resolve against."""
    admin, t, courts = make_tournament()
    r = api(admin).post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id), "day": day,
         "watch_url": WATCH_URL},
        format="json",
    )
    assert r.status_code == 400, r.content
    assert r.json()["detail"] == detail


def test_a_category_must_be_one_this_tournament_runs():
    """A free-typed leaf would create a link no match can match, and the
    organiser would be left staring at a row that does nothing."""
    admin, t, _courts = make_tournament()
    with_categories(t)
    r = api(admin).post(
        _list_url(t),
        {"scope": "category", "leaf_key": "football.u21", "watch_url": WATCH_URL},
        format="json",
    )
    assert r.status_code == 400, r.content
    assert r.json()["detail"] == "leaf_key_not_in_tournament"


# ------------------------------------------------------------------ the gate
def test_a_plain_member_cannot_paste_a_link():
    admin, t, courts = make_tournament()
    scorer = verified("scorer")
    TournamentMembership.objects.create(
        user=scorer,
        tournament=t,
        role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
        assigned_by=admin,
    )
    c = api(scorer)
    assert c.get(_list_url(t)).status_code == 403
    assert c.post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
         "watch_url": WATCH_URL},
        format="json",
    ).status_code == 403
    assert StreamLink.objects.count() == 0


def test_a_plain_member_cannot_edit_or_clear_an_existing_link():
    admin, t, courts = make_tournament()
    created = api(admin).post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
         "watch_url": COURT_DAY_LINK_URL},
        format="json",
    ).json()
    scorer = verified("scorer")
    TournamentMembership.objects.create(
        user=scorer,
        tournament=t,
        role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
        assigned_by=admin,
    )
    c = api(scorer)
    assert c.patch(
        _detail_url(t, created["id"]), {"watch_url": SHORT_URL}, format="json"
    ).status_code == 403
    assert c.delete(_detail_url(t, created["id"])).status_code == 403
    link = StreamLink.objects.get(id=created["id"])
    assert link.watch_url == COURT_DAY_LINK_URL
    assert link.deleted_at is None


def test_a_co_organizer_can_paste_a_link():
    admin, t, courts = make_tournament()
    co = verified("co")
    TournamentMembership.objects.create(
        user=co,
        tournament=t,
        role=TournamentMembershipRole.CO_ORGANIZER,
        status=TournamentMembershipStatus.ACTIVE,
        assigned_by=admin,
    )
    r = api(co).post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
         "watch_url": COURT_DAY_LINK_URL},
        format="json",
    )
    assert r.status_code == 201, r.content


def test_anonymous_callers_are_refused():
    _admin, t, courts = make_tournament()
    c = api()
    assert c.get(_list_url(t)).status_code in (401, 403)
    assert c.post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
         "watch_url": WATCH_URL},
        format="json",
    ).status_code in (401, 403)
    assert StreamLink.objects.count() == 0


# --------------------------------------------------------- cross-org (inv. 2)
def test_org_a_cannot_read_or_write_org_bs_links():
    admin_a, _t_a, _c_a = make_tournament(name="Cup A")
    admin_b, t_b, courts_b = make_tournament(name="Cup B")
    created = api(admin_b).post(
        _list_url(t_b),
        {"scope": "court_day", "court_id": str(courts_b[0].id), "day": _day(t_b),
         "watch_url": COURT_DAY_LINK_URL},
        format="json",
    ).json()
    c = api(admin_a)
    assert c.get(_list_url(t_b)).status_code == 404
    assert c.get(_detail_url(t_b, created["id"])).status_code == 404
    assert c.patch(
        _detail_url(t_b, created["id"]), {"watch_url": SHORT_URL}, format="json"
    ).status_code == 404
    assert c.delete(_detail_url(t_b, created["id"])).status_code == 404
    link = StreamLink.objects.get(id=created["id"])
    assert link.watch_url == COURT_DAY_LINK_URL
    assert link.deleted_at is None


def test_org_b_cannot_reach_org_as_links_either():
    """Isolation is not a one-way property of whichever org was created first."""
    admin_a, t_a, courts_a = make_tournament(name="Cup A")
    admin_b, _t_b, _c_b = make_tournament(name="Cup B")
    created = api(admin_a).post(
        _list_url(t_a),
        {"scope": "court_day", "court_id": str(courts_a[0].id), "day": _day(t_a),
         "watch_url": COURT_DAY_LINK_URL},
        format="json",
    ).json()
    assert api(admin_b).get(_detail_url(t_a, created["id"])).status_code == 404


def test_another_orgs_court_smuggled_through_my_own_tournament_is_404():
    """The caller CAN manage tournament A, so the tournament gate passes — the
    court lookup has to be workspace-scoped as well."""
    admin_a, t_a, _c_a = make_tournament(name="Cup A")
    _admin_b, _t_b, courts_b = make_tournament(name="Cup B")
    r = api(admin_a).post(
        _list_url(t_a),
        {"scope": "court_day", "court_id": str(courts_b[0].id), "day": _day(t_a),
         "watch_url": WATCH_URL},
        format="json",
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "court_not_found"
    assert StreamLink.objects.count() == 0


def test_another_tournaments_match_smuggled_in_is_404():
    admin_a, t_a, _c_a = make_tournament(name="Cup A")
    _admin_b, t_b, courts_b = make_tournament(name="Cup B")
    m = make_match(t_b, courts_b[0], scheduled_at=_kickoff(t_b))
    r = api(admin_a).post(
        _list_url(t_a),
        {"scope": "match", "match_id": str(m.id), "watch_url": WATCH_URL},
        format="json",
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "match_not_found"
    assert StreamLink.objects.count() == 0


def test_the_listing_never_shows_another_workspaces_links():
    admin_a, t_a, courts_a = make_tournament(name="Cup A")
    admin_b, t_b, courts_b = make_tournament(name="Cup B")
    for admin, t, courts in ((admin_a, t_a, courts_a), (admin_b, t_b, courts_b)):
        api(admin).post(
            _list_url(t),
            {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
             "watch_url": COURT_DAY_LINK_URL},
            format="json",
        )
    rows = api(admin_a).get(_list_url(t_a)).json()["stream_links"]
    assert [row["court_id"] for row in rows] == [str(courts_a[0].id)]


# ------------------------------------------------------ end to end, the point
def test_a_pasted_court_day_link_reaches_the_public_schedule():
    """The whole feature in one pass: an organiser pastes today's link for a
    court, and the spectator's row resolves to it over the court's standing
    default."""
    admin, t, courts = make_tournament()
    make_stream(courts[0], watch_url=COURT_STREAM_URL)
    m = make_match(t, courts[0], scheduled_at=_kickoff(t))

    def row():
        cache.clear()
        body = api().get(
            f"/api/public/tournaments/{t.slug}/{t.id}/schedule/"
        ).json()
        return next(r for r in body["matches"] if r["id"] == str(m.id))

    assert row()["watch_url"] == COURT_STREAM_URL
    created = api(admin).post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
         "watch_url": COURT_DAY_LINK_URL},
        format="json",
    )
    assert created.status_code == 201, created.content
    assert row()["watch_url"] == COURT_DAY_LINK_URL
    # …and clearing it hands the match straight back to the court default.
    assert api(admin).delete(
        _detail_url(t, created.json()["id"])
    ).status_code == 204
    assert row()["watch_url"] == COURT_STREAM_URL


def test_a_match_link_beats_everything_on_the_public_schedule():
    admin, t, courts = make_tournament()
    make_stream(courts[0], watch_url=COURT_STREAM_URL)
    m = make_match(t, courts[0], scheduled_at=_kickoff(t))
    c = api(admin)
    c.post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id), "day": _day(t),
         "watch_url": COURT_DAY_LINK_URL},
        format="json",
    )
    c.post(
        _list_url(t),
        {"scope": "match", "match_id": str(m.id), "watch_url": MATCH_LINK_URL},
        format="json",
    )
    cache.clear()
    body = api().get(f"/api/public/tournaments/{t.slug}/{t.id}/schedule/").json()
    row = next(r for r in body["matches"] if r["id"] == str(m.id))
    assert row["watch_url"] == MATCH_LINK_URL


def test_the_public_court_payload_shows_the_courts_link_for_today():
    """The ``courts`` list answers "what is this court showing right now", so
    its day is TODAY — while a match row answers for the match's own day.

    Both sides of this test are derived from ``timezone.now()`` for that
    reason: a link pasted for a fixed date would agree with "today" on one
    calendar day of the year and the assertion would flip on every other.
    """
    from django.utils import timezone as dj_tz

    admin, t, courts = make_tournament()
    today = local_day(dj_tz.now(), tz_of(t))
    make_stream(courts[0], watch_url=COURT_STREAM_URL)
    make_match(t, courts[0], scheduled_at=dj_tz.now())
    api(admin).post(
        _list_url(t),
        {"scope": "court_day", "court_id": str(courts[0].id),
         "day": today.isoformat(), "watch_url": COURT_DAY_LINK_URL},
        format="json",
    )
    cache.clear()
    body = api().get(f"/api/public/tournaments/{t.slug}/{t.id}/schedule/").json()
    court_row = next(c for c in body["courts"] if c["id"] == str(courts[0].id))
    assert court_row["watch_url"] == COURT_DAY_LINK_URL
    # An enabled link for today is the organiser saying this court is on air.
    assert court_row["is_streaming"] is True


def test_the_scope_values_are_the_ones_the_api_documents():
    """A guard on the wire format: these strings are in URLs, clients and the
    audit log, so renaming one is a breaking change, not a refactor."""
    assert StreamLinkScope.values == ["match", "court_day", "category"]
