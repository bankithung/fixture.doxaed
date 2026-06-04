"""Sports catalog tests.

The Phase 1A surface is intentionally minimal — these tests assert:
  - the fixture loads without errors,
  - every row has a unique slug code,
  - every category/status value in the fixture matches the enum,
  - the read-only API returns the catalog and supports filters.
"""
from __future__ import annotations

import pytest
from django.core.management import call_command
from rest_framework.test import APIClient

from apps.sports.models import Sport, SportCategory, SportStatus


@pytest.mark.django_db
def test_load_sports_idempotent():
    """`load_sports` populates the catalog and is safe to re-run."""

    call_command("load_sports")
    first = Sport.objects.count()
    assert first > 0

    call_command("load_sports")
    second = Sport.objects.count()
    assert second == first  # update-or-create, no duplicates


@pytest.mark.django_db
def test_sports_have_valid_categories_and_statuses():
    call_command("load_sports")

    valid_categories = {c.value for c in SportCategory}
    valid_statuses = {s.value for s in SportStatus}

    for sport in Sport.objects.all():
        assert sport.category in valid_categories, sport.code
        assert sport.status in valid_statuses, sport.code
        assert sport.code == sport.code.lower(), sport.code  # slug must be lowercase


@pytest.mark.django_db
def test_sport_list_endpoint_is_public():
    """`GET /api/sports/` is open — any visitor can see the catalog."""

    call_command("load_sports")
    client = APIClient()
    res = client.get("/api/sports/")
    assert res.status_code == 200
    body = res.json()
    assert isinstance(body, list)
    assert len(body) == Sport.objects.count()
    assert body[0]["display_order"] <= body[-1]["display_order"]


@pytest.mark.django_db
def test_sport_list_filters_by_status():
    call_command("load_sports")
    client = APIClient()
    res = client.get("/api/sports/?status=coming_soon")
    assert res.status_code == 200
    body = res.json()
    # Football is seeded with status=coming_soon as the Phase 1B vertical.
    assert any(s["code"] == "football" for s in body)
    for s in body:
        assert s["status"] == "coming_soon"


@pytest.mark.django_db
def test_sport_list_filters_by_category():
    call_command("load_sports")
    client = APIClient()
    res = client.get("/api/sports/?category=indigenous")
    assert res.status_code == 200
    body = res.json()
    codes = {s["code"] for s in body}
    # A few indigenous Indian sports we expect in the seed.
    assert {"mallakhamb", "gatka", "thang-ta"}.issubset(codes)


@pytest.mark.django_db
def test_sport_detail_endpoint_by_code():
    call_command("load_sports")
    client = APIClient()
    res = client.get("/api/sports/football/")
    assert res.status_code == 200
    body = res.json()
    assert body["code"] == "football"
    assert body["category"] == "team"
    assert body["is_team_sport"] is True


@pytest.mark.django_db
def test_sport_detail_404_for_unknown_code():
    call_command("load_sports")
    client = APIClient()
    res = client.get("/api/sports/quidditch/")
    assert res.status_code == 404
