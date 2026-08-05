"""The QR code that gets a court's broadcast URL onto a phone.

    GET /api/tournaments/{id}/court-streams/{court_id}/broadcast-qr/

The URL under test is only *copyable* on a laptop, and the device that films
the match is a phone — so what these tests pin is the payload, not the picture:
the absolute origin, and the venue string encoded exactly as
``routes.broadcastCourt`` encodes it in the client (``Court2 · T3`` →
``Court2%20%C2%B7%20T3``). A QR that encodes a *nearly* right URL opens a page
that never finds a match, and the volunteer holding the phone has no way to
tell.

Gating is the same one every streaming write has (invariant 2): a tournament
outside the caller's access is a 404, a member who cannot manage is a 403.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from apps.streaming.services.qr import broadcast_court_url, public_base_url, qr_png
from apps.streaming.tests.support import api, make_tournament, verified
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)

pytestmark = pytest.mark.django_db

#: The venue shape that breaks every hand-typed URL: a space and a middle dot.
#: (Courts are resolved from the "Hall" venue ``make_tournament`` creates, so
#: the base name is fixed; the dot and the spaces are the part that matters.)
DOTTED_COURT = "Hall · T3"
DOTTED_ENCODED = "Hall%20%C2%B7%20T3"

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _url(t, court) -> str:
    return f"/api/tournaments/{t.id}/court-streams/{court.id}/broadcast-qr/"


def test_returns_a_png_encoding_the_absolute_broadcast_url():
    admin, t, courts = make_tournament(court_names=(DOTTED_COURT, "Hall · T2"))
    court = courts[0]

    res = api(admin).get(_url(t, court))

    assert res.status_code == 200
    assert res["Content-Type"] == "image/png"
    body = b"".join(res.streaming_content) if res.streaming else res.content
    assert body.startswith(PNG_MAGIC)
    # Big enough to scan off a laptop screen at arm's length, which is the only
    # reason this endpoint exists.
    assert len(body) > 400

    # The payload: absolute, and the venue percent-encoded exactly as the
    # client's `routes.broadcastCourt` encodes it.
    assert res["X-Broadcast-Url"] == (
        f"http://testserver/broadcast/t/{t.slug}/{t.id}/court/{DOTTED_ENCODED}"
    )


def test_the_payload_is_the_venue_string_not_the_court_uuid():
    """The overlay/broadcast pages match on ``Match.venue``; a UUID in the path
    would render a page that never finds a fixture."""
    admin, t, courts = make_tournament(court_names=(DOTTED_COURT,))
    court = courts[0]

    res = api(admin).get(_url(t, court))

    assert str(court.id) not in res["X-Broadcast-Url"]
    assert res["X-Broadcast-Url"].endswith(f"/court/{DOTTED_ENCODED}")


def test_url_builder_matches_encodeURIComponent():
    """`quote` and `encodeURIComponent` disagree on ``!*'()`` unless told not
    to — and the copy button and the QR must hand out one identical string."""
    tournament = SimpleNamespace(slug="cup", id="t1")
    court = SimpleNamespace(name="Court (A)'s · 1!")

    built = broadcast_court_url("https://fixture.doxaed.com", tournament, court)

    # encodeURIComponent("Court (A)'s · 1!") === "Court%20(A)'s%20%C2%B7%201!"
    assert built == (
        "https://fixture.doxaed.com/broadcast/t/cup/t1"
        "/court/Court%20(A)'s%20%C2%B7%201!"
    )


def test_the_image_is_drawn_from_that_exact_url(monkeypatch):
    """Nothing in the process can decode a PNG, so the payload is pinned where
    it is decided: the string handed to the renderer IS what the camera reads."""
    admin, t, courts = make_tournament(court_names=(DOTTED_COURT,))
    seen: list[str] = []

    def spy(payload, **kw):
        seen.append(payload)
        return qr_png(payload, **kw)

    monkeypatch.setattr("apps.streaming.services.qr.qr_png", spy)

    res = api(admin).get(_url(t, courts[0]))

    assert res.status_code == 200
    assert seen == [
        f"http://testserver/broadcast/t/{t.slug}/{t.id}/court/{DOTTED_ENCODED}"
    ]


def test_never_caches_publicly_and_offers_a_printable_filename():
    admin, t, courts = make_tournament(court_names=("Hall · T1",))

    res = api(admin).get(_url(t, courts[0]))

    assert "private" in res["Cache-Control"]
    assert res["Content-Disposition"].startswith("inline; filename=")
    assert res["Content-Disposition"].endswith('-broadcast-qr.png"')


def test_anonymous_is_refused():
    _admin, t, courts = make_tournament(court_names=("Hall · T1",))

    res = api().get(_url(t, courts[0]))

    assert res.status_code in (401, 403)


def test_a_stranger_gets_404_not_403():
    """Invariant 2: a tournament outside the caller's access must not even be
    confirmed to exist."""
    _admin, t, courts = make_tournament(court_names=("Hall · T1",))
    stranger = verified("stranger")

    res = api(stranger).get(_url(t, courts[0]))

    assert res.status_code == 404


def test_a_member_who_cannot_manage_is_refused():
    _admin, t, courts = make_tournament(court_names=("Hall · T1",))
    member = verified("member")
    TournamentMembership.objects.create(
        tournament=t,
        user=member,
        role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )

    res = api(member).get(_url(t, courts[0]))

    assert res.status_code == 403


def test_a_court_from_another_workspace_is_not_addressable():
    admin, t, _courts = make_tournament(court_names=("Hall · T1",))
    _other_admin, _other_t, other_courts = make_tournament(
        name="Other Cup", court_names=("Hall · T1",)
    )

    res = api(admin).get(_url(t, other_courts[0]))

    assert res.status_code == 404


def test_an_unknown_court_is_404():
    admin, t, _courts = make_tournament(court_names=("Hall · T1",))

    res = api(admin).get(
        f"/api/tournaments/{t.id}/court-streams/{uuid.uuid4()}/broadcast-qr/"
    )

    assert res.status_code == 404


def test_public_base_url_prefers_the_configured_host(settings, rf):
    settings.PUBLIC_BASE_URL = "https://fixture.doxaed.com/"

    assert public_base_url(rf.get("/")) == "https://fixture.doxaed.com"


def test_public_base_url_falls_back_to_the_requesting_origin(settings, rf):
    """A QR generated on a staging box must open THAT box — a hard-coded
    production host would send a volunteer's phone to someone else's event."""
    settings.PUBLIC_BASE_URL = ""
    settings.ALLOWED_HOSTS = ["staging.example.test"]

    assert public_base_url(rf.get("/", HTTP_HOST="staging.example.test")) == (
        "http://staging.example.test"
    )


def test_qr_png_encodes_a_long_url_without_error():
    payload = "https://fixture.doxaed.com/broadcast/t/a-rather-long-slug/" + (
        "0" * 36
    ) + "/court/" + DOTTED_ENCODED

    png = qr_png(payload)

    assert png.startswith(PNG_MAGIC)
