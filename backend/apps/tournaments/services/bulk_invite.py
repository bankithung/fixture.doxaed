"""Bulk tournament invitations (owner request 2026-08-03).

Inviting a crew one address at a time is the reason a live tournament can end
up with every scorer seat filled by the organiser himself. This service takes
a list of ``{email, role}`` rows and invites them in one pass.

Two rules shape the whole module:

1. **Per-row outcomes, never all-or-nothing.** One fat-fingered address must
   not discard nineteen good ones, so every row runs inside its own
   ``atomic()`` savepoint (the request itself is already a transaction —
   ``ATOMIC_REQUESTS = True``) and a failure rolls back that row alone.
2. **Mail leaves the request path.** ``create_invitation`` is called with
   ``send_email=False``; the caller mails the whole batch over ONE connection
   from a ``transaction.on_commit`` hook, so SMTP latency never holds a write
   transaction open and a bounced address never rolls back a committed row.

``already_pending`` is deliberately a *skip*, not a failure: an organiser who
pastes the same list twice should be told "already pending", not handed an
error.
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction

from apps.organizations.models import AdminInvitation, InviteStatus
from apps.organizations.services.invitation import create_invitation
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)

# Row outcomes. `invited` counts as a success; `already_*` are skips (the
# invitee is already handled); the rest are failures.
STATUS_INVITED = "invited"
STATUS_ALREADY_PENDING = "already_pending"
STATUS_ALREADY_MEMBER = "already_member"
STATUS_INVALID_EMAIL = "invalid_email"
STATUS_INVALID_ROLE = "invalid_role"
STATUS_ERROR = "error"

_SKIPPED = {STATUS_ALREADY_PENDING, STATUS_ALREADY_MEMBER}


@dataclass
class BulkInviteResult:
    results: list[dict[str, Any]] = field(default_factory=list)
    summary: dict[str, int] = field(default_factory=dict)
    # (invitation, plaintext_token) pairs still owed an email.
    pending_mail: list[tuple[AdminInvitation, str]] = field(default_factory=list)


def _row(email: str, role: str | None, status: str, detail: str = "", inv_id=None) -> dict:
    return {
        "email": email,
        "role": role,
        "status": status,
        "detail": detail,
        "invitation_id": str(inv_id) if inv_id else None,
    }


def normalize_rows(
    raw_rows: Iterable[Any], *, default_role: str | None = None
) -> list[tuple[str, str | None]]:
    """Normalise + de-duplicate the request rows.

    Emails are trimmed and lower-cased; the FIRST occurrence of an address
    wins (so a paste that repeats an address is reported once, not twice).
    A row may be ``{"email": ..., "role": ...}`` or a bare email string.
    Returns ``[(email, role_or_None), ...]`` in first-appearance order.
    """
    seen: set[str] = set()
    out: list[tuple[str, str | None]] = []
    for raw in raw_rows:
        if isinstance(raw, str):
            email, role = raw, default_role
        elif isinstance(raw, dict):
            email = raw.get("email") or ""
            role = raw.get("role") or default_role
        else:
            email, role = "", default_role
        email = str(email).strip().lower()
        key = email or f"__blank__{len(out)}"  # blanks each get their own row
        if key in seen:
            continue
        seen.add(key)
        out.append((email, str(role) if role else None))
    return out


def _is_already_member(tournament, email: str) -> bool:
    """True if somebody with this address is already on the tournament.

    Covers both the roster (an active TournamentMembership) and the people who
    never needed one — the tournament's creator and the workspace org admins
    (``is_tournament_organizer``). Inviting them is a no-op that would only
    produce a confusing pending row.
    """
    from apps.tournaments.permissions import is_tournament_organizer

    user = get_user_model().objects.filter(email__iexact=email).first()
    if user is None:
        return False
    if TournamentMembership.objects.filter(
        user=user,
        tournament=tournament,
        status=TournamentMembershipStatus.ACTIVE,
    ).exists():
        return True
    return is_tournament_organizer(user, tournament)


def _pending_invitation(tournament, email: str) -> AdminInvitation | None:
    return AdminInvitation.objects.filter(
        organization_id=tournament.organization_id,
        tournament=tournament,
        email=email,
        status=InviteStatus.PENDING,
    ).first()


def bulk_invite(
    *,
    tournament,
    rows: Sequence[tuple[str, str | None]],
    invited_by,
    request=None,
) -> BulkInviteResult:
    """Invite every row, reporting each outcome independently.

    ``rows`` must already be normalised/de-duplicated (see
    :func:`normalize_rows`). No email is sent here — the returned
    ``pending_mail`` pairs are the caller's to deliver, ideally from a
    ``transaction.on_commit`` hook.
    """
    result = BulkInviteResult()
    valid_roles = set(TournamentMembershipRole.values)

    for email, role in rows:
        if not email:
            result.results.append(
                _row(email, role, STATUS_INVALID_EMAIL, "email_required")
            )
            continue
        try:
            validate_email(email)
        except ValidationError:
            result.results.append(
                _row(email, role, STATUS_INVALID_EMAIL, "not_a_valid_email")
            )
            continue
        if not role:
            result.results.append(_row(email, role, STATUS_INVALID_ROLE, "role_required"))
            continue
        if role not in valid_roles:
            result.results.append(
                _row(email, role, STATUS_INVALID_ROLE, f"unknown_role:{role}")
            )
            continue

        existing = _pending_invitation(tournament, email)
        if existing is not None:
            result.results.append(
                _row(
                    email,
                    existing.role,
                    STATUS_ALREADY_PENDING,
                    "invitation_already_pending",
                    existing.id,
                )
            )
            continue

        if _is_already_member(tournament, email):
            result.results.append(
                _row(email, role, STATUS_ALREADY_MEMBER, "already_on_this_tournament")
            )
            continue

        # One savepoint per row: a ValidationError here rolls back THIS row
        # only, never the invitations already created above it.
        try:
            with transaction.atomic():
                inv, token = create_invitation(
                    org=tournament.organization,
                    tournament=tournament,
                    email=email,
                    role=role,
                    invited_by=invited_by,
                    request=request,
                    send_email=False,
                )
        except ValidationError as exc:
            # Lost a race with a concurrent invite for the same address?
            # That is still "already pending", not a failure.
            racing = _pending_invitation(tournament, email)
            if racing is not None:
                result.results.append(
                    _row(
                        email,
                        racing.role,
                        STATUS_ALREADY_PENDING,
                        "invitation_already_pending",
                        racing.id,
                    )
                )
            else:
                detail = "; ".join(getattr(exc, "messages", None) or [str(exc)])
                result.results.append(_row(email, role, STATUS_ERROR, detail[:300]))
            continue
        except Exception as exc:  # one bad row must never kill the batch
            result.results.append(
                _row(email, role, STATUS_ERROR, str(exc)[:300])
            )
            continue

        result.pending_mail.append((inv, token))
        result.results.append(_row(email, inv.role, STATUS_INVITED, "", inv.id))

    invited = sum(1 for r in result.results if r["status"] == STATUS_INVITED)
    skipped = sum(1 for r in result.results if r["status"] in _SKIPPED)
    result.summary = {
        "invited": invited,
        "skipped": skipped,
        "failed": len(result.results) - invited - skipped,
        "total": len(result.results),
    }
    return result
