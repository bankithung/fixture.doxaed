"""Map a submitted FormResponse into domain entities, dispatched by Form.purpose.

``team_registration`` reuses ``apps/teams`` ``register_school`` (no rewrite);
``organization_registration`` and ``generic`` are no-ops (the response row IS the
participant record). Mapping is idempotent: an already-mapped response is skipped
so a replayed submission never creates duplicate teams.

Audit-key note (correctness): ``AuditEvent.idempotency_key`` is *globally* unique
(``unique=True``, not unique-per-event-type). ``submit_response`` already emits an
``AuditEvent`` keyed on the response's ``event_id`` (event_type
``form_response_submitted``). Passing that same ``event_id`` straight to
``register_school`` would NOT raise — ``emit_audit`` returns the pre-existing row
on a key match — but it would silently drop the ``school_registered`` audit AND,
worse, defeat ``register_school``'s own idempotency (it filters audit rows by
``event_type="school_registered"``, never finds one, and re-creates teams on
replay). So we derive a *stable, distinct* key (uuid5 over the response id) for
the register_school call: register_school stays idempotent on its own without
colliding with the submit audit.
"""
from __future__ import annotations

import uuid

from apps.forms.constants import FormPurpose
from apps.forms.models import FormResponse
from apps.teams.services.registration import (
    get_or_create_institution,
    register_school,
)


def supersede_team_registration(
    form, institution_id, *, exclude_response_id=None, request=None
) -> int:
    """Soft-delete the teams (and their players) created by this institution's
    PREVIOUS submissions of ``form`` — the new, code-authorized submission
    replaces them wholesale. Returns the number of superseded teams."""
    from django.utils import timezone

    from apps.audit.models import ActorRole
    from apps.audit.services import emit_audit
    from apps.teams.models import Player, Team

    iid_key = (form.settings or {}).get("bindings", {}).get(
        "institution_id", "institution_id"
    )
    prior = FormResponse.objects.filter(
        form=form, **{f"answers__{iid_key}": str(institution_id)}
    )
    if exclude_response_id is not None:
        prior = prior.exclude(id=exclude_response_id)
    team_ids: set[str] = set()
    for r in prior:
        team_ids.update((r.mapped_entities or {}).get("team_ids") or [])
    if not team_ids:
        return 0
    now = timezone.now()
    Player.objects.filter(team_id__in=team_ids, deleted_at__isnull=True).update(
        deleted_at=now
    )
    n = Team.objects.filter(id__in=team_ids, deleted_at__isnull=True).update(
        deleted_at=now
    )
    emit_audit(
        actor_user=None,
        actor_role=ActorRole.SYSTEM,
        event_type="team_registration_superseded",
        target_type="tournament",
        target_id=form.tournament_id,
        organization_id=form.organization_id,
        payload_after={
            "institution_id": str(institution_id),
            "teams_removed": n,
            "form_id": str(form.id),
        },
        request=request,
    )
    return n


def team_registration_field_errors(
    form, answers: dict, *, exclude_institution_id=None
) -> dict[str, str]:
    """Pre-submit guard for generated team forms: team names must be unique
    within each COMPETITION (mirrors ``unique_team_name_per_competition``),
    checked against both the submission itself and already-registered teams —
    so the respondent gets a clear field error instead of a silent failure.
    Callers must skip this on idempotent replays (the teams already exist)."""
    b = (form.settings or {}).get("bindings", {})
    cgs = b.get("category_groups") or []
    if not cgs:
        return {}
    from apps.teams.models import Team

    errors: dict[str, str] = {}
    for cg in cgs:
        group_key, tname_key = cg.get("group"), cg.get("team_name")
        leaf = cg.get("leaf_key") or cg.get("category") or ""
        rows = answers.get(group_key) or []
        if not isinstance(rows, list):
            continue
        names = [
            str(r.get(tname_key)).strip()
            for r in rows
            if isinstance(r, dict) and str(r.get(tname_key) or "").strip()
        ]
        lowered = [n.lower() for n in names]
        dup = next(
            (n for i, n in enumerate(names) if lowered.index(n.lower()) != i),
            None,
        )
        if dup:
            errors[group_key] = (
                f'Two of your teams here are both named "{dup}" — '
                "give each team in a competition a distinct name."
            )
            continue
        if names:
            qs = Team.objects.filter(
                tournament=form.tournament,
                leaf_key=leaf,
                name__in=names,
                deleted_at__isnull=True,
            )
            # A code-authorized resubmission REPLACES the institution's own
            # teams — its previous names must not block the update.
            if exclude_institution_id is not None:
                qs = qs.exclude(institution_id=exclude_institution_id)
            taken = qs.values_list("name", flat=True).first()
            if taken:
                errors[group_key] = (
                    f'"{taken}" is already registered in this competition — '
                    "pick another name."
                )
    return errors


def map_response(resp: FormResponse) -> FormResponse:
    """Dispatch by purpose. No-op (early return) if already mapped — this makes
    a replayed submission safe: the public view calls map_response on every
    request (including idempotent replays that return the existing row)."""
    if resp.mapped_entities:
        return resp
    if resp.form.purpose == FormPurpose.TEAM_REGISTRATION:
        return _map_team_registration(resp)
    if resp.form.purpose == FormPurpose.ORGANIZATION_REGISTRATION:
        return _map_organization_registration(resp)
    # generic: the response IS the record.
    return resp


def _map_organization_registration(resp: FormResponse) -> FormResponse:
    """Stage-1: an organization-registration submission creates an Institution.

    Idempotent: ``map_response`` early-returns if already mapped, and
    ``get_or_create_institution`` is keyed on (tournament, name)."""
    form = resp.form
    b = (form.settings or {}).get("bindings", {})
    a = resp.answers or {}
    # First non-blank candidate (whitespace-only counts as blank, else a "   "
    # answer would short-circuit the chain and create no Institution).
    name = next(
        (
            str(c).strip()
            for c in (
                a.get(b.get("institution_name", "institution_name")),
                a.get("school"),
                a.get("name"),
                resp.title,
            )
            if c and str(c).strip()
        ),
        "Institution",
    )
    kind = str(a.get(b.get("kind", "kind")) or "school").lower()

    # An admin-minted BOUND link is an explicit edit grant for ONE existing
    # institution: the resubmission is authoritative for that row (rename,
    # overwrite contacts, replace competitions) — never a new institution.
    bound_iid = (
        (resp.submitted_via.bound_entity or {}).get("institution_id")
        if resp.submitted_via_id
        else None
    )
    inst = None
    if bound_iid:
        from django.db import IntegrityError

        from apps.teams.models import Institution

        inst = Institution.objects.filter(
            id=bound_iid, tournament=form.tournament, deleted_at__isnull=True
        ).first()
        if inst is not None:
            changed: list[str] = []
            if name and name != inst.name:
                inst.name = str(name)[:200]
                changed.append("name")
            if kind and kind != inst.kind:
                inst.kind = kind
                changed.append("kind")
            for field, attr in (
                ("contact_name", "contact_name"),
                ("contact_email", "contact_email"),
                ("contact_phone", "contact_phone"),
                ("region", "region"),
            ):
                val = a.get(b.get(field, field))
                if val and str(val)[:200] != getattr(inst, attr):
                    setattr(inst, attr, str(val)[:200])
                    changed.append(attr)
            leaves = _selected_leaves(form.settings or {}, a)
            if leaves and leaves != list((inst.attributes or {}).get("leaves") or []):
                inst.attributes = {**(inst.attributes or {}), "leaves": leaves}
                changed.append("attributes")
            inst.source_response_id = resp.id
            changed.append("source_response_id")
            try:
                inst.save(update_fields=[*dict.fromkeys(changed), "updated_at"])
            except IntegrityError:
                # Rename collided with another institution's name — keep the
                # old name, persist everything else.
                inst.refresh_from_db(fields=["name"])
                rest = [c for c in dict.fromkeys(changed) if c != "name"]
                if rest:
                    inst.save(update_fields=[*rest, "updated_at"])

    if inst is None:
        inst = get_or_create_institution(
            tournament=form.tournament,
            name=str(name),
            kind=kind,
            source_response_id=resp.id,
        )
        if inst is not None:
            changed = []
            for field, attr in (
                ("contact_name", "contact_name"),
                ("contact_email", "contact_email"),
                ("contact_phone", "contact_phone"),
                ("region", "region"),
            ):
                val = a.get(b.get(field, field))
                if val and not getattr(inst, attr):
                    setattr(inst, attr, str(val)[:200])
                    changed.append(attr)
            # Persist WHICH competitions (category leaves) the institution
            # entered, as structured data — Stage 2 scoping and dashboards read
            # this instead of re-parsing raw answers (spec 2026-06-10). Union
            # on re-submission.
            leaves = _selected_leaves(form.settings or {}, a)
            if leaves:
                existing = list((inst.attributes or {}).get("leaves") or [])
                merged = existing + [lf for lf in leaves if lf not in existing]
                if merged != existing:
                    inst.attributes = {**(inst.attributes or {}), "leaves": merged}
                    changed.append("attributes")
            if changed:
                inst.save(update_fields=[*dict.fromkeys(changed), "updated_at"])
    resp.mapped_entities = {"institution_id": str(inst.id) if inst else None}
    resp.save(update_fields=["mapped_entities"])
    return resp


def _selected_leaves(settings: dict, answers: dict) -> list[str]:
    """Category-leaf keys an org-registration response selected, derived from
    the generator's structural tags. A sport selected without category fields
    contributes its sport-level leaf.

    Progressive-chain forms (W2-A: ``category_fields_all`` + ``leaf_values``)
    collect answers across EVERY level's field and keep only values that are
    real competitions — branch-level picks ("U19" when U19 has children) are
    navigation, not entries. Single-level forms keep the legacy path."""
    cat_fields = settings.get("category_fields") or {}
    all_fields = settings.get("category_fields_all") or {}
    leaf_values = set(settings.get("leaf_values") or [])
    sports_field = settings.get("sports_field") or "sports"
    selected = answers.get(sports_field)
    if not isinstance(selected, list):
        return []
    leaves: list[str] = []
    for skey in selected:
        skey = str(skey)
        fkeys = all_fields.get(skey)
        if fkeys and leaf_values:
            picked: list[str] = []
            for fk in fkeys:
                vals = answers.get(fk)
                if isinstance(vals, list):
                    picked.extend(str(v) for v in vals if v)
            leaves.extend(
                v for v in picked if v in leaf_values and v not in leaves
            )
            continue
        fkey = cat_fields.get(skey)
        if fkey is None:
            leaves.append(skey)  # sport-level leaf (sport has no categories)
            continue
        vals = answers.get(fkey)
        if isinstance(vals, list):
            leaves.extend(str(v) for v in vals if v)
    return leaves


def _map_team_registration(resp: FormResponse) -> FormResponse:
    form = resp.form
    b = (form.settings or {}).get("bindings", {})
    a = resp.answers or {}

    # Auto-generated multi-category team form: one repeating group per category,
    # each row = a team (pool = category) under the selected institution.
    if b.get("category_groups"):
        return _map_team_registration_multi(resp, form, b, a)

    school_name = a.get(b.get("school_name", "school_name")) or resp.title or "School"

    # A team_registration form may carry a repeating ``group`` for players; v1
    # supports either a single team (flat) or a players group. We build
    # register_school's teams=[{name, players:[{full_name, jersey_no?, position?,
    # dob_year?}]}].
    team_name = a.get(b.get("team_name", "team_name")) or school_name
    players_raw = a.get(b.get("players_group", "players"), []) or []
    name_key = b.get("player_name", "full_name")
    players: list[dict] = []
    if isinstance(players_raw, list):
        for p in players_raw:
            if isinstance(p, dict) and p.get(name_key):
                row = {"full_name": p[name_key]}
                for k in ("jersey_no", "position", "dob_year"):
                    if k in p:
                        row[k] = p[k]
                players.append(row)

    # Stage-2 "select your institution": a data-bound field maps to the chosen
    # institution id, which scopes the teams under that institution.
    institution_id = a.get(b.get("institution_id", "institution_id")) or None

    # Derive a stable audit key distinct from the submit audit (see module note).
    derived_event_id = uuid.uuid5(uuid.NAMESPACE_URL, f"formresp-teamreg:{resp.id}")

    teams = register_school(
        tournament=form.tournament,
        school_name=school_name,
        teams=[{"name": team_name, "players": players}],
        channel="self",
        event_id=derived_event_id,
        institution_id=institution_id,
    )
    resp.mapped_entities = {"team_ids": [str(t.id) for t in teams]}
    resp.save(update_fields=["mapped_entities"])
    return resp


def _map_team_registration_multi(resp, form, b, a) -> FormResponse:
    """Auto-generated team form: collect teams from every category group into one
    register_school call (all under the chosen institution)."""
    institution_id = a.get(b.get("institution_id", "institution_id")) or None
    teams_payload: list[dict] = []
    for cg in b.get("category_groups", []):
        group_key = cg.get("group")
        tname_key = cg.get("team_name")
        players_group_key = cg.get("players_group")
        pname_key = cg.get("player_name")
        category = cg.get("category") or ""
        rows = a.get(group_key, []) or []
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = row.get(tname_key)
            if not name:
                continue
            # Each team row carries its own nested, repeatable players group.
            players: list[dict] = []
            if players_group_key:
                for pr in row.get(players_group_key, []) or []:
                    if isinstance(pr, dict):
                        pn = pr.get(pname_key)
                        if pn:
                            players.append({"full_name": str(pn)})
            teams_payload.append({
                "name": str(name),
                # pool = human-readable label; sport/leaf_key = the structural
                # competition binding fixtures scope by (spec 2026-06-10).
                "pool": cg.get("label") or category,
                "sport": cg.get("sport_key") or "",
                "leaf_key": cg.get("leaf_key") or category,
                "players": players,
            })

    derived_event_id = uuid.uuid5(uuid.NAMESPACE_URL, f"formresp-teamreg:{resp.id}")
    teams = register_school(
        tournament=form.tournament,
        school_name="",
        teams=teams_payload,
        channel="self",
        event_id=derived_event_id,
        institution_id=institution_id,
    ) if teams_payload else []
    resp.mapped_entities = {"team_ids": [str(t.id) for t in teams]}
    resp.save(update_fields=["mapped_entities"])
    return resp
