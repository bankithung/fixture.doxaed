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

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.audit.models import ActorRole, AuditEvent
from apps.audit.services import emit_audit
from apps.teams.models import (
    Institution,
    InstitutionStatus,
    Person,
    Player,
    RegistrationLink,
    Team,
    TeamStatus,
)


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


def _unique_institution_slug(tournament, name: str) -> str:
    base = _slugify(name) or "institution"
    slug, n = base, 2
    while Institution.objects.filter(tournament=tournament, slug=slug).exists():
        slug = f"{base}-{n}"[:80]
        n += 1
    return slug


def get_or_create_institution(
    *, tournament, name, kind: str = "school", attributes=None,
    status=InstitutionStatus.REGISTERED, created_by=None, source_response_id=None,
) -> Institution | None:
    """Stage-1 institution writer — idempotent on (tournament, name). Copies the
    tournament's organization (org-consistency). Returns None for a blank name."""
    name = (name or "").strip()[:200]
    if not name:
        return None
    existing = Institution.objects.filter(
        tournament=tournament, name=name, deleted_at__isnull=True
    ).first()
    if existing is not None:
        return existing
    return Institution.objects.create(
        organization=tournament.organization,
        tournament=tournament,
        slug=_unique_institution_slug(tournament, name),
        name=name,
        kind=kind or "school",
        attributes=attributes or {},
        status=status,
        created_by=created_by,
        source_response_id=source_response_id,
    )


def register_school(
    *,
    tournament,
    school_name: str,
    teams: list[dict],
    submitted_by=None,
    channel: str = "self",
    event_id: _uuid.UUID | None = None,
    request=None,
    # Institution hierarchy (spec 2026-06-08). All keyword-only with defaults so
    # every existing caller/test works unchanged; legacy school_name-only calls
    # auto-upgrade to create/link an Institution.
    institution: Institution | None = None,
    institution_id: _uuid.UUID | None = None,
    institution_kind: str = "school",
    institution_attributes: dict | None = None,
) -> list[Team]:
    """Create the school's teams + players. Returns the created Team rows.

    `teams` = [{name, short_name?, region?, pool?, sport?, leaf_key?, players: [
        {full_name, jersey_no?, position?, dob_year?, is_goalkeeper?, captain?}, ...]}]

    ``sport``/``leaf_key`` are the structural competition binding (spec
    2026-06-10): the category leaf the team registered into. ``pool`` remains
    the display label.

    Resolves (or creates from ``school_name``) an Institution and links every
    created Team to it (Organization → Tournament → Institution → Team → Player).
    """
    org = tournament.organization

    def _replay() -> list[Team]:
        inst = institution
        if inst is None and institution_id is not None:
            inst = Institution.objects.filter(
                id=institution_id, tournament=tournament
            ).first()
        existing = Team.objects.filter(tournament=tournament, deleted_at__isnull=True)
        return list(
            existing.filter(institution=inst)
            if inst is not None
            else existing.filter(school=school_name)
        )

    # Replay (invariant 3): if this event already registered, return its teams.
    if event_id is not None and AuditEvent.objects.filter(
        idempotency_key=event_id, event_type="school_registered"
    ).exists():
        return _replay()

    created: list[Team] = []
    try:
        with transaction.atomic():
            # Resolve or create the Institution this school's teams belong to.
            resolved = institution
            if resolved is None and institution_id is not None:
                resolved = Institution.objects.filter(
                    id=institution_id, tournament=tournament
                ).first()
                if resolved is None:
                    raise ValueError("institution_not_in_tournament")
            if resolved is None:
                resolved = get_or_create_institution(
                    tournament=tournament,
                    name=school_name,
                    kind=institution_kind,
                    attributes=institution_attributes,
                    created_by=submitted_by,
                )
            # School-name mirror stays in sync with the institution (deprecated).
            school_label = resolved.name if resolved is not None else (school_name or "")

            for td in teams:
                team = Team.objects.create(
                    organization=org,
                    tournament=tournament,
                    institution=resolved,
                    slug=_unique_team_slug(tournament, td["name"]),
                    name=td["name"][:200],
                    short_name=(td.get("short_name") or "")[:40],
                    school=school_label[:200],
                    region=(td.get("region") or "")[:120],
                    pool=(td.get("pool") or "")[:80],
                    sport=(td.get("sport") or "")[:40],
                    leaf_key=(td.get("leaf_key") or "")[:160],
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
    except IntegrityError:
        # A concurrent request with the same event_id won the race (its audit
        # row's unique idempotency_key tripped ours). Return the winner's teams.
        if event_id is not None:
            return _replay()
        raise
    return created
