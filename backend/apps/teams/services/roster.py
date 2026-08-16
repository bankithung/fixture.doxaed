"""The participants layer — a school's declared people (spec 2026-08-17).

Why this exists: until now a player's identity was INFERRED from a typed
string. ``register_school`` reused a ``Person`` by ``full_name__iexact`` within
the institution, so "Imliyanger Jamir" typed two ways became two people — and
the scheduler's "these teams share a player, never overlap them" rule silently
stopped protecting that child. Every rule that depends on knowing whether one
student is in two competitions was standing on a guess.

Here the school declares its people ONCE. Teams then pick from this list, so
``Player.person`` is chosen rather than matched, and the question "is this
student in two sports?" has an exact answer.

Teachers are declared the same way and for the same reason: a teacher in charge
can only be in one place at a time, which is a scheduling fact, not an
administrative one.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from apps.audit.models import ActorRole
from apps.audit.services import emit_audit
from apps.teams.models import (
    Institution,
    Person,
    RosterMember,
    RosterMemberKind,
    RosterMemberStatus,
)

#: Fields a caller may set on a roster row. Anything else the tournament asks
#: for lands in ``attributes`` rather than growing a column per event.
EDITABLE = (
    "class_section", "roll_no", "gender", "date_of_birth",
    "contact_email", "contact_phone",
)


def roster_for(tournament, institution=None, *, kind: str | None = None, group=None):
    """The declared people of a tournament, newest last. Scope to ONE
    institution for anything a school is allowed to see — a roster is student
    PII and must never be handed out across schools.

    ``group`` narrows further to one house: inside a within-school event every
    competitor shares the single host institution, so the house is the only
    boundary a house captain may be trusted with.
    """
    qs = RosterMember.objects.filter(
        tournament=tournament,
        deleted_at__isnull=True,
        status=RosterMemberStatus.ACTIVE,
    ).select_related("person", "institution", "group")
    if institution is not None:
        qs = qs.filter(institution=institution)
    if group is not None:
        qs = qs.filter(group=group)
    if kind:
        qs = qs.filter(kind=kind)
    return qs.order_by("kind", "person__full_name")


def _coerce(fields: dict) -> dict:
    """Normalize the columns callers pass in.

    A date arrives as a ``date`` from a service call and as ``"2012-03-04"``
    from JSON; both must reach the model as a real date, because ``Person``'s
    coarse ``dob_year`` is derived from it here rather than at save time.
    """
    raw = fields.get("date_of_birth")
    if isinstance(raw, str):
        from django.utils.dateparse import parse_date

        fields = {**fields, "date_of_birth": parse_date(raw.strip()[:10])}
        if fields["date_of_birth"] is None:
            raise ValidationError("invalid_date_of_birth")
    return fields


def _match_existing(tournament, institution, full_name: str, roll_no: str):
    """An already-declared member this submission is plainly re-stating.

    A roll number is a school's own unique key, so it wins outright. Failing
    that we fall back to the name — the SAME weak signal the old pipeline used,
    but here it only merges rows *inside one school's own declaration*, where a
    duplicate is a re-submission rather than two different children, and the
    school can see and fix the result.
    """
    base = RosterMember.objects.filter(
        tournament=tournament, institution=institution, deleted_at__isnull=True,
    )
    if roll_no.strip():
        hit = base.filter(roll_no__iexact=roll_no.strip()).first()
        if hit is not None:
            return hit
    return base.filter(person__full_name__iexact=full_name.strip()).first()


@transaction.atomic
def declare_member(
    *, tournament, institution: Institution, full_name: str,
    kind: str = RosterMemberKind.STUDENT, group=None, by=None, request=None,
    source_response_id=None, attributes: dict | None = None, **fields,
) -> RosterMember:
    """Declare one person for a school. Idempotent on (roll number, else name)
    within that school, so a re-submitted form updates rather than duplicates."""
    name = (full_name or "").strip()
    if not name:
        raise ValidationError("participant_name_required")
    if kind not in RosterMemberKind.values:
        raise ValidationError("invalid_participant_kind")
    fields = _coerce(fields)

    existing = _match_existing(
        tournament, institution, name, str(fields.get("roll_no") or ""),
    )
    if existing is not None:
        changed: list[str] = []
        if existing.person.full_name != name[:200]:
            existing.person.full_name = name[:200]
            existing.person.save(update_fields=["full_name"])
        for f in EDITABLE:
            if f in fields and getattr(existing, f) != fields[f]:
                setattr(existing, f, fields[f])
                changed.append(f)
        if existing.kind != kind:
            existing.kind = kind
            changed.append("kind")
        if group is not None and existing.group_id != getattr(group, "id", None):
            existing.group = group
            changed.append("group")
        if attributes:
            existing.attributes = {**(existing.attributes or {}), **attributes}
            changed.append("attributes")
        if existing.status != RosterMemberStatus.ACTIVE:
            existing.status = RosterMemberStatus.ACTIVE
            changed.append("status")
        if changed:
            existing.save(update_fields=[*changed, "updated_at"])
        return existing

    person = Person.objects.create(
        full_name=name[:200],
        dob_year=(
            fields["date_of_birth"].year if fields.get("date_of_birth") else None
        ),
        created_by=by,
    )
    member = RosterMember.objects.create(
        organization=tournament.organization,
        tournament=tournament,
        institution=institution,
        group=group,
        person=person,
        kind=kind,
        source_response_id=source_response_id,
        attributes=attributes or {},
        created_by=by,
        **{f: fields[f] for f in EDITABLE if f in fields},
    )
    emit_audit(
        actor_user=by,
        actor_role=ActorRole.ADMIN,
        event_type="roster_member_declared",
        target_type="roster_member",
        target_id=member.id,
        organization_id=tournament.organization_id,
        payload_after={"name": name, "kind": kind, "institution": str(institution.id)},
        request=request,
    )
    return member


@transaction.atomic
def update_member(
    *, member: RosterMember, full_name: str | None = None, kind: str | None = None,
    attributes: dict | None = None, by=None, request=None, **fields,
) -> RosterMember:
    """Correct one declared person in place.

    The organizer's editor, not a second way to declare: it never creates, so a
    name fixed here keeps the same ``Person`` — and therefore every team the
    participant is already on, and every scheduling edge that depends on them.
    """
    changed: list[str] = []
    fields = _coerce(fields)
    if full_name is not None:
        name = full_name.strip()
        if not name:
            raise ValidationError("participant_name_required")
        if member.person.full_name != name[:200]:
            member.person.full_name = name[:200]
            member.person.save(update_fields=["full_name"])
    if kind is not None:
        if kind not in RosterMemberKind.values:
            raise ValidationError("invalid_participant_kind")
        if member.kind != kind:
            member.kind = kind
            changed.append("kind")
    for f in EDITABLE:
        if f in fields and getattr(member, f) != fields[f]:
            setattr(member, f, fields[f])
            changed.append(f)
    if attributes:
        member.attributes = {**(member.attributes or {}), **attributes}
        changed.append("attributes")
    if changed:
        member.save(update_fields=[*dict.fromkeys(changed), "updated_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="roster_member_updated",
            target_type="roster_member",
            target_id=member.id,
            organization_id=member.organization_id,
            payload_after={f: str(getattr(member, f)) for f in dict.fromkeys(changed)},
            request=request,
        )
    return member


@transaction.atomic
def withdraw_member(*, member: RosterMember, by=None, request=None) -> None:
    """Take a person off the school's list.

    Soft, and refused once they are on a team: a ``Player`` row PROTECTs its
    Person, and quietly dropping someone who is fielded would leave a team a
    player short with nothing on screen to say so.
    """
    from apps.teams.models import Player, TeamStaff

    fielded = Player.objects.filter(
        tournament=member.tournament, person=member.person,
        deleted_at__isnull=True,
    ).exists()
    in_charge = TeamStaff.objects.filter(member=member).exists()
    if fielded or in_charge:
        raise ValidationError("participant_in_use")
    member.deleted_at = timezone.now()
    member.status = RosterMemberStatus.WITHDRAWN
    member.save(update_fields=["deleted_at", "status", "updated_at"])
    emit_audit(
        actor_user=by,
        actor_role=ActorRole.ADMIN,
        event_type="roster_member_withdrawn",
        target_type="roster_member",
        target_id=member.id,
        organization_id=member.organization_id,
        payload_before={"name": member.person.full_name},
        request=request,
    )


def member_options(
    tournament, institution, *, kind=RosterMemberKind.STUDENT, group=None,
):
    """The picker payload a team form fills its person dropdowns from.

    Deliberately NOT part of the public form schema: schema resolution happens
    before anyone proves who they are, and a school's student list is PII. This
    is served only to a caller already authorized for THIS institution.
    """
    return [
        {
            "value": str(m.id),
            "label": m.person.full_name,
            "class_section": m.class_section,
            "roll_no": m.roll_no,
            "kind": m.kind,
        }
        for m in roster_for(tournament, institution, kind=kind, group=group)
    ]
