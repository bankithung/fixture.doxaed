"""TDD — live: public match snapshot (REST) + WebSocket broadcast (invariant #11)."""
from __future__ import annotations

import pytest
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.live.routing import websocket_urlpatterns
from apps.matches.models import Match, MatchEventType, MatchStatus
from apps.matches.services.events import record_match_event
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()


def _verified(email: str = "org@test.local") -> "User":
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


@pytest.mark.django_db
def test_live_snapshot_is_public_and_shows_score():
    admin = _verified()
    t = create_tournament(user=admin, name="Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        status=MatchStatus.LIVE,
    )
    record_match_event(match=m, event_type=MatchEventType.GOAL, team=a, by=admin)

    client = APIClient()  # no auth — public viewer
    r = client.get(f"/api/live/match/{m.id}/")
    assert r.status_code == 200
    assert r.json()["match"]["home_score"] == 1
    assert len(r.json()["events"]) >= 1


@pytest.mark.django_db
def test_ws_match_room_receives_broadcast():
    app = ProtocolTypeRouter({"websocket": URLRouter(websocket_urlpatterns)})
    match_id = "019e0000-0000-0000-0000-000000000abc"

    async def flow():
        comm = WebsocketCommunicator(app, f"/ws/match/{match_id}/")
        connected, _ = await comm.connect()
        assert connected
        layer = get_channel_layer()
        await layer.group_send(
            f"match_{match_id}",
            {"type": "match.event", "data": {"hello": "world"}},
        )
        msg = await comm.receive_json_from(timeout=2)
        assert msg["hello"] == "world"
        await comm.disconnect()

    async_to_sync(flow)()

@pytest.mark.django_db
def test_snapshot_serves_sport_meta():
    """P1.d — the snapshot carries the SportDefinition slice (family/terms)
    so consoles and viewers render sport-natively without hardcoding."""
    admin = _verified("meta@test.local")
    t = create_tournament(user=admin, name="Meta Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    tt = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        sport="table_tennis",
    )
    client = APIClient()
    meta = client.get(f"/api/live/match/{tt.id}/").json()["match"]["sport_meta"]
    assert meta["family"] == "target"
    assert meta["terms"]["period"] == "Game"

    fb = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
    )
    meta = client.get(f"/api/live/match/{fb.id}/").json()["match"]["sport_meta"]
    assert meta["key"] == "football" and meta["family"] == "timed"


@pytest.mark.django_db
def test_snapshot_serves_hub_blocks():
    """P6 hub: tournament back-nav block, schedule context, h2h, stats and
    (once live) confirmed lineups ride the public snapshot."""
    admin = _verified("hub@test.local")
    t = create_tournament(user=admin, name="Hub Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": [{"full_name": "Nine"}]},
               {"name": "B", "players": []}],
    )
    prior = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        status=MatchStatus.COMPLETED, home_score=2, away_score=1,
    )
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        venue="Court 1",
    )
    # Lineups freeze at kickoff: build the sheet BEFORE going live.
    from apps.matches.services.lineups import set_lineup
    from apps.matches.services.state import transition_match

    set_lineup(
        match=m, team=a,
        entries=[{"player_id": str(a.players.first().id), "role": "starter",
                  "shirt_no": 9}],
        by=admin,
    )
    transition_match(match=m, to_status=MatchStatus.LIVE, by=admin)
    record_match_event(match=m, event_type=MatchEventType.SHOT, team=a, by=admin)

    data = APIClient().get(f"/api/live/match/{m.id}/").json()
    assert data["tournament"]["name"] == "Hub Cup"
    assert data["tournament"]["slug"]
    assert data["match"]["venue"] == "Court 1"
    assert data["h2h"][0]["id"] == str(prior.id)
    assert {"type": "shot", "home": 1, "away": 0} in data["stats"]
    lineups = data["match"]["lineups"]
    assert lineups["home"]["entries"][0]["shirt_no"] == 9


@pytest.mark.django_db
def test_match_card_png_renders_and_caches():
    """P6 reach: the share card renders a real PNG for scheduled AND live
    matches, with an ETag that busts on score changes."""
    admin = _verified("card@test.local")
    t = create_tournament(user=admin, name="Card Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        status=MatchStatus.LIVE, sport="sepak_takraw",
        set_scores=[[8, 7]], home_score=0, away_score=0, venue="Court 1",
    )
    c = APIClient()
    r = c.get(f"/api/live/match-card/{m.id}.png")
    assert r.status_code == 200
    assert r["Content-Type"] == "image/png"
    body = b"".join(r.streaming_content) if hasattr(r, "streaming_content") else r.content
    assert body[:8] == b"\x89PNG\r\n\x1a\n"
    etag = r["ETag"]
    assert c.get(f"/api/live/match-card/{m.id}.png",
                 HTTP_IF_NONE_MATCH=etag).status_code == 304


@pytest.mark.django_db
def test_match_meta_serves_og_tags_with_score():
    admin = _verified("meta-og@test.local")
    t = create_tournament(user=admin, name="Meta OG Cup")
    a, b = register_school(
        tournament=t, school_name="S",
        teams=[{"name": "A", "players": []}, {"name": "B", "players": []}],
    )
    m = Match.objects.create(
        organization=t.organization, tournament=t, home_team=a, away_team=b,
        status=MatchStatus.LIVE, sport="sepak_takraw", set_scores=[[8, 7]],
        home_score=0, away_score=0,
    )
    r = APIClient().get(f"/api/live/match-meta/{m.id}/")
    assert r.status_code == 200
    html = r.content.decode()
    assert 'property="og:title" content="A 8 - 7 B (LIVE)"' in html
    assert f"match-card/{m.id}.png" in html


@pytest.mark.django_db
def test_tournament_meta_serves_og_tags():
    admin = _verified("t-og@test.local")
    t = create_tournament(user=admin, name="Share Cup")
    r = APIClient().get(f"/api/live/tournament-meta/{t.slug}/{t.id}/")
    assert r.status_code == 200
    assert 'og:title" content="Share Cup"' in r.content.decode()
    # Wrong slug for the id: 404, no leak.
    assert APIClient().get(
        f"/api/live/tournament-meta/wrong-slug/{t.id}/"
    ).status_code == 404
