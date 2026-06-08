"""Tournament setup-stage state machine (services/state.py) — the mandatory
state-machine suite (every legal + illegal transition) plus lifecycle coupling,
form auto-close, warn/blocker semantics, reversibility, and idempotency.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.forms.constants import FormPurpose, FormStatus
from apps.forms.models import Form
from apps.matches.models import Match
from apps.teams.models import Team, TeamStatus
from apps.tournaments.models import TournamentStage as G
from apps.tournaments.models import TournamentStatus as S
from apps.tournaments.services import state as st
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _admin(email="admin@stage.test"):
    u = User.objects.create_user(email=email, password="FixtureDemo2026!", is_active=True)
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _team(t, name="Team A"):
    return Team.objects.create(
        organization=t.organization, tournament=t, slug=name.lower().replace(" ", "-"),
        name=name, status=TeamStatus.REGISTERED,
    )


def _match(t):
    return Match.objects.create(organization=t.organization, tournament=t, status="scheduled")


def _advance(t, to, **kw):
    return st.transition_tournament(tournament=t, to_stage=to, ack_warnings=True, **kw)


# --------------------------------------------------------------------------- table
def test_allowed_transitions_table_complete():
    """Every (from,to) pair: legal iff one-step-forward OR any-earlier (reopen)."""
    order = st._ORDER
    for i, frm in enumerate(order):
        for j, to in enumerate(order):
            legal = (j == i + 1) or (j < i)  # one forward, or any earlier
            assert st.can_transition(frm, to) is legal, f"{frm}->{to}"


@pytest.mark.parametrize("to", [G.TEAM_REGISTRATION, G.MEMBERS, G.FIXTURES, G.READY])
def test_illegal_forward_skip_raises(to):
    t = create_tournament(user=_admin(), name="Skip")
    assert t.stage == G.SETUP
    with pytest.raises(ValidationError, match="Illegal stage transition"):
        st.transition_tournament(tournament=t, to_stage=to, ack_warnings=True)


# --------------------------------------------------------------------------- happy path
def test_forward_happy_path_with_lifecycle_and_freeze():
    t = create_tournament(user=_admin(), name="Happy")
    assert t.status == S.DRAFT and t.stage == G.SETUP

    t = _advance(t, G.ORG_REGISTRATION)
    assert t.stage == G.ORG_REGISTRATION and t.status == S.PUBLISHED

    t = _advance(t, G.TEAM_REGISTRATION)
    assert t.stage == G.TEAM_REGISTRATION and t.status == S.REGISTRATION_OPEN
    assert t.rules_frozen_at is not None  # freeze_rules wired (invariant 7)

    _team(t)  # satisfy the members blocker
    t = _advance(t, G.MEMBERS)
    assert t.stage == G.MEMBERS

    t = _advance(t, G.FIXTURES)
    assert t.stage == G.FIXTURES

    _match(t)  # satisfy the ready blocker
    t = _advance(t, G.READY)
    assert t.stage == G.READY and t.status == S.SCHEDULED


# --------------------------------------------------------------------------- blockers
def test_blocker_no_teams_for_members():
    t = create_tournament(user=_admin(), name="Block")
    t = _advance(t, G.ORG_REGISTRATION)
    t = _advance(t, G.TEAM_REGISTRATION)
    with pytest.raises(st.StageTransitionError) as exc:
        st.transition_tournament(tournament=t, to_stage=G.MEMBERS, ack_warnings=True)
    assert exc.value.detail == "stage_blocked"
    assert "no_teams_registered" in exc.value.consequences["blockers"]


def test_blocker_no_fixtures_for_ready():
    t = create_tournament(user=_admin(), name="Block2")
    t = _advance(t, G.ORG_REGISTRATION)
    t = _advance(t, G.TEAM_REGISTRATION)
    _team(t)
    t = _advance(t, G.MEMBERS)
    t = _advance(t, G.FIXTURES)
    with pytest.raises(st.StageTransitionError) as exc:
        st.transition_tournament(tournament=t, to_stage=G.READY, ack_warnings=True)
    assert exc.value.detail == "stage_blocked"


# --------------------------------------------------------------------------- warnings
def test_unacknowledged_warnings_blocks_then_acks():
    t = create_tournament(user=_admin(), name="Warn")
    # setup -> org_registration changes lifecycle (draft->published) => a warning
    with pytest.raises(st.StageTransitionError) as exc:
        st.transition_tournament(tournament=t, to_stage=G.ORG_REGISTRATION)  # no ack
    assert exc.value.detail == "unacknowledged_warnings"
    # with ack it proceeds
    t = st.transition_tournament(tournament=t, to_stage=G.ORG_REGISTRATION, ack_warnings=True)
    assert t.stage == G.ORG_REGISTRATION


def test_preview_advance_reports_freeze_and_lifecycle():
    t = create_tournament(user=_admin(), name="Prev")
    t = _advance(t, G.ORG_REGISTRATION)
    prev = st.preview_advance(t, G.TEAM_REGISTRATION)
    codes = {w["code"] for w in prev["warnings"]}
    assert "rules_will_freeze" in codes and "lifecycle_will_change" in codes
    assert prev["allowed"] is True


# --------------------------------------------------------------------------- forms
def test_form_autoclose_on_advance():
    t = create_tournament(user=_admin(), name="Forms")
    t = _advance(t, G.ORG_REGISTRATION)
    form = Form.objects.create(
        organization=t.organization, tournament=t, slug="org-signup", title="Sign up",
        purpose=FormPurpose.ORGANIZATION_REGISTRATION, stage=G.ORG_REGISTRATION,
        status=FormStatus.OPEN, schema={"sections": [{"key": "s", "title": "S", "fields": []}]},
    )
    t = _advance(t, G.TEAM_REGISTRATION)  # leaving org_registration closes its form
    form.refresh_from_db()
    assert form.status == FormStatus.CLOSED
    assert AuditEvent.objects.filter(event_type="form_closed", target_id=form.id).exists()


# --------------------------------------------------------------------------- reversibility
def test_reopen_does_not_roll_back_lifecycle_or_unfreeze():
    t = create_tournament(user=_admin(), name="Reopen")
    t = _advance(t, G.ORG_REGISTRATION)
    t = _advance(t, G.TEAM_REGISTRATION)
    frozen_at = t.rules_frozen_at
    assert frozen_at is not None and t.status == S.REGISTRATION_OPEN

    t = st.transition_tournament(tournament=t, to_stage=G.ORG_REGISTRATION, ack_warnings=True)
    assert t.stage == G.ORG_REGISTRATION
    assert t.status == S.REGISTRATION_OPEN          # lifecycle NOT rolled back
    assert t.rules_frozen_at == frozen_at           # still frozen
    assert t.stage_meta["org_registration"]["reopened_count"] == 1


def test_reopen_with_matches_warns_downstream():
    t = create_tournament(user=_admin(), name="Down")
    t = _advance(t, G.ORG_REGISTRATION)
    t = _advance(t, G.TEAM_REGISTRATION)
    _team(t)
    t = _advance(t, G.MEMBERS)
    t = _advance(t, G.FIXTURES)
    _match(t)
    prev = st.preview_reopen(t, G.TEAM_REGISTRATION)
    codes = {w["code"] for w in prev["warnings"]}
    assert "downstream_artifacts_exist" in codes


# --------------------------------------------------------------------------- idempotency + audit
def test_idempotent_replay_single_audit_row():
    t = create_tournament(user=_admin(), name="Idem")
    eid = uuid.uuid4()
    t = st.transition_tournament(tournament=t, to_stage=G.ORG_REGISTRATION,
                                 ack_warnings=True, event_id=eid)
    # replay: no-op, no second audit row
    st.transition_tournament(tournament=t, to_stage=G.ORG_REGISTRATION,
                             ack_warnings=True, event_id=eid)
    rows = AuditEvent.objects.filter(
        event_type="tournament_stage_changed", idempotency_key=eid
    )
    assert rows.count() == 1


def test_audit_event_string_pinned():
    t = create_tournament(user=_admin(), name="Audit")
    _advance(t, G.ORG_REGISTRATION)
    assert AuditEvent.objects.filter(
        event_type="tournament_stage_changed", target_type="tournament"
    ).exists()


# --------------------------------------------------------------------------- payload
def test_build_stage_payload_shape():
    admin = _admin()
    t = create_tournament(user=admin, name="Payload")
    payload = st.build_stage_payload(t, admin)
    assert payload["stage"] == G.SETUP
    assert payload["order"] == list(st._ORDER)
    assert payload["allowed_to"] == sorted(st.ALLOWED_TRANSITIONS[G.SETUP])
    assert payload["can_manage"] is True
    assert [s["key"] for s in payload["stages"]] == list(st._ORDER)
    assert payload["stages"][0]["state"] == "current"
    assert payload["stages"][1]["state"] == "upcoming"
