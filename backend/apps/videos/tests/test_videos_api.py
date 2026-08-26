"""Video albums: manager CRUD, the public read, and the link parsing.

The platform does not host video — a school meet's footage is already on
YouTube, Facebook and Instagram. A video here is a LINK, so what has to be
right is: who may write one, that an entry always points somewhere, and that a
YouTube link of any shape yields the id an embed needs.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.tournaments.models import TournamentStatus
from apps.tournaments.services.create import create_tournament
from apps.videos.services.links import clean_link, youtube_id

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user(email):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _setup():
    admin = _user(f"vid-{uuid.uuid4().hex[:8]}@test.local")
    t = create_tournament(user=admin, name="Video Cup")
    t.status = TournamentStatus.SCHEDULED
    t.save(update_fields=["status"])
    return t, admin


@pytest.mark.parametrize("url,expected", [
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://youtu.be/dQw4w9WgXcQ?t=30", "dQw4w9WgXcQ"),
    ("https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share", "dQw4w9WgXcQ"),
    ("https://www.facebook.com/watch/?v=123", ""),
    ("not a url", ""),
    ("", ""),
])
def test_youtube_id_reads_every_shape_a_browser_hands_over(url, expected):
    assert youtube_id(url) == expected


def test_a_link_that_is_not_http_is_dropped_rather_than_stored():
    """The page hands these to a browser as an href."""
    assert clean_link("javascript:alert(1)") == ""
    assert clean_link("https://youtu.be/abc123") == "https://youtu.be/abc123"


def test_host_builds_an_album_and_adds_an_event():
    t, admin = _setup()
    c = _client(admin)
    album = c.post(
        f"/api/tournaments/{t.id}/video-albums/",
        {"title": "Day 1", "description": "Friday"}, format="json",
    )
    assert album.status_code == 201, album.content
    aid = album.json()["id"]

    r = c.post(
        f"/api/tournaments/{t.id}/video-albums/{aid}/videos/",
        {
            "event": "U-14 Boys Final",
            "youtube_url": "https://youtu.be/dQw4w9WgXcQ",
            "facebook_url": "https://facebook.com/anpsa/videos/1",
        },
        format="json",
    )
    assert r.status_code == 201, r.content
    body = r.json()
    assert body["event"] == "U-14 Boys Final"
    # The id is parsed once, on the server: the page embeds it, never the URL.
    assert body["youtube_id"] == "dQw4w9WgXcQ"
    assert body["instagram_url"] == ""


def test_an_entry_that_points_nowhere_is_refused():
    t, admin = _setup()
    c = _client(admin)
    aid = c.post(f"/api/tournaments/{t.id}/video-albums/",
                 {"title": "Day 1"}, format="json").json()["id"]
    r = c.post(f"/api/tournaments/{t.id}/video-albums/{aid}/videos/",
               {"event": "A final with no footage"}, format="json")
    assert r.status_code == 400
    assert "at_least_one_link_required" in str(r.json())


def test_the_public_tab_shows_albums_in_the_hosts_order_and_hides_empty_ones():
    t, admin = _setup()
    c = _client(admin)
    first = c.post(f"/api/tournaments/{t.id}/video-albums/",
                   {"title": "Finals", "position": 2}, format="json").json()["id"]
    second = c.post(f"/api/tournaments/{t.id}/video-albums/",
                    {"title": "Day 1", "position": 1}, format="json").json()["id"]
    c.post(f"/api/tournaments/{t.id}/video-albums/", {"title": "Nothing yet"},
           format="json")
    for aid, ev in ((first, "The Final"), (second, "Opening")):
        c.post(f"/api/tournaments/{t.id}/video-albums/{aid}/videos/",
               {"event": ev, "youtube_url": "https://youtu.be/dQw4w9WgXcQ"},
               format="json")

    r = APIClient().get(f"/api/public/tournaments/{t.slug}/{t.id}/videos/")
    assert r.status_code == 200, r.content
    body = r.json()
    # Host order, and the empty album is withheld: a heading with nothing under
    # it is not a section.
    assert [a["title"] for a in body["albums"]] == ["Day 1", "Finals"]
    assert body["totals"] == {"albums": 2, "videos": 2}


def test_editing_one_link_keeps_the_others():
    t, admin = _setup()
    c = _client(admin)
    aid = c.post(f"/api/tournaments/{t.id}/video-albums/",
                 {"title": "Day 1"}, format="json").json()["id"]
    vid = c.post(
        f"/api/tournaments/{t.id}/video-albums/{aid}/videos/",
        {"event": "Final", "youtube_url": "https://youtu.be/dQw4w9WgXcQ",
         "instagram_url": "https://instagram.com/p/abc"},
        format="json",
    ).json()["id"]

    r = c.patch(f"/api/tournaments/{t.id}/videos/{vid}/",
                {"facebook_url": "https://facebook.com/v/9"}, format="json")
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["youtube_id"] == "dQw4w9WgXcQ"
    assert body["instagram_url"] == "https://instagram.com/p/abc"
    assert body["facebook_url"] == "https://facebook.com/v/9"


def test_removing_an_album_takes_its_videos_with_it():
    t, admin = _setup()
    c = _client(admin)
    aid = c.post(f"/api/tournaments/{t.id}/video-albums/",
                 {"title": "Day 1"}, format="json").json()["id"]
    c.post(f"/api/tournaments/{t.id}/video-albums/{aid}/videos/",
           {"event": "Final", "youtube_url": "https://youtu.be/dQw4w9WgXcQ"},
           format="json")
    assert c.delete(f"/api/tournaments/{t.id}/video-albums/{aid}/").status_code == 200

    r = APIClient().get(f"/api/public/tournaments/{t.slug}/{t.id}/videos/")
    assert r.json()["albums"] == []


def test_a_viewer_may_read_but_not_write_and_a_stranger_sees_nothing():
    """Invariant 2: no existence leak across workspaces."""
    t, admin = _setup()
    from apps.tournaments.models import TournamentMembership

    viewer = _user(f"vw-{uuid.uuid4().hex[:6]}@test.local")
    TournamentMembership.objects.create(
        user=viewer, tournament=t, role="viewer", status="active",
    )
    vc = _client(viewer)
    assert vc.get(f"/api/tournaments/{t.id}/video-albums/").status_code == 200
    assert vc.post(f"/api/tournaments/{t.id}/video-albums/",
                   {"title": "Mine"}, format="json").status_code == 403

    stranger = _client(_user(f"st-{uuid.uuid4().hex[:6]}@test.local"))
    assert stranger.get(f"/api/tournaments/{t.id}/video-albums/").status_code == 404
    assert stranger.post(f"/api/tournaments/{t.id}/video-albums/",
                         {"title": "Mine"}, format="json").status_code == 404
