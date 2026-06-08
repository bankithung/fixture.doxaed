# Institution → Team → Player data model & migration — Design

> Status: **design / implementation-ready**. No source code changed by this doc.
> Author: restructuring workstream (participant hierarchy). Date: 2026-06-08.
> Grounding: spec `docs/superpowers/specs/2026-06-08-tournament-flow-and-constraint-engine.md`
> (§1, §4 decision 1, §2), `docs/ARCHITECTURE.md` (§4.5, §7, §10), `docs/RESTRUCTURING-NOTES.md`
> (§2 coupling, §6 invariants, seam #8). Citations use `path::symbol`.

---

## 0. The decision, restated (LOCKED — do not relitigate)

Introduce a first-class **Institution** entity (the design-domain name for the spec's
"Participant Organization") that **owns many Teams**. Hierarchy:

```
Organization (tenant — hidden personal workspace, organizations.Organization)
   └─ Tournament (tournaments.Tournament)
        └─ Institution   ← NEW level (school / college / club)
             └─ Team     (teams.Team — gains institution FK; loses `school` string as source of truth)
                  └─ Player (teams.Player) *—1 Person (teams.Person, platform-global, org-less)
```

Naming rationale (spec §4.1): the tenant is already `organizations.Organization`. Calling the new
participant entity "Organization" would collide. We use **`Institution`** as the Python model
name and `teams_institution` as the table. The user-facing label is configurable
("Institution" / "School" / "College" / "Club") via a `kind` enum so a college-sports organizer
and a schools organizer both see natural wording.

Today the platform treats a *school as a Team* — `Team.school` is a free `CharField`
(`teams/models.py::Team`), and `register_school` (`teams/services/registration.py::register_school`)
takes a `school_name` string and stamps it onto every created Team. We are promoting that string
into a real row, **without breaking `register_school` as the sole write path** (invariant /
seam #8) and **without breaking the ~448 backend tests** that build worlds through it.

---

## 1. What exists today (the surface we must reconcile)

| Concern | Today | Where |
|---|---|---|
| "School" | free `CharField` on every Team, copied per row | `teams/models.py::Team.school` |
| Entrant write path | `register_school(*, tournament, school_name, teams=[...], ...)` — atomic, idempotent on `(event_id,"school_registered")` | `teams/services/registration.py::register_school` |
| Public ingest | `POST /api/register/{token}/` → `register_school` | `teams/views.py::PublicRegistrationView` |
| Forms ingest | `team_registration` response → `map_response` → `register_school` | `forms/services/mapping.py::_map_team_registration` |
| Idempotent-replay re-read | re-queries `Team.objects.filter(tournament=…, school=school_name)` | `registration.py::register_school` lines ~107-110 |
| Generator team selection | `Team.objects.filter(status=REGISTERED)` — `Team(status=REGISTERED)` is *exactly* what the generator selects (locked invariant) | `fixtures/services/generate.py::generate_round_robin` |
| Standings payload | echoes `team.school` | `matches/services/standings.py::compute_standings` (~line 59) |
| Teams list API | returns `t.school` | `teams/views.py::TournamentTeamsListView` |
| FE registration types | `RegSubmission{school_name, teams[]}` | `frontend/src/api/registration.ts` |

**Org-scoping invariant** (invariant #2): every tenant row carries an `organization` FK and it
**must equal its tournament's** org. Today this is *service-enforced only* — there is **no DB
CHECK** tying `child.organization_id == tournament.organization_id` (`docs/RESTRUCTURING-NOTES.md`
§4 CRITICAL, `docs/ARCHITECTURE.md` §7.2, `DEEP-DIVE.md` H3). The notes call for adding that
DB-level guarantee (seam #3). Institution is a brand-new model, so **we add the CHECK for
Institution from day one** and, in the same migration set, retrofit it onto `Team`/`Player` (cheap
while we are already touching them).

---

## 2. The data model

### 2.1 New model: `Institution` (in `apps/teams/models.py`)

`Institution` is the participant entity. It is **org + tournament scoped** (so the same physical
school registered for two different tournaments is two `Institution` rows — same as `Team`/`Player`
are tournament-scoped today; cross-tournament identity rollup is a later concern, exactly mirroring
the `Person`/`Player` split rationale in invariant #8). It carries the denormalized `organization`
FK like every deep tenant row.

```python
class InstitutionKind(models.TextChoices):
    SCHOOL = "school", _("School")
    COLLEGE = "college", _("College")
    UNIVERSITY = "university", _("University")
    CLUB = "club", _("Club")
    ACADEMY = "academy", _("Academy")
    OTHER = "other", _("Other")


class InstitutionStatus(models.TextChoices):
    # Stage-1 registration lifecycle (mirrors the Team status MVP discipline:
    # only INVITED/REGISTERED are written in v1; the rest are reserved so the
    # state machine can be widened without a migration — same posture as TeamStatus).
    DRAFT = "draft", _("Draft")               # admin started a direct-entry row
    INVITED = "invited", _("Invited")          # admin invited via Stage-1 form, not yet responded
    REGISTERED = "registered", _("Registered") # confirmed participant (default for direct entry)
    WITHDRAWN = "withdrawn", _("Withdrawn")
    REJECTED = "rejected", _("Rejected")


class Institution(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="institutions",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE,
        related_name="institutions",
    )
    slug = models.CharField(max_length=80)
    name = models.CharField(max_length=200)
    short_name = models.CharField(max_length=40, blank=True)
    kind = models.CharField(
        max_length=16, choices=InstitutionKind.choices,
        default=InstitutionKind.SCHOOL,
    )
    region = models.CharField(max_length=120, blank=True)   # district / zone (moved up from Team)
    # Stage-1 contact captured by the org-registration form / direct entry.
    contact_name = models.CharField(max_length=200, blank=True)
    contact_email = models.EmailField(blank=True)
    contact_phone = models.CharField(max_length=32, blank=True)
    status = models.CharField(
        max_length=16, choices=InstitutionStatus.choices,
        default=InstitutionStatus.REGISTERED, db_index=True,
    )
    # Flexible attributes for the constraint engine (e.g. {"campus": "north"}).
    # The "same-institution teams cannot meet in round R" constraint resolves
    # via Team.institution_id; richer attributes (shared bus, same campus) live
    # here so constraints can key off them. Schema-free (FET-style, like rules).
    attributes = models.JSONField(default=dict, blank=True)
    # Optional pointer to the Stage-1 form response that created this row
    # (bare UUID, no FK — mirrors how audit/usage scope columns survive deletion;
    # avoids a teams→forms import cycle).
    source_response_id = models.UUIDField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="institutions_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "teams_institution"
        constraints = [
            UniqueConstraint(
                fields=["tournament", "slug"],
                name="unique_institution_slug_per_tournament",
            ),
            UniqueConstraint(
                fields=["tournament", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_institution_name_per_tournament",
            ),
            # NEW org-consistency CHECK is added by a RunSQL migration (see §4.3),
            # not declarable as a plain CheckConstraint because it references
            # another table.
        ]
        indexes = [
            models.Index(fields=["tournament", "status"], name="inst_trn_status_idx"),
            models.Index(fields=["organization"], name="inst_org_idx"),
        ]
```

Design notes:
- **`unique_institution_name_per_tournament`** (partial, `deleted_at IS NULL`) reproduces the
  exact pattern of `unique_team_name_per_tournament` (`teams/models.py::Team.Meta`). This is the
  de-dup guarantee that Stage-2 needs: "select your institution" must resolve to one row. It also
  means the migration backfill (§4.2) must collapse duplicate `Team.school` strings to one
  Institution.
- **`region` moves up** from `Team` to `Institution` (a school's district is a property of the
  school, not each team). `Team.region` is kept for backward compat but deprecated (§3.3).
- **`attributes` JSONB** is the hook for the spec's *generalized* keep-apart constraint
  ("teams sharing attribute X are kept apart until round R", spec §3.B). The opening-round
  same-institution rule resolves through `Team.institution_id` directly; `attributes` covers
  the richer cases (same campus, shared transport) without a migration — consistent with the
  FET-style "everything is data" posture of `Tournament.rules`/`constraints`.
- **`source_response_id`** is a bare UUID, not an FK, to avoid a `teams → forms` import dependency
  (forms already imports teams via `mapping.py`; the reverse FK would risk a cycle). This mirrors
  the deliberate bare-UUID scope columns on `AuditEvent`/`UsageEvent` (`docs/ARCHITECTURE.md` §7.2)
  and keeps the row alive if the response is purged.

### 2.2 `Team` gains `institution` FK

```python
class Team(models.Model):
    ...
    institution = models.ForeignKey(
        Institution, null=True, blank=True,          # nullable in the migration window; see §4
        on_delete=models.PROTECT,                     # an Institution with teams cannot be hard-deleted
        related_name="teams",
    )
    school = models.CharField(max_length=200, blank=True)  # DEPRECATED — see §3.3
    region = models.CharField(max_length=120, blank=True)  # DEPRECATED in favour of Institution.region
    ...
```

- **`on_delete=PROTECT`** matches the platform's "PROTECT where deletion must be blocked"
  convention (`docs/ARCHITECTURE.md` §7.3 — same as `Player.person`, `Tournament.sport`). The app
  prefers soft-delete; removing an institution that still owns teams must go through a service that
  withdraws/reassigns its teams first.
- `institution` is **nullable initially** (the migration can't backfill in `AddField` and stay
  reversible/atomic — see §4). It is tightened to a non-null + per-team org-consistency CHECK in a
  follow-up migration **once backfill is verified**, behind the migrations-blocked-while-live gate
  (`docs/RESTRUCTURING-NOTES.md` §6 operational constraints).
- New convenience constraint (added with the FK, once backfilled):
  `UniqueConstraint(fields=["institution", "name"], condition=Q(deleted_at__isnull=True),
  name="unique_team_name_per_institution")` — so a single institution can't register two teams
  with the same name (e.g. two "U-15 Boys"), which `unique_team_name_per_tournament` would *not*
  catch across different institutions.

### 2.3 `Player` — unchanged structurally

`Player` already reaches its institution transitively (`Player.team.institution`). No FK added to
`Player`: a denormalized `institution` on `Player` would be a third place org/tournament drift
could happen, and there is no query that needs it that `team__institution` can't serve via
`select_related`. (If a hot path later needs it, add it then with the same CHECK discipline.)
This keeps the **Person ↔ Player split (invariant #8)** untouched: `Person` stays platform-global
and org-less; `register_school` still creates the `Person` (de-dup remains a separate follow-up,
`docs/ARCHITECTURE.md` §4.5).

### 2.4 ERD delta (prose, extends `docs/ARCHITECTURE.md` §7.1)

`Organization 1—* Tournament 1—* Institution 1—* Team 1—* Player *—1 Person`. `Team.institution`
is `PROTECT`; `Team.organization`/`Team.tournament` unchanged (`CASCADE`). `Institution.organization`
& `.tournament` are `CASCADE` (ownership edges). All three of `Institution`, `Team`, `Player` carry
`organization_id` that **must equal** `tournament.organization_id` — now DB-enforced (§4.3).

---

## 3. JSONB / config schemas

### 3.1 `Institution.attributes` (free-form, validated only for being a flat dict)

```jsonc
{
  "campus": "north",          // string label; used by keep-apart constraints
  "transport_group": "bus-3", // teams sharing transport scheduled apart
  "established": 1985          // arbitrary metadata; ignored by the engine
}
```
No whitelist (unlike `Tournament.rules`, which is whitelisted): institution attributes are
open-ended labels the constraint authoring UI offers as "keep-apart keys". Validation = "must be a
JSON object of scalar values". Constraints reference them by key (§3.2).

### 3.2 Constraint that consumes the hierarchy (extends `fixtures/services/constraints.py`)

The spec's headline flexible rule — *"same-institution teams cannot meet in the opening round"* and
its generalization *"teams sharing attribute X kept apart until round R"* — adds **one catalog
entry** to `CONSTRAINT_TYPES` (`fixtures/services/constraints.py::CONSTRAINT_TYPES`). This is a
catalog/shape addition only; enforcement lands with the constraint-engine workstream (seam #10),
not here.

```python
{
  "type": "keep_apart_until_round",
  "label": "Keep matching participants apart until a round",
  "hard": True,
  "params_schema": {
    # "institution" → resolved via Team.institution_id;
    # "attribute:<key>" → resolved via Team.institution.attributes[<key>]
    "key": "str",
    "until_round": "int",   # inclusive round number; pairing rejected if both teams share key
  },
},
```

Stored instance on `Tournament.constraints`:
```jsonc
{"type": "keep_apart_until_round", "scope": "all", "hard": true,
 "params": {"key": "institution", "until_round": 1}}
```
The pairing generator (`fixtures/services/generate.py`) reads `Team.institution_id` (already
selected with `select_related("institution")`), so the eventual `validate_schedule` handler can
reject/repair pairings where `home.institution_id == away.institution_id` for `round_no <=
until_round`. No new storage needed — the hierarchy *is* the data the constraint reads.

### 3.3 Deprecation of `Team.school` / `Team.region`

`Team.school` and `Team.region` are **kept as columns** through at least one release for
backward-compat (the standings payload and teams-list API echo `school`; FE reads it). Post-backfill
they become **derived mirrors** written by `register_school` from the Institution, and reads migrate
to `team.institution.name` / `team.institution.region`. They are dropped in a later cleanup migration
once no reader references them (tracked as an open item, §9). Do **not** drop them in the same change
that adds the FK — that would be a coordinated FE/BE break.

---

## 4. Migration path (today's `school=Team` data → Institution → Team)

Four migrations, sequenced so each lands on a stable base. All run under the
migrations-blocked-while-live deploy gate (`docs/RESTRUCTURING-NOTES.md` §6).

### 4.1 `teams/migrations/000X_create_institution.py` (schema only)
- `CreateModel Institution` with the two declarative `UniqueConstraint`s and the two indexes.
- `AddField Team.institution` as **nullable** `FK(Institution, on_delete=PROTECT, related_name="teams")`.
- No data touched. Reversible. Safe to deploy independently.

### 4.2 `teams/migrations/000X_backfill_institutions.py` (`RunPython`, reversible)
Data migration — for each tournament, collapse distinct non-empty `Team.school` strings into
`Institution` rows and point each Team at its row. Teams with empty `school` get a per-team
fallback institution named after the team (so the FK can later be made non-null).

```python
def backfill(apps, schema_editor):
    Team = apps.get_model("teams", "Team")
    Institution = apps.get_model("teams", "Institution")
    from django.db.models import Q
    # Group teams by (tournament, normalized school name).
    teams = Team.objects.filter(deleted_at__isnull=True).select_related("tournament")
    cache = {}  # (tournament_id, name_key) -> institution_id
    for t in teams.iterator():
        raw_name = (t.school or "").strip() or t.name  # fallback: the team's own name
        key = (t.tournament_id, raw_name.lower())
        inst_id = cache.get(key)
        if inst_id is None:
            inst = Institution.objects.create(
                organization_id=t.organization_id,   # CRITICAL: copy the TEAM's org (== tournament org)
                tournament_id=t.tournament_id,
                slug=_unique_slug(Institution, t.tournament_id, raw_name),
                name=raw_name[:200],
                kind="school",
                region=(t.region or "")[:120],
                status="registered",
            )
            inst_id = inst.id
            cache[key] = inst_id
        t.institution_id = inst_id
        t.save(update_fields=["institution"])
```
- **Org-consistency is preserved by construction**: `organization_id` is copied from the Team,
  which already equals `tournament.organization_id` (service discipline held to date). The CHECK
  added in 4.3 then *locks* it.
- `_unique_slug` reuses the same scheme as `registration.py::_unique_team_slug` (slugify + `-2`,
  `-3` suffixing) — extract a shared `_unique_slug(model, tournament_id, name)` helper so
  Institution and Team slugging stay in sync (kills a near-duplicate; `docs/RESTRUCTURING-NOTES.md`
  §3 flags slug-logic duplication generally).
- **Reverse**: set `Team.institution = None` and delete `Institution` rows created here (track via a
  marker or simply delete all institutions whose every team's `school` still matches — simpler:
  reverse just nulls `institution`; institutions are harmless orphans if rolled back, and the
  forward re-run is idempotent because it groups by name).
- **Idempotency / re-run safety**: grouping by `(tournament, name_key)` and checking `cache` makes
  a partial-then-rerun safe within one pass; across runs, guard with
  `Institution.objects.get_or_create` keyed on `(tournament_id, name)` instead of blind `create`.

### 4.3 `teams/migrations/000X_org_consistency_checks.py` (`RunSQL`, the new DB invariant)
Adds the **org-consistency CHECK** the restructuring notes demand (§4 CRITICAL, seam #3). A plain
`CheckConstraint` can't reference another table, so we use a Postgres trigger **or** a composite-FK
approach. Two options, recommend **Option B** (composite FK) where feasible because it is
declarative and the planner enforces it on every write with no trigger maintenance.

**Option A — trigger (works everywhere, matches the audit append-only precedent):**
```sql
CREATE OR REPLACE FUNCTION teams_check_institution_org() RETURNS trigger AS $$
DECLARE trn_org uuid;
BEGIN
  SELECT organization_id INTO trn_org FROM tournaments_tournament WHERE id = NEW.tournament_id;
  IF NEW.organization_id <> trn_org THEN
    RAISE EXCEPTION 'institution.organization_id must equal its tournament.organization_id'
      USING ERRCODE = '23514';   -- check_violation
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER teams_institution_org_consistent
  AFTER INSERT OR UPDATE ON teams_institution
  FOR EACH ROW EXECUTE FUNCTION teams_check_institution_org();
```
Mirror for `teams_team` (and optionally `teams_player`). This follows the exact pattern of
`audit/migrations/0002_audit_append_only.py` (`RunSQL` with `reverse_sql` dropping the trigger +
function). `reverse_sql` must `DROP TRIGGER` + `DROP FUNCTION`.

**Option B — composite FK (preferred; no trigger to maintain):**
Add a `UNIQUE (id, organization_id)` to `tournaments_tournament`, then make the child's
`(tournament_id, organization_id)` a composite FK to it:
```sql
ALTER TABLE tournaments_tournament ADD CONSTRAINT trn_id_org_uniq UNIQUE (id, organization_id);
ALTER TABLE teams_institution
  ADD CONSTRAINT inst_org_matches_trn
  FOREIGN KEY (tournament_id, organization_id)
  REFERENCES tournaments_tournament (id, organization_id);
```
This makes org/tournament drift **structurally impossible** for Institution (and, applied the same
way, for Team/Player). It is the cleaner long-term answer and is what seam #3 envisions
("a DB-level composite FK/CHECK"). Trade-off: requires the extra unique index on Tournament and a
migration on the already-existing `Team` rows — gate behind backfill being clean (4.2 guarantees it).

**Recommendation:** ship Option B for the new `Institution` immediately; retrofit Team/Player with
Option B in the same migration since backfill just verified their org columns are consistent. Keep
Option A documented as the fallback for environments where altering `tournaments_tournament` is
undesirable.

### 4.4 `teams/migrations/000X_finalize_institution_fk.py` (tighten nullability)
Once 4.2 backfill is verified in staging/prod, make `Team.institution` **non-null** and add
`unique_team_name_per_institution`. Separate migration so the non-null flip is a deliberate,
post-verification step (and reversible to nullable if backfill is found wanting).

---

## 5. Services & API — staged registration

`register_school` **stays the sole writer** (seam #8). We extend it keyword-only, with defaults, so
every existing caller and test keeps working unchanged (`docs/RESTRUCTURING-NOTES.md` §6: "keep
params keyword-only with defaults").

### 5.1 `register_school` extension (Stage-2 writer)
```python
def register_school(
    *,
    tournament,
    school_name: str,
    teams: list[dict],
    submitted_by=None,
    channel: str = "self",
    event_id: uuid.UUID | None = None,
    request=None,
    # NEW — all keyword-only with defaults (backward compatible):
    institution=None,            # an already-resolved Institution row, OR
    institution_id=None,         # its UUID (Stage-2 "select your institution"), OR
    institution_kind="school",   # used only when creating from school_name
    institution_attributes=None, # merged onto Institution.attributes on create
) -> list[Team]:
```
Behavior (new logic, additive):
1. **Resolve or create the Institution** *inside the existing atomic block*:
   - If `institution`/`institution_id` given → load it (404/ValueError if not in this tournament).
   - Else → `get_or_create_institution(tournament, name=school_name, kind=institution_kind,
     attributes=institution_attributes)` — `get_or_create` keyed on
     `(tournament, name)` so re-submitting the same school name attaches to the existing row
     (matches `unique_institution_name_per_tournament`). This makes the legacy `school_name`-only
     callers (public link, current forms mapping, every test) **auto-upgrade**: they now create/find
     an Institution and link teams to it, with zero call-site changes.
2. Each created `Team` gets `institution=<resolved>` **and** still gets `school=institution.name`
   written (the deprecated mirror, §3.3) so existing readers don't break.
3. **Idempotency unchanged**: still keyed on `(event_id, "school_registered")`. The replay re-read
   query changes from `filter(school=school_name)` to
   `filter(institution=resolved_institution)` (more precise; falls back to `school=` if no
   institution resolved, for the transition window).
4. **Audit unchanged**: `event_type="school_registered"` string is preserved verbatim
   (tests + audit-history continuity pin it — `docs/RESTRUCTURING-NOTES.md` §6). Add
   `institution_id` to `payload_after` (additive, non-breaking).

New helper, also in `registration.py`, also the sole institution writer:
```python
def get_or_create_institution(*, tournament, name, kind="school",
                              attributes=None, status=InstitutionStatus.REGISTERED,
                              created_by=None, source_response_id=None):
    """Stage-1 writer. Idempotent on (tournament, name). Copies tournament.organization."""
```
This is the **Stage-1 creation path** (direct admin add OR org-registration form mapping). It copies
`tournament.organization` (org-consistency holds; the §4.3 CHECK locks it).

### 5.2 Stage-1: Institution registration (org-registration form / direct entry)
- **Direct admin entry**: `POST /api/tournaments/{id}/institutions/` → `get_or_create_institution`
  (gated by `can_manage_tournament`, 404-before-403 via `accessible_tournaments` — same pattern as
  `teams/views.py::TournamentTeamsListView`).
- **Form-driven**: a `Form` with `purpose="organization_registration"` (already an enum value —
  `forms/constants.py::FormPurpose.ORGANIZATION_REGISTRATION`). Today `map_response` treats it as a
  no-op ("the response IS the record" — `forms/services/mapping.py::map_response`). **Change**: add
  `_map_organization_registration(resp)` that calls `get_or_create_institution` using
  `form.settings["bindings"]` (e.g. `{"institution_name": "school", "kind": "level",
  "contact_email": "email"}`), and stamps `source_response_id=resp.id`. Idempotent via a derived
  uuid5 audit key, exactly like `_map_team_registration` derives one to avoid colliding with the
  submit audit (`forms/services/mapping.py` module note). This keeps the forms engine as the
  registration UI and `get_or_create_institution`/`register_school` as the only domain writers.

### 5.3 Stage-2: Team registration (per institution)
- **The "select your institution" field** (spec §2) is a forms field **bound to live tournament
  data** — its options are this tournament's Stage-1 Institutions. New capability for the forms
  engine: a `data_source` binding `{"type": "institution_list", "tournament": "<self>"}`. The team
  form's `bindings` then map the chosen institution id into `_map_team_registration`, which passes
  `institution_id=` to `register_school` (instead of, or in addition to, `school_name`).
- **Direct admin entry**: `POST /api/tournaments/{id}/institutions/{inst_id}/teams/` (or the
  existing add-team flow with an `institution_id` in the body) → `register_school(institution_id=…)`.
- **Per-respondent scoping** (spec §2): a school's respondent sees/edits only *their* institution's
  teams. Server-side this is just `Team.objects.filter(institution_id=…)`; the share-link can pin
  the institution via `FormShareLink.bound_entity` (`docs/ARCHITECTURE.md` §8 lists
  `FormShareLink.bound_entity`/`prefill` JSONB) — bind a link to one institution so its people only
  touch their teams.

### 5.4 API surface summary
| Verb / path | Stage | Writer | Auth |
|---|---|---|---|
| `POST /api/tournaments/{id}/institutions/` | 1 (direct) | `get_or_create_institution` | `can_manage_tournament` |
| `GET /api/tournaments/{id}/institutions/` | 1 (list / Stage-2 dropdown source) | — | `accessible_tournaments` |
| `PATCH /api/tournaments/{id}/institutions/{iid}/` | 1 (edit; reversible) | service | `can_manage_tournament` |
| `POST /api/tournaments/{id}/institutions/{iid}/teams/` | 2 (direct) | `register_school(institution_id=…)` | `can_manage_tournament` |
| `GET /api/tournaments/{id}/teams/?institution={iid}` | 2 (scoped list) | — | `accessible_tournaments` |
| `POST /api/register/{token}/` (existing) | 2 (public link) | `register_school` (auto get_or_create institution) | AllowAny + throttle |
| form submit → `map_response` (existing path) | 1 & 2 | `get_or_create_institution` / `register_school` | AllowAny (public form) |

All institution routes are **routed from `tournaments/urls.py`** to match the existing cross-app
router convention for teams (`tournaments/urls.py` already imports `TournamentTeamsListView`).
`TournamentTeamsListView` gains an optional `?institution=` filter and returns `institution_id`
+ `institution_name` alongside the deprecated `school`.

---

## 6. Frontend components

Match the established design system (`CLAUDE.md` "Frontend design system": tokens only, no native
`<select>` — use `components/ui/Select.tsx`, full-width pages, `t()` on every string).

- **`api/institutions.ts`** (new, mirrors `api/registration.ts` shape): `list(tournamentId)`,
  `create(tournamentId, {name, kind, region, contact*})`, `update`, `addTeam(instId, payload)`.
  Add `institution_id`/`institution_name` to the team/standings TS types (regenerate via
  `npm --prefix frontend run gen:types` from `schema.yml` — never hand-edit `api.generated.ts`).
- **Stage-1 admin surface** — `features/tournaments/InstitutionsPanel.tsx`: a table (→ stacked cards
  on mobile via `useBreakpoint().isMobile`) of registered institutions with add/edit/withdraw;
  "Create registration form" vs "Add directly" affordance (mirrors the existing onboarding state
  machine on `TournamentDetailPage`). Reversible per spec: editing/withdrawing always available.
- **Stage-2** — extend `RegistrationFormPage.tsx` / the team form wizard: a **`<Select>`-backed
  "Your institution"** dropdown populated from the Stage-1 list (the data-bound field), then the
  team/players sub-form scoped to that institution; on submit posts to the team-registration path
  with `institution_id`.
- **Reuse `RegSubmission`/`RegTeam` types** (`api/registration.ts`) — add optional
  `institution_id?: string` to `RegSubmission` rather than forking a new shape.
- **Standings / brackets**: where `team.school` is rendered, switch to `institution_name` (with
  `school` as fallback during the transition). Single source — feed the server payload; do not add
  client-side derivation (consistent with the standings-single-source restructuring goal,
  `docs/RESTRUCTURING-NOTES.md` §3.1 / Phase 7).

---

## 7. Invariants this design must preserve

Drawn from `docs/RESTRUCTURING-NOTES.md` §6 and `docs/ARCHITECTURE.md` §10. Each row states how the
design honors it.

| # | Invariant | How preserved |
|---|---|---|
| 1 | UUIDv7 PKs via `accounts.models.uuid7`; no auto-increment | `Institution.id = UUIDField(default=uuid7)`. |
| 2 | Multi-tenancy by `Organization`; every tenant row has `organization` FK; **404-not-403** | `Institution`/Team carry `organization`; institution endpoints route through `accessible_tournaments` (404) then `can_manage_tournament` (403), copying `teams/views.py` exactly. |
| — | **NEW org-consistency CHECK** (`child.organization_id == tournament.organization_id`) | Added DB-level for Institution (and retrofit Team/Player) via §4.3 composite-FK/trigger — this design *introduces* the invariant the notes call CRITICAL-missing. |
| 3 | Idempotent writes (client `event_id` + unique constraint; replay returns existing) | `register_school` idempotency on `(event_id,"school_registered")` unchanged; `get_or_create_institution` idempotent on `(tournament, name)`; form mapping keeps its distinct uuid5 audit keys. |
| 8 | **Person ↔ Player split**; `Person` org-less; `PROTECT` on `person`; `unique_person_per_tournament` | Untouched. No FK added to Person/Player; Institution sits *above* Team. |
| seam #8 | `register_school` is the **sole entrant write path**; `teams=[{name,players}]` shape; `(event_id,"school_registered")` idempotency; **new params keyword-only with defaults** | All new params are keyword-only with defaults; existing positional/keyword callers (public view, `map_response`, ~448 tests) work unchanged. Audit `event_type` string preserved verbatim. |
| locked | `Team(status=REGISTERED)` is exactly what the generator selects — do not silently change generation | Institution gets its *own* status enum; the generator keeps selecting `Team.status=REGISTERED`. Institution status does **not** gate team selection (a team under an `invited` institution can still be `registered` and selectable — or, if desired, add an explicit filter as a *coordinated* change, not a silent one). |
| 7.4 | Load-bearing scoped-unique constraints; any model split must carry them | New `unique_institution_slug_per_tournament` + `unique_institution_name_per_tournament` (partial) mirror the Team patterns; existing Team/Player constraints unchanged. |
| 7.3 | `PROTECT` where deletion must be blocked; soft-delete preferred | `Team.institution` is `PROTECT`; `Institution.deleted_at` soft-delete column present. |
| 5 | Append-only audit at DB level; `emit_audit` sole write path; exact `event_type` strings | No new direct `AuditEvent` writes; reuse `emit_audit`; `school_registered` string preserved; new institution events (if any) use additive new `event_type`s, never reusing/renaming existing ones. |
| 6 op | Migrations blocked while any tournament is `live` | All four migrations ship behind the deploy pre-flight; the non-null flip (§4.4) is deliberately a separate, post-verification migration. |
| structural | `register_school` always creates a new `Person` (no de-dup) — *intentional MVP* | Preserved; de-dup remains a separate follow-up (out of scope here). |

---

## 8. Test strategy

Mirror the existing suites (`teams/tests/test_registration*.py`) and the platform's mandatory
isolation + state coverage (`CLAUDE.md`: multi-tenancy isolation tests are not optional).

1. **Model / constraint tests** (`teams/tests/test_institution_model.py`):
   - `unique_institution_name_per_tournament` rejects a duplicate live name; allows reuse after
     soft-delete; allows the same name in a *different* tournament.
   - `Team.institution` `PROTECT`: deleting an institution with teams raises.
   - **Org-consistency CHECK** (the new invariant): inserting an Institution / Team whose
     `organization_id` differs from its `tournament.organization_id` raises (IntegrityError /
     `23514`). This is the test that proves cross-tenant drift is now structurally impossible — the
     single most important new test.
2. **`register_school` backward-compat** (extend `teams/tests/test_registration.py`):
   - Legacy call (`school_name=` only, no institution kwargs) now creates an Institution and links
     teams to it; `team.institution.name == school_name`; `team.school == school_name` (mirror).
   - Second legacy call with the same `school_name` attaches to the **same** Institution
     (get_or_create), does not duplicate.
   - `institution_id=` path links to the given institution and rejects an institution from a
     different tournament.
   - **Idempotency**: replay with the same `event_id` returns the same teams and creates no second
     institution; audit `event_type` is still exactly `"school_registered"`.
3. **Forms mapping** (`forms/tests/`): `organization_registration` response now creates an
   Institution (was a no-op); replay creates no duplicate (distinct uuid5 audit key holds);
   `team_registration` with an institution binding links correctly.
4. **Isolation** (every domain app's pattern): user in org X cannot list/create institutions in
   org Y's tournament → 404 (not 403, no existence leak).
5. **Migration test**: a small fixture with two teams sharing `school="Mount Hermon"` + one team
   with empty school → backfill (4.2) yields one Institution for the shared name + one fallback,
   both teams of the shared name point at the same row, org columns consistent. Run forward then
   reverse to assert reversibility.
6. **Standings / API**: `compute_standings` and `TournamentTeamsListView` return `institution_name`;
   FE consumers read it (vitest on the teams list / standings render).

Keep the **~448 backend + ~193 frontend** baseline green; the additive keyword-only signature plus
the auto-upgrade get_or_create is specifically chosen so no existing test needs editing — only new
tests are added.

---

## 9. Open questions

1. **Cross-tournament institution identity.** Like `Person` vs `Player`, should there be a
   platform-global `InstitutionProfile` (org-less, deduped across tournaments for rollup stats /
   "this school's all-time record") with per-tournament `Institution` rows referencing it? Mirrors
   invariant #8's rationale. Deferred — v1 keeps Institution tournament-scoped, matching Team/Player.
2. **Composite FK vs trigger for org-consistency (§4.3).** Recommend the composite FK (Option B) but
   it requires `UNIQUE (id, organization_id)` on `tournaments_tournament` and a Team/Player retrofit.
   Confirm appetite for altering the Tournament table now vs trigger-only.
3. **Does Institution status gate team selection?** Locked invariant says `Team.status=REGISTERED`
   is what the generator selects. Should a team under a non-`registered` (e.g. `withdrawn`)
   institution be excluded? If yes, it is a *coordinated* generator change, not silent — flag before
   building.
4. **`school`/`region` removal timeline.** When can the deprecated `Team.school`/`Team.region`
   columns be dropped? Needs all readers (standings, teams API, FE, any export) migrated to
   `institution.*` first.
5. **Multi-institution / mixed teams.** Some events have composite/representative teams (e.g.
   "District XI"). Is a Team always owned by exactly one Institution (current FK), or do we need an
   M2M for representative squads? v1 assumes one — confirm against the multi-sport/multi-category
   scope (spec §4.2).
6. **Stage-1 form data-bound field & per-respondent scoping** (spec §2) are *new forms-engine
   capabilities* (`data_source` field + share-link `bound_entity` scoping). Owned by the forms
   workstream, not this model change — but the Institution model is its prerequisite. Confirm
   sequencing.
7. **De-dup of `Person`** remains out of scope (intentional MVP) — note it stays a follow-up so the
   Institution work isn't blocked on it.

---

## 10. Dependencies & sequencing

- **Depends on**: nothing new structurally; builds directly on `teams/models.py`,
  `teams/services/registration.py::register_school`, `forms/services/mapping.py`,
  `tournaments/models.py::Tournament`.
- **Unblocks**: Stage-1/Stage-2 of the target product flow (spec §1); the `keep_apart_until_round`
  constraint that reads `Team.institution_id` (constraint-engine workstream, seam #10); the
  Tournament state-machine workstream (Stage transitions auto-close forms — seam #5) which gates
  Stage-1→Stage-2.
- **Coordinated with**: the org-consistency DB-CHECK seam (#3) — this design *delivers a first
  slice* of it (Institution + retrofit Team/Player) rather than waiting for the broader tenancy
  rework.
