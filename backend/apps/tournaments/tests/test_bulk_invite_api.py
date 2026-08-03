"""POST /api/tournaments/{id}/invitations/bulk/ — invite a whole crew at once.

The live "Dimapur Tourni" had a roster of exactly one person because inviting
had to happen one address at a time. This endpoint is the fix, and its
contract is per-row: one bad address must never discard the good ones.
"""
from __future__ import annotations

import uuid

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.utils import timezone
from rest_framework.test import APIClient

from apps.organizations.models import AdminInvitation, InviteStatus
from apps.organizations.services.invitation import create_invitation
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


def _verified(email: str) -> User:
    user = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True
    )
    user.email_verified_at = timezone.now()
    user.save(update_fields=["email_verified_at"])
    return user


def _client(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _url(tournament) -> str:
    return f"/api/tournaments/{tournament.id}/invitations/bulk/"


def _post(client, tournament, body, capture=None):
    """POST the batch, executing the post-commit mail hook when asked."""
    if capture is None:
        return client.post(_url(tournament), body, format="json")
    with capture(execute=True):
        resp = client.post(_url(tournament), body, format="json")
    return resp


def _by_email(payload) -> dict[str, dict]:
    return {row["email"]: row for row in payload["results"]}


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_bulk_invite_creates_every_row(django_capture_on_commit_callbacks):
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")
    emails = [f"crew{i}@test.local" for i in range(5)]

    resp = _post(
        _client(admin),
        t,
        {"invitations": [{"email": e, "role": "match_scorer"} for e in emails]},
        capture=django_capture_on_commit_callbacks,
    )

    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["summary"] == {"invited": 5, "skipped": 0, "failed": 0, "total": 5}
    assert body["replayed"] is False
    assert all(r["status"] == "invited" for r in body["results"])
    assert all(r["invitation_id"] for r in body["results"])
    assert AdminInvitation.objects.filter(tournament=t, email__in=emails).count() == 5
    assert {inv.role for inv in AdminInvitation.objects.filter(tournament=t)} == {
        "match_scorer"
    }
    # Every new invite is actually mailed, and the token is never returned.
    assert len(mail.outbox) == 5
    assert {m.to[0] for m in mail.outbox} == set(emails)
    assert "token" not in resp.content.decode()


def test_top_level_role_is_the_default_for_rows_without_one():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")

    resp = _post(
        _client(admin),
        t,
        {"invitations": ["a@test.local", {"email": "b@test.local"}], "role": "referee"},
    )

    assert resp.status_code == 200, resp.content
    assert resp.json()["summary"]["invited"] == 2
    assert set(
        AdminInvitation.objects.filter(tournament=t).values_list("role", flat=True)
    ) == {"referee"}


@pytest.mark.parametrize("role", [r.value for r in TournamentMembershipRole])
def test_every_tournament_role_is_accepted(role):
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")

    resp = _post(
        _client(admin), t, {"invitations": [{"email": "x@test.local", "role": role}]}
    )

    assert resp.status_code == 200, resp.content
    assert resp.json()["results"][0]["status"] == "invited"
    assert AdminInvitation.objects.get(tournament=t, email="x@test.local").role == role


# ---------------------------------------------------------------------------
# Mixed batch — the core promise
# ---------------------------------------------------------------------------


def test_mixed_batch_still_creates_the_good_rows(django_capture_on_commit_callbacks):
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")

    # One already-pending invite.
    create_invitation(
        org=t.organization,
        tournament=t,
        email="pending@test.local",
        role="referee",
        invited_by=admin,
    )
    # One already-a-member.
    member = _verified("member@test.local")
    TournamentMembership.objects.create(
        user=member,
        tournament=t,
        role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )
    mail.outbox.clear()

    resp = _post(
        _client(admin),
        t,
        {
            "invitations": [
                {"email": "not-an-email", "role": "match_scorer"},
                {"email": "pending@test.local", "role": "match_scorer"},
                {"email": "member@test.local", "role": "match_scorer"},
                {"email": "good1@test.local", "role": "match_scorer"},
                {"email": "good2@test.local", "role": "referee"},
                {"email": "good3@test.local", "role": "team_manager"},
            ]
        },
        capture=django_capture_on_commit_callbacks,
    )

    assert resp.status_code == 200, resp.content
    body = resp.json()
    rows = _by_email(body)
    assert rows["not-an-email"]["status"] == "invalid_email"
    assert rows["pending@test.local"]["status"] == "already_pending"
    assert rows["pending@test.local"]["invitation_id"]  # points at the live invite
    assert rows["member@test.local"]["status"] == "already_member"
    assert [rows[f"good{i}@test.local"]["status"] for i in (1, 2, 3)] == [
        "invited"
    ] * 3
    assert body["summary"] == {"invited": 3, "skipped": 2, "failed": 1, "total": 6}

    # The three good ones exist despite the bad row sitting first.
    for i in (1, 2, 3):
        assert AdminInvitation.objects.filter(
            tournament=t, email=f"good{i}@test.local", status=InviteStatus.PENDING
        ).exists()
    # Mail goes to the NEW invites only — never to the skipped rows.
    assert sorted(m.to[0] for m in mail.outbox) == [
        "good1@test.local",
        "good2@test.local",
        "good3@test.local",
    ]


def test_invalid_role_is_a_per_row_failure_not_a_batch_failure():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")

    resp = _post(
        _client(admin),
        t,
        {
            "invitations": [
                {"email": "a@test.local", "role": "supreme_overlord"},
                {"email": "b@test.local"},  # no role at all
                {"email": "c@test.local", "role": "referee"},
            ]
        },
    )

    assert resp.status_code == 200, resp.content
    rows = _by_email(resp.json())
    assert rows["a@test.local"]["status"] == "invalid_role"
    assert rows["b@test.local"]["detail"] == "role_required"
    assert rows["b@test.local"]["status"] == "invalid_role"
    assert rows["c@test.local"]["status"] == "invited"
    assert resp.json()["summary"] == {
        "invited": 1,
        "skipped": 0,
        "failed": 2,
        "total": 3,
    }
    assert not AdminInvitation.objects.filter(email="a@test.local").exists()


def test_a_row_that_explodes_mid_write_rolls_back_only_itself(monkeypatch):
    """Per-row savepoints: a row that blows up AFTER writing must not take the
    committed rows around it down with it."""
    from apps.tournaments.services import bulk_invite as mod

    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")
    real = mod.create_invitation

    def flaky(**kwargs):
        inv, token = real(**kwargs)  # the row IS written
        if kwargs["email"] == "boom@test.local":
            raise RuntimeError("mail server on fire")
        return inv, token

    monkeypatch.setattr(mod, "create_invitation", flaky)

    resp = _post(
        _client(admin),
        t,
        {
            "invitations": [
                {"email": "before@test.local", "role": "referee"},
                {"email": "boom@test.local", "role": "referee"},
                {"email": "after@test.local", "role": "referee"},
            ]
        },
    )

    assert resp.status_code == 200, resp.content
    rows = _by_email(resp.json())
    assert rows["boom@test.local"]["status"] == "error"
    assert "mail server on fire" in rows["boom@test.local"]["detail"]
    assert rows["before@test.local"]["status"] == "invited"
    assert rows["after@test.local"]["status"] == "invited"
    assert set(
        AdminInvitation.objects.filter(tournament=t).values_list("email", flat=True)
    ) == {"before@test.local", "after@test.local"}


def test_inviting_the_organiser_himself_reports_already_member():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")

    resp = _post(
        _client(admin),
        t,
        {"invitations": [{"email": "ADMIN@test.local", "role": "match_scorer"}]},
    )

    assert resp.status_code == 200, resp.content
    assert resp.json()["results"][0]["status"] == "already_member"
    assert not AdminInvitation.objects.filter(tournament=t).exists()


# ---------------------------------------------------------------------------
# Normalisation, cap, idempotency
# ---------------------------------------------------------------------------


def test_duplicate_emails_are_normalised_and_reported_once(
    django_capture_on_commit_callbacks,
):
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")

    resp = _post(
        _client(admin),
        t,
        {
            "invitations": [
                {"email": "Dup@Test.local", "role": "referee"},
                {"email": "  dup@test.local  ", "role": "match_scorer"},
                {"email": "DUP@TEST.LOCAL", "role": "referee"},
                {"email": "other@test.local", "role": "referee"},
            ]
        },
        capture=django_capture_on_commit_callbacks,
    )

    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert len(body["results"]) == 2
    assert [r["email"] for r in body["results"]] == [
        "dup@test.local",
        "other@test.local",
    ]
    assert body["summary"] == {"invited": 2, "skipped": 0, "failed": 0, "total": 2}
    assert AdminInvitation.objects.filter(tournament=t, email="dup@test.local").count() == 1
    # First occurrence wins the role.
    assert AdminInvitation.objects.get(tournament=t, email="dup@test.local").role == "referee"
    assert len(mail.outbox) == 2


def test_empty_batch_is_rejected():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")

    resp = _post(_client(admin), t, {"invitations": []})

    assert resp.status_code == 400
    assert resp.json()["detail"] == "invitations_required"


def test_batch_over_the_cap_is_rejected(settings):
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")
    rows = [
        {"email": f"crew{i}@test.local", "role": "match_scorer"}
        for i in range(settings.INVITE_BULK_MAX + 1)
    ]

    resp = _post(_client(admin), t, {"invitations": rows})

    assert resp.status_code == 400
    assert resp.json()["detail"] == "too_many_invitations"
    assert resp.json()["max"] == settings.INVITE_BULK_MAX
    assert not AdminInvitation.objects.filter(tournament=t).exists()


def test_event_id_replay_returns_the_original_result_and_mails_nobody(
    django_capture_on_commit_callbacks,
):
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")
    client = _client(admin)
    body = {
        "invitations": [
            {"email": "a@test.local", "role": "referee"},
            {"email": "b@test.local", "role": "match_scorer"},
        ],
        "event_id": str(uuid.uuid4()),
    }

    first = _post(client, t, body, capture=django_capture_on_commit_callbacks)
    assert first.status_code == 200, first.content
    assert len(mail.outbox) == 2
    mail.outbox.clear()

    second = _post(client, t, body, capture=django_capture_on_commit_callbacks)

    assert second.status_code == 200, second.content
    assert second.json()["replayed"] is True
    assert second.json()["results"] == first.json()["results"]
    assert second.json()["summary"] == first.json()["summary"]
    assert AdminInvitation.objects.filter(tournament=t).count() == 2  # no duplicates
    assert mail.outbox == []  # a replay must not re-send


def test_invalid_event_id_is_rejected():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")

    resp = _post(
        _client(admin),
        t,
        {"invitations": [{"email": "a@test.local", "role": "referee"}], "event_id": "nope"},
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] == "invalid_event_id"


def test_batch_is_audited_with_the_counts():
    from apps.audit.models import AuditEvent

    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")

    _post(
        _client(admin),
        t,
        {"invitations": [{"email": "a@test.local", "role": "referee"}]},
    )

    audit = AuditEvent.objects.get(event_type="invitations_bulk_created")
    assert audit.target_id == t.id
    assert audit.tournament_id == t.id
    assert audit.organization_id == t.organization_id
    assert audit.payload_after["summary"]["invited"] == 1


# ---------------------------------------------------------------------------
# Isolation (invariant 2) — not optional
# ---------------------------------------------------------------------------


def test_manager_of_another_org_cannot_invite_into_this_tournament():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")
    # A fully-fledged manager — of a DIFFERENT workspace.
    other = _verified("other-admin@test.local")
    create_tournament(user=other, name="Kohima Cup")

    resp = _post(
        _client(other),
        t,
        {"invitations": [{"email": "x@test.local", "role": "referee"}]},
    )

    assert resp.status_code == 404  # no existence leak
    assert not AdminInvitation.objects.filter(email="x@test.local").exists()


def test_outsider_cannot_bulk_invite():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")
    outsider = _verified("outsider@test.local")

    resp = _post(
        _client(outsider),
        t,
        {"invitations": [{"email": "x@test.local", "role": "referee"}]},
    )

    assert resp.status_code == 404
    assert not AdminInvitation.objects.filter(email="x@test.local").exists()


def test_non_manager_member_cannot_bulk_invite():
    """A member who CAN see the tournament but doesn't manage it gets 403 —
    the same answer the single-invite view and member-detail view give. Only
    a tournament that doesn't resolve at all 404s."""
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")
    scorer = _verified("scorer@test.local")
    TournamentMembership.objects.create(
        user=scorer,
        tournament=t,
        role=TournamentMembershipRole.MATCH_SCORER,
        status=TournamentMembershipStatus.ACTIVE,
    )

    resp = _post(
        _client(scorer),
        t,
        {"invitations": [{"email": "x@test.local", "role": "referee"}]},
    )

    assert resp.status_code == 403
    assert not AdminInvitation.objects.filter(email="x@test.local").exists()


def test_invited_co_organizer_can_bulk_invite():
    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")
    co = _verified("co@test.local")
    TournamentMembership.objects.create(
        user=co,
        tournament=t,
        role=TournamentMembershipRole.CO_ORGANIZER,
        status=TournamentMembershipStatus.ACTIVE,
    )

    resp = _post(
        _client(co), t, {"invitations": [{"email": "x@test.local", "role": "referee"}]}
    )

    assert resp.status_code == 200, resp.content
    assert resp.json()["summary"]["invited"] == 1


def test_bulk_invite_never_creates_an_org_membership():
    """Tournament invites stay tournament-scoped (isolation is deliberate)."""
    from apps.organizations.models import OrganizationMembership

    admin = _verified("admin@test.local")
    t = create_tournament(user=admin, name="Dimapur Tourni")
    before = OrganizationMembership.objects.count()

    _post(
        _client(admin),
        t,
        {"invitations": [{"email": "x@test.local", "role": "referee"}]},
    )

    inv = AdminInvitation.objects.get(email="x@test.local")
    assert inv.tournament_id == t.id
    assert OrganizationMembership.objects.count() == before
    assert not User.objects.filter(email="x@test.local").exists()  # no user conjured
