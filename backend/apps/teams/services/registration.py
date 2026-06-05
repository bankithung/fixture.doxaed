"""Register a school's teams + players (v1Teams.md §5.1 self-register channel).

One school submits one or more teams, each with players. Atomic; idempotent on
a client `event_id` (invariant 3). Used by both the authenticated admin add-team
flow and the public registration-link submission.
"""
from __future__ import annotations

import hashlib
import re
import secrets
import uuid as _uuid

from django.db import transaction
from django.utils import timezone

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.teams.models import Person, Player, RegistrationLink, Team, TeamStatus


def _hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def create_registration_link(
    *, tournament, created_by=None, label: str = "",
    expires_at=None, max_submissions=None,
):
    """Create a shareable registration link. Returns (link, plaintext_token)."""
    token = secrets.token_urlsafe(24)
    link = RegistrationLink.objects.create(
        organization=tournament.organization,
        tournament=tournament,
        token_hash=_hash_token(token),
        label=(label or "")[:120],
        expires_at=expires_at,
        max_submissions=max_submissions,
        created_by=created_by,
    )
    return link, token


def resolve_registration_link(token_plaintext: str):
    """Resolve an active, non-expired, under-cap link by plaintext token, or None."""
    if not token_plaintext:
        return None
    link = (
        RegistrationLink.objects.filter(
            token_hash=_hash_token(token_plaintext),
            is_active=True,
            tournament__deleted_at__isnull=True,
        )
        .select_related("tournament", "tournament__organization")
        .first()
    )
    if link is None:
        return None
    if link.expires_at is not None and link.expires_at <= timezone.now():
        return None
    if (
        link.max_submissions is not None
        and link.submission_count >= link.max_submissions
    ):
        return None
    return link

_SCRUB = re.compile(r"[^a-z0-9-]+")
_HYPHEN = re.compile(r"-+")


def _slugify(raw: str) -> str:
    s = _HYPHEN.sub("-", _SCRUB.sub("-", (raw or "").strip().lower())).strip("-")
    return s[:80]


def _unique_team_slug(tournament, name: str) -> str:
    base = _slugify(name) or "team"
    slug, n = base, 2
    while Team.objects.filter(tournament=tournament, slug=slug).exists():
        slug = f"{base}-{n}"[:80]
        n += 1
    return slug


def register_school(
    *,
    tournament,
    school_name: str,
    teams: list[dict],
    submitted_by=None,
    channel: str = "self",
    event_id: _uuid.UUID | None = None,
    request=None,
) -> list[Team]:
    """Create the school's teams + players. Returns the created Team rows.

    `teams` = [{name, short_name?, region?, pool?, players: [
        {full_name, jersey_no?, position?, dob_year?, is_goalkeeper?, captain?}, ...]}]
    """
    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="school_registered"
        ).first()
        if prior is not None:
            return list(
                Team.objects.filter(
                    tournament=tournament, school=school_name, deleted_at__isnull=True
                )
            )

    org = tournament.organization
    created: list[Team] = []
    with transaction.atomic():
        for td in teams:
            team = Team.objects.create(
                organization=org,
                tournament=tournament,
                slug=_unique_team_slug(tournament, td["name"]),
                name=td["name"][:200],
                short_name=(td.get("short_name") or "")[:40],
                school=(school_name or "")[:200],
                region=(td.get("region") or "")[:120],
                pool=(td.get("pool") or "")[:80],
                status=TeamStatus.REGISTERED,
                created_by=submitted_by,
            )
            for pd in td.get("players", []):
                person = Person.objects.create(
                    full_name=pd["full_name"][:200],
                    display_name=(pd.get("display_name") or "")[:120],
                    dob_year=pd.get("dob_year"),
                    created_by=submitted_by,
                )
                Player.objects.create(
                    organization=org,
                    tournament=tournament,
                    team=team,
                    person=person,
                    jersey_no=pd.get("jersey_no"),
                    position=(pd.get("position") or "")[:16],
                    captain=bool(pd.get("captain", False)),
                    is_goalkeeper=bool(pd.get("is_goalkeeper", False)),
                    added_by=submitted_by,
                )
            created.append(team)

        emit_audit(
            actor_user=submitted_by,
            actor_role=ActorRole.SYSTEM,
            event_type="school_registered",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=org.id,
            idempotency_key=event_id,
            payload_after={"school": school_name, "teams": [t.name for t in created]},
            request=request,
        )
    return created
