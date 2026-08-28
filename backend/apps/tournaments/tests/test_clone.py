"""Cloning a tournament END-TO-END (owner ask, 2026-08-23).

"Add a button where any user can clone any tournament and the clone should
retain exactly the same as the one — even fixture, everything, end to end."

The clone is a fork: settings, venues/courts, forms, institutions, teams,
players, and the FIXTURE ITSELF — matches with slots, scores, statuses, event
history and advancement pointers, all remapped to the new ids so brackets and
standings read identically. It lands in the CALLER's workspace; nothing is
written into the source tenant.
"""
from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.tournaments.models import Tournament
from apps.tournaments.services.clone import clone_tournament
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _user(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def test_clone_copies_settings_teams_and_fixture_end_to_end():
    from apps.fixtures.services.generate import generate_round_robin
    from apps.matches.models import Match, MatchEvent
    from apps.matches.services.events import record_match_event
    from apps.teams.models import Institution, Person, Player, Team

    owner = _user("src@example.com")
    cloner = _user("cloner@example.com")
    src = create_tournament(user=owner, name="Dimapur TT Cup")

    Institution.objects.create(
        organization=src.organization, tournament=src,
        slug="gps", name="Govt Primary School",
    )
    inst = Institution.objects.get(tournament=src)
    for n in ("Alpha", "Beta"):
        Team.objects.create(
            organization=src.organization, tournament=src,
            institution=inst, slug=n.lower(), name=n,
            leaf_key="table_tennis.u_14.boys.singles",
        )
    team_a = Team.objects.get(name="Alpha")
    person = Person.objects.create(
        created_by=owner, full_name="Kevo",
    )
    Player.objects.create(
        organization=src.organization, tournament=src,
        team=team_a, person=person, jersey_no=1, captain=True,
    )
    src.draw_config = {
        "table_tennis.u_14.boys.singles": {"format": "round_robin", "legs": 1}
    }
    src.constraints = [
        {"type": "competition_priority", "scope": "__all__",
         "params": {"order": ["table_tennis"]}},
    ]
    src.save()

    matches = generate_round_robin(
        tournament=src, leaf_key="table_tennis.u_14.boys.singles"
    )
    first = matches[0]
    record_match_event(
        match=first, event_type="GOAL", by=owner, team=team_a
    )
    first.refresh_from_db()
    assert first.home_score is not None or first.away_score is not None

    # A user who has NO access to the source clones it into their own workspace.
    clone = clone_tournament(source=src, target_org=cloner_org(cloner), by=cloner)

    assert clone.pk != src.pk
    assert clone.organization != src.organization
    assert clone.name.startswith("Dimapur TT Cup (Clone)")
    assert clone.status == src.status
    assert clone.draw_config == src.draw_config
    assert clone.constraints == src.constraints
    # Teams + players came along.
    assert Team.objects.filter(tournament=clone).count() == 2
    assert Player.objects.filter(tournament=clone).count() == 1
    assert not Team.objects.filter(
        tournament=clone, institution__tournament=src
    ).exists(), "the clone must reference ITS OWN institution copies"
    # The fixture itself: same count, same pairing shape, scores intact.
    new_matches = list(Match.objects.filter(tournament=clone))
    old_matches = list(Match.objects.filter(tournament=src))
    assert len(new_matches) == len(old_matches)
    old_first = min(old_matches, key=lambda m: m.match_no)
    new_first = min(new_matches, key=lambda m: m.match_no)
    assert new_first.home_team.institution.tournament_id == clone.id
    assert new_first.home_team.name == old_first.home_team.name
    assert new_first.home_score == old_first.home_score
    assert new_first.away_score == old_first.away_score
    assert new_first.status == old_first.status
    # The event log replayed, so standings derive identically.
    assert MatchEvent.objects.filter(tournament=clone).count() == (
        MatchEvent.objects.filter(tournament=src).count()
    )
    # Advancement pointers remap to the CLONE's match ids, never dangle.
    for m in new_matches:
        for side in (m.home_source, m.away_source):
            ref = (side or {}).get("match_id") if isinstance(side, dict) else None
            if ref:
                assert str(ref) in {str(x.id) for x in new_matches}


def cloner_org(user):
    from apps.organizations.services.workspace import provision_personal_workspace
    return provision_personal_workspace(user=user, name="Cloner Workspace")


def test_clone_is_idempotent_on_event_id():
    owner = _user("idem-src@example.com")
    cloner = _user("idem-clone@example.com")
    src = create_tournament(user=owner, name="Idempotent Cup")
    org = cloner_org(cloner)
    eid = "11111111-1111-5111-8111-111111111111"
    a = clone_tournament(source=src, target_org=org, by=cloner, event_id=eid)
    b = clone_tournament(source=src, target_org=org, by=cloner, event_id=eid)
    assert a.id == b.id
    assert Tournament.objects.filter(name__startswith="Idempotent Cup").count() == 2


def test_clone_survives_events_that_carry_a_client_event_id():
    """Prod 2026-08-28: cloning the live ANPSA tournament failed with
    ``duplicate key value violates unique constraint
    "matches_match_event_event_id_key"``. Every real score comes in with the
    scorer's idempotency ``event_id`` (invariant 3), and the copy carried it
    over into a column that is unique across the table. A copied event was
    never submitted by anyone — it has no client key."""
    from apps.fixtures.services.generate import generate_round_robin
    from apps.matches.models import MatchEvent
    from apps.matches.services.events import record_match_event
    from apps.teams.models import Institution, Team

    owner = _user("keyed-src@example.com")
    cloner = _user("keyed-clone@example.com")
    src = create_tournament(user=owner, name="Keyed Cup")
    inst = Institution.objects.create(
        organization=src.organization, tournament=src,
        slug="gps", name="Govt Primary School",
    )
    for n in ("Alpha", "Beta"):
        Team.objects.create(
            organization=src.organization, tournament=src,
            institution=inst, slug=n.lower(), name=n,
            leaf_key="table_tennis.u_14.boys.singles",
        )
    team_a = Team.objects.get(name="Alpha")
    src.draw_config = {
        "table_tennis.u_14.boys.singles": {"format": "round_robin", "legs": 1}
    }
    src.save()
    first = generate_round_robin(
        tournament=src, leaf_key="table_tennis.u_14.boys.singles"
    )[0]
    record_match_event(
        match=first, event_type="GOAL", by=owner, team=team_a,
        event_id="22222222-2222-5222-8222-222222222222",
    )
    assert MatchEvent.objects.filter(tournament=src, event_id__isnull=False).exists()

    clone = clone_tournament(source=src, target_org=cloner_org(cloner), by=cloner)

    copied = MatchEvent.objects.filter(tournament=clone)
    assert copied.count() == MatchEvent.objects.filter(tournament=src).count()
    # The source keeps its keys; the copies have none.
    assert not copied.filter(event_id__isnull=False).exists()
