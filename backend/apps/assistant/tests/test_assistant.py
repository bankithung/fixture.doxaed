"""Setup-assistant endpoint + tool loop (Gemini mocked).

The assistant drives the SAME services as the manual form, so these assert that
a model function-call actually persists setup (calendar, format, constraints),
that the freeze gate is amended (not bypassed), and that auth/scope hold.
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.assistant import gemini
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import normalize_sports

User = get_user_model()


# --------------------------------------------------------------- fake Gemini
def _text(text: str) -> dict:
    return {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}}]}


def _call(name: str, args: dict) -> dict:
    return {"candidates": [{"content": {"role": "model",
            "parts": [{"functionCall": {"name": name, "args": args}}]}}]}


def _queue(monkeypatch, responses: list[dict]):
    """Make gemini.generate pop canned responses in order."""
    box = list(responses)

    def fake(**_kwargs):
        return box.pop(0) if box else _text("ok")

    monkeypatch.setattr(gemini, "generate", fake)


# ------------------------------------------------------------------- helpers
def _verified(email: str) -> User:
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _tournament(admin, *, status="draft"):
    t = create_tournament(user=admin, name="Assistant Cup")
    t.sports = normalize_sports([
        {"name": "Table Tennis", "nodes": [{"name": "U14"}, {"name": "Open"}]},
    ])
    t.status = status
    t.save(update_fields=["sports", "status"])
    return t


def _url(t) -> str:
    return f"/api/tournaments/{t.id}/assistant/chat/"


def _post(client, t, text="hi"):
    return client.post(_url(t), {"messages": [{"role": "user", "content": text}]},
                       format="json")


# --------------------------------------------------------------------- tests
@pytest.mark.django_db
def test_requires_auth(monkeypatch):
    _queue(monkeypatch, [_text("hi")])
    admin = _verified("a@test.local")
    t = _tournament(admin)
    resp = APIClient().post(_url(t), {"messages": []}, format="json")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_cross_org_user_gets_404(monkeypatch):
    _queue(monkeypatch, [_text("hi")])
    admin = _verified("owner@test.local")
    t = _tournament(admin)
    stranger = _verified("stranger@test.local")
    resp = _post(_client(stranger), t)
    assert resp.status_code == 404


@pytest.mark.django_db
def test_qna_returns_reply_without_changing(monkeypatch):
    _queue(monkeypatch, [_text("Courts are how many matches a venue runs at once.")])
    admin = _verified("a@test.local")
    t = _tournament(admin)
    resp = _post(_client(admin), t, "what is courts?")
    assert resp.status_code == 200
    body = resp.json()
    assert "Courts" in body["reply"]
    assert body["changed"] is False
    assert body["actions"] == []


@pytest.mark.django_db
def test_set_schedule_window_persists_calendar(monkeypatch):
    _queue(monkeypatch, [
        _call("set_schedule_window", {
            "date_start": "2026-08-01", "date_end": "2026-08-03",
            "daily_start": "09:00", "daily_end": "18:00", "slot_minutes": 20,
        }),
        _text("Done — dates set."),
    ])
    admin = _verified("a@test.local")
    t = _tournament(admin)
    resp = _post(_client(admin), t, "run it Aug 1 to 3, 9-6, 20 min matches")
    assert resp.status_code == 200
    body = resp.json()
    assert body["changed"] is True
    assert any(a["ok"] for a in body["actions"])
    t.refresh_from_db()
    cal = t.draw_config["*"]["calendar"]
    assert cal["date_start"] == "2026-08-01"
    assert cal["date_end"] == "2026-08-03"
    assert cal["slot_minutes"] == 20


@pytest.mark.django_db
def test_set_format_per_sport_persists(monkeypatch):
    _queue(monkeypatch, [
        _call("set_format", {"scope": "Table Tennis", "format": "knockout"}),
        _text("Table Tennis is knockout now."),
    ])
    admin = _verified("a@test.local")
    t = _tournament(admin)
    resp = _post(_client(admin), t, "make table tennis knockout")
    assert resp.status_code == 200
    assert resp.json()["changed"] is True
    t.refresh_from_db()
    assert t.draw_config["sport:table_tennis"]["format"] == "knockout"


@pytest.mark.django_db
def test_set_breaks_amends_through_freeze_gate(monkeypatch):
    # registration_open => rules frozen; the handler must amend, not fail.
    _queue(monkeypatch, [
        _call("set_breaks", {"rest_minutes": 10, "max_matches_per_team_per_day": 3}),
        _text("Breaks set."),
    ])
    admin = _verified("a@test.local")
    t = _tournament(admin, status="registration_open")
    resp = _post(_client(admin), t, "10 min rest, max 3 a day")
    assert resp.status_code == 200
    assert resp.json()["changed"] is True
    t.refresh_from_db()
    by_type = {c["type"]: c for c in t.constraints}
    assert by_type["min_rest_minutes"]["params"]["minutes"] == 10
    assert by_type["max_matches_per_team_per_day"]["params"]["count"] == 3


@pytest.mark.django_db
def test_two_tool_calls_in_one_turn(monkeypatch):
    _queue(monkeypatch, [
        _call("add_or_update_venue", {"name": "TT Hall", "courts": 2, "sports": ["Table Tennis"]}),
        _call("set_concurrency_cap", {"scope": "all", "count": 2}),
        _text("Added the hall and capped concurrency."),
    ])
    admin = _verified("a@test.local")
    t = _tournament(admin)
    resp = _post(_client(admin), t, "add TT Hall with 2 courts and cap to 2 at once")
    assert resp.status_code == 200
    body = resp.json()
    assert body["changed"] is True
    assert len(body["actions"]) == 2
    from apps.fixtures.models import Venue
    v = Venue.objects.get(organization=t.organization, name="TT Hall", deleted_at__isnull=True)
    assert v.count == 2
    assert v.sports == ["table_tennis"]
    t.refresh_from_db()
    assert any(c["type"] == "official_capacity" and c["params"]["count"] == 2
               for c in t.constraints)


@pytest.mark.django_db
def test_gemini_not_configured_returns_503(monkeypatch):
    def boom(**_kwargs):
        raise gemini.GeminiError("gemini_not_configured")

    monkeypatch.setattr(gemini, "generate", boom)
    admin = _verified("a@test.local")
    t = _tournament(admin)
    resp = _post(_client(admin), t)
    assert resp.status_code == 503
    assert resp.json()["code"] == "gemini_not_configured"
