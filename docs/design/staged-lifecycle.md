# Staged Tournament Lifecycle & State Machine — Implementation Design

Status: design (2026-06-08). Implementation-ready. **No source code changed by this doc.**

Grounding:
- Spec: `docs/superpowers/specs/2026-06-08-tournament-flow-and-constraint-engine.md` (§1 the 4-stage flow, §1 stage mechanics).
- Architecture: `docs/ARCHITECTURE.md` §3.2 (the Tournament state-machine GAP), §10 invariant table.
- Restructuring notes: `docs/RESTRUCTURING-NOTES.md` §4 HIGH ("No Tournament state machine"), §5 seam #5 (`transition_tournament`), §6 invariants.
- Real code this builds on (cited as `file::symbol`):
  - `apps/matches/services/state.py::transition_match` / `ALLOWED_TRANSITIONS` — the **canonical pattern to mirror** (select_for_update + guarded + audited + on_commit hook).
  - `apps/disputes/services/lifecycle.py::transition_dispute` — second mirror (resolution-note guard, notify parties).
  - `apps/tournaments/models.py::Tournament` / `TournamentStatus` (the enum to extend).
  - `apps/tournaments/services/rules.py::freeze_rules`,`can_edit_rules`,`update_settings` — freeze interplay.
  - `apps/forms/services/forms.py::close_form`,`publish_form`,`is_open`; `apps/forms/constants.py::FormStatus`,`FormPurpose`.
  - `apps/forms/services/mapping.py::map_response` — the per-purpose entity mapper.
  - `apps/teams/services/registration.py::register_school` — sole entrant writer.
  - `apps/fixtures/services/generate.py` + `advance.py` — fixture stage downstream artifacts; `inputs_hash`.
  - `apps/tournaments/views.py::_get_tournament_or_404`,`TournamentSettingsView` — view/auth/404-not-403 pattern.
  - `apps/audit/services.py::emit_audit` — sole audit write path.

---

## 0. Problem statement & scope

Today `Tournament.status` is set to `DRAFT` at create (`create.py`) and **never transitions in
production** — the single largest architecture-vs-code gap (`ARCHITECTURE.md` §3.2). There is no
transition service, no endpoint, `freeze_rules`/`rules_frozen_at` are dead, TZ-lock is unenforced.

This design delivers the **staged lifecycle seam** (`RESTRUCTURING-NOTES.md` seam #5): a guarded,
audited `transition_tournament` service realizing the owner's 4-stage flow, plus stage objects, the
auto-close-form-on-advance behavior, a warn-before-advance pre-check, full reversibility (re-open a
stage + its form with downstream-artifact warnings keyed on `inputs_hash`), and the rule-freeze
interplay at the fixtures stage.

**In scope:** the lifecycle state machine, stage model, transition service+API, form auto-close
wiring, pre-advance consequence check, reversibility, freeze interplay, frontend stepper.
**Out of scope (separate designs, referenced):** the Institution/Participant hierarchy, the forms
data-binding ("select your organization"), the deep fixture-generation wizard + constraint engine.
This design exposes the **seams** those features plug into (stage gating, the `map_response`
dispatch, the constraint-engine freeze).

---

## 1. The two-axis model: lifecycle status vs. workflow stage

The owner's flow is a **setup workflow** (4 stages); the PRD §5.2 `TournamentStatus` is the
**lifecycle** (draft → … → live → completed). These are **distinct axes** and conflating them is the
core modeling decision. Keep both, with a defined coupling:

```
TournamentStatus (lifecycle — PRD §5.2, the EXISTING enum)
   draft → published → registration_open → scheduled → live → completed → archived

TournamentStage (NEW — the setup workflow, the owner's 4 stages)
   setup → org_registration → team_registration → members → fixtures → ready
```

Coupling (one-way, derived, enforced in the transition service):

| Stage entered            | Lifecycle effect (auto-applied in the same txn)                          |
|--------------------------|--------------------------------------------------------------------------|
| `setup`                  | status stays `draft`                                                      |
| `org_registration`       | status → `published` if still `draft` (the tournament is now public-ish) |
| `team_registration`      | status → `registration_open` (calls `freeze_rules`) — *rules freeze*     |
| `members`                | no lifecycle change                                                       |
| `fixtures`               | no lifecycle change; **fixture generation** is the constraint wizard      |
| `ready`                  | status → `scheduled` once fixtures exist (TZ-lock engages)               |

Rationale for two axes (not folding stages into the status enum):
- The status enum is **pinned verbatim by tests + PRD §5.2** (`RESTRUCTURING-NOTES.md` §6 "behavior
  contracts"). Adding `org_registration`/`team_registration`/`members`/`fixtures` as *statuses* would
  fork the canonical enum and break the rules-freeze gate (`can_edit_rules` checks
  `status in {DRAFT, PUBLISHED}`).
- Reversibility: an admin can re-open `org_registration` after fixtures exist **without** dragging
  the lifecycle back from `scheduled` to `draft` (which would un-freeze rules / un-schedule matches).
  Decoupling lets "go back to edit orgs" be cheap while "regenerate fixtures" stays a guarded warning.
- The `live → completed` end of the lifecycle is driven by **match** completion (existing match
  state machine), not by the setup stepper. Two axes keeps that intact.

> Locked-decision alignment: the spec names the participants level **Institution/Participant**. This
> doc uses **stage `org_registration`** as the *workflow* name (it matches `FormPurpose.
> ORGANIZATION_REGISTRATION` already in the codebase, `apps/forms/constants.py`) but the entities it
> registers are **Institutions**. The stage key string is `org_registration`; user-facing label is
> "Institution registration".

---

## 2. Data model & migrations

### 2.1 `TournamentStage` enum (new, in `apps/tournaments/models.py`)

```python
class TournamentStage(models.TextChoices):
    """Setup-workflow stages (spec §1). Orthogonal to TournamentStatus (lifecycle).

    Forward order is SETUP < ORG_REGISTRATION < TEAM_REGISTRATION < MEMBERS < FIXTURES < READY.
    Reversible: admin may move back; advancing auto-closes the previous stage's form.
    """
    SETUP = "setup", _("Setup")
    ORG_REGISTRATION = "org_registration", _("Institution registration")
    TEAM_REGISTRATION = "team_registration", _("Team registration")
    MEMBERS = "members", _("Members & roles")
    FIXTURES = "fixtures", _("Fixtures")
    READY = "ready", _("Ready")
```

### 2.2 `Tournament` field additions

Add to `Tournament` (`apps/tournaments/models.py`), all nullable/defaulted so the migration is safe
on existing rows (none are `live`, so the migrations-blocked-while-live gate is satisfied):

```python
    stage = models.CharField(
        max_length=24,
        choices=TournamentStage.choices,
        default=TournamentStage.SETUP,
        db_index=True,
    )
    # Per-stage bookkeeping (entered/exited/reopened, who, when, completeness snapshot).
    # Keyed by stage value; see §3 JSONB schema. Avoids a 1:N table for v1.
    stage_meta = models.JSONField(default=dict, blank=True)
```

Index: extend the existing `trn_org_status_idx`; add
`models.Index(fields=["organization", "stage"], name="trn_org_stage_idx")`.

**Why JSONB `stage_meta`, not a `TournamentStageRecord` table?** Stages are a fixed, small,
ordered set (6 values) with no cross-row queries needed; the per-stage history mirrors the existing
`Tournament.rules`/`constraints` JSONB convention (`CLAUDE.md` "Data-driven rules"). If audit-grade
per-transition history is later required, it already lives in `AuditEvent`
(`event_type="tournament_stage_changed"`, see §4.3) — `stage_meta` is the *current snapshot*, the
audit log is the *history*. (Open question OQ-3 revisits a table if reporting needs it.)

### 2.3 `Form` → stage linkage (new field on `apps/forms/models.py::Form`)

Stage 1/2 forms must be findable so advancing can auto-close them. Two options:

- **Chosen:** add `Form.stage = models.CharField(max_length=24, blank=True, db_index=True)` (the
  `TournamentStage` value the form belongs to, e.g. `"org_registration"`). A form is "the stage's
  form" iff `form.tournament_id == t.id AND form.stage == <stage> AND form.deleted_at IS NULL`.
- Rejected: deriving from `Form.purpose` alone — `purpose` is about *entity mapping*
  (`organization_registration`/`team_registration`), and a stage could (later) have multiple forms
  or a form could be re-used; an explicit `stage` is clearer and indexable.

`Form.purpose` and `Form.stage` are set together at form-creation time inside a stage (the stepper
creates the form with both). Default `stage=""` means "not stage-bound" (generic forms; never
auto-closed).

### 2.4 Migration plan

`backend/apps/tournaments/migrations/00XX_tournament_stage.py`:
1. `AddField Tournament.stage` (default `setup`).
2. `AddField Tournament.stage_meta` (default `dict`).
3. `AddIndex trn_org_stage_idx`.
4. **Data migration**: backfill `stage` for existing tournaments by inferring from current state so
   the stepper opens on the right step (idempotent, forward-only):
   - has matches → `fixtures` (or `ready` if `status >= scheduled`)
   - else has `Team(status=REGISTERED)` rows → `team_registration`
   - else has any forms → `org_registration`
   - else → `setup`
   This keeps `Team(status=REGISTERED)` semantics untouched — we only *read* it (invariant in
   `RESTRUCTURING-NOTES.md` §6: "Team(status=REGISTERED) is exactly what the generator selects").

`backend/apps/forms/migrations/00YY_form_stage.py`: `AddField Form.stage` (default `""`) + index.

Both ship behind the "migrations blocked while any tournament is `live`" pre-flight (`CLAUDE.md` Dev
gotchas). Confirmed safe: dev/seed data has no `live` tournaments at design time; verify in deploy
pre-flight.

---

## 3. JSONB schemas

### 3.1 `Tournament.stage_meta`

```jsonc
{
  // one entry per stage that has been entered at least once; absent = never entered
  "org_registration": {
    "entered_at": "2026-06-08T10:00:00Z",     // first/most-recent entry (ISO-8601 UTC)
    "exited_at":  "2026-06-09T12:00:00Z",     // null while current
    "reopened_count": 0,                       // ++ each time the admin moves back into it
    "entered_by": "<user-uuid>",
    "form_id": "<form-uuid|null>",             // the stage's bound form, if created
    "form_closed_on_advance": true,            // did advancing auto-close it
    "completeness": {                          // snapshot from the pre-advance check (§5.2)
      "ok": true,
      "counts": {"institutions": 12}
    }
  },
  "team_registration": { /* same shape; counts: {"teams": 34, "institutions_with_teams": 11} */ },
  "members":           { /* counts: {"members": 5} */ },
  "fixtures":          { /* counts: {"matches": 48}, "inputs_hash": "<sha256>" */ }
}
```

Writer: only `transition_tournament` (and the pre-advance check, read-only) touch `stage_meta`.
Schema is internal (not a public API contract) — surfaced to the FE only through the serialized
stepper payload (§6.1), so it can evolve without a typed-contract break.

### 3.2 Pre-advance consequences payload (API response of the dry-run, §5.2)

```jsonc
{
  "from_stage": "org_registration",
  "to_stage": "team_registration",
  "allowed": true,                    // false → blocked, see `blockers`
  "blockers": [],                     // hard stops, e.g. ["no_institutions_registered"]
  "warnings": [                       // soft, ack-required consequences
    {"code": "form_will_close", "form_id": "<uuid>", "form_title": "Institution sign-up"},
    {"code": "lifecycle_will_change", "from": "published", "to": "registration_open"},
    {"code": "rules_will_freeze"}     // only on the team_registration step
  ],
  "lifecycle_effect": {"status_from": "published", "status_to": "registration_open"},
  "summary_counts": {"institutions": 12}
}
```

### 3.3 Reversibility (re-open) consequences payload (§5.3)

```jsonc
{
  "from_stage": "fixtures",
  "to_stage": "team_registration",
  "allowed": true,
  "warnings": [
    {"code": "form_will_reopen", "form_id": "<uuid>"},
    {"code": "downstream_artifacts_exist", "kind": "matches", "count": 48,
     "detail": "Generated fixtures exist. Editing teams may invalidate them.",
     "inputs_hash": "<sha256>"},          // present iff matches' inputs_hash would drift
    {"code": "rules_frozen", "detail": "Rules are frozen; editing requires an amend reason."}
  ],
  "irreversible": false                    // true only if a hard downstream lock exists
}
```

---

## 4. Backend service — `apps/tournaments/services/state.py`

New module, **mirroring `apps/matches/services/state.py`** exactly in structure: an
`ALLOWED_TRANSITIONS` table, a `can_transition`, a guarded+audited `transition_tournament` under
`select_for_update`, and `transaction.on_commit` side-effects.

### 4.1 Transition table (stage axis)

```python
from apps.tournaments.models import TournamentStage as G

# Forward order; reverse to ANY earlier stage is allowed (reversibility, spec §1).
_ORDER = [G.SETUP, G.ORG_REGISTRATION, G.TEAM_REGISTRATION, G.MEMBERS, G.FIXTURES, G.READY]

def _allowed(frm: str) -> set[str]:
    i = _ORDER.index(frm)
    fwd = {_ORDER[i + 1]} if i + 1 < len(_ORDER) else set()   # one step forward
    back = set(_ORDER[:i])                                     # any earlier stage (reopen)
    return fwd | back

ALLOWED_TRANSITIONS: dict[str, set[str]] = {s: _allowed(s) for s in _ORDER}
```

Design choices:
- **Forward = one step at a time** (you cannot skip from `setup` straight to `fixtures` — each stage
  gates the next, spec §1). **Backward = jump to any earlier stage** (the owner: "every stage is
  reversible; go back to edit/add").
- The table is the single source of truth; the FE stepper mirrors it (see §6, parity contract).

### 4.2 Lifecycle coupling helper

```python
def _lifecycle_for_stage(to_stage: str, current_status: str) -> str | None:
    """Return the new TournamentStatus to apply on entering `to_stage`, or None.

    Forward-only on lifecycle: re-opening an earlier *stage* does NOT roll the
    lifecycle status backward (so rules stay frozen, matches stay scheduled).
    """
    S = TournamentStatus
    table = {
        G.ORG_REGISTRATION:  S.PUBLISHED,
        G.TEAM_REGISTRATION: S.REGISTRATION_OPEN,   # triggers freeze_rules
        G.READY:             S.SCHEDULED,            # triggers TZ-lock
    }
    target = table.get(to_stage)
    if target is None:
        return None
    if _status_rank(target) <= _status_rank(current_status):
        return None   # never move lifecycle backward (reopen safety)
    return target
```

`_status_rank` is a small ordered map over the PRD §5.2 enum
(`draft<published<registration_open<scheduled<live<completed<archived`).

### 4.3 `transition_tournament` (the seam)

```python
def transition_tournament(*, tournament, to_stage, by=None, reason="",
                          ack_warnings=False, event_id=None, request=None) -> Tournament:
    """Move a tournament's setup stage. Guarded + audited (mirrors transition_match).

    - Validates the transition against ALLOWED_TRANSITIONS (ValidationError on illegal).
    - FORWARD: runs the pre-advance check; if it returns blockers -> ValidationError;
      if it returns warnings and not ack_warnings -> ValidationError("unacknowledged_warnings")
      carrying the consequences payload so the API returns 409 with details.
    - Applies the lifecycle status coupling (calls freeze_rules on registration_open).
    - Auto-closes the prior stage's form on forward; re-opens it on reopen (§5.4).
    - Updates stage_meta (entered/exited/reopened_count).
    - Idempotent on event_id (invariant 3): replay returns the tournament unchanged.
    - on_commit: notify managers (and, on reopen-with-artifacts, flag regeneration).
    """
    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="tournament_stage_changed"
        ).first()
        if prior is not None:
            return tournament  # replay (invariant 3)

    with transaction.atomic():
        locked = Tournament.objects.select_for_update().get(pk=tournament.pk)
        frm = locked.stage
        if to_stage not in ALLOWED_TRANSITIONS.get(frm, set()):
            raise ValidationError(f"Illegal stage transition: {frm} -> {to_stage}")

        is_forward = _ORDER.index(to_stage) > _ORDER.index(frm)
        consequences = (preview_advance if is_forward else preview_reopen)(locked, to_stage)
        if consequences["blockers"]:
            raise ValidationError({"detail": "stage_blocked", "consequences": consequences})
        if consequences["warnings"] and not ack_warnings:
            raise ValidationError({"detail": "unacknowledged_warnings",
                                   "consequences": consequences})

        before = {"stage": frm, "status": locked.status}

        # --- form auto-close / re-open (§5.4) ---
        if is_forward:
            _close_stage_form(locked, frm, by=by, request=request)
        else:
            _reopen_stage_form(locked, to_stage, by=by, request=request)

        # --- lifecycle coupling ---
        new_status = _lifecycle_for_stage(to_stage, locked.status)
        if new_status is not None:
            locked.status = new_status
            if new_status == TournamentStatus.REGISTRATION_OPEN:
                freeze_rules(locked)              # rules.py — stamps rules_frozen_at, idempotent

        # --- stage_meta bookkeeping ---
        _stamp_stage_meta(locked, frm, to_stage, by, is_forward, consequences)
        locked.stage = to_stage
        locked.save(update_fields=["stage", "status", "stage_meta", "updated_at"])

        emit_audit(
            actor_user=by, actor_role=ActorRole.ADMIN,
            event_type="tournament_stage_changed", target_type="tournament",
            target_id=locked.id, organization_id=locked.organization_id,
            idempotency_key=event_id, reason=reason,
            payload_before=before,
            payload_after={"stage": to_stage, "status": locked.status,
                           "direction": "forward" if is_forward else "reopen"},
            request=request,
        )

        if (not is_forward) and consequences_has_artifacts(consequences):
            tid = locked.id
            transaction.on_commit(lambda: _flag_regeneration(tid))
    return locked
```

Notes:
- **`select_for_update` + Max/guard pattern** is copied verbatim from `transition_match` — no new
  concurrency model.
- The **ValidationError → `{"detail": ...}` mapping** is the contract pinned by tests
  (`RESTRUCTURING-NOTES.md` §6). The view maps `ValidationError` to a 4xx with the `detail`/
  `consequences` body (§5).
- `freeze_rules` is the **existing** function (`rules.py`); calling it here is precisely the dead-code
  wiring the ARCHITECTURE doc flags (invariant #7).
- `Tournament` currently has **no `updated_at`** field — add one in the same migration (`auto_now`),
  or drop it from `update_fields`. **Decision:** add `updated_at` (consistent with every other model;
  `Team`/`Form`/`Match` all have it).

### 4.4 Helper services in the same module

- `preview_advance(t, to_stage) -> dict` — the §5.2 dry-run (read-only; also reused for the warn-
  before-advance UI). Computes blockers + warnings (see §5.2 rules).
- `preview_reopen(t, to_stage) -> dict` — the §5.3 reversibility dry-run (downstream-artifact
  detection via match presence + `inputs_hash` drift).
- `_close_stage_form(t, stage, ...)` / `_reopen_stage_form(t, stage, ...)` — call the existing
  `apps/forms/services/forms.py::close_form` / `publish_form` (§5.4).
- `_stamp_stage_meta(...)` — mutate the `stage_meta` JSON (entered/exited/reopened_count).
- `_flag_regeneration(tid)` — on_commit; sets the regeneration-needed signal the FE already
  understands via `inputs_hash`/`last_manual_edit_at` (invariant #10) and notifies managers.

### 4.5 Audit event types (new — pin these strings, `RESTRUCTURING-NOTES.md` §6)

- `"tournament_stage_changed"` — every transition (forward + reopen), `target_type="tournament"`.
- `"form_closed"` / `"form_published"` — already emitted by `forms.py`; auto-close/re-open reuse them
  (no new strings; keeps the audit vocabulary stable).

No new strings beyond `tournament_stage_changed`. (The lifecycle status change is captured *inside*
that one event's `payload_after.status`, not as a separate `match_status_changed`-style event, to
avoid implying a second independent state machine.)

---

## 5. Stage mechanics in detail

### 5.1 Per-stage entry/exit semantics

| Stage              | Entry effect                                  | Exit (advance) effect                                  |
|--------------------|-----------------------------------------------|--------------------------------------------------------|
| `setup`            | initial; name/sport/TZ editable               | —                                                      |
| `org_registration` | status→`published`; stage's form openable     | auto-close org form; warn                              |
| `team_registration`| status→`registration_open`; **freeze_rules**  | auto-close team form; warn                             |
| `members`          | invite/assign roles (existing membership API) | (no form to close)                                     |
| `fixtures`         | constraint wizard / `generate_fixtures`       | requires matches to exist to advance to `ready`        |
| `ready`            | status→`scheduled`; TZ-lock engages           | terminal for setup; `live` is match-driven thereafter  |

### 5.2 Warn-before-advance (`preview_advance`) — consequences contract

`preview_advance` is a **pure, read-only** function returning the §3.2 payload. Rules:

**Blockers (hard — advance refused, returns `allowed:false`):**
- `org_registration → team_registration`: block `no_institutions_registered` if zero institutions
  exist (so team registration has something to attach to). *(Until the Institution entity lands, this
  reads the proxy: distinct `Team.school` values or accepted org-registration responses; see OQ-1.)*
- `team_registration → members`: block `no_teams_registered` if zero `Team(status=REGISTERED)`.
- `fixtures → ready`: block `no_fixtures_generated` if zero `Match` rows.

**Warnings (soft — advance allowed only with `ack_warnings=true`):**
- `form_will_close` — iff the *current* stage has an open bound form (`Form.stage == frm`,
  `is_open(form)`); carries `form_id`,`form_title`.
- `lifecycle_will_change` — iff `_lifecycle_for_stage` returns a new status; carries from/to.
- `rules_will_freeze` — specifically on the `→ team_registration` step (status hits
  `registration_open`); makes the freeze explicit to the admin (invariant #7).

This is the "you're moving to Team Registration — the Organization form will close. Continue?"
behavior from the spec, computed server-side so FE and BE never drift.

### 5.3 Reversibility (`preview_reopen`) + downstream-artifact warnings

Re-opening (`to_stage` earlier than current) is always *allowed* (spec: every stage reversible) but
surfaces consequences so the admin acknowledges blast radius:

- `form_will_reopen` — the target stage's bound form will be re-opened (status `closed → open` via
  `publish_form`). Carries `form_id`.
- `downstream_artifacts_exist` — computed by walking what each earlier stage feeds:
  - re-opening `org_registration` or `team_registration` while **matches exist** →
    `{kind:"matches", count, inputs_hash}` warning. The `inputs_hash` is recomputed from the *would-be*
    team set; if it differs from the stored `Match.inputs_hash`, the warning includes the drift flag
    so the FE shows the existing **regenerate / keep / diff** UX (invariant #10). This reuses, not
    reinvents, the `inputs_hash`/`last_manual_edit_at` machinery already on `Tournament`/`Match`.
  - re-opening any stage while `rules_frozen_at` is set → `rules_frozen` warning (edits to rules now
    require `update_settings(amend=True, reason=...)`, which the existing service already enforces).
- The lifecycle status is **not** rolled back (§4.2). Re-opening `org_registration` from `fixtures`
  leaves status at `registration_open`/`scheduled`; only the *stage* pointer and the *forms* move.

`_flag_regeneration` (on_commit) fires only when artifacts exist, notifying managers + setting the
FE-visible "fixtures may be stale" signal (the FE reads `Tournament.last_manual_edit_at` /
`Match.inputs_hash` drift, no new field needed).

### 5.4 Auto-close / re-open forms — wiring

`_close_stage_form(t, stage)`:
1. Find the bound form: `Form.objects.filter(tournament=t, stage=stage, deleted_at__isnull=True,
   status=FormStatus.OPEN).first()`.
2. If found, call `apps/forms/services/forms.py::close_form(form, user=by, request=request)` (emits
   `form_closed` audit — reuse, no new path).
3. Record `stage_meta[stage]["form_closed_on_advance"]=True`, `form_id`.

`_reopen_stage_form(t, stage)`:
1. Find the bound form (any status). If `CLOSED`, call `publish_form(form, ...)` (re-opens, emits
   `form_published`). If it was never published (`DRAFT` with empty schema), skip (nothing to open).
2. Record `stage_meta[stage]["reopened_count"] += 1`.

This makes "advancing auto-closes the previous stage's form" and "re-opening a stage re-opens its
form" literal, using the **existing** form lifecycle service (`RESTRUCTURING-NOTES.md` seam #8
spirit: keep one writer per concern).

### 5.5 Freeze interplay (invariant #7) — exact behavior

- `freeze_rules` is called **once**, when the stage transition crosses into `registration_open`
  (entering `team_registration`). It stamps `rules_frozen_at` (idempotent — the existing guard).
- After that, `can_edit_rules` (status-based, `{DRAFT, PUBLISHED}`) returns `False`, so
  `update_settings` requires `amend=True`+`reason` (existing 409 `rules_frozen` path). **No change to
  `rules.py` needed** — we only *call* `freeze_rules`, which today nothing does.
- **Fixtures-stage freeze:** `constraints` follow the same `rules` freeze (they live in the same
  `update_settings`/freeze gate). The deep fixture wizard (separate design) must therefore either run
  *before* `team_registration` or use the `amend` path; this design records that as the contract the
  wizard plugs into (OQ-2). The constraint engine itself is out of scope here; this doc only ensures
  the freeze fires at the right stage.
- Re-opening `team_registration` does **not** un-freeze (lifecycle never rolls back, §4.2) — rule
  edits stay amend-gated. This preserves invariant #7's "frozen at the boundary" semantics across
  reopens.

---

## 6. API

All routes are added to `apps/tournaments/urls.py` (the existing cross-app router) and follow the
`_get_tournament_or_404` + `can_manage_tournament` pattern (404-not-403 invariant) used by every
tournament view.

### 6.1 `GET /api/tournaments/{id}/stage/` — stepper state

Returns the full stepper payload (manager or any member; access-scoped → 404 on no access):

```jsonc
{
  "stage": "team_registration",
  "status": "registration_open",
  "order": ["setup","org_registration","team_registration","members","fixtures","ready"],
  "allowed_to": ["members", "setup", "org_registration"],   // from ALLOWED_TRANSITIONS[stage]
  "can_manage": true,                                         // gates the advance/reopen buttons
  "rules_frozen_at": "2026-06-08T10:00:00Z",
  "stages": [
    {"key":"setup","label":"Setup","state":"complete","entered_at":"...","form":null},
    {"key":"org_registration","label":"Institution registration","state":"complete",
     "form":{"id":"<uuid>","status":"closed","title":"..."},"counts":{"institutions":12}},
    {"key":"team_registration","label":"Team registration","state":"current",
     "form":{"id":"<uuid>","status":"open"},"counts":{"teams":0}},
    {"key":"members","label":"Members & roles","state":"upcoming","counts":{"members":3}},
    {"key":"fixtures","label":"Fixtures","state":"upcoming","counts":{"matches":0}},
    {"key":"ready","label":"Ready","state":"upcoming"}
  ]
}
```

`state ∈ {complete, current, upcoming}` is derived from stage order vs current stage (+ "reopened"
hint from `stage_meta`).

### 6.2 `POST /api/tournaments/{id}/stage/preview/` — dry-run consequences

Body `{ "to_stage": "team_registration" }`. Returns the §3.2 (forward) or §3.3 (reopen) consequences
payload. **Never mutates.** This is the warn-before-advance source the FE shows in a confirm dialog.
Manager-only (403 otherwise; 404 on no access).

### 6.3 `POST /api/tournaments/{id}/stage/` — execute a transition

Body:
```jsonc
{ "to_stage": "team_registration", "ack_warnings": true, "reason": "", "event_id": "<uuid>" }
```
- Manager-only. Idempotent on `event_id` (invariant 3 → replay returns 200 with the stepper payload).
- Calls `transition_tournament`. Maps:
  - illegal transition → `400 {"detail":"Illegal stage transition: ..."}` (mirrors `transition_match`
    400 contract).
  - blockers → `409 {"detail":"stage_blocked","consequences":{...}}`.
  - unacknowledged warnings → `409 {"detail":"unacknowledged_warnings","consequences":{...}}` (FE
    re-shows the dialog; user re-submits with `ack_warnings:true`).
  - success → `200` with the §6.1 stepper payload (so the FE refreshes the stepper in one round-trip).
- Returns 200 (not 201) — this is a state transition on an existing resource, matching the
  `transition_match`/`transition_dispute` 200 convention and invariant #3 (replay returns 200).

### 6.4 View skeleton (`apps/tournaments/views.py`)

```python
class TournamentStageView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        t = _get_tournament_or_404(request.user, tournament_id)
        return Response(build_stage_payload(t, request.user))   # services/state.py helper

    def post(self, request, tournament_id):
        t = _get_tournament_or_404(request.user, tournament_id)
        if not can_manage_tournament(request.user, t):
            raise PermissionDenied("not_tournament_manager")
        ser = TournamentStageTransitionSerializer(data=request.data); ser.is_valid(raise_exception=True)
        try:
            t = transition_tournament(
                tournament=t, to_stage=ser.validated_data["to_stage"],
                ack_warnings=ser.validated_data.get("ack_warnings", False),
                reason=ser.validated_data.get("reason", ""),
                event_id=ser.validated_data.get("event_id"),
                by=request.user, request=request,
            )
        except ValidationError as exc:
            detail = exc.message_dict if hasattr(exc, "message_dict") else {"detail": str(exc)}
            # blockers / unacknowledged_warnings carry a consequences dict -> 409; illegal -> 400
            code = 409 if isinstance(getattr(exc, "params", None) or detail, dict) and \
                   detail.get("detail") in {"stage_blocked","unacknowledged_warnings"} else 400
            return Response(detail, status=code)
        return Response(build_stage_payload(t, request.user))


class TournamentStagePreviewView(GenericAPIView):
    permission_classes = [IsAuthenticated]
    def post(self, request, tournament_id):
        t = _get_tournament_or_404(request.user, tournament_id)
        if not can_manage_tournament(request.user, t):
            raise PermissionDenied("not_tournament_manager")
        to_stage = request.data.get("to_stage")
        return Response(preview_transition(t, to_stage))   # dispatches advance/reopen
```

URLs (append to `apps/tournaments/urls.py`):
```python
path("<uuid:tournament_id>/stage/", TournamentStageView.as_view(), name="tournament-stage"),
path("<uuid:tournament_id>/stage/preview/", TournamentStagePreviewView.as_view(),
     name="tournament-stage-preview"),
```

Serializer (`apps/tournaments/serializers.py`):
```python
class TournamentStageTransitionSerializer(serializers.Serializer):
    to_stage = serializers.ChoiceField(choices=TournamentStage.choices)
    ack_warnings = serializers.BooleanField(required=False, default=False)
    reason = serializers.CharField(required=False, allow_blank=True)
    event_id = serializers.UUIDField(required=False)
```

---

## 7. Frontend — the stage stepper

### 7.1 API client (`frontend/src/api/tournaments.ts`)

Add to `tournamentsApi`:
```ts
stage: (id: string) => api.get<StagePayload>(`/api/tournaments/${id}/stage/`),
previewStage: (id: string, toStage: string) =>
  api.post<StageConsequences>(`/api/tournaments/${id}/stage/preview/`, { to_stage: toStage }),
transitionStage: (id: string, body: { to_stage: string; ack_warnings?: boolean;
  reason?: string; event_id: string }) =>
  api.post<StagePayload>(`/api/tournaments/${id}/stage/`, body),
```
with `StagePayload`/`StageConsequences` TS interfaces mirroring §6.1/§3.2-3.3 (eventually generated
by `npm run gen:types` from the DRF schema — `CLAUDE.md`).

### 7.2 Components (`frontend/src/features/tournaments/`)

- **`StageStepper.tsx`** — the horizontal stepper (6 steps). Each step shows label + state
  (`complete`/`current`/`upcoming`), a check for complete (lucide `Check`, already imported in
  `TournamentDetailPage`), the bound form's open/closed badge, and the counts (institutions/teams/
  members/matches). Renders inside `<main>` full-width per the design system
  (`flex w-full flex-col gap-6 px-4 ...`, never `mx-auto max-w-*` — `CLAUDE.md` design system).
  - Tokens only (`bg-card`, `border-border`, `bg-primary`, `text-muted-foreground`); numbers use
    `font-tabular`.
  - "Advance" primary button (enabled iff `can_manage` and a forward `allowed_to` exists). Clicking
    a *past* step opens the **re-open** flow.
- **`StageAdvanceDialog.tsx`** — uses `components/ui/dialog` (no `window.confirm`, design system).
  On open it calls `previewStage(toStage)` and renders the consequences:
  - blockers → red, advance disabled, explains what's missing (e.g. "Register at least one
    institution first").
  - warnings → list with an "I understand" checkbox; "Continue" calls `transitionStage` with
    `ack_warnings:true` + a fresh `newEventId()` (`lib/eventId.ts`, idempotency).
  - `rules_will_freeze` warning gets emphasized copy ("Rules will be locked; later changes need an
    amend reason").
- **`StageReopenDialog.tsx`** — same shell; shows downstream-artifact warnings
  (`downstream_artifacts_exist` with count + the regenerate/keep/diff hint, reusing the existing
  invariant-#10 affordance), `form_will_reopen`, `rules_frozen`.
- Each step body deep-links to the existing surface for that stage (no new screens needed for the
  work itself, only the orchestration):
  - `org_registration` / `team_registration` → `routes.tournamentForms(id)` (forms builder) +
    direct-entry (existing teams add).
  - `members` → `routes.tournamentMembers(id)`.
  - `fixtures` → the generate-fixtures action / future wizard route.

### 7.3 Mounting

Mount `StageStepper` at the top of `TournamentDetailPage.tsx` (it already imports `tournamentsApi`,
`useToast`, `routes`, `cn`, `t`, lucide icons). The stepper becomes the page's primary navigation
spine; the existing teams/fixtures/standings panels render under the *current* step's body.

### 7.4 Parity contract (FE ↔ BE)

The stage **order** and **allowed transitions** are computed **server-side** and shipped in §6.1
(`order`, `allowed_to`). The FE must **render from those fields**, never hardcode the order — this
avoids the class of FE↔BE state-machine drift called out in `RESTRUCTURING-NOTES.md` §3.1 (the
match `STATE_ACTIONS` ↔ `ALLOWED_TRANSITIONS` fork). Add an FE unit test asserting the stepper only
enables transitions present in `allowed_to`.

---

## 8. Invariants this design must preserve (from `RESTRUCTURING-NOTES.md` §6 + `CLAUDE.md`)

1. **404-not-403** (`scope::accessible_tournaments` + `_get_tournament_or_404`): every new endpoint
   resolves through `_get_tournament_or_404`, then the verb gate (`can_manage_tournament`) → 403.
   No existence leak. (NOTES §6, ARCHITECTURE §3.3.)
2. **Exact `emit_audit` event-type strings**: introduce exactly **one** new string
   `"tournament_stage_changed"`; reuse `form_closed`/`form_published` for the form side. Pin it in
   tests. (NOTES §6.)
3. **`ALLOWED_TRANSITIONS` + `ValidationError → {"detail": ...}` mapping + exact status codes**: the
   stage table mirrors the match table's contract; illegal → 400 with `detail`; the test suite must
   cover every legal + every illegal transition (the mandatory state-machine suite, `CLAUDE.md`).
4. **Idempotent writes (invariant 3)**: `transition_tournament` is idempotent on `event_id`; replay
   returns 200 + unchanged stepper payload. Keyed on the `tournament_stage_changed` audit row (the
   same pattern as `create_tournament`/`register_school`). Avoid the cross-verb `event_id` collision
   bug (NOTES §4 CRITICAL): the lookup filters by `event_type="tournament_stage_changed"`.
5. **State machines, not booleans (invariant 6)**: stage is an enum with guarded/audited transitions;
   no boolean flags. The lifecycle status enum (§5.2 PRD) is unchanged — we only *drive* it.
6. **Rule freeze at the boundary (invariant 7)**: `freeze_rules` fires exactly once at
   `registration_open` (entering `team_registration`); reopens never un-freeze; `update_settings`'s
   existing amend gate is the only mutation path after freeze.
7. **TZ-lock once scheduled (invariant 14)**: entering `ready` → status `scheduled`; the
   time-zone-change guard (to be enforced where TZ is editable) keys off `status >= scheduled`. This
   design *engages* the lock at the right moment; the guard itself is a one-line check in the
   TZ-edit path (note it; OQ-4).
8. **`Team(status=REGISTERED)` is exactly what the generator selects** (NOTES §6 structural fact):
   the blockers/counts in `preview_advance` only **read** this status; we do **not** introduce a new
   team-approval state machine. Treat any change as coordinated.
9. **Migrations blocked while live** (`CLAUDE.md`): the additive migrations ship behind the deploy
   pre-flight; all new fields are nullable/defaulted.
10. **Auto-generate + manual-edit conflict warnings (invariant 10)**: reopen-with-artifacts reuses
    `inputs_hash`/`last_manual_edit_at`; no parallel "stale" flag is invented.
11. **Service-layer audit at the call site (B.4)**: `emit_audit` is called inside
    `transition_tournament`'s atomic block, not via signals.
12. **Keep `register_school` / forms `map_response` as the sole entrant writers** (NOTES seam #8):
    the stage machine **orchestrates** (opens/closes forms, gates advance) but never writes
    teams/institutions directly — those still flow through `register_school` / `map_response`.
13. **Single writer per concern**: only `transition_tournament` writes `Tournament.stage`/
    `stage_meta`; only `forms.py` opens/closes forms (we call it, not re-implement it).

---

## 9. Test strategy

Mirror the existing `apps/matches/tests/test_state.py` + `apps/disputes` lifecycle suites.

**Backend (pytest) — `apps/tournaments/tests/test_stage.py` (new):**
- State-machine completeness (mandatory per `CLAUDE.md`): parametrize **every** `(from, to)` pair;
  assert legal forward (one step) succeeds, every legal reopen (any earlier) succeeds, and every
  illegal pair raises `ValidationError` → 400 `{"detail": "Illegal stage transition..."}`.
- Lifecycle coupling: entering `org_registration` sets `published`; `team_registration` sets
  `registration_open` **and** stamps `rules_frozen_at` (assert `freeze_rules` fired); `ready` sets
  `scheduled`. Reopen does **not** roll status back.
- Auto-close: with an OPEN bound `org_registration` form, advancing to `team_registration` closes it
  (assert `Form.status==CLOSED` + a `form_closed` audit row). Reopen re-publishes it (`form_published`).
- Warn-before-advance: `preview_advance` returns `rules_will_freeze` + `form_will_close` +
  `lifecycle_will_change`; transition without `ack_warnings` → 409 `unacknowledged_warnings` carrying
  `consequences`; with `ack_warnings` → 200.
- Blockers: advancing past `team_registration` with zero `REGISTERED` teams → 409 `stage_blocked`.
- Reversibility: reopen `team_registration` from `fixtures` while matches exist →
  `downstream_artifacts_exist` warning with `count` + `inputs_hash`; on_commit `_flag_regeneration`
  fires (assert via captured on_commit / notification).
- Idempotency (invariant 3): same `event_id` twice → second is a no-op replay, 200, single audit row.
- **Isolation (mandatory, invariant 2):** user in org X gets 404 (not 403) on
  `GET/POST /api/tournaments/{Y-id}/stage/`; a non-manager member gets 403 on POST, 200 on GET.
- Audit string pin: assert the exact `"tournament_stage_changed"` literal.
- Migration data-backfill test: a tournament with matches backfills to `fixtures`/`ready`; with teams
  → `team_registration`; empty → `setup`.

**Frontend (vitest) — `StageStepper.test.tsx` / `StageAdvanceDialog.test.tsx`:**
- Renders 6 steps from the server `order`; marks `current`/`complete`/`upcoming` correctly.
- Advance button disabled when `can_manage:false`; enabled only for `allowed_to` forward.
- Advance dialog fetches `previewStage`, shows warnings, requires the ack checkbox before "Continue",
  and posts `ack_warnings:true` + an `event_id`.
- Blockers hide "Continue".
- Reopen dialog shows the downstream-artifact warning + regenerate hint.
- Parity test: the stepper never enables a transition absent from `allowed_to`.

---

## 10. Build sequencing

1. Models + migration (`TournamentStage`, `Tournament.stage`/`stage_meta`/`updated_at`, `Form.stage`)
   + data backfill. Run `makemigrations`/`migrate`.
2. `services/state.py` (`ALLOWED_TRANSITIONS`, `can_transition`, `transition_tournament`,
   `preview_advance`/`preview_reopen`, form close/reopen helpers, `build_stage_payload`) — tests first
   for the transition table + lifecycle coupling (the mandatory state-machine suite).
3. Serializer + views + URLs (`/stage/`, `/stage/preview/`) + isolation tests.
4. FE: API client types, `StageStepper`, `StageAdvanceDialog`, `StageReopenDialog`, mount in
   `TournamentDetailPage`; vitest + `type-check`.
5. Wire the existing stage surfaces (forms/members/fixtures) as step bodies; create-in-stage sets
   `Form.stage`+`purpose`.

Each step is a verified increment (`CLAUDE.md`: run the relevant suite + `type-check`, commit per
increment).

---

## 11. Open questions

- **OQ-1 (Institution entity timing):** the spec locks `Institution → Team → Player`, but that entity
  isn't built yet. Until it lands, `preview_advance`'s "institutions" count/blocker uses a proxy
  (distinct `Team.school` or accepted `organization_registration` form responses). Confirm the proxy
  is acceptable for v1, or sequence the Institution model **before** this stage machine so blockers
  read real institutions. (Cross-references the participant-hierarchy design.)
- **OQ-2 (fixture wizard vs. freeze ordering):** entering `team_registration` freezes `rules`+
  `constraints`. The deep fixture wizard (separate design) edits `constraints` at the `fixtures`
  stage — *after* freeze. Decide: (a) the wizard always uses the `amend` path, or (b)
  `constraints` are exempted from the freeze (split the freeze so scheduling constraints stay mutable
  through `fixtures`). Recommendation: (b) — scheduling constraints are inherently a fixtures-stage
  concern; freeze only *competitive* `rules` at `registration_open`. This needs an owner decision and
  a small change to `rules.py`'s freeze scope.
- **OQ-3 (stage history table):** `stage_meta` JSON holds the current snapshot; full history is in
  `AuditEvent`. If per-stage reporting/analytics needs queryable history, promote to a
  `TournamentStageRecord` table later. Confirm JSON is sufficient for v1.
- **OQ-4 (TZ-lock enforcement point):** entering `ready` sets `scheduled`; the actual
  "TZ change blocked once scheduled" guard must live in whatever endpoint edits `Tournament.time_zone`
  (none exists yet — there's no tournament-update endpoint). Confirm where TZ edits will live so the
  guard lands with it.
- **OQ-5 (members stage as a gate):** is `members` a *blocking* stage (must invite ≥1 staff before
  `fixtures`) or purely advisory? The spec lists it as a stage but implies no hard gate. Current
  design treats it as non-blocking (no blocker rule). Confirm.
- **OQ-6 (multi-form per stage):** v1 assumes one bound form per stage (`Form.stage` unique-ish per
  stage). Multi-category tournaments (locked decision #2) may want several Stage-2 forms (e.g. per
  sport/category). If so, auto-close must close *all* forms with `Form.stage==stage`; the helper
  already filters by stage, so it generalizes — confirm the "close all" semantics are desired.
- **OQ-7 (`live`/`completed` re-entry):** once matches drive the lifecycle to `live`, should the
  setup stepper be locked (read-only)? Proposed: stage stays at `ready`; reopens that would mutate
  rules/teams become hard `blockers` (not warnings) while `status==live`, aligning with
  invariant #7's "once live" rigor. Confirm.
</content>
</invoke>
