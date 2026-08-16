"""Per-court competition reservations (spec 2026-08-16 §D7).

The owner's ask: "in the sub-category I have girls and boys, so court one boys,
court two girls". A `Court.competitions` entry is a leaf-key PREFIX, matched
segment-aligned, so a reservation can name a whole sport, an age group, or one
exact competition — and it has to bind when fixtures are GENERATED, not only
when they are hand-moved afterwards.
"""
from __future__ import annotations

from datetime import date, time

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.fixtures.models import Court, Venue
from apps.fixtures.services.courts import materialise_courts
from apps.fixtures.services.scheduler import (
    MatchSlotReq,
    ScheduleConfig,
    config_from_dict,
    court_allows,
    expand_venues,
    schedule_matches,
    validate_schedule,
)
from apps.tournaments.services.create import create_tournament
from apps.tournaments.services.sports import leaf_allowed_by, leaf_matches_prefix

User = get_user_model()

TT = "table_tennis"
BOYS = "table_tennis.u14.boys"
GIRLS = "table_tennis.u14.girls"
SEPAK = "sepak_takraw.u14.boys"

SPORTS = [
    {
        "name": "Table Tennis",
        "nodes": [
            {
                "name": "U14",
                "children": [{"name": "Boys"}, {"name": "Girls"}],
            }
        ],
    },
]


def _user(email="courts@test.local"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


# --------------------------------------------------------------- the matcher
def test_a_prefix_names_a_whole_subtree_and_is_segment_aligned():
    assert leaf_matches_prefix(TT, BOYS) is True
    assert leaf_matches_prefix("table_tennis.u14", BOYS) is True
    assert leaf_matches_prefix(BOYS, BOYS) is True
    assert leaf_matches_prefix(BOYS, GIRLS) is False
    # Not a string prefix — a SEGMENT prefix. "u1" must not catch "u14".
    assert leaf_matches_prefix("table_tennis.u1", BOYS) is False
    assert leaf_matches_prefix("table", BOYS) is False
    # An empty prefix is never a licence.
    assert leaf_matches_prefix("", BOYS) is False
    assert leaf_matches_prefix(TT, "") is False


def test_no_reservation_means_no_restriction():
    """The behaviour every court had before this existed — which is why no
    venue needed migrating."""
    assert leaf_allowed_by([], BOYS) is True
    assert leaf_allowed_by(None, BOYS) is True
    assert leaf_allowed_by([BOYS], BOYS) is True
    assert leaf_allowed_by([BOYS], GIRLS) is False
    assert leaf_allowed_by([BOYS, GIRLS], GIRLS) is True


def test_a_reserved_court_refuses_a_match_that_will_not_say_what_it_is():
    cfg = ScheduleConfig(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["Hall"], court_competitions={"Hall · T1": [BOYS]},
    )
    assert court_allows(cfg, "Hall · T1", BOYS) is True
    assert court_allows(cfg, "Hall · T1", GIRLS) is False
    assert court_allows(cfg, "Hall · T1", "") is False
    # An unreserved court is unaffected.
    assert court_allows(cfg, "Hall · T2", GIRLS) is True


# --------------------------------------------------------------- config
def test_the_venue_payload_resolves_courts_to_the_names_the_grid_uses():
    cfg = config_from_dict({
        "date_start": "2026-08-01", "date_end": "2026-08-01",
        "venues": [{
            "name": "MP Hall", "count": 2,
            "courts": [
                {"index": 1, "competitions": [BOYS]},
                {"index": 2, "competitions": [GIRLS]},
            ],
        }],
    })
    assert cfg.court_competitions == {
        "MP Hall · T1": [BOYS], "MP Hall · T2": [GIRLS],
    }
    assert [d for d, _ in expand_venues(cfg)] == ["MP Hall · T1", "MP Hall · T2"]


def test_a_single_court_venue_is_keyed_by_its_bare_name():
    cfg = config_from_dict({
        "date_start": "2026-08-01", "date_end": "2026-08-01",
        "venues": [{"name": "Court A", "count": 1,
                    "courts": [{"index": 1, "competitions": [BOYS]}]}],
    })
    assert cfg.court_competitions == {"Court A": [BOYS]}


# --------------------------------------------------------------- generation
def _slots(n_boys=2, n_girls=2) -> list[MatchSlotReq]:
    out = []
    for i in range(n_boys):
        out.append(MatchSlotReq(
            id=f"b{i}", round_no=1, match_no=i + 1,
            home=f"bh{i}", away=f"ba{i}", leaf_key=BOYS, sport=TT,
        ))
    for i in range(n_girls):
        out.append(MatchSlotReq(
            id=f"g{i}", round_no=1, match_no=i + 1,
            home=f"gh{i}", away=f"ga{i}", leaf_key=GIRLS, sport=TT,
        ))
    return out


def _two_court_cfg(**over) -> ScheduleConfig:
    base = dict(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["Hall"], venue_counts={"Hall": 2}, rest_minutes=0,
        max_per_team_per_day=99,
        court_competitions={"Hall · T1": [BOYS], "Hall · T2": [GIRLS]},
    )
    base.update(over)
    return ScheduleConfig(**base)


def test_the_reservation_binds_when_the_schedule_IS_GENERATED():
    """The rule has to shape the draw, not merely complain about it after."""
    res = schedule_matches(_slots(), _two_court_cfg())

    assert res.unscheduled == []
    for mid, (_dt, venue) in res.assignments.items():
        expected = "Hall · T1" if mid.startswith("b") else "Hall · T2"
        assert venue == expected, f"{mid} landed on {venue}"


def test_generation_reports_infeasibility_rather_than_breaking_the_rule():
    """One court, reserved for boys, and girls' matches to place: the engine
    must leave them unscheduled instead of quietly using the boys' court."""
    cfg = ScheduleConfig(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(12, 0), slot_minutes=60,
        venues=["Hall"], rest_minutes=0, max_per_team_per_day=99,
        court_competitions={"Hall": [BOYS]},
    )
    res = schedule_matches(_slots(n_boys=1, n_girls=2), cfg)

    assert [m for m in res.unscheduled] == ["g0", "g1"]
    assert res.assignments["b0"][1] == "Hall"


def test_an_unreserved_court_still_takes_everything():
    cfg = _two_court_cfg(court_competitions={"Hall · T1": [BOYS]})
    res = schedule_matches(_slots(), cfg)
    assert res.unscheduled == []
    for mid, (_dt, venue) in res.assignments.items():
        if venue == "Hall · T1":
            assert mid.startswith("b")


def test_a_sport_level_reservation_behaves_exactly_like_the_old_venue_list():
    """`["table_tennis"]` is the same rule the venue sport allow-list already
    expressed — the widening is backward compatible by construction."""
    cfg = _two_court_cfg(court_competitions={"Hall · T1": [TT], "Hall · T2": [TT]})
    res = schedule_matches(_slots(), cfg)
    assert res.unscheduled == []

    blocked = _two_court_cfg(
        court_competitions={"Hall · T1": ["sepak_takraw"], "Hall · T2": ["sepak_takraw"]}
    )
    assert len(schedule_matches(_slots(), blocked).unscheduled) == 4


# --------------------------------------------------------------- validation
def test_a_manual_move_onto_the_wrong_court_is_a_hard_violation():
    """Every repair verb routes through validate_schedule, which before this
    checked no resource binding at all — not even the sport allow-list."""
    cfg = _two_court_cfg()
    matches = _slots(n_boys=1, n_girls=1)
    from datetime import datetime

    from django.utils import timezone as dj_tz

    tz = dj_tz.get_current_timezone()
    when = datetime(2026, 8, 1, 10, 0, tzinfo=tz)
    # Put the girls' match on the boys' court, by hand.
    bad = {"b0": (when, "Hall · T1"), "g0": (when, "Hall · T1")}

    violations = validate_schedule(bad, matches, cfg)
    codes = {v["code"] for v in violations}
    assert "court_competition_mismatch" in codes
    offending = [v for v in violations if v["code"] == "court_competition_mismatch"]
    assert offending[0]["match_id"] == "g0"
    assert offending[0]["hard"] is True


def test_the_sport_allow_list_is_now_validated_too():
    cfg = ScheduleConfig(
        date_start=date(2026, 8, 1), date_end=date(2026, 8, 1),
        daily_start=time(9, 0), daily_end=time(18, 0), slot_minutes=60,
        venues=["Hall"], venue_sports={"Hall": ["sepak_takraw"]},
    )
    from datetime import datetime

    from django.utils import timezone as dj_tz

    when = datetime(2026, 8, 1, 10, 0, tzinfo=dj_tz.get_current_timezone())
    violations = validate_schedule({"b0": (when, "Hall")}, _slots(n_boys=1, n_girls=0), cfg)
    assert "venue_sport_mismatch" in {v["code"] for v in violations}


# --------------------------------------------------------------- persistence
@pytest.mark.django_db
def test_courts_become_real_rows_as_soon_as_a_venue_says_how_many():
    """An organiser cannot reserve 'court 2' if court 2 does not exist yet, and
    the reservation must be settable BEFORE the draw."""
    t = create_tournament(user=_user(), name="Court Meet")
    v = Venue.objects.create(organization=t.organization, name="MP Hall", count=3)
    materialise_courts(v)

    names = list(
        Court.objects.filter(venue=v, deleted_at__isnull=True)
        .order_by("index").values_list("name", flat=True)
    )
    assert names == ["MP Hall · T1", "MP Hall · T2", "MP Hall · T3"]

    # Shrinking retires the surplus rather than deleting it — a match may
    # still reference it by name.
    v.count = 2
    v.save(update_fields=["count"])
    materialise_courts(v)
    assert Court.objects.filter(venue=v, deleted_at__isnull=True).count() == 2
    assert Court.objects.filter(venue=v).count() == 3


@pytest.mark.django_db
def test_the_api_reserves_a_court_and_refuses_a_competition_that_does_not_exist():
    user = _user("api@courts.test")
    t = create_tournament(user=user, name="API Meet")
    t.sports = SPORTS
    t.save(update_fields=["sports"])
    from apps.tournaments.services.sports import normalize_sports

    t.sports = normalize_sports(SPORTS)
    t.save(update_fields=["sports"])

    c = APIClient()
    c.force_authenticate(user=user)
    r = c.post(f"/api/tournaments/{t.id}/venues/", {"name": "MP Hall", "count": 2})
    assert r.status_code == 201, r.data
    assert [ct["index"] for ct in r.data["courts"]] == [1, 2]
    court_id = r.data["courts"][0]["id"]

    leaves = [leaf["leaf_key"] for leaf in __import__(
        "apps.tournaments.services.sports", fromlist=["iter_leaves"]
    ).iter_leaves(t.sports)]
    boys = next(k for k in leaves if k.endswith("boys"))

    r = c.patch(
        f"/api/tournaments/{t.id}/courts/{court_id}/", {"competitions": [boys]},
        format="json",
    )
    assert r.status_code == 200, r.data
    assert r.data["competitions"] == [boys]

    # An ancestor is valid too — that is what "all of U14" looks like.
    r = c.patch(
        f"/api/tournaments/{t.id}/courts/{court_id}/",
        {"competitions": [boys.rsplit(".", 1)[0]]}, format="json",
    )
    assert r.status_code == 200

    # A typo must not silently strand a whole draw.
    r = c.patch(
        f"/api/tournaments/{t.id}/courts/{court_id}/",
        {"competitions": ["table_tennis.u15"]}, format="json",
    )
    assert r.status_code == 400
    assert r.data["detail"] == "unknown_competition"


@pytest.mark.django_db
def test_the_stored_venue_pool_carries_reservations_into_a_run():
    """Preview and commit both build from the stored pool, so the reservation
    has to travel with it or the two disagree."""
    from apps.fixtures.services.preview import stored_venue_records

    t = create_tournament(user=_user("stored@courts.test"), name="Stored Meet")
    v = Venue.objects.create(organization=t.organization, name="Hall", count=2)
    courts = materialise_courts(v)
    courts[1].competitions = [GIRLS]
    courts[1].save(update_fields=["competitions"])

    records = stored_venue_records(t)
    assert records[0]["courts"] == [{"index": 2, "competitions": [GIRLS]}]

    cfg = config_from_dict({
        "date_start": "2026-08-01", "date_end": "2026-08-01",
        "venues": records,
    })
    assert cfg.court_competitions == {"Hall · T2": [GIRLS]}


# --------------------------------------------------------- separation is a RULE
@pytest.mark.django_db
def test_the_opening_round_separation_is_a_record_not_a_hidden_rule():
    """It ran on every draw with no stored record and no way off (owner
    2026-08-17: no hard-coded rules). The default still behaves exactly as it
    always did — absence of a record is not absence of the rule."""
    from apps.fixtures.services.generate import (
        SEPARATION_KEY_GROUP,
        SEPARATION_KEY_INSTITUTION,
        SEPARATION_OFF,
        _separation_key,
    )
    from apps.tournaments.models import TournamentScope

    t = create_tournament(user=_user("sep@courts.test"), name="Sep")
    assert _separation_key(t) == SEPARATION_KEY_INSTITUTION

    t.constraints = [
        {"type": "opening_round_separation", "scope": "all",
         "params": {"key": "none"}},
    ]
    assert _separation_key(t) == SEPARATION_OFF

    t.constraints = [
        {"type": "opening_round_separation", "scope": "all",
         "params": {"key": "group"}},
    ]
    assert _separation_key(t) == SEPARATION_KEY_GROUP

    # A within-school event separates by HOUSE without being told: every team
    # shares the one host institution, so the old axis was a silent no-op.
    meet = create_tournament(
        user=_user("sepintra@courts.test"), name="Meet",
        scope=TournamentScope.INTRA_SCHOOL,
    )
    assert _separation_key(meet) == SEPARATION_KEY_GROUP
