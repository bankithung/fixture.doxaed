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

from django.core.exceptions import ValidationError
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
    RosterMember,
    RosterMemberKind,
    RosterMemberStatus,
    Team,
    TeamStaff,
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
    tournament's organization (org-consistency). Returns None for a blank name.

    Identity is the SLUGIFIED name, not the exact string: the same school
    typed as "AMAZING SCHOOL", "Amazing School" or the picker slug
    "amazing_school" is one school, and minting a second row for it would
    split its teams, its standings and its emails in two (owner 2026-08-19).
    An existing row keeps the name it has — renaming belongs to the bound-link
    edit path, which asks for it explicitly.
    """
    name = (name or "").strip()[:200]
    if not name:
        return None
    existing = Institution.objects.filter(
        tournament=tournament, name=name, deleted_at__isnull=True
    ).first()
    if existing is None:
        key = _slugify(name)
        if key:
            existing = next(
                (
                    i for i in Institution.objects.filter(
                        tournament=tournament, deleted_at__isnull=True
                    )
                    if i.slug == key or _slugify(i.name) == key
                ),
                None,
            )
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


def _staff_ref(entry) -> tuple[str, str]:
    """One ``staff`` entry as (member_id, role). Accepts a bare id or a dict, so
    a caller that only knows "this teacher" need not invent a role."""
    if isinstance(entry, dict):
        return (
            str(entry.get("member_id") or entry.get("id") or ""),
            str(entry.get("role") or "in_charge")[:32],
        )
    return str(entry or ""), "in_charge"


def _declare_participants(
    tournament, institution, group, rows: list[dict], by=None,
) -> dict[str, RosterMember]:
    """Turn the form's own participants sheet into declared people.

    Returns ``{row_id: RosterMember}`` — the map the team picks below resolve
    against, since a pick made in this form names a row of this form.

    **Idempotent within a school**, on the same identity rule the layer already
    used: a roll number if the school gives one, else the name. A school that
    resubmits its sheet updates its people in place instead of doubling them,
    and a person already declared through any other route is reused rather than
    duplicated — which is the entire reason this layer exists.
    """
    if not rows:
        return {}
    existing = list(
        RosterMember.objects.filter(
            tournament=tournament, institution=institution,
            deleted_at__isnull=True,
        ).select_related("person")
    )
    by_roll = {
        m.roll_no.strip().lower(): m for m in existing if (m.roll_no or "").strip()
    }
    by_name = {m.person.full_name.strip().lower(): m for m in existing}

    out: dict[str, RosterMember] = {}
    # Members already claimed by an earlier row of THIS submission. Two rows
    # are two people by construction: a school that lists "Imli Jamir" twice is
    # telling us there are two of them (owner 2026-08-18 removed the roll-number
    # box, and without this the second row would silently match the first and
    # the pair would collapse into one child).
    claimed: set = set()
    for row in rows:
        name = str(row.get("full_name") or "").strip()
        if not name:
            continue
        roll = str(row.get("roll_no") or "").strip()
        kind = (
            RosterMemberKind.TEACHER
            if row.get("kind") == "teacher" else RosterMemberKind.STUDENT
        )
        # A roll number is the school's OWN discriminator, so when one is given
        # it decides alone. Falling back to the name here would merge the two
        # same-named children this layer exists to keep apart — they differ by
        # roll and by nothing else.
        member = (
            by_roll.get(roll.lower()) if roll else by_name.get(name.lower())
        )
        if member is not None and member.pk in claimed:
            member = None
        if member is None:
            person = Person.objects.create(full_name=name)
            member = RosterMember(
                organization_id=tournament.organization_id,
                tournament=tournament,
                institution=institution,
                group=group,
                person=person,
                kind=kind,
                status=RosterMemberStatus.ACTIVE,
                created_by=by,
            )
        else:
            member.person.full_name = name
            member.person.save(update_fields=["full_name"])
            member.kind = kind
        member.roll_no = roll[:40]
        member.class_section = str(row.get("class_section") or "").strip()[:60]
        member.gender = str(row.get("gender") or "").strip()[:20]
        member.contact_phone = str(row.get("contact_phone") or "").strip()[:40]
        dob = row.get("date_of_birth") or None
        if dob:
            member.date_of_birth = dob
        row_id = str(row.get("row_id") or "").strip()
        if row_id:
            # Which sheet row declared this person. The columns above are the
            # ones every tournament means the same thing by; anything else the
            # sheet asked for (documents, and whatever an event adds next) is
            # read back out of the submission by this id, so the link has to
            # survive on the member.
            member.attributes = {**(member.attributes or {}), "form_row_id": row_id}
        member.save()
        claimed.add(member.pk)
        if roll:
            by_roll[roll.lower()] = member
        by_name[name.lower()] = member
        if row_id:
            out[row_id] = member
        # A pick may also carry the member's real id (an older form, or an
        # organizer editing), so accept that spelling too.
        out[str(member.id)] = member
    return out


def _resolve_members(
    tournament, institution, teams: list[dict],
    extra: dict[str, RosterMember] | None = None,
) -> dict[str, RosterMember]:
    """Every declared participant the submission PICKS, keyed by id.

    Scoped to the submitting institution on purpose: a school fielding another
    school's child (or claiming their teacher, which would link two unrelated
    schools' matches in the scheduler) is refused rather than silently dropped.
    An id we cannot resolve is an error too — falling back to the typed name
    would quietly restore the guess this layer exists to remove.
    """
    wanted: set[str] = set()
    for td in teams:
        for pd in td.get("players", []) or []:
            if pd.get("member_id"):
                wanted.add(str(pd["member_id"]))
        for entry in td.get("staff", []) or []:
            mid, _role = _staff_ref(entry)
            if mid:
                wanted.add(mid)
    if not wanted:
        return {}
    # Rows declared by THIS submission resolve first — their ids are the
    # form's own row keys, which no database lookup could ever find.
    found = {k: v for k, v in (extra or {}).items() if k in wanted}
    valid = [m for m in wanted - set(found) if _is_uuid(m)]
    found.update({
        str(m.id): m
        for m in RosterMember.objects.filter(
            id__in=valid,
            tournament=tournament,
            institution=institution,
            deleted_at__isnull=True,
            status=RosterMemberStatus.ACTIVE,
        ).select_related("person")
    })
    missing = sorted(wanted - set(found))
    if missing:
        raise ValidationError(f"participant_not_in_roster:{missing[0]}")
    return found


def _is_uuid(value: str) -> bool:
    try:
        _uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return False
    return True


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
    # Intra-school (spec 2026-08-16): the HOUSE these teams play for. The
    # institution stays the one host school so every existing reader keeps
    # working; `group` is what actually distinguishes the competitors.
    group=None,
    group_id=None,
    # The participants sheet carried IN this submission (owner 2026-08-17):
    # [{row_id, kind, full_name, class_section?, roll_no?, date_of_birth?,
    # gender?, contact_phone?}]. Declared before the teams are built, so a
    # team's pick can name a person this same submission introduced.
    participants: list[dict] | None = None,
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

            # The house/class these teams play for, in a within-school event.
            resolved_group = group
            if resolved_group is None and group_id is not None:
                from apps.teams.models import TeamGroup

                resolved_group = TeamGroup.objects.filter(
                    id=group_id,
                    organization=org,
                    deleted_at__isnull=True,
                ).first()
                if resolved_group is None:
                    raise ValueError("group_not_found")

            # H5 backstop: a leaf's age rule blocks over/under-age players at
            # the write boundary no matter which surface called us. Coarse
            # dob_year is exact for the default 31 Dec cutoff; players with
            # no DOB pass (required-ness is the form's concern).
            from apps.teams.services.eligibility import (
                age_cutoff,
                enforce_age_enabled,
                team_age_rule,
                violation,
            )

            if enforce_age_enabled(tournament):
                cutoff = age_cutoff(tournament)
                for td in teams:
                    rule = team_age_rule(tournament, td.get("leaf_key") or "")
                    if not rule:
                        continue
                    for pd in td.get("players", []):
                        code = violation(
                            rule, cutoff=cutoff, dob_year=pd.get("dob_year")
                        )
                        if code:
                            raise ValidationError(
                                f"player_age_ineligible:{td.get('leaf_key')}:"
                                f"{pd.get('full_name', '')}:{code}"
                            )

            # Participants-first (spec 2026-08-17): identities the submission
            # PICKS rather than types. Resolved once, up front, so a bad id
            # fails the whole submission before any row is written.
            # The sheet at the top of the form comes first: its rows BECOME
            # declared participants, and the map it returns is what the picks
            # below resolve against.
            in_form = _declare_participants(
                tournament, resolved, resolved_group, participants or [],
                by=submitted_by,
            )
            picked = _resolve_members(tournament, resolved, teams, extra=in_form)

            for td in teams:
                team = Team.objects.create(
                    organization=org,
                    tournament=tournament,
                    institution=resolved,
                    group=resolved_group,
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
                # Persons already rostered on THIS team (this loop) — a name
                # listed twice on one squad is two people (or a typo), never
                # the same Person twice: re-using it would violate
                # unique_person_per_team and roll back the whole submission
                # (review W2-F, critical).
                team_person_ids: set = set()
                for pd in td.get("players", []):
                    # A picked participant IS the identity — no matching, no
                    # dedupe pass, and a name re-picked on one squad lands once
                    # (a second Player row would trip unique_person_per_team and
                    # roll the school's whole submission back).
                    member = picked.get(str(pd.get("member_id") or ""))
                    if member is not None:
                        if member.person_id in team_person_ids:
                            continue
                        team_person_ids.add(member.person_id)
                        Player.objects.create(
                            organization=org,
                            tournament=tournament,
                            team=team,
                            person=member.person,
                            jersey_no=pd.get("jersey_no"),
                            position=(pd.get("position") or "")[:16],
                            captain=bool(pd.get("captain", False)),
                            is_goalkeeper=bool(pd.get("is_goalkeeper", False)),
                            added_by=submitted_by,
                        )
                        continue
                    # W2-D person dedupe: the same name registered before by
                    # THIS institution in THIS tournament is the same person,
                    # so a student entering football AND badminton shares one
                    # Person — that's what lets the scheduler keep their two
                    # teams' matches from overlapping. (Cross-team homonyms
                    # within one school collapse; organisers can split them
                    # in the roster editor later.)
                    full_name = pd["full_name"][:200]
                    person = None
                    if resolved is not None and full_name.strip():
                        dedupe = Person.objects.filter(
                            full_name__iexact=full_name.strip(),
                            players__tournament=tournament,
                            players__team__institution=resolved,
                            players__deleted_at__isnull=True,
                        )
                        # In a within-school event EVERY team shares the one
                        # host institution, so name-matching inside it would
                        # merge two different students called the same thing in
                        # different houses into one Person. Narrow to the house.
                        if resolved_group is not None:
                            dedupe = dedupe.filter(
                                players__team__group=resolved_group
                            )
                        person = (
                            dedupe.exclude(id__in=team_person_ids)
                            .order_by("created_at")
                            .first()
                        )
                    if person is None:
                        person = Person.objects.create(
                            full_name=full_name,
                            display_name=(pd.get("display_name") or "")[:120],
                            dob_year=pd.get("dob_year"),
                            created_by=submitted_by,
                        )
                    team_person_ids.add(person.id)
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
                # Teachers in charge. Many per team on purpose: a school that
                # sends two teachers can legitimately run two courts at once,
                # and the scheduler keys its keep-apart edge on the teacher.
                seen_staff: set = set()
                for entry in td.get("staff", []) or []:
                    mid, role = _staff_ref(entry)
                    member = picked.get(mid)
                    if member is None or member.id in seen_staff:
                        continue
                    seen_staff.add(member.id)
                    TeamStaff.objects.create(
                        organization=org, team=team, member=member, role=role,
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
        # row's unique idempotency_key tripped ours). Return the winner's teams
        # — but only after VERIFYING the winner exists: any other integrity
        # failure (e.g. a duplicate team name) must surface, not silently
        # return [] while the caller records "success" (owner 2026-06-10).
        if event_id is not None and AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="school_registered"
        ).exists():
            return _replay()
        raise
    return created
