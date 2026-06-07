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
from apps.teams.services.registration import register_school


def map_response(resp: FormResponse) -> FormResponse:
    """Dispatch by purpose. No-op (early return) if already mapped — this makes
    a replayed submission safe: the public view calls map_response on every
    request (including idempotent replays that return the existing row)."""
    if resp.mapped_entities:
        return resp
    if resp.form.purpose == FormPurpose.TEAM_REGISTRATION:
        return _map_team_registration(resp)
    # organization_registration + generic: the response IS the record.
    return resp


def _map_team_registration(resp: FormResponse) -> FormResponse:
    form = resp.form
    b = (form.settings or {}).get("bindings", {})
    a = resp.answers or {}
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

    # Derive a stable audit key distinct from the submit audit (see module note).
    derived_event_id = uuid.uuid5(uuid.NAMESPACE_URL, f"formresp-teamreg:{resp.id}")

    teams = register_school(
        tournament=form.tournament,
        school_name=school_name,
        teams=[{"name": team_name, "players": players}],
        channel="self",
        event_id=derived_event_id,
    )
    resp.mapped_entities = {"team_ids": [str(t.id) for t in teams]}
    resp.save(update_fields=["mapped_entities"])
    return resp
