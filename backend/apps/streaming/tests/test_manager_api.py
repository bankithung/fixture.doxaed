"""The manager API that binds a court to a stream.

    GET/POST   /api/tournaments/{id}/court-streams/
    GET/PATCH/DELETE /api/tournaments/{id}/court-streams/{court_id}/

Phase 1 is a **paste**, not OAuth: the organiser streams from whatever they
already use and pastes the resulting YouTube watch URL per court. The one thing
this endpoint must be opinionated about is refusing a channel-level ``/live``
URL — it is the URL every organiser reaches for first, and it silently sends
spectators to whichever court YouTube feels like.

Also pinned here: cross-org isolation in both directions (invariant 2),
``event_id`` replay semantics (invariant 3), and the rule that
``yt_stream_key`` — an RTMP ingestion credential — never appears in a response.
"""
from __future__ import annotations

import uuid

import pytest
from django.core.cache import cache

from apps.streaming.models import CourtStream
from apps.streaming.tests.support import (
    CHANNEL_LIVE_URL,
    SHORT_URL,
    VIDEO_ID,
    WATCH_URL,
    api,
    make_match,
    make_stream,
    make_tournament,
    verified,
)
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)

pytestmark = pytest.mark.django_db

SECRET_KEY_VALUE = "xxxx-yyyy-zzzz-secret-ingest-key"


@pytest.fixture(autouse=True)
def _reset_throttle():
    cache.clear()
    yield
    cache.clear()


def _list_url(t) -> str:
    return f"/api/tournaments/{t.id}/court-streams/"


def _detail_url(t, court) -> str:
    return f"/api/tournaments/{t.id}/court-streams/{court.id}/"


# --------------------------------------------------------------------- CRUD
def test_paste_a_url_creates_the_binding_and_switches_the_court_on():
    admin, t, courts = make_tournament()
    r = api(admin).post(
        _list_url(t),
        {"court_id": str(courts[0].id), "watch_url": WATCH_URL,
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 201, r.content
    body = r.json()
    assert body["watch_url"] == WATCH_URL
    # Pasting a link IS switching the court on — a second toggle is a trap.
    assert body["enabled"] is True
    assert body["live_watch_url"] == WATCH_URL
    assert body["is_streaming"] is True
    assert body["public_link"] == (
        f"/api/public/tournaments/{t.slug}/{t.id}/court/{courts[0].id}/live/"
    )
    assert CourtStream.objects.filter(court=courts[0]).count() == 1


def test_listing_covers_every_court_with_and_without_a_binding():
    admin, t, courts = make_tournament(
        court_names=("Hall · T1", "Hall · T2", "Hall · T3")
    )
    make_stream(courts[1], watch_url=SHORT_URL)
    r = api(admin).get(_list_url(t))
    assert r.status_code == 200, r.content
    rows = {row["court_name"]: row for row in r.json()["court_streams"]}
    assert set(rows) == {"Hall · T1", "Hall · T2", "Hall · T3"}
    assert rows["Hall · T2"]["watch_url"] == SHORT_URL
    assert rows["Hall · T1"]["watch_url"] == ""
    assert rows["Hall · T1"]["live_watch_url"] is None
    assert rows["Hall · T1"]["is_streaming"] is False


def test_patch_edits_url_and_enabled_in_place():
    admin, t, courts = make_tournament()
    make_stream(courts[0], watch_url=WATCH_URL)
    r = api(admin).patch(
        _detail_url(t, courts[0]),
        {"watch_url": SHORT_URL, "enabled": False, "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["watch_url"] == SHORT_URL
    assert r.json()["enabled"] is False
    # A disabled binding still has a clickable link, but is not "on air".
    assert r.json()["is_streaming"] is False
    assert CourtStream.objects.filter(court=courts[0]).count() == 1


def test_patch_can_clear_the_binding_with_a_blank_url():
    admin, t, courts = make_tournament()
    make_stream(courts[0], watch_url=WATCH_URL)
    r = api(admin).patch(
        _detail_url(t, courts[0]), {"watch_url": ""}, format="json"
    )
    assert r.status_code == 200
    assert r.json()["watch_url"] == ""
    assert r.json()["live_watch_url"] is None


def test_get_detail_for_a_court_with_no_binding_yet():
    admin, t, courts = make_tournament()
    r = api(admin).get(_detail_url(t, courts[0]))
    assert r.status_code == 200
    assert r.json()["watch_url"] == ""
    assert r.json()["enabled"] is False


def test_delete_soft_deletes_and_is_idempotent():
    admin, t, courts = make_tournament()
    make_stream(courts[0], watch_url=WATCH_URL)
    c = api(admin)
    assert c.delete(_detail_url(t, courts[0])).status_code == 204
    assert CourtStream.objects.filter(
        court=courts[0], deleted_at__isnull=True
    ).count() == 0
    assert CourtStream.objects.filter(court=courts[0]).count() == 1  # row survives
    assert c.delete(_detail_url(t, courts[0])).status_code == 204  # replay
    assert c.get(_detail_url(t, courts[0])).json()["watch_url"] == ""


def test_a_court_can_be_re_bound_after_a_delete():
    """``court`` is a OneToOneField, so a soft-deleted binding still occupies
    the slot — re-binding has to resurrect that row, not insert a second one
    the unique constraint would refuse."""
    admin, t, courts = make_tournament()
    c = api(admin)
    make_stream(courts[0], watch_url=WATCH_URL)
    assert c.delete(_detail_url(t, courts[0])).status_code == 204
    r = c.post(
        _list_url(t),
        {"court_id": str(courts[0].id), "watch_url": SHORT_URL},
        format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["watch_url"] == SHORT_URL
    assert CourtStream.objects.filter(court=courts[0]).count() == 1
    assert CourtStream.objects.get(court=courts[0]).deleted_at is None


def test_court_id_is_required_on_create():
    admin, t, _courts = make_tournament()
    r = api(admin).post(_list_url(t), {"watch_url": WATCH_URL}, format="json")
    assert r.status_code == 400
    assert r.json()["detail"] == "court_id_required"


# -------------------------------------------------------------- idempotency
def test_post_replay_returns_200_not_201_and_writes_once():
    """Invariant 3: a client retry (flaky phone on a school ground) must not
    produce a second row or a second audit entry."""
    admin, t, courts = make_tournament()
    event_id = str(uuid.uuid4())
    payload = {
        "court_id": str(courts[0].id),
        "watch_url": WATCH_URL,
        "event_id": event_id,
    }
    c = api(admin)
    first = c.post(_list_url(t), payload, format="json")
    assert first.status_code == 201
    second = c.post(_list_url(t), payload, format="json")
    assert second.status_code == 200, second.content
    assert second.json()["court_id"] == str(courts[0].id)
    assert CourtStream.objects.filter(court=courts[0]).count() == 1


def test_post_replay_does_not_reapply_a_later_edit():
    admin, t, courts = make_tournament()
    event_id = str(uuid.uuid4())
    c = api(admin)
    c.post(
        _list_url(t),
        {"court_id": str(courts[0].id), "watch_url": WATCH_URL,
         "event_id": event_id},
        format="json",
    )
    c.patch(
        _detail_url(t, courts[0]),
        {"watch_url": SHORT_URL, "event_id": str(uuid.uuid4())},
        format="json",
    )
    # The stale retry of the ORIGINAL create must not stamp the old URL back.
    replay = c.post(
        _list_url(t),
        {"court_id": str(courts[0].id), "watch_url": WATCH_URL,
         "event_id": event_id},
        format="json",
    )
    assert replay.status_code == 200
    assert CourtStream.objects.get(court=courts[0]).watch_url == SHORT_URL


def test_patch_replay_returns_200_and_is_a_no_op():
    admin, t, courts = make_tournament()
    make_stream(courts[0], watch_url=WATCH_URL)
    event_id = str(uuid.uuid4())
    c = api(admin)
    first = c.patch(
        _detail_url(t, courts[0]),
        {"watch_url": SHORT_URL, "event_id": event_id},
        format="json",
    )
    assert first.status_code == 200
    CourtStream.objects.filter(court=courts[0]).update(watch_url=WATCH_URL)
    second = c.patch(
        _detail_url(t, courts[0]),
        {"watch_url": SHORT_URL, "event_id": event_id},
        format="json",
    )
    assert second.status_code == 200
    # Replay recognised: the row was NOT written a second time.
    assert CourtStream.objects.get(court=courts[0]).watch_url == WATCH_URL


def test_post_without_an_event_id_still_works():
    admin, t, courts = make_tournament()
    r = api(admin).post(
        _list_url(t),
        {"court_id": str(courts[0].id), "watch_url": WATCH_URL},
        format="json",
    )
    assert r.status_code == 201


# ------------------------------------------------------------ URL validation
def test_channel_level_live_url_is_rejected_and_explains_why():
    admin, t, courts = make_tournament()
    r = api(admin).post(
        _list_url(t),
        {"court_id": str(courts[0].id), "watch_url": CHANNEL_LIVE_URL},
        format="json",
    )
    assert r.status_code == 400, r.content
    body = r.json()
    assert body["detail"] == "channel_live_url"
    message = body["message"].lower()
    # It must explain the MULTI-COURT failure, not merely refuse.
    assert "court" in message
    assert "channel" in message
    assert CourtStream.objects.filter(court=courts[0]).count() == 0


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/@nagalandschoolscup/live",
        "https://youtube.com/channel/UCabcdefghijklmnopqrstu/live",
        "https://www.youtube.com/c/SomeChannel/live",
    ],
)
def test_every_channel_live_shape_is_rejected(url):
    admin, t, courts = make_tournament()
    r = api(admin).post(
        _list_url(t),
        {"court_id": str(courts[0].id), "watch_url": url},
        format="json",
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "channel_live_url"


def test_a_non_youtube_url_is_rejected():
    admin, t, courts = make_tournament()
    r = api(admin).post(
        _list_url(t),
        {"court_id": str(courts[0].id), "watch_url": "https://example.com/live"},
        format="json",
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "not_a_youtube_video_url"


@pytest.mark.parametrize(
    "url",
    [WATCH_URL, SHORT_URL, f"https://www.youtube.com/live/{VIDEO_ID}"],
)
def test_the_three_accepted_video_shapes(url):
    admin, t, courts = make_tournament()
    r = api(admin).post(
        _list_url(t),
        {"court_id": str(courts[0].id), "watch_url": url},
        format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["watch_url"] == url


# ------------------------------------------------------------- the credential
def _all_response_bodies(admin, t, court) -> list[str]:
    c = api(admin)
    return [
        c.get(_list_url(t)).content.decode(),
        c.get(_detail_url(t, court)).content.decode(),
        c.patch(
            _detail_url(t, court), {"enabled": True}, format="json"
        ).content.decode(),
        c.post(
            _list_url(t),
            {"court_id": str(court.id), "watch_url": WATCH_URL},
            format="json",
        ).content.decode(),
    ]


def test_yt_stream_key_never_appears_in_any_response_body():
    """The RTMP ingestion key is write-only: anyone holding it can push video
    onto the organiser's channel."""
    admin, t, courts = make_tournament()
    make_stream(
        courts[0],
        watch_url=WATCH_URL,
        yt_stream_id="stream-abc123",
        yt_stream_key=SECRET_KEY_VALUE,
    )
    for body in _all_response_bodies(admin, t, courts[0]):
        assert SECRET_KEY_VALUE not in body
        assert "yt_stream_key" not in body
    # ...and the non-secret half is still surfaced, so the UI can show state.
    detail = api(admin).get(_detail_url(t, courts[0])).json()
    assert detail["yt_stream_id"] == "stream-abc123"
    assert detail["has_stream_key"] is True


def test_yt_stream_key_is_not_in_the_public_payloads_either():
    _admin, t, courts = make_tournament()
    make_stream(courts[0], watch_url=WATCH_URL, yt_stream_key=SECRET_KEY_VALUE)
    make_match(t, courts[0])  # so the court reaches the public payload at all
    cache.clear()
    schedule = api().get(
        f"/api/public/tournaments/{t.slug}/{t.id}/schedule/"
    ).content.decode()
    assert SECRET_KEY_VALUE not in schedule
    assert "yt_stream_key" not in schedule


def test_stream_key_stays_out_of_str_and_repr():
    _admin, _t, courts = make_tournament()
    s = make_stream(courts[0], watch_url=WATCH_URL, yt_stream_key=SECRET_KEY_VALUE)
    assert SECRET_KEY_VALUE not in str(s)
    assert SECRET_KEY_VALUE not in repr(s)


# --------------------------------------------------------- cross-org (inv. 2)
def test_org_a_cannot_read_org_bs_court_streams():
    admin_a, _t_a, _c_a = make_tournament(name="Cup A")
    _admin_b, t_b, courts_b = make_tournament(name="Cup B")
    make_stream(courts_b[0], watch_url=WATCH_URL)
    c = api(admin_a)
    assert c.get(_list_url(t_b)).status_code == 404
    assert c.get(_detail_url(t_b, courts_b[0])).status_code == 404


def test_org_a_cannot_write_org_bs_court_streams():
    admin_a, _t_a, _c_a = make_tournament(name="Cup A")
    _admin_b, t_b, courts_b = make_tournament(name="Cup B")
    c = api(admin_a)
    assert c.post(
        _list_url(t_b),
        {"court_id": str(courts_b[0].id), "watch_url": WATCH_URL},
        format="json",
    ).status_code == 404
    assert c.patch(
        _detail_url(t_b, courts_b[0]), {"enabled": True}, format="json"
    ).status_code == 404
    assert c.delete(_detail_url(t_b, courts_b[0])).status_code == 404
    assert CourtStream.objects.filter(court=courts_b[0]).count() == 0


def test_org_b_cannot_read_or_write_org_as_court_streams():
    """The same check in the other direction — isolation is not a one-way
    property of whichever org happened to be created first."""
    _admin_a, t_a, courts_a = make_tournament(name="Cup A")
    admin_b, _t_b, _c_b = make_tournament(name="Cup B")
    make_stream(courts_a[0], watch_url=WATCH_URL)
    c = api(admin_b)
    assert c.get(_list_url(t_a)).status_code == 404
    assert c.patch(
        _detail_url(t_a, courts_a[0]), {"enabled": False}, format="json"
    ).status_code == 404
    assert CourtStream.objects.get(court=courts_a[0]).enabled is True


def test_another_orgs_court_id_smuggled_through_my_own_tournament_is_404():
    """The subtle one: the caller CAN manage tournament A, so the tournament
    gate passes — the court lookup has to be workspace-scoped as well."""
    admin_a, t_a, _c_a = make_tournament(name="Cup A")
    _admin_b, _t_b, courts_b = make_tournament(name="Cup B")
    c = api(admin_a)
    r = c.post(
        _list_url(t_a),
        {"court_id": str(courts_b[0].id), "watch_url": WATCH_URL},
        format="json",
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "court_not_found"
    assert c.patch(
        _detail_url(t_a, courts_b[0]), {"enabled": True}, format="json"
    ).status_code == 404
    assert CourtStream.objects.filter(court=courts_b[0]).count() == 0


def test_the_listing_never_shows_another_workspaces_courts():
    admin_a, t_a, courts_a = make_tournament(name="Cup A")
    _admin_b, _t_b, courts_b = make_tournament(name="Cup B")
    rows = api(admin_a).get(_list_url(t_a)).json()["court_streams"]
    ids = {row["court_id"] for row in rows}
    assert ids == {str(c.id) for c in courts_a}
    assert not ids & {str(c.id) for c in courts_b}


# ------------------------------------------------------------------ the gate
def test_a_plain_member_cannot_bind_a_stream():
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
        {"court_id": str(courts[0].id), "watch_url": WATCH_URL},
        format="json",
    ).status_code == 403
    assert CourtStream.objects.filter(court=courts[0]).count() == 0


def test_a_co_organizer_can_bind_a_stream():
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
        {"court_id": str(courts[0].id), "watch_url": WATCH_URL},
        format="json",
    )
    assert r.status_code == 201, r.content


def test_anonymous_callers_are_refused():
    _admin, t, courts = make_tournament()
    c = api()
    assert c.get(_list_url(t)).status_code in (401, 403)
    assert c.post(
        _list_url(t),
        {"court_id": str(courts[0].id), "watch_url": WATCH_URL},
        format="json",
    ).status_code in (401, 403)
