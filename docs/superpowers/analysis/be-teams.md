# Backend Subsystem Analysis — `apps/teams` (Person / Player / Registration)

> Scope: `backend/apps/teams/` — models, services, views, urls, serializers, throttling, migrations, tests.
> Read against `docs/superpowers/specs/v1Teams.md` (the design intent) and CLAUDE.md invariants.
> Date: 2026-06-08. Ground-truth read of the **actually-built** code, not the spec aspiration.

## 1. Purpose

`apps.teams` owns the **entrant layer** of the platform: the humans (`Person`), their per-tournament
registrations (`Player`), the entrant unit (`Team`), and the **public self-registration channel**
(`RegistrationLink` + the unauthenticated `/api/register/{token}/` endpoint). It is the source of the
entrant set that `apps.fixtures` seeds matches from and that `apps.matches` builds lineups against.
The implemented surface is a **deliberate MVP** of the much larger `v1Teams.md` design (see §8): it ships
the sport-agnostic core needed to register schools and feed the fixture generator, and defers almost
everything else (TeamMembership/team-manager authz, roster schema validation, eligibility, suspensions,
PII/DOB encryption, the full registration-approval state machine, per-team/per-player REST CRUD).

## 2. File-by-file roles

- `models.py` — Four models + one enum: `TeamStatus` (TextChoices), `Person`, `Team`, `Player`,
  `RegistrationLink`. All PKs are `uuid7` (invariant #1). `Person` is the only model with **no
  `organization` FK** (deliberate exception to invariant #2, per invariant #8).
- `services/registration.py` — The domain heart. `create_registration_link`, `resolve_registration_link`,
  `register_school` (the atomic, idempotent team+player creation service), plus slug helpers
  (`_slugify`, `_unique_team_slug`) and token hashing (`_hash_token`).
- `views.py` — Three DRF `GenericAPIView`s: `RegistrationLinkCreateView` (organizer mints a link),
  `PublicRegistrationView` (AllowAny GET/POST self-register), `TournamentTeamsListView` (authenticated
  entrant list). All hand-roll their JSON responses (no ModelSerializer for output).
- `serializers.py` — Input-only `Serializer`s for the public registration payload:
  `PlayerInSerializer`, `TeamInSerializer`, `SchoolRegistrationSerializer` (with `validate_teams`).
- `urls.py` — Mounts only `PublicRegistrationView` at `register/<str:token>/`. The other two views are
  routed **from `apps.tournaments.urls`** (see §6/§7 coupling).
- `throttling.py` — `RegistrationRateThrottle` (scope `school_registration`, POST-only, per-IP).
- `apps.py` — `TeamsConfig` (label `teams`).
- `migrations/` — `0001_initial` (Person/Team/Player + all constraints/indexes), `0002_registrationlink`,
  `0003_registrationlink_expires_at_and_more` (adds `expires_at`, `max_submissions`, `submission_count`).
- `tests/` — `test_registration.py` (service: create/jersey-unique/idempotent), `test_registration_link.py`
  (mint + public GET/POST + 404 + non-manager), `test_registration_link_limits.py` (expiry + usage cap),
  `test_registration_throttle.py` (429 on rate limit).
- `services/__init__.py`, `__init__.py` — empty package markers.

## 3. Data model

**`Person`** (`teams_person`) — platform-scoped human identity (invariant #8). Fields: `id (uuid7)`,
`full_name`, `display_name`, `dob_year` (PositiveSmallInt; coarse, **plaintext** — full Fernet-encrypted
DOB from spec §2.1 is NOT built), `created_by → User (SET_NULL)`, `deleted_at` (soft-delete column exists
but is never written by any code path), `created_at`/`updated_at`. Index: `person_full_name_idx` on
`full_name`. **No org FK, no manager, no `set_dob`/`get_dob`, no `user` OneToOne** (claim-flow reservation
not present).

**`Team`** (`teams_team`) — org- and tournament-scoped entrant. Fields: `id`, `organization → Organization
(CASCADE)`, `tournament → Tournament (CASCADE)`, `slug`, `name`, `short_name`, `school`, `region`, `pool`
(group/category), `seed`, `status` (`TeamStatus`, default `REGISTERED`), `created_by`, `deleted_at`,
timestamps. Constraints: `unique_team_slug_per_tournament` (tournament+slug, **unconditional** — includes
soft-deleted rows), `unique_team_name_per_tournament` (tournament+name, **only where `deleted_at IS NULL`**).
Index: `team_trn_status_idx` (tournament, status). Missing vs spec: crest, colors, tags, time_zone,
withdrawn/disqualified metadata, `last_manual_edit_at`.

**`Player`** (`teams_player`) — per-(tournament, team) registration. Fields: `id`, `organization (CASCADE)`,
`tournament (CASCADE)`, `team → Team (CASCADE)`, `person → Person (PROTECT)` (PROTECT = never orphan
career stats), `jersey_no`, `position` (max 16), `captain` (bool), `is_goalkeeper` (bool), `added_by`,
`deleted_at`, timestamps. Constraints: `unique_jersey_per_team` (team+jersey_no where not-deleted and
jersey not null), `unique_person_per_tournament` (tournament+person where not-deleted — the hard #8
constraint), `unique_captain_per_team` (team where captain=true and not-deleted). Indexes: `player_team_idx`,
`player_person_idx`. Missing vs spec: `eligibility_status`, `attributes` JSONB.

**`RegistrationLink`** (`teams_registration_link`) — shareable self-registration token. Fields: `id`,
`organization (CASCADE)`, `tournament (CASCADE)`, `token_hash` (sha256 hex, indexed; **plaintext shown
once, never stored** — same pattern as invitations), `label`, `is_active` (bool, default true),
`expires_at` (nullable), `max_submissions` (nullable cap), `submission_count` (default 0, incremented via
F-expression), `created_by`, `created_at`. No `updated_at`, no unique constraint on `token_hash`.

Relationships: `Tournament 1—N Team 1—N Player N—1 Person`; `Tournament 1—N RegistrationLink`.
`organization` is denormalized onto Team/Player/RegistrationLink (copied from `tournament.organization`).

## 4. Core algorithms / services (file:function, step-by-step)

**`registration.py::_hash_token(plaintext)`** — `sha256(plaintext.encode()).hexdigest()`. Used for both
mint and resolve so the plaintext token is never persisted.

**`registration.py::create_registration_link(*, tournament, created_by, label, expires_at, max_submissions)`**
1. `secrets.token_urlsafe(24)` → plaintext token.
2. Create `RegistrationLink` with `token_hash=_hash_token(token)`, org copied from `tournament.organization`,
   label truncated to 120, optional `expires_at`/`max_submissions`.
3. Return `(link, token)` — caller is responsible for surfacing the plaintext exactly once.

**`registration.py::resolve_registration_link(token_plaintext)`** — the gate guarding the public endpoint:
1. Empty token → `None`.
2. Query by `token_hash`, `is_active=True`, `tournament__deleted_at__isnull=True`, `select_related`
   tournament+org, `.first()`. None → `None`.
3. If `expires_at` set and `<= now()` → `None` (expired).
4. If `max_submissions` set and `submission_count >= max_submissions` → `None` (over cap).
5. Else return the link. **All failure modes collapse to `None`** → the view raises `NotFound("invalid_link")`,
   so expired/over-cap/inactive/wrong-token are indistinguishable to the client (no existence leak).

**`registration.py::_unique_team_slug(tournament, name)`** — `_slugify` (lowercase, scrub non-`[a-z0-9-]`,
collapse hyphens, trim, cap 80; falls back to `"team"`), then a `while Team.objects.filter(...).exists()`
loop appending `-2`, `-3`, … This is a **read-then-write race** (TOCTOU) — not atomic; concurrent submits
could both pick the same slug, but the DB `unique_team_slug_per_tournament` constraint is the safety net
(would raise `IntegrityError`).

**`registration.py::register_school(*, tournament, school_name, teams, submitted_by, channel, event_id, request)`**
— the central write path, used by BOTH the public endpoint and `apps.forms.services.mapping`:
1. **Idempotency (invariant #3):** if `event_id` given, look for a prior `AuditEvent` with
   `idempotency_key=event_id` AND `event_type="school_registered"`. If found, **return the existing Teams**
   (filtered by tournament + school + not-deleted) without writing — this is the replay path.
2. `org = tournament.organization`.
3. `transaction.atomic()`: for each team dict — create `Team` (status `REGISTERED`, slug via
   `_unique_team_slug`, all string fields truncated to model max lengths); for each player dict — create a
   **new `Person`** (always; never de-dups/reuses, contra spec §1.1) then a `Player` linking team+person+org+tournament.
4. After the loop, `emit_audit(actor_role=SYSTEM, event_type="school_registered", target=tournament,
   organization_id, idempotency_key=event_id, payload_after={school, teams:[names]})`. The audit row IS the
   idempotency ledger — there is no dedicated registration record.
5. Return the created `Team` list.

Note the **idempotency replay is keyed on `(event_id, "school_registered")`** and the `AuditEvent.idempotency_key`
is globally unique; `apps.forms.services.mapping` works around this by deriving a *distinct* `uuid5` key so the
form-submit audit and the school-registered audit don't collide (documented at length in `mapping.py` module docstring).

**`views.py::RegistrationLinkCreateView.post(request, tournament_id)`**
1. Fetch tournament (not-deleted) + `select_related(organization)`.
2. **Access gate:** if tournament None OR not in `accessible_tournaments(request.user)` → `NotFound`
   (404, no existence leak). Then `can_manage_tournament(user, tournament)` → else `PermissionDenied` (403).
3. `create_registration_link(...)`, return `{token, path: "/register/{token}", tournament_id}` (201).

**`views.py::PublicRegistrationView`** (AllowAny, `RegistrationRateThrottle`)
- `get`: `resolve_registration_link(token)` → 404 if None, else `{tournament_name, tournament_id}`.
- `post`: resolve (404 if None) → validate `SchoolRegistrationSerializer` → `register_school(channel="self",
  event_id=…)` inside try/except `IntegrityError` → on integrity error raise `ValidationError
  {"detail": "duplicate_team_name_or_jersey_in_submission"}`; on success **increment `submission_count`
  via `F("submission_count") + 1`** (atomic update) and return `{registered, teams:[names]}` (201).

**`views.py::TournamentTeamsListView.get(request, tournament_id)`** — access-scoped (`accessible_tournaments`
→ 404 if not), returns teams (not-deleted) annotated with `player_count` (count of not-deleted players),
ordered by `(pool, name)`. Shape: `{id, name, short_name, school, pool, status, player_count}`.

**`throttling.py::RegistrationRateThrottle`** — `SimpleRateThrottle`, scope `school_registration`
(`30/hour` in `settings/base.py`), per-IP via `get_ident`, **GET exempt** (only POST throttled).

**`serializers.py::SchoolRegistrationSerializer.validate_teams`** — rejects empty `teams` list; rejects any
team with >1 captain (the only multi-captain guard at submit; the DB constraint also enforces it per team).

## 5. API / endpoint surface

| Method · path | View | Auth | Notes |
|---|---|---|---|
| `POST /api/tournaments/{id}/registration-link/` | `RegistrationLinkCreateView` | IsAuthenticated + `can_manage_tournament` | Mints link; returns plaintext token once. 404 on no-access, 403 on non-manager. |
| `GET /api/tournaments/{id}/teams/` | `TournamentTeamsListView` | IsAuthenticated (access-scoped) | Entrant list with `player_count`. |
| `GET /api/register/{token}/` | `PublicRegistrationView` | AllowAny | Resolves link → tournament name/id. 404 on invalid/expired/over-cap. |
| `POST /api/register/{token}/` | `PublicRegistrationView` | AllowAny (throttled) | Self-register school's teams+players. 201; 404 invalid link; 400 duplicate; 429 throttled. |

Exported service API (the real reuse surface): `register_school`, `create_registration_link`,
`resolve_registration_link` from `apps.teams.services.registration`; models `Person/Team/Player/RegistrationLink`
and `TeamStatus` from `apps.teams.models`.

## 6. Invariants that MUST be preserved through restructuring

1. **Person ↔ Player split (#8):** `Person` is platform-scoped (no org FK); `Player` is the per-tournament
   registration referencing a `Person`. Career stats roll up by `person_id`. This is the named
   architectural invariant — do not collapse Person into Player.
2. **`unique_person_per_tournament`** (Player tournament+person where not-deleted) — a Person cannot be on
   two teams in one tournament. Hard DB constraint mandated by PRD §5.3 / v1Users §8.2.
3. **`unique_jersey_per_team`** and **`unique_captain_per_team`** — both conditional on not-deleted.
4. **`person` FK is `PROTECT`** — Players (and therefore stats) must never be orphaned by a Person delete.
5. **Idempotent writes (#3):** `register_school` replays on `(event_id, "school_registered")` and returns
   the existing Teams (no duplicate creation). The audit row is the ledger.
6. **Token hashing:** plaintext registration tokens are NEVER stored; only the sha256 hash. Plaintext is
   returned exactly once at mint.
7. **Link gate semantics:** `resolve_registration_link` collapses inactive/expired/over-cap/wrong to a
   single `None` → uniform 404 (no existence leak; mirrors the multi-tenancy no-leak rule).
8. **Multi-tenancy (#2):** Team/Player/RegistrationLink carry `organization` copied from the tournament;
   `RegistrationLinkCreateView`/`TournamentTeamsListView` resolve via `accessible_tournaments` (404 on
   no-access). Org isolation must survive any refactor.
9. **UUID7 PKs (#1)** on all four models.
10. **Public endpoint rate-limit (#anti-abuse):** POST-only, per-IP throttle on `/api/register/{token}/`.
11. **Atomicity:** `register_school` is one `transaction.atomic()` — partial school registration must not persist.
12. **`status=REGISTERED` is what the fixture generator selects** — see §7. Changing the default or the
    self-register status silently changes which teams get fixtures.

## 7. Dependencies / coupling

**Outgoing (apps.teams imports):**
- `apps.accounts.models.uuid7` (PKs).
- `apps.audit.models` (`ActorRole`, `AuditEvent`) + `apps.audit.services.emit_audit` — idempotency ledger
  + audit trail. `register_school`'s idempotency literally depends on AuditEvent semantics.
- `apps.tournaments.models.Tournament`, `apps.tournaments.permissions.can_manage_tournament`,
  `apps.tournaments.scope.accessible_tournaments` (in views).
- `apps.organizations.Organization`, `apps.tournaments.Tournament` (string FKs in models).

**Incoming (who depends on apps.teams) — this is the heavily-coupled direction:**
- **`apps.tournaments.urls`** imports `RegistrationLinkCreateView` + `TournamentTeamsListView` and routes
  them under `/api/tournaments/{id}/...`. So two of the three teams views are **wired from another app's
  URLConf** — the teams app's own `urls.py` only owns `/api/register/`.
- **`apps.fixtures`** — `generate.py` and `views.py` import `Team, TeamStatus` and select
  `status=REGISTERED, deleted_at__isnull=True`, ordered by `seed, name`, as the seed list for round-robin /
  knockout / groups→knockout generation. The generator reads `Team.id` / `seed` only.
- **`apps.matches.models`** — `Match.home_team`/`away_team` → `teams.Team (SET_NULL)`; `Lineup.team` →
  `teams.Team (CASCADE)`; `LineupEntry.player` / incident-report player FKs → `teams.Player (CASCADE/SET_NULL)`.
- **`apps.matches.services.lineups`** — validates submitted lineup players against `Player` (must exist,
  not-deleted, and `player.team_id == team.id`). This is the only place outside teams that enforces
  roster membership.
- **`apps.forms.services.mapping._map_team_registration`** — calls `register_school` to turn a submitted
  registration FormResponse into Teams+Players (with a derived uuid5 idempotency key). The forms feature
  is a second, parallel ingress to the same write path.
- **`apps.live.views`** — reads `Person.display_name or Person.full_name` for public name rendering.
- **`apps.tournaments.management.commands.run_e2e_demo`** — uses `register_school` + `Team` for the demo seed.
- Numerous tests across `fixtures`, `matches`, `live` import `register_school` as the canonical entrant fixture.

**Coupling summary:** `apps.teams` is a **foundational dependency** of fixtures, matches, forms, and live.
`register_school` and the `Team(status=REGISTERED)` invariant are the two highest-leverage seams — many
downstream tests build their world through `register_school`.

## 8. Tech debt / smells / gaps (implementation vs `v1Teams.md`)

The shipped code is a thin MVP; the spec describes a much larger system. The gap is itself the principal
"debt" to be aware of before restructuring:
- **No `ScopedManager`/`active_objects`.** Spec §2 mandates `ScopedManager.from_queryset(...)` on every
  org-scoped model; the built models use the default manager. Every caller hand-filters
  `deleted_at__isnull=True` and `accessible_tournaments(...)`. Soft-delete is a column with no manager,
  no service that sets it, and no enforcement — `deleted_at` is effectively dead weight today.
- **Not built at all (spec'd but absent):** `TeamMembership` + the two-layer team-manager authz
  (`is_team_manager_of`, `IsTeamManagerOfObject`), `TeamRegistration` (the approval-record/state machine),
  `RosterSnapshot`, `PlayerSuspension`, `EligibilityStatus`, the `roster_schema` data-driven validator,
  DOB Fernet encryption + `set_dob`/`get_dob` + DOB-view audit, `Person.user` claim reservation, crest/colors.
- **Registration state machine is vestigial.** `TeamStatus` has 6 values but the only one ever written is
  `REGISTERED`. No approve/reject/withdraw/disqualify transitions, no audited transition function (contra
  invariant #6). `pending_approval`, `rejected`, `withdrawn`, `disqualified` are unreachable in code.
  The bracket-impact / walkover-on-withdrawal hook (`on_team_left_tournament`) does not exist.
- **No de-dup of Person.** `register_school` *always* creates a fresh `Person` per player (spec §1.1 wants
  typeahead reuse + de-dup suggestions). Re-registering the same human across tournaments yields duplicate
  Person rows, which undermines the cross-tournament career-stats rationale of invariant #8 until a merge
  tool exists (deferred, spec §10).
- **No per-team / per-player CRUD endpoints.** The entire §5.1/§5.2/§5.3 REST surface (GET/PATCH team,
  approve/reject/withdraw, players list/add/edit/delete, persons typeahead/career) is absent. The only
  mutating endpoint is the public self-register POST. Admin roster management has no API.
- **Hand-rolled JSON responses** in all views (no output serializer) → the API shape is undocumented to
  drf-spectacular and untyped to the frontend gen:types pipeline.
- **`display_name` / `dob_year`** are accepted by `register_school` (it reads `pd.get("display_name")` /
  `pd.get("dob_year")`) but the public `PlayerInSerializer` does NOT expose `display_name` (only
  `dob_year`), so the public channel can never set it; only the internal forms-mapping path could.
- **TOCTOU in `_unique_team_slug`** (check-then-insert), saved only by the DB constraint.
- **Asymmetric slug vs name uniqueness:** `unique_team_slug_per_tournament` is unconditional (counts
  soft-deleted rows) while `unique_team_name_per_tournament` excludes soft-deleted — so a re-created team
  with the same name gets a fresh `-2` slug forever after a (hypothetical) delete. Minor, but inconsistent.
- **`RegistrationLink` has no revoke/usage-audit endpoint** and `submission_count` is incremented in the
  view, not the service — a second caller of `register_school` (forms mapping) does NOT touch link counters,
  which is correct (forms don't use links) but means the cap only applies to the `/register/` channel.
- **No `event_id` on the link-mint or teams-list endpoints** (only `register_school` is idempotent).

## 9. Restructuring seams & risks

**Cleanest seams to cut along:**
- **`register_school` is THE service seam.** It is the single write path shared by the public endpoint and
  forms-mapping; any restructure should keep a function with this contract (or a clearly-versioned successor)
  because fixtures/matches/live tests and the forms feature all funnel through it.
- **`resolve_registration_link` + token-hash gate** is a self-contained, well-tested unit — safe to lift
  into a shared "tokenized public access" utility (mirrors the invitations pattern noted in the docstring).
- **The `Team(status=REGISTERED)` selection contract** between teams and fixtures is a narrow, explicit
  interface (`generate.py` / `fixtures/views.py`). If the registration approval state machine is finally
  built, the generator's "REGISTERED only" filter is the exact integration point — and the moment
  `pending_approval` becomes reachable, the generator silently changes behavior. Treat as a coordinated change.
- **URL ownership split is a smell to fix:** move `RegistrationLinkCreateView` + `TournamentTeamsListView`
  routing into `apps/teams/urls.py` (or a teams router) so the teams app owns its surface; today
  `apps.tournaments.urls` imports teams views, creating an avoidable import edge.

**Risks / things that will break if touched carelessly:**
- Changing the **idempotency key tuple** `(event_id, "school_registered")` breaks both the public replay
  path and the forms-mapping de-dup (which deliberately derives a distinct uuid5 — read `mapping.py`'s
  module docstring before changing audit semantics).
- Dropping/altering the **`unique_person_per_tournament`** or **`PROTECT` on `person`** breaks invariant #8
  and the matches/lineup membership checks.
- The **migration-during-live guard** (PRD §5) applies — any model change ships behind the deploy pre-flight.
- Many downstream test suites construct their fixtures via `register_school`; a signature change is a
  repo-wide test break. Add new params keyword-only with defaults (the function is already `*`-keyword-only).
- Introducing `ScopedManager` (to match spec) would change default querysets everywhere teams models are
  queried in fixtures/matches/forms — every `.objects` call that currently expects unscoped rows must be audited.

**Opportunities:** introduce the missing managers + soft-delete service, build the approval state machine
behind `TeamStatus` (already enumerated), de-dup `Person` via typeahead, and add output serializers — all
can be layered additively because the current surface is so small. The existing 4 test files lock the two
behaviors that matter most (idempotency + link caps/throttle); preserve them as the regression baseline.

## 10. Ambiguities / things worth confirming

- Whether `deleted_at` is intended to be live (no code writes it) or is forward-scaffolding only.
- Whether the unreachable `TeamStatus` values are reserved for the deferred state machine or should be
  pruned to `{REGISTERED}` until built.
- Whether the URL-ownership split (teams views routed from tournaments) is intentional or accidental.
- Whether `display_name`'s absence from the public serializer is deliberate (privacy) or an oversight.
