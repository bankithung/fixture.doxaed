"""An AUTHORED groups→knockout bracket (owner 2026-08-20).

The engine could already say "top 2 of each group advance, cross-seeded". It
could not say what a real organiser says: *"Group A's winner plays the best
loser, Group A's runner-up plays Group C's winner, and the winners of match 1
and match 3 meet in the semi-final."* Those are three separate things the
cross-seed decides on the organiser's behalf: which slots qualify, who plays
whom, and which quarter-final feeds which semi-final.

So the bracket becomes data like every other rule here: ``from.pairings`` is
the round-1 sheet in the organiser's own words and numbering, ``from.meets``
says which of those matches converge. Nothing about the shape is hardcoded and
nothing is competition-specific: the same two keys describe a 2-match bracket
or an 8-match one, in any sport.
"""
from __future__ import annotations

import re

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.fixtures.services.advance import advance_from_match
from apps.fixtures.services.draw_config import _validate_stages
from apps.fixtures.services.generate import (
    authored_qualifier_pairs,
    generate_for_leaf,
    group_short_name,
)
from apps.matches.models import Match
from apps.matches.services.scoring import record_score
from apps.teams.services.registration import register_school
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db

#: The owner's own sheet: three groups of 4/4/3, the top two of each plus the
#: two best losers, and the semi-finals crossing 1v3 / 2v4.
PAIRINGS = [["A1", "L1"], ["A2", "C1"], ["B1", "L2"], ["B2", "C2"]]
MEETS = [[1, 3], [2, 4]]


def _verified(email: str = "org@test.local") -> User:
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _stages(pairings=PAIRINGS, meets=MEETS, best_losers: int = 2) -> list[dict]:
    return [
        {"id": "groups", "type": "round_robin", "group_size": 4,
         "balance_groups": True},
        {"id": "ko", "type": "knockout", "third_place": True,
         "from": {"stage": "groups", "advance_per_group": 2,
                  "advance_best_thirds": best_losers, "seeding": "explicit",
                  "pairings": pairings, "meets": meets}},
    ]


def _tournament(admin, *, n: int = 11, stages=None):
    t = create_tournament(user=admin, name="Sepak Cup")
    register_school(
        tournament=t, school_name="S",
        teams=[{"name": f"T{i + 1}", "players": []} for i in range(n)],
    )
    t.draw_config = {"*": {"stages": stages if stages is not None else _stages()}}
    t.save(update_fields=["draw_config"])
    return t


def _generate(t):
    from apps.fixtures.services.draw_config import effective_draw_config

    return generate_for_leaf(
        tournament=t, leaf_key="", cfg=effective_draw_config(t, None),
    )


def _knockout(t) -> list[Match]:
    return list(
        Match.objects.filter(tournament=t, stage="knockout", deleted_at__isnull=True)
        .order_by("match_no")
    )


def _slot(src: dict) -> str:
    """A pointer back in the organiser's own notation, so the assertions read
    like the sheet they are checking."""
    if src.get("best_third"):
        return f"L{src['rank']}"
    return f"{group_short_name(src['group_label'])}{src['position']}"


def test_the_bracket_is_the_one_that_was_written_down():
    admin = _verified()
    t = _tournament(admin)
    _generate(t)
    ko = _knockout(t)

    r1 = [m for m in ko if m.round_no == 1]
    assert [(_slot(m.home_source), _slot(m.away_source)) for m in r1] == [
        ("A1", "L1"), ("A2", "C1"), ("B1", "L2"), ("B2", "C2")
    ]
    # Eight qualifiers means a full first round: the six-team bracket this
    # replaces handed two group winners a bye.
    assert len(r1) == 4
    assert not any(m.home_source == {} or m.away_source == {} for m in r1)

    # …and the semis cross the way `meets` says: M1 with M3, M2 with M4.
    ids = [str(m.id) for m in r1]
    semis = [m for m in ko if m.round_no == 2]
    assert [
        (m.home_source["match_id"], m.away_source["match_id"]) for m in semis
    ] == [(ids[0], ids[2]), (ids[1], ids[3])]

    last = [m for m in ko if m.round_no == 3]
    assert len(last) == 2  # the final and the third-place match
    assert sum("3rd Place" in (m.group_label or "") for m in last) == 1


def test_without_meets_the_semi_finals_are_the_usual_adjacent_tree():
    """`meets` is opt-in: leave it out and M1 plays M2, which is what every
    bracket does by default. The key exists because no ORDERING of the
    pairings can express 1v3 while also keeping the organiser's numbering."""
    admin = _verified()
    t = _tournament(admin, stages=_stages(meets=None))
    _generate(t)
    ko = _knockout(t)
    ids = [str(m.id) for m in ko if m.round_no == 1]
    semis = [m for m in ko if m.round_no == 2]
    assert [
        (m.home_source["match_id"], m.away_source["match_id"]) for m in semis
    ] == [(ids[0], ids[1]), (ids[2], ids[3])]


def test_a_qualifier_with_nowhere_to_play_is_refused():
    """The failure this guards against is invisible on a bracket diagram: it
    shows up as a team standing on the court with no match."""
    groups = ["Group A", "Group B", "Group C"]
    with pytest.raises(ValueError) as exc:
        authored_qualifier_pairs(
            [["A1", "L1"], ["A2", "C1"]],
            groups, advance_per_group=2, advance_best_thirds=2,
        )
    # Named, not merely counted: the organiser has to know WHO is missing.
    for slot in ("B1", "B2", "C2", "L2"):
        assert slot in str(exc.value)


def test_a_team_seated_in_two_matches_is_refused():
    groups = ["Group A", "Group B", "Group C"]
    with pytest.raises(ValueError, match="seated twice"):
        authored_qualifier_pairs(
            [["A1", "L1"], ["A1", "C1"], ["B1", "L2"], ["B2", "C2"]],
            groups, advance_per_group=2, advance_best_thirds=2,
        )


def test_a_slot_that_does_not_qualify_is_refused():
    """"A3" when only two advance, and "L3" when only two best losers do."""
    groups = ["Group A", "Group B", "Group C"]
    for sheet in (
        [["A3", "L1"], ["A2", "C1"], ["B1", "L2"], ["B2", "C2"]],
        [["A1", "L3"], ["A2", "C1"], ["B1", "L2"], ["B2", "C2"]],
    ):
        with pytest.raises(ValueError):
            authored_qualifier_pairs(
                sheet, groups, advance_per_group=2, advance_best_thirds=2,
            )


def test_an_unknown_group_is_named_in_the_error():
    with pytest.raises(ValueError, match="no group"):
        authored_qualifier_pairs(
            [["A1", "D1"]], ["Group A", "Group B"],
            advance_per_group=1, advance_best_thirds=0,
        )


def test_the_shape_is_checked_when_the_config_is_saved():
    """Slot COVERAGE needs the groups, which do not exist until the teams are
    in. Shape does not, so it is caught at save time where the organiser is
    still looking at the form."""
    _validate_stages(_stages())  # the good one
    for bad in (
        _stages(pairings=[["A1", "L1"], ["A2", "C1"], ["B1", "L2"]]),  # not 2^n
        _stages(meets=[[1, 1], [2, 4]]),                               # M3 unpaired
        _stages(pairings=[["A1"], ["A2", "C1"], ["B1", "L2"], ["B2", "C2"]]),
    ):
        with pytest.raises(ValueError):
            _validate_stages(bad)


def test_explicit_seeding_without_a_sheet_is_refused():
    stages = _stages()
    del stages[1]["from"]["pairings"]
    with pytest.raises(ValueError, match=re.escape("from.pairings")):
        _validate_stages(stages)


def test_the_best_losers_arrive_when_the_last_group_match_ends():
    """A group position is answerable as soon as ITS group is done; "best
    loser" is not answerable until every group is. So the slot stays open,
    visibly, and fills on the last whistle rather than being guessed early."""
    admin = _verified()
    t = _tournament(admin)
    _generate(t)

    group_matches = list(
        Match.objects.filter(tournament=t, stage="group", deleted_at__isnull=True)
        .select_related("home_team", "away_team").order_by("group_label", "match_no")
    )
    # Play every group but the last one: the best-loser slots must stay empty.
    labels = sorted({m.group_label for m in group_matches})
    for m in [g for g in group_matches if g.group_label != labels[-1]]:
        record_score(match=m, home_score=2, away_score=1, by=admin)
        advance_from_match(m.id)  # on_commit doesn't fire inside the test txn
    open_slots = [
        m for m in _knockout(t)
        if (m.home_source or {}).get("best_third") and m.home_team_id is None
    ] + [
        m for m in _knockout(t)
        if (m.away_source or {}).get("best_third") and m.away_team_id is None
    ]
    assert len(open_slots) == 2

    for m in [g for g in group_matches if g.group_label == labels[-1]]:
        record_score(match=m, home_score=2, away_score=1, by=admin)
        advance_from_match(m.id)

    filled = [
        m for m in _knockout(t)
        if (m.away_source or {}).get("best_third") and m.away_team_id is not None
    ]
    assert len(filled) == 2
    # Two DIFFERENT teams, and neither of them qualified in a top-two place.
    assert len({m.away_team_id for m in filled}) == 2


def test_the_bracket_previews_exactly_as_it_commits():
    """The preview is what an organiser signs off, so it must show the sheet
    that will commit and not the cross-seed it replaced."""
    from apps.fixtures.services.preview import preview_fixtures

    admin = _verified()
    t = _tournament(admin)
    body = preview_fixtures(tournament=t, leaf_key=None, include_schedule=False)
    ko = [m for m in body["matches"] if m["stage"] == "knockout"]
    r1 = [m for m in ko if m["round_no"] == 1]
    assert [
        (_slot(m["home"]["source"]), _slot(m["away"]["source"])) for m in r1
    ] == [("A1", "L1"), ("A2", "C1"), ("B1", "L2"), ("B2", "C2")]
    assert len([m for m in ko if m["round_no"] == 2]) == 2
