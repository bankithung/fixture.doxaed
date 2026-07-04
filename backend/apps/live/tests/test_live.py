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
