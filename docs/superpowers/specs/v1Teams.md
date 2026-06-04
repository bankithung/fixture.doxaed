# v1 — Teams: Person ↔ Player, Team, Registration, Roster, Eligibility

> **Status:** Draft v1 (design) — 2026-06-04
> **Owner:** graceschooledu@gmail.com
> **App:** `backend/apps/teams/` (Phase 1B)
> **Canonical sources:**
> - PRD `docs/superpowers/specs/2026-04-30-fixture-platform-prd.md` — §5.3 (Person/Team/Player registration), §5.4 (lineup), §5.13 (football params), §8 (data model), §10 (invariants), §7.7 (PII/encryption).
> - `v1Users.md` §7 (Team manager, `TeamMembership` schema sketch lines 1697-1718, two-layer auth invariant lines 1720-1724), §8 (Person/Player deferral + the sport-agnostic commitments table lines 1862-1874).
> - `v1Fixtures.md` §1, §7 (typed match-dependency #9; `Match.home_team`/`away_team` resolve to `teams.Team`).
> **Chassis reused:** `uuid7` (`apps/accounts/models.py:28`), `ScopedManager`/`ScopedQuerySet` (`apps/permissions/scope.py`), `HasModule` (`apps/permissions/permissions.py`), `emit_audit` (`apps/audit/services.py:24`), Fernet `encrypt_secret`/`decrypt_secret` (`apps/accounts/services/_crypto.py`), `OrganizationMembership` (`apps/organizations/models.py:169`), `Sport` (`apps/sports/models.py:62`), module catalog (`apps/permissions/fixtures/modules.json`).

---

## 0. The central tension and how this design resolves it

`v1Users.md §8` **defers the full `Player` schema to the sport module** (positions, jersey rules, GK/captain/eligibility enums are sport-coupled, lines 1842-1890). PRD §5.3 / §8 / §5.13 **do** lock the football-flavoured fields. The reconciliation — consistent with the locked "fully data-driven, ZERO hardcoded rules" decision in `v1Fixtures.md §3` — is:

1. **`apps.teams` ships the sport-AGNOSTIC core**: `Person`, `Team`, `TeamRegistration`, `TeamMembership`, `Player`, `RosterSlot`, `PlayerSuspension`. These exist for **all** sports and carry **no** hardcoded football rule.
2. **Every sport-specific attribute** (jersey number range, position taxonomy, GK semantics, squad sizes, eligibility-freeze stages, suspension calc) lives in a **`roster_schema` blob** contributed by the sport plugin **as data**, exactly like the fixtures constraint DSL. `Player.attributes` is JSONB validated against that schema. Football is the v1 vertical and ships the first `roster_schema`.
3. The PRD's named football fields (`jersey_no`, `position`, `is_goalkeeper`, `captain`) become **first-class indexed columns on `Player`** because PRD §5.3 / §8 lock them and the live-scoring + lineup + advancement engines need them queryable. They are nullable/defaulted so non-football sports that don't use jersey numbers leave them empty. This satisfies PRD §8 line 950 (`Player = org, team, person, jersey_no, position, captain, is_goalkeeper, eligibility_status, deleted_at`) **and** §8's sport-agnostic deferral, by keeping anything genuinely sport-variable (squad sizes, freeze stages, GK-minimums, validation predicates) in data.

> **Net rule:** columns = what the platform engine must index/join on and the PRD already locked; `attributes` JSONB + `roster_schema` = everything a future sport could vary. No `if sport == "football"` anywhere.

`v1Users.md §8` says "the implementation plan should NOT scaffold the Player table from `v1Users.md` alone" — correct: it is scaffolded from **PRD §5.3/§8 + this `v1Teams.md` + the football `roster_schema`**, which is the sport-module work this document is part of.

---

## 1. Person ↔ Player split (invariant #8)

```
Person (platform-scoped human identity, 1 row per real human)
  └─< Player (per-(tournament,team) registration, N rows — one per tournament played)
        └─ Person FK   ← cross-tournament career stats roll up by Person
```

- **`Person`** is **platform-scoped, NOT org-scoped.** A footballer from Kohima may play in tournaments run by three different orgs; they are one `Person`. This is the deliberate exception to invariant #2: `Person` carries **no `organization` FK**. Isolation is enforced at the `Player`/`Team` layer (both org-scoped) — a user can only *see* a `Person` through a `Player` that is in an org they can access (see §7.3).
- **`Player`** is the per-tournament registration. It is org-scoped (`organization` FK, redundant-but-indexed, copied from `team.organization` at create) so it plugs into `ScopedManager`.
- **Career stats** (PRD §8 line 765 "Per-Person stats export"; §5.7 Head-to-Head line 545 "using Person + Team identity") aggregate `MatchEvent` rows (sport module / `apps.matches`) by `player.person_id`. `Person` is the durable join key across tournaments and across orgs.
- **No Player login in v1.0** (`v1Users.md §8.5`): `Player` is passive data. `Person.user` (OneToOne) is reserved for the **v1.5 claim flow**; null in v1.0.
- **Soft-delete** both (`deleted_at`); references retained for audit/stats (PRD decision #32).

### 1.1 Why a Person and not just denormalized names on Player

Without `Person`, "Mhonbeni's career: 3 tournaments, 41 goals" requires fuzzy name-matching across `Player` rows — impossible to do reliably and impossible to migrate to later (invariant #8 rationale: *"makes cross-tournament career stats work without later migrations"*). With `Person`, the TM picks an existing `Person` (typeahead) or creates a new one when adding a player; the platform offers de-dup suggestions (same name + DOB) but **never auto-merges** (merge is an Admin/Super-admin tool, §10 open question).

---

## 2. Models (`backend/apps/teams/models.py`)

All models: `id = UUIDField(primary_key=True, default=uuid7, editable=False)` (#1). All org-scoped models use `ScopedManager.from_queryset(...)` (#2). `created_at`/`updated_at`. Soft-delete via `deleted_at` where noted. Mutations audited via `emit_audit` (#5/#6).

### 2.1 `Person` — platform-scoped identity

```python
class Person(models.Model):
    id            = UUIDField(pk, default=uuid7)
    # Identity (sport-agnostic)
    full_name     = CharField(max_length=200)
    display_name  = CharField(max_length=120, blank=True)   # "M. Kikon" for public surfaces
    # DOB: PII, field-level encrypted (PRD §7.7 line 910 "Fernet on Person.dob")
    dob_encrypted = CharField(max_length=255, blank=True)   # "fernet$..." via _crypto
    dob_year      = PositiveSmallIntegerField(null=True, blank=True)  # coarse, UNencrypted, for age-band queries
    photo         = ImageField(upload_to="persons/", null=True, blank=True)  # ≤2MB, MIME-sniffed
    gender        = CharField(max_length=16, blank=True)    # free-form; sport-coupled categories live in roster_schema
    # v1.5 claim flow reservation (v1Users.md §8.2 / §8.5): single OneToOne, NO join table
    user          = OneToOneField(User, null=True, blank=True, on_delete=SET_NULL, related_name="person")
    # de-dup support — NOT a unique key (homonyms are real)
    external_ref  = CharField(max_length=120, blank=True)   # school roll no / govt id hash, optional
    created_by    = FK(User, null=True, on_delete=SET_NULL)
    deleted_at    = DateTimeField(null=True, db_index=True)
    created_at / updated_at

    objects        = PersonManager()          # plain manager (NOT ScopedManager — platform-scoped)
    active_objects = ActivePersonManager()    # filters deleted_at__isnull=True
```

**DOB handling:** plaintext DOB never persisted. `Person.set_dob(date)` encrypts to `dob_encrypted` and stores `date.year` into `dob_year` (used for `eligibility` age-band filters without decrypting). `Person.get_dob()` decrypts (gated — see §7.3). Reuses `apps/accounts/services/_crypto.py` exactly (no new crypto). PII annotation registry updated (PRD §7.7 line 911).

**No `organization` FK** — see §1. Indexes: `(full_name)` (typeahead), `(dob_year)`, `(user)`.

### 2.2 `Team` — org-scoped, per-tournament entrant

PRD §5.3 line 341 fields + §8 line 947. **A `Team` belongs to exactly one `Tournament`** (the PRD/`v1Fixtures` model is per-tournament entrants; cross-tournament "team library" reuse is explicitly v1.5, PRD line 253). `tournament` FK is to `apps.tournaments.Tournament` (Phase 1B, sibling).

```python
class Team(models.Model):
    id            = UUIDField(pk, default=uuid7)
    organization  = FK(Organization, on_delete=CASCADE, related_name="teams")   # #2
    tournament    = FK("tournaments.Tournament", on_delete=CASCADE, related_name="teams")
    slug          = SlugField(max_length=80)                # unique per tournament (public URL pair w/ UUID, #1)
    name          = CharField(max_length=200)
    short_name    = CharField(max_length=40, blank=True)    # scoreboard abbr e.g. "BYV"
    crest         = ImageField(upload_to="crests/", null=True, blank=True)   # ≤2MB PNG/JPG/SVG, MIME-sniffed
    primary_color = CharField(max_length=7, blank=True)     # "#RRGGBB"
    secondary_color = CharField(max_length=7, blank=True)
    school        = CharField(max_length=200, blank=True)
    region        = CharField(max_length=120, blank=True)   # district
    pool          = CharField(max_length=80, blank=True)    # group/category — ONE per team per tournament (PRD line 344)
    tags          = JSONField(default=list, blank=True)     # free-form
    time_zone     = CharField(max_length=64, blank=True)    # default = tournament TZ (#14)
    status        = CharField(choices=TeamStatus, default=DRAFT, db_index=True)   # §3.1
    # invariant #10: auto-gen artifacts track manual edits (e.g. seed assignment)
    seed          = PositiveSmallIntegerField(null=True, blank=True)
    last_manual_edit_at = DateTimeField(null=True, blank=True)
    withdrawn_at  = DateTimeField(null=True, blank=True)
    withdrawn_reason = TextField(blank=True)
    disqualified_at = DateTimeField(null=True, blank=True)
    disqualified_reason = TextField(blank=True)
    created_by    = FK(User, null=True, on_delete=SET_NULL)
    deleted_at    = DateTimeField(null=True, db_index=True)
    created_at / updated_at

    objects        = ScopedManager.from_queryset(TeamQuerySet)()
    active_objects  # deleted_at__isnull=True

    class Meta:
        constraints = [
            UniqueConstraint(fields=["tournament", "slug"], name="unique_team_slug_per_tournament"),
            UniqueConstraint(fields=["tournament", "name"], condition=Q(deleted_at__isnull=True),
                             name="unique_team_name_per_tournament"),
        ]
```

### 2.3 `TeamRegistration` — the registration/approval state record

PRD §5.3 (team registration + approval flow) and `v1Users.md §7.3/§7.9`. Separated from `Team` so the *registration submission* (who, when, approval audit, late-reg override) is a first-class auditable record distinct from the team identity. Idempotent on `event_id` (#3).

```python
class TeamRegistration(models.Model):
    id            = UUIDField(pk, default=uuid7)
    organization  = FK(Organization)                       # #2
    tournament    = FK("tournaments.Tournament")
    team          = OneToOneField(Team, on_delete=CASCADE, related_name="registration")
    event_id      = UUIDField(unique=True)                 # #3 idempotent submit
    submitted_by  = FK(User, null=True, on_delete=SET_NULL)
    channel       = CharField(choices=[("invite","Invite"),("self","Self-register")])
    status        = CharField(choices=RegistrationStatus, default=PENDING, db_index=True)   # §3.2
    is_late       = BooleanField(default=False)            # Admin override after window (PRD line 343)
    reviewed_by   = FK(User, null=True, on_delete=SET_NULL)
    reviewed_at   = DateTimeField(null=True)
    review_reason = TextField(blank=True)                  # required ≥20 chars on reject (service layer)
    submitted_at  = DateTimeField(auto_now_add=True)
    objects = ScopedManager.from_queryset(...)()
```

### 2.4 `TeamMembership` — the Team-manager scope row (locked in `v1Users.md §7.7`)

Implemented verbatim from `v1Users.md §7.7` lines 1697-1718, with the locked **two-layer auth invariant** (§7.7 lines 1720-1724).

```python
class TeamMembership(models.Model):
    id          = UUIDField(pk, default=uuid7)
    organization = FK(Organization)            # #2; = team.organization
    team        = FK(Team, on_delete=CASCADE, related_name="memberships")
    user        = FK(User, on_delete=CASCADE, related_name="team_memberships")
    role        = CharField(choices=[("team_manager","Team manager")], default="team_manager")  # only role at this scope v1.0
    status      = CharField(choices=TeamMembershipStatus)   # §3.3 — superset of PRD §3.3
    invited_by  = FK(User, null=True, on_delete=SET_NULL)
    invited_at  = DateTimeField(null=True)
    accepted_at = DateTimeField(null=True)
    revoked_at  = DateTimeField(null=True)
    created_at

    class Meta:
        constraints = [
            UniqueConstraint(fields=["user","team","role"], condition=Q(status="active"),
                             name="unique_active_team_role"),   # v1Users.md §7.7
        ]
```

**Authorization invariant (locked, `v1Users.md §7.7`):** to act as TM on Team T a user needs BOTH an active `OrganizationMembership(role='team_manager')` in `T.organization` AND an active `TeamMembership(user, team=T)`. Encoded as a helper `is_team_manager_of(user, team) -> bool` in `apps/teams/services/authz.py`, used by the `IsTeamManagerOfObject` DRF permission (§5.4).

### 2.5 `Player` — per-tournament registration (sport-agnostic core + football columns + `attributes`)

```python
class Player(models.Model):
    id              = UUIDField(pk, default=uuid7)
    organization    = FK(Organization)                     # #2; copied from team
    tournament      = FK("tournaments.Tournament")
    team            = FK(Team, on_delete=CASCADE, related_name="players")
    person          = FK(Person, on_delete=PROTECT, related_name="players")   # PROTECT: never orphan stats
    # --- PRD §5.3/§8-locked columns (football vertical; nullable for other sports) ---
    jersey_no       = PositiveSmallIntegerField(null=True, blank=True)
    position        = CharField(max_length=16, blank=True)  # value from sport roster_schema.positions
    captain         = BooleanField(default=False)
    is_goalkeeper   = BooleanField(default=False)
    # --- sport-agnostic lifecycle ---
    eligibility_status = CharField(choices=EligibilityStatus, default=ELIGIBLE, db_index=True)  # §3.4
    # --- everything sport-variable lives here, validated vs roster_schema (DATA, not code) ---
    attributes      = JSONField(default=dict, blank=True)   # e.g. {"weight_class":"u60"} for combat sports
    added_by        = FK(User, null=True, on_delete=SET_NULL)
    deleted_at      = DateTimeField(null=True, db_index=True)
    created_at / updated_at

    objects = ScopedManager.from_queryset(PlayerQuerySet)()

    class Meta:
        constraints = [
            # PRD §5.3 line 349: jersey unique within team for the tournament
            UniqueConstraint(fields=["team","jersey_no"], condition=Q(deleted_at__isnull=True, jersey_no__isnull=False),
                             name="unique_jersey_per_team"),
            # PRD §5.3 line 352 / v1Users.md §8.2: a Person cannot be on two Teams in the same tournament
            UniqueConstraint(fields=["tournament","person"], condition=Q(deleted_at__isnull=True),
                             name="unique_person_per_tournament"),
            # at most one captain per team (active)
            UniqueConstraint(fields=["team"], condition=Q(captain=True, deleted_at__isnull=True),
                             name="unique_captain_per_team"),
        ]
```

> **`unique_person_per_tournament`** is the hard DB constraint mandated by both PRD §5.3 line 352 and `v1Users.md §8.2` ("A Person cannot be on two Teams in the same tournament — DB constraint"). The service layer surfaces a friendly error before hitting the constraint.

### 2.6 `RosterSnapshot` — frozen squad at lineup/eligibility-freeze time (invariant #7, #10)

PRD §5.3 line 354 ("previous matches retain their snapshot") + §5.4 lineup validation needs a stable "registered squad" reference. Rather than version every `Player` edit, we snapshot the roster when eligibility freezes (and lineups snapshot the relevant players, owned by `apps.matches`). `inputs_hash` per #10.

```python
class RosterSnapshot(models.Model):
    id           = UUIDField(pk, default=uuid7)
    organization = FK(Organization)
    team         = FK(Team, related_name="roster_snapshots")
    reason       = CharField(choices=[("eligibility_freeze","Freeze"),("manual","Manual")])
    inputs_hash  = CharField(max_length=64)                 # #10 sha256 over player set
    players      = JSONField()                              # [{player_id, person_id, jersey_no, position, ...}]
    frozen_at    = DateTimeField(auto_now_add=True)
    frozen_by    = FK(User, null=True, on_delete=SET_NULL)
```

### 2.7 `PlayerSuspension` — sport-agnostic shell (calc deferred per `v1Users.md §8.3`)

PRD §8 line 956 / §5.10 line 522. The **suspension calculation** (cards→suspension) is football-specific and fired by the sport module's match-event hook (`apps.matches`), but the **suspension record + the lineup hard-block** (PRD §5.4 line 385, §5.10 line 523) are sport-agnostic and belong here so the eligibility query is uniform.

```python
class PlayerSuspension(models.Model):
    id              = UUIDField(pk, default=uuid7)
    organization    = FK(Organization)
    tournament      = FK("tournaments.Tournament")
    player          = FK(Player, on_delete=CASCADE, related_name="suspensions")
    person          = FK(Person, on_delete=PROTECT)        # so it can carry across tournaments if a sport wants
    reason          = CharField(max_length=200)            # "2nd yellow card", "red card"
    applies_to_match = FK("matches.Match", null=True, on_delete=SET_NULL)  # null = next match (resolved at fixture)
    source_event_id  = UUIDField(null=True)                # MatchEvent that triggered it (#4 DB-first)
    matches_remaining = PositiveSmallIntegerField(default=1)
    status          = CharField(choices=SuspensionStatus, default=ACTIVE, db_index=True)  # active/served/voided
    created_at
```

---

## 3. State machines & enums (invariant #6 — explicit, audited transitions)

### 3.1 `TeamStatus`
`draft → registered → bracket_locked` (informational) and side states. Aligns to PRD §5.3 withdrawal/DQ and `v1Users.md §7.9`.

| value | meaning |
|---|---|
| `draft` | created, registration not yet submitted/approved |
| `pending_approval` | self-registered, awaiting Admin (when `team_registration_requires_approval=true`) |
| `registered` | accepted, on the entrant list |
| `rejected` | registration rejected |
| `withdrawn` | TM withdrew (PRD §5.3 walkover rules apply post-lock) |
| `disqualified` | Admin DQ (PRD §5.3 line 365) |
| `orphaned` | all TMs left (`v1Users.md §7.12` recommendation — surfaces in Admin's registration module) |

Transitions (trigger / preconditions / actor / audit) — each row emits `emit_audit`:

| from → to | trigger | actor | preconditions | notifies |
|---|---|---|---|---|
| `draft → pending_approval` | self-register submit, approval required | TM (self) | tournament `registration_open`; window open | Admins, GameCoord (`team_registered`) |
| `draft → registered` | invite-accept OR self-register no-approval OR Admin add | TM/Admin/Coord | window open OR Admin late-override | TM (`team_invited`/`team_approved`) |
| `pending_approval → registered` | approve | Admin/Co-org/GameCoord(scoped) | — | TM (`team_approved`) |
| `pending_approval → rejected` | reject + reason(≥20) | Admin/Co-org/GameCoord | reason present | TM (`team_rejected`) |
| `registered → withdrawn` | TM withdraw (pw re-prompt + reason) OR pre-lock removal | TM/Admin | reason present | opponent TMs, Admin |
| `registered → disqualified` | Admin DQ + reason | Admin only | reason present | TM, opponents |
| `* → orphaned` | last active TM leaves | system | no active TM | Admins |

**Bracket-impact** (PRD §5.3 lines 363-369): withdrawal/DQ **post-bracket-lock** fires the `apps.fixtures`/`apps.matches` advancement hook (`transaction.on_commit`, #4/#9) → opponent walkover; pre-lock = clean removal. `apps.teams` calls a published domain hook `on_team_left_tournament(team, mode)`; it does **not** import bracket logic (clean app boundary).

### 3.2 `RegistrationStatus`
`pending → approved | rejected | withdrawn`. Mirrors §3.1 but on the registration record (the audit trail of the submission).

### 3.3 `TeamMembershipStatus` (verbatim `v1Users.md §7.7`)
`invited`, `pending_email_verification`, `pending_approval`, `active`, `suspended`, `revoked`, `left`. Transitions per `v1Users.md §7.9` (approval flow, withdrawal, DQ auto-revoke, sole-TM-leave block).

### 3.4 `EligibilityStatus`
`eligible` (default), `ineligible` (failed an eligibility rule), `suspended` (has active `PlayerSuspension`), `pending` (registration not yet approved). The **definition of what makes a player ineligible** is sport-data (`roster_schema.eligibility`), not code (`v1Users.md §8.3`).

### 3.5 Eligibility freeze (invariant #7)
Tournament field `eligibility_freeze_round` (PRD §5.13 line 638: `no_freeze / after_registration / after_group_stage / after_round_of_16 / custom`). When the freeze point is reached:
- a `RosterSnapshot(reason="eligibility_freeze")` is written per team;
- subsequent roster edits are **blocked** except Admin override (reason + audit, PRD §5.3 line 359);
- service `roster_is_frozen(team) -> bool` consulted by every roster-mutation verb.
Freeze evaluation is driven by tournament/match state (sibling apps) via a domain hook; `apps.teams` exposes `freeze_roster(team)` and never reads bracket internals.

---

## 4. The sport `roster_schema` (data-driven, ZERO hardcoded rules)

Each sport plugin contributes a `roster_schema` blob (stored on the sport row / per-tournament override), mirroring `v1Fixtures.md §6`. It declares — **as data** — what `apps.teams` validators enforce generically:

```jsonc
// football roster_schema (the v1 vertical) — DATA, shipped by apps.sports.football
{
  "positions": ["GK","CB","LB","RB","DM","CM","AM","LW","RW","ST","CF"],   // PRD §5.13 line 652
  "jersey": { "min": 1, "max": 99, "unique_scope": "team", "required": true },
  "squad": { "min": 11, "max": 25, "field_per_team": 11 },                 // PRD §5.13 635-637,627
  "goalkeeper": { "flag_field": "is_goalkeeper", "min_in_squad": 1 },      // PRD §5.13 line 637
  "captain": { "required": true, "max_per_team": 1 },
  "eligibility": [
    // generic predicate vocabulary (same family as fixtures DSL): age bands etc.
    { "code": "age_max", "field": "dob_year", "op": ">=", "value_from": "tournament.min_birth_year",
      "fail_status": "ineligible" }
  ],
  "freeze_stages": ["no_freeze","after_registration","after_group_stage","after_round_of_16","custom"]
}
```

One **generic roster validator** (`apps/teams/services/validation.py`) interprets any `roster_schema` → no per-sport branch, no `if sport=="football"`. Adding cricket = a new JSON blob, no code/deploy (matches the locked fixtures philosophy). The PRD's football squad rules (≥1 GK starter, ≥1 GK bench, jersey unique, captain in starters — §5.4 lines 383-389) are expressed as `roster_schema` + lineup-validation predicates consumed by `apps.matches`' lineup submit; `apps.teams` owns roster-time validation (squad size, jersey uniqueness, GK-min-in-squad, captain count).

---

## 5. API (DRF, session auth #15, idempotent #3, module-gated #12, org-scoped #2)

Base: `/api/`. All write endpoints accept `event_id` (UUID) and return existing row (200) on resubmit (#3). All list/detail use `ScopedManager.scoped_for_user(request.user)` then `.module_gated(...)`; cross-org leak test mandatory per endpoint (#2). Permission classes compose `IsAuthenticated` + `HasModule(...)` (`apps/permissions/permissions.py`) + object-level `IsTeamManagerOfObject`.

### 5.1 Teams & registration (module-gated)
| Method · path | module (#12) | role intent | notes |
|---|---|---|---|
| `GET /api/tournaments/{t}/teams/` | `org.tournament_list`/public | all | public surface filters to `registered`; admin overlay via `tournament.team_registration` |
| `POST /api/tournaments/{t}/teams/` | `tournament.team_registration` | Admin/Co-org/GameCoord(scoped) / TM(self, open-reg) | idempotent; channel=invite\|self; window check |
| `GET /api/teams/{id}/` | scoped | all (registered → public) | |
| `PATCH /api/teams/{id}/` | `tournament.team_registration` or own-team TM | TM edits own team profile; sets `last_manual_edit_at` (#10) | |
| `POST /api/teams/{id}/approve/` | `tournament.team_registration` | Admin/Co-org/GameCoord(scoped) | status→registered; audit |
| `POST /api/teams/{id}/reject/` | `tournament.team_registration` | same | reason≥20; status→rejected; audit |
| `POST /api/teams/{id}/withdraw/` | own-team TM (or Admin) | TM | **password re-prompt** + reason; fires advancement hook if post-lock |
| `POST /api/teams/{id}/disqualify/` | `tournament.editor` (Admin) | Admin only | reason; cascade per `dq_stats_policy` |

### 5.2 Roster / players (`tournament.player_roster`, 🔵 own-team for TM)
| Method · path | module | notes |
|---|---|---|
| `GET /api/teams/{id}/players/` | `tournament.player_roster` (own team for TM) | DOB redacted unless requester may view (§7.3) |
| `POST /api/teams/{id}/players/` | `tournament.player_roster` (own team) | idempotent; body picks/creates Person; validates vs `roster_schema`; blocked if `roster_is_frozen` |
| `PATCH /api/players/{id}/` | own-team TM / Admin | jersey/captain/position/GK edits; audit each (PRD §5.3 354) |
| `DELETE /api/players/{id}/` | own-team TM / Admin | soft-delete; blocked if frozen (Admin override) |
| `POST /api/teams/{id}/players/{pid}/set-captain/` | own-team TM | enforces unique captain |

### 5.3 Person (typeahead + de-dup, platform-scoped read is access-mediated)
| Method · path | notes |
|---|---|
| `GET /api/persons/?q=` | typeahead for roster add; returns only Persons the requester can see via an accessible Player, OR Persons they created; de-dup suggestions (name+dob_year) |
| `POST /api/persons/` | create new Person (auto when TM adds a brand-new player); `set_dob` encrypts |
| `GET /api/persons/{id}/career/` | cross-tournament stats roll-up (joins MatchEvent by person; sport module supplies aggregates) |

### 5.4 Team-manager auth helper
- `IsTeamManagerOfObject(BasePermission)` → calls `is_team_manager_of(request.user, obj.team)` (the two-layer invariant). Used for own-team write endpoints. Superuser bypass mirrors `HasModule`.

### 5.5 Serializers
- `TeamSerializer` (public) vs `TeamAdminSerializer` (adds registration/audit overlay).
- `PlayerSerializer` redacts `dob` → `age_band` derived from `dob_year` unless requester passes the DOB-view gate (§7.3), then `PlayerPIISerializer` exposes decrypted DOB.
- `PersonSerializer` never exposes DOB by default.

---

## 6. Frontend (React 18 + TS + Vite; shadcn/ui + lucide + framer-motion; TanStack Query; #13 i18n/a11y)

Feature folder `frontend/src/features/teams/`. All strings via `t()` (#13); WCAG 2.1 AA. TanStack Query hooks in `frontend/src/api/teams.ts` over the DRF client (cookies + CSRF header, #15). Optimistic updates carry a client `event_id` (#3).

### 6.1 Routes / pages
| Route | Page | Primary role |
|---|---|---|
| `/t/:tslug/teams` | **Entrant list** — cards (crest, name, school, status badge) | public/all |
| `/t/:tslug/register` | **Team registration form** — name/short/crest/color/school/region/pool; self-reg account fields if anon | TM (self) |
| `/teams/:slug-:id` | **Team page** — header, roster table, fixtures, standings row highlighted | all (own team = full detail) |
| `/teams/:slug-:id/roster` | **Roster Manager** — table + add/edit player drawer; jersey/position/captain/GK; freeze banner | TM (own) |
| `/teams/:slug-:id/settings` | **Team settings** — profile edit, withdraw (pw re-prompt modal) | TM (own) |
| `/t/:tslug/admin/registrations` | **Registration review queue** — approve/reject with reason | Admin/Co-org/GameCoord |
| `/teams/dashboard` | **TM dashboard** — assigned teams, upcoming matches, suspensions (`v1Users.md §7.5`) | TM |

### 6.2 Key components
- `<RosterTable>` (sortable; jersey, name, position, GK/captain badges; eligibility/suspension chips).
- `<PlayerDrawer>` — add/edit; **Person typeahead** (search existing → de-dup suggestion card → "create new"); jersey/position/GK/captain; DOB picker (gated visibility); validates against `roster_schema` (form schema auto-built from the blob → no hardcoded football form).
- `<RegistrationForm>` (react-hook-form + zod; zod schema derived partly from `roster_schema`).
- `<RegistrationReviewQueue>` (approve/reject; reason textarea ≥20).
- `<FreezeBanner>` (invariant #10/#7: "Roster frozen on {date}. Admin override required to edit.").
- `<WithdrawTeamModal>` (password re-prompt + reason; warns of walkover if post-lock).
- `<ConflictWarning>` reused at TM/scorer assignment (the soft-warning from `v1Users.md §7.12`).
- DOB rendered as **age band** by default; "Reveal DOB" action (own-team TM only) hits the PII endpoint and audits the read.

---

## 7. Multi-tenancy, RBAC, PII (invariants #2, #5, #12, #7.7)

### 7.1 Org isolation (#2)
`Team`, `TeamRegistration`, `TeamMembership`, `Player`, `PlayerSuspension`, `RosterSnapshot` all carry `organization` and use `ScopedManager`. **Mandatory isolation test per endpoint**: user A (Org X) cannot read/write Org Y teams/players via DRF (and later SSE/WS). `Person` is platform-scoped (§1) — its isolation is *access-mediated*: §5.3 `GET /api/persons/` returns only Persons reachable through a Player in an accessible org, or created-by-self. A dedicated test asserts a Person solely in Org Y is invisible to an Org-X user with no shared Player.

### 7.2 RBAC (#12 — module + verb, default-deny)
- Module layer: endpoints gated by `tournament.team_registration` / `tournament.player_roster` / `tournament.lineup_manager` / `match.center_admin_view` (codes already in `apps/permissions/fixtures/modules.json`).
- Verb layer (PRD §3.2 parametrized test): "Register team", "Approve team registration", "Submit lineup", "View opposing lineup pre-kickoff" (TM=❌), "View own player DOB" (TM=✅). The two-layer TM auth invariant (§2.4) is the object-level gate beyond the module.
- TM 🔵-own-team scoping enforced by `IsTeamManagerOfObject`; a TM cannot list/read another team's roster (`v1Users.md §7.10`).

### 7.3 PII / DOB (#7.7)
- `Person.dob` Fernet-encrypted at rest via `_crypto` (no new crypto). `dob_year` kept coarse + unencrypted for age-band eligibility (avoids decrypt-on-filter).
- DOB visible only to: the player's own-team TM (PRD §3.2 "View own player DOB"=✅ TM), Admin/Co-org, Super-admin. Every DOB **read** emits an `emit_audit` event (`person.dob_viewed`) — surfaced in audit log.
- Photos/crests MIME-sniffed, ≤2 MB (PRD §5.3).

### 7.4 Audit (#5/#6)
Every team/registration/roster/suspension mutation calls `emit_audit` (`apps/audit/services.py`) with `organization_id`, `tournament_id`, before/after payload, reason. Append-only at DB role level (existing audit migration). Reject/withdraw/DQ require reason ≥20 chars (service layer), mirroring grants pattern.

---

## 8. Migrations & build order

`apps.teams` depends on `accounts`, `organizations`, `permissions`, `audit`, `sports` (all built) and `tournaments` + `matches` (Phase 1B siblings). Order:

1. **`0001_initial`** — `Person`, `Team`, `TeamRegistration`, `TeamMembership` (no `matches` FK yet). `Team.tournament` FK requires `apps.tournaments` migrated first → build `tournaments` 0001 before this (or use a string FK + dependency).
2. **`0002_player_roster`** — `Player`, `RosterSnapshot`, all `Player` constraints (jersey-unique, person-per-tournament, captain-unique).
3. **`0003_suspensions`** — `PlayerSuspension` (adds `matches.Match` FK → depends on `apps.matches` 0001).
4. **`0004_indexes_and_pii`** — composite indexes (`team,status`, `tournament,eligibility_status`, `person full_name`), register `Person.dob` in the PII annotation registry.
5. Data: football `roster_schema` shipped by `apps.sports.football` fixture (loaded with that plugin), not a teams migration.

> **Migration-during-live guard** (PRD §5): the deploy pre-flight already blocks migrations while any tournament is `live` — teams migrations inherit that.

**Implementation sequencing (TDD, tests-first per CLAUDE.md):**
A. Models + migrations 0001–0002 + factories.
B. Person↔Player + constraints tests (jersey, person-per-tournament, captain) — **write first**.
C. Registration/approval service + state machine + audit + idempotency.
D. Two-layer TM authz helper + `IsTeamManagerOfObject` + module gating.
E. Generic `roster_schema` validator + football blob.
F. DRF endpoints + serializers (PII redaction) + cross-org isolation tests per endpoint.
G. Eligibility freeze + `RosterSnapshot` + suspension lineup-block shell.
H. Frontend feature folder (routes, hooks, components) + vitest + Playwright happy-path.

---

## 9. Tests to write (`backend/apps/teams/tests/`)

Following existing conventions (`pytest`, `factories.py`, `conftest.py` per app):
- **Model constraints:** `test_unique_jersey_per_team`, `test_person_cannot_be_on_two_teams_in_tournament` (the #8 hard constraint), `test_unique_captain_per_team`, `test_team_slug_unique_per_tournament`.
- **Person↔Player:** `test_one_person_many_players_across_tournaments`, `test_career_rollup_joins_by_person`, `test_person_is_not_org_scoped`, `test_soft_delete_retains_player_for_stats`.
- **Registration state machine:** every transition + every blocked transition (#6) — self-reg approval, invite-accept, reject-requires-reason, late-reg-admin-only, withdraw pre/post-lock, DQ admin-only, orphaned-on-last-TM-leave.
- **Two-layer TM auth:** `test_tm_needs_both_org_and_team_membership`, `test_tm_cannot_manage_other_team`, `test_sole_tm_leave_blocked`.
- **Multi-tenancy isolation (mandatory, per endpoint #2):** `test_org_x_user_cannot_read_org_y_team`, `..._roster`, `..._registration`, `test_person_only_in_org_y_invisible`.
- **Module RBAC (#12):** parametrize over `tournament.team_registration` / `tournament.player_roster` grants & denies (extend `test_module_matrix.py` pattern).
- **PII (#7.7):** `test_dob_encrypted_at_rest`, `test_dob_hidden_from_non_owning_tm`, `test_dob_read_is_audited`, `test_age_band_uses_dob_year_without_decrypt`.
- **roster_schema validator:** `test_jersey_range_from_schema`, `test_squad_min_max_from_schema`, `test_gk_minimum_from_schema`, `test_adding_sport_needs_no_code` (new blob → validator passes, no branch).
- **Eligibility freeze (#7/#10):** `test_roster_locked_after_freeze`, `test_admin_override_after_freeze_audited`, `test_roster_snapshot_inputs_hash`.
- **Idempotency (#3):** `test_duplicate_registration_event_id_returns_existing`, `test_duplicate_add_player_event_id`.
- **Frontend (vitest):** RosterTable render, PlayerDrawer Person typeahead + de-dup, RegistrationForm zod, FreezeBanner gating. **Playwright:** self-register → approve → add roster → withdraw happy path.

---

## 10. Open questions (deferred, non-blocking)

- **Person merge tool** (homonym/duplicate cleanup) — Admin/Super-admin only; needs stat-reconciliation. Defer to v1.5 (`apps.sadmin`).
- **Player claim flow** (`Person.user` OneToOne wiring + UI) — v1.5 per `v1Users.md §8.5` / PRD §238.
- **Cross-tournament team library** (reuse a Team across tournaments) — v1.5 per PRD line 253; v1.0 `Team` is per-tournament.
- **`PlayerSuspension` carry-across-stages vs across-tournaments** — PRD `suspension_carries_across_stages` covers stages; cross-tournament carry is a future per-sport policy.
- **DOB encryption key management** — currently SECRET_KEY-derived Fernet (inherited from `_crypto`); KMS-backed hardening tracked in `v1Users.md B.21`.
- **Auto-team-deletion vs `orphaned`** on last-TM-leave — design adopts `orphaned` (the `v1Users.md §7.12` recommendation).
