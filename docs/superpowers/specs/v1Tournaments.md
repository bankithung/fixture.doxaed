# v1 — Tournaments App (Deep Design)

> **Status:** Draft v1 (design) — 2026-06-04
> **Owner:** graceschooledu@gmail.com
> **App:** `backend/apps/tournaments/`
> **Phase:** 1B (first sport-coupled milestone) — but the *state machine, rule-freeze, membership, and self-serve provisioning* in this doc are **sport-agnostic** and form the chassis the football module plugs into.
> **Canonical inputs:** PRD §5.1, §5.2 (state machine), §5.13 (rule catalog), §8 (data model); v1Users.md §2 (Admin lifecycle), §2.7 (schema), §4 (Game coordinator + `TournamentMembership` §4.7), Appendix A (modules), Appendix B (B.2 scope filters, B.3 DRF conventions, B.4 audit, B.18 migration order); v1Fixtures.md (Phase A/B engine seam).
> **Companion (separate):** `v1Fixtures.md` (bracket + schedule generation — `apps.fixtures`), `v1Sport.md` (football scoring + Player/Person — to be written).

This document supersedes nothing already locked; it **realises** PRD §8 `Tournament`, `TournamentMembership`, `TournamentStateTransition`, `Stage`, `Group`, `Venue` and resolves the locked self-serve decision (creating a tournament auto-provisions the creator's hidden personal-workspace Org and makes them tournament admin) against the existing `single_org_per_admin_user` DB constraint.

---

## 0. Scope boundary (what is in this app vs. neighbours)

| In `apps.tournaments` | NOT here (where) |
|---|---|
| `Tournament` model + state machine + rule freeze/amend | `Match` state machine (`apps.matches`, PRD §5.5) |
| `TournamentMembership` (tournament-scoped roles — Game coordinator v1) | `MatchAssignment` (scorer/referee — `apps.matches`) |
| `Stage`, `Group`, `Venue`, `VenueAvailability`, `TeamBlackout` (structural containers) | Bracket/schedule **generation** (`apps.fixtures`, v1Fixtures.md) |
| `TournamentStateTransition` (append-only transition log) | `SchedulingConstraint`, `ScheduleRun` (`apps.fixtures`) |
| Self-serve creation + personal-workspace auto-provisioning | `Team`, `Player`, `Person` (`apps.teams`, sport module) |
| Setup wizard API (basics/format/rules/venues/days/roles/registration/review) | Live transport (`apps.live`), notifications dispatch (`apps.notifications`) |
| Structured-rules JSONB column + JSON-schema validation hook | The **football** rule catalog values (§5.13) — supplied by the football plugin as `SportRuleDefaults` |

**Invariant the seam rests on (v1Fixtures §1, PRD #9):** this app owns *who/what/when containers*; `apps.fixtures` owns the *combinatorics + constraint solving* that fills `Match.home_source`/`away_source` and `scheduled_at`. The two are decoupled so a draw can be re-run without re-scheduling.

---

## 1. Self-serve creation — resolving the `single_org_per_admin_user` blocker

### 1.1 The blocker (verbatim from existing code)

`backend/apps/organizations/models.py:229-233`:

```python
UniqueConstraint(
    fields=["user"],
    condition=Q(role="admin", is_active=True),
    name="single_org_per_admin_user",
),
```

A user may hold an **active `admin` `OrganizationMembership` in exactly one Org globally**. The locked self-serve decision says "creating a tournament auto-provisions the creator workspace; they become *tournament admin*." Naively making the creator an **Org admin of a new Org per tournament** would violate this constraint on the second tournament a user creates outside an existing Org.

### 1.2 Resolution (locked decision, no schema fight)

The constraint is **correct and stays**. We resolve by separating two distinct ownerships:

1. **One personal-workspace Org per user, created lazily and reused.** The first time a user with no Admin-tier Org membership creates a tournament, we auto-provision a single hidden Org (`Organization.is_personal_workspace=True`) and make them its `admin` + `is_org_owner=True`. **Every later tournament that same user creates self-serve reuses that one workspace Org** — so the user is admin of exactly one Org, ever. `single_org_per_admin_user` is never violated.
2. **Tournament-level admin is a `TournamentMembership`, not an Org-admin row.** "Tournament admin" is the union of (a) being the workspace Org admin (full module set via `effective_modules`) and (b) — for invited collaborators on that tournament — a `TournamentMembership(role='game_coordinator'|...)`. We do **not** mint extra Org-admin rows per tournament.

```
create_tournament(user, payload)
  ├─ resolve_workspace_org(user):
  │     existing = OrganizationMembership.objects.filter(
  │         user=user, role='admin', is_active=True).first()
  │     if existing: return existing.organization        # reuse (incl. real Orgs)
  │     else: provision personal workspace Org (1 per user, hidden)
  └─ Tournament.objects.create(organization=workspace_org, created_by=user, ...)
        creator is tournament admin via effective_modules over the workspace Org
```

**Why reuse a real Org too:** if the user is *already* an Org admin (e.g., invited via Super-admin Path A), self-serve tournament creation lands the tournament in **that** Org — no second workspace is made. The personal workspace only exists for users who arrived purely self-serve. This keeps "one Admin Org per user" literally true.

### 1.3 Personal-workspace Org shape

Add to `Organization` (organizations app migration, owned by tournaments-phase but living in organizations to keep the model cohesive):

```python
# organizations/models.py — Organization additions
is_personal_workspace = models.BooleanField(default=False, db_index=True)
```

Behaviour of a personal-workspace Org:
- **Hidden from public Org browse** and from the Super-admin "real orgs" KPI counts (`is_personal_workspace=True` filtered out of those queries; still visible in the Super-admin support console).
- **Status starts `active`** (NOT `pending_review`) — self-serve tournament creation does **not** gate on Super-admin approval (locked decision: "NO super-admin approval gate"). This is the one place `OrgStatus.ACTIVE` is set without Super-admin action; gated behind feature flag `self_serve_workspace` (B.19 style, default ON).
- **Slug** auto-generated as `ws-<short-uuid>` (or `<username>-workspace`, de-duplicated via `services.slug.validate_slug`); user can rename their workspace later (becomes a normal Org slug, `SlugRedirect` on change).
- **Name** defaults to `"<User name>'s workspace"`; editable.
- **`created_by = user`**, and one `OrganizationMembership(user, org, role='admin', is_org_owner=True, is_active=True)` row — the single Admin row that satisfies the constraint.
- A user who later gets a "real" Org via Super-admin invite keeps the workspace; multi-Org-Admin is still blocked, so the workspace would have to be transferred/left first if they want the invite (orphan/transfer flow handles this; non-blocking edge, documented in §11 open questions).

### 1.4 Service: `tournaments/services/creation.py`

```python
def resolve_or_provision_workspace(user, *, request=None) -> Organization:
    existing = OrganizationMembership.objects.filter(
        user=user, role=MembershipRole.ADMIN, is_active=True,
        organization__deleted_at__isnull=True,
    ).select_related("organization").first()
    if existing:
        return existing.organization
    # No Admin Org anywhere → provision the personal workspace.
    with transaction.atomic():
        slug = unique_workspace_slug(user)
        org = create_organization(            # reuse organizations.services.lifecycle
            slug=slug, name=f"{user.display_name}'s workspace",
            created_by=user, status=OrgStatus.ACTIVE, request=request,
        )
        org.is_personal_workspace = True
        org.save(update_fields=["is_personal_workspace"])
        OrganizationMembership.objects.create(
            user=user, organization=org, role=MembershipRole.ADMIN,
            is_org_owner=True, is_active=True, created_by=user,
        )
        emit_audit(actor_user=user, actor_role=ActorRole.ADMIN,
                   event_type="workspace_provisioned", target_type="organization",
                   target_id=org.id, organization_id=org.id,
                   payload_after={"is_personal_workspace": True}, request=request)
    return org


def create_tournament(*, user, sport, name, slug=None, format=None,
                      time_zone=None, dates=None, visibility="public",
                      event_id=None, request=None) -> Tournament:
    org = resolve_or_provision_workspace(user, request=request)
    slug = validate_tournament_slug(slug or slugify(name), org=org)
    with transaction.atomic():
        # Idempotency (#3): event_id unique per (org, event_id).
        if event_id:
            existing = Tournament.objects.filter(
                organization=org, idempotency_key=event_id).first()
            if existing:
                return existing            # 200, not 201
        t = Tournament.objects.create(
            organization=org, sport=sport, name=name, slug=slug,
            format=format or TournamentFormat.SINGLE_ELIMINATION,
            time_zone=time_zone or org.time_zone,
            visibility=visibility, status=TournamentStatus.DRAFT,
            created_by=user, idempotency_key=event_id,
        )
        # creator IS tournament admin via org-admin effective_modules; no extra row.
        emit_audit(actor_user=user, actor_role=ActorRole.ADMIN,
                   event_type="tournament_created", target_type="tournament",
                   target_id=t.id, organization_id=org.id, tournament_id=t.id,
                   payload_after={"name": name, "slug": slug, "sport": sport.code},
                   idempotency_key=event_id, request=request)
    return t
```

Reused chassis: `organizations.services.lifecycle.create_organization`, `organizations.services.slug.validate_slug`, `audit.services.emit_audit`, `accounts.models.uuid7`, `permissions.services.resolver.effective_modules`.

---

## 2. Data model

All PKs are UUID v7 (`apps.accounts.models.uuid7`, invariant #1). All tenant-scoped via `organization` FK (invariant #2). All mutations idempotent via `idempotency_key` (invariant #3). Soft-delete via `deleted_at`. Managers via `apps.permissions.scope.ScopedManager`/`ScopedQuerySet` (Appendix B.2).

### 2.1 `Tournament`

```python
class TournamentStatus(models.TextChoices):           # PRD §5.2
    DRAFT = "draft"
    PUBLISHED = "published"
    REGISTRATION_OPEN = "registration_open"
    REGISTRATION_CLOSED = "registration_closed"
    BRACKET_GENERATED = "bracket_generated"
    SCHEDULED = "scheduled"
    LIVE = "live"
    COMPLETED = "completed"
    ARCHIVED = "archived"
    CANCELLED = "cancelled"                            # terminal, side
    # paused/disputed/orphaned are OVERLAYS, not the linear status — see §3.4

class TournamentFormat(models.TextChoices):           # PRD §5.1; v1Fixtures §2
    SINGLE_ELIMINATION = "single_elimination"
    DOUBLE_ELIMINATION = "double_elimination"          # "coming soon" gated in wizard
    ROUND_ROBIN_SINGLE = "round_robin_single"
    ROUND_ROBIN_DOUBLE = "round_robin_double"          # league (home/away)
    GROUPS_KNOCKOUT = "groups_knockout"
    SWISS = "swiss"                                    # v1Fixtures phase 2
    MULTI_STAGE = "multi_stage"
    CUSTOM = "custom"

class Visibility(models.TextChoices):
    PUBLIC = "public"; UNLISTED = "unlisted"; PRIVATE = "private"

class Tournament(models.Model):
    id = UUIDField(pk, default=uuid7)
    idempotency_key = UUIDField(null=True, blank=True)        # #3 create-time event_id
    organization = FK(Organization, on_delete=PROTECT, related_name="tournaments")
    sport = FK("sports.Sport", on_delete=PROTECT, related_name="tournaments")

    slug = SlugField(max_length=80)                            # unique within Org (#2.8)
    name = CharField(max_length=200)
    description = TextField(blank=True)

    format = CharField(choices=TournamentFormat.choices)
    visibility = CharField(choices=Visibility.choices, default=PUBLIC)
    status = CharField(choices=TournamentStatus.choices, default=DRAFT, db_index=True)

    # Overlays (PRD §5.2 side-states) — orthogonal to `status`.
    is_paused = BooleanField(default=False)
    paused_reason = TextField(blank=True)
    paused_from_status = CharField(blank=True, default="")     # resume target
    paused_at = DateTimeField(null=True)
    has_open_dispute = BooleanField(default=False)             # `disputed` overlay
    is_orphaned = BooleanField(default=False)                  # mirrors Org orphan

    # Dates / TZ (invariant #14: stored UTC; rendered tournament TZ admin, viewer TZ public)
    start_date = DateField(null=True)
    end_date = DateField(null=True)
    time_zone = CharField(max_length=64, default="Asia/Kolkata")   # default Org TZ
    tz_locked = BooleanField(default=False)                    # true once `scheduled` (#14)

    # Registration window (PRD §5.1 step 8, §5.2)
    registration_open_at = DateTimeField(null=True)
    registration_close_at = DateTimeField(null=True)
    team_registration_open = BooleanField(default=False)       # open vs invite-only
    team_registration_requires_approval = BooleanField(default=False)
    min_teams_to_start = PositiveIntegerField(default=4)

    # Rules (sport-agnostic column; football values come from SportRuleDefaults)
    structured_rules = JSONField(default=dict, blank=True)     # JSONB; #10 + §5.13
    prose_rules = TextField(blank=True)                        # auto-gen, editable
    structured_rules_schema_version = PositiveIntegerField(default=1)

    # Rule freeze (#7, PRD §5.2 rule-freeze policy)
    rule_freeze_at = DateTimeField(null=True)                  # set on → registration_open
    pending_amend = JSONField(null=True, blank=True)           # staged amend in 24h grace

    # Ancillary post-live-amendable fields (PRD §5.2 "strictly amendable post-live")
    dispute_window_hours = PositiveIntegerField(default=24)
    dispute_cascade_policy = CharField(default="strict_unplayed_lenient_played")
    archive_after_days = PositiveIntegerField(default=90)

    # Generation provenance (#10 conflict-warning)
    inputs_hash = CharField(max_length=64, blank=True, default="")
    last_manual_edit_at = DateTimeField(null=True)

    is_demo = BooleanField(default=False)                      # PRD §5.17
    created_at = DateTimeField(auto_now_add=True)
    created_by = FK(User, null=True, on_delete=SET_NULL, related_name="tournaments_created")
    deleted_at = DateTimeField(null=True, db_index=True)

    objects = TournamentManager.from_queryset(TournamentQuerySet)()

    class Meta:
        db_table = "tournaments_tournament"
        constraints = [
            UniqueConstraint(fields=["organization", "slug"],
                condition=Q(deleted_at__isnull=True),
                name="unique_tournament_slug_per_org"),                     # #2.8
            UniqueConstraint(fields=["organization", "idempotency_key"],
                condition=Q(idempotency_key__isnull=False),
                name="unique_tournament_event_id_per_org"),                  # #3
        ]
        indexes = [
            Index(fields=["organization", "status"]),
            Index(fields=["sport", "status"]),
            Index(fields=["deleted_at"]),
        ]
```

**Notes:**
- `structured_rules` JSONB carries the **whole** football catalog (§5.13: `match_length_minutes`, `tie_breaker_order`, `lineup_miss_policy`, `eligibility_freeze_round`, etc.). Validated by a JSON-schema the **football plugin** registers (`SportRuleDefaults.structured_rules` + schema). The column and validation *hook* are sport-agnostic; the schema content is not. New rule fields = zero migrations (PRD §5.13).
- `format` / `tie_breaker_order` (the latter living inside `structured_rules`) are **never amendable post-freeze** (Super-admin override only) — enforced in the amend service (§3.3).
- `paused_from_status` enables `paused → prior_state` (PRD §5.2). Overlays are booleans so they compose with the linear `status` (a tournament can be `live` AND paused AND disputed simultaneously).

### 2.2 `TournamentMembership` (tournament-scoped roles)

Exactly per v1Users.md §4.7, extended with the sport hook v1Fixtures/sport module will need:

```python
class TournamentMembershipRole(models.TextChoices):
    GAME_COORDINATOR = "game_coordinator"     # only tournament-scoped role in v1.0

class TournamentMembershipStatus(models.TextChoices):
    ACTIVE = "active"; SUSPENDED = "suspended"; REVOKED = "revoked"

class TournamentMembership(models.Model):
    id = UUIDField(pk, default=uuid7)
    user = FK(User, on_delete=CASCADE, related_name="tournament_memberships")
    tournament = FK(Tournament, on_delete=CASCADE, related_name="memberships")
    role = CharField(choices=TournamentMembershipRole.choices,
                     default=GAME_COORDINATOR)
    status = CharField(choices=TournamentMembershipStatus.choices, default=ACTIVE)
    assigned_by = FK(User, null=True, on_delete=SET_NULL,
                     related_name="tournament_assignments_made")
    assigned_at = DateTimeField(auto_now_add=True)
    revoked_at = DateTimeField(null=True)
    # sport_id intentionally omitted in v1.0 (added nullable by sport module, §4.7 note)

    class Meta:
        db_table = "tournaments_membership"
        constraints = [
            UniqueConstraint(fields=["user", "tournament", "role"],
                condition=Q(status="active"),
                name="unique_active_tournament_role"),                       # §4.7
        ]
        indexes = [Index(fields=["tournament", "role", "status"]),
                   Index(fields=["user", "status"])]
```

**Authorization invariant (v1Users §4.7, MUST be a test):** to act as Game coordinator on Tournament T a user needs BOTH (a) `OrganizationMembership(user, T.organization, role='game_coordinator', is_active=True)` AND (b) `TournamentMembership(user, T, role='game_coordinator', status='active')`. Org-level-only = "no assignments", zero operational access.

### 2.3 `TournamentStateTransition` (append-only)

```python
class TournamentStateTransition(models.Model):
    id = UUIDField(pk, default=uuid7)
    tournament = FK(Tournament, on_delete=CASCADE, related_name="transitions")
    from_state = CharField(max_length=24)
    to_state = CharField(max_length=24)
    overlay = CharField(max_length=16, blank=True, default="")  # '', 'pause','resume','dispute'
    actor = FK(User, null=True, on_delete=SET_NULL)             # null = system
    actor_role = CharField(max_length=32)                       # B.5 taxonomy
    reason = TextField(blank=True)                              # ≥20 chars for cancel/amend
    trigger = CharField(max_length=32)                          # 'manual' | 'auto' | 'system'
    idempotency_key = UUIDField(null=True, blank=True)          # #3
    created_at = DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "tournaments_state_transition"
        constraints = [UniqueConstraint(fields=["idempotency_key"],
            condition=Q(idempotency_key__isnull=False),
            name="unique_tournament_transition_event")]
```

**Append-only at DB role level (invariant #5):** the same migration pattern `apps.audit` uses (Postgres role denies `UPDATE`/`DELETE`). Add a `RunSQL` migration `REVOKE UPDATE, DELETE ON tournaments_state_transition FROM <app_role>`. A test must assert that `transition.save()` of an existing row raises a DB error. (The canonical system-of-record is still `AuditEvent`; this table is a fast-read transition history — both are append-only.)

### 2.4 Structural containers: `Stage`, `Group`, `Venue`, `VenueAvailability`, `TeamBlackout`

These are PRD §8 + v1Fixtures §7. They live here because they're tournament structure; `apps.fixtures` *reads* them and `apps.matches` *references* them.

```python
class Stage(models.Model):                        # PRD §8
    id = UUIDField(pk, default=uuid7)
    tournament = FK(Tournament, on_delete=CASCADE, related_name="stages")
    name = CharField(max_length=120)              # "Group stage", "Knockout"
    format = CharField(choices=TournamentFormat.choices)   # per-stage in multi_stage
    order = PositiveIntegerField()                # ordering within tournament
    params = JSONField(default=dict, blank=True)  # format params (v1Fixtures §2)
    class Meta:
        constraints = [UniqueConstraint(fields=["tournament", "order"],
            name="unique_stage_order_per_tournament")]

class Group(models.Model):                        # PRD §8
    id = UUIDField(pk, default=uuid7)
    stage = FK(Stage, on_delete=CASCADE, related_name="groups")
    name = CharField(max_length=120)              # "Group A"
    ordinal = PositiveIntegerField()
    class Meta:
        constraints = [UniqueConstraint(fields=["stage", "ordinal"],
            name="unique_group_ordinal_per_stage")]

class Venue(models.Model):                        # PRD §8; v1Fixtures §7
    id = UUIDField(pk, default=uuid7)
    organization = FK(Organization, on_delete=CASCADE, related_name="venues")
    tournament = FK(Tournament, null=True, on_delete=CASCADE, related_name="venues")
    name = CharField(max_length=200)
    address = TextField(blank=True)
    capacity = PositiveIntegerField(null=True)
    latitude = FloatField(null=True)              # for minimize_travel (v1Fixtures §9)
    longitude = FloatField(null=True)
    time_windows = JSONField(default=list, blank=True)  # default availability
    turnaround_min = PositiveIntegerField(default=30)
    deleted_at = DateTimeField(null=True)
    objects = ScopedManager.from_queryset(ScopedQuerySet)()

class VenueAvailability(models.Model):            # v1Fixtures §7
    id = UUIDField(pk, default=uuid7)
    venue = FK(Venue, on_delete=CASCADE, related_name="availability")
    start = DateTimeField(); end = DateTimeField()   # UTC (#14)
    is_blackout = BooleanField(default=False)

class TeamBlackout(models.Model):                 # v1Fixtures §7 (team FK lands w/ teams app)
    id = UUIDField(pk, default=uuid7)
    tournament = FK(Tournament, on_delete=CASCADE, related_name="team_blackouts")
    team_id = UUIDField(null=True)                # soft FK until apps.teams exists
    dates = JSONField(default=list, blank=True)   # ISO date strings
    reason = TextField(blank=True)
```

`SchedulingConstraint` and `ScheduleRun` are **not** here — they belong to `apps.fixtures` (v1Fixtures §3.1, §5).

---

## 3. State machine (PRD §5.2 — full)

### 3.1 Linear transitions

```
draft → published → registration_open → registration_closed
      → bracket_generated → scheduled → live → completed → archived
```

Implemented as a single guarded service per transition in `tournaments/services/state.py`. Every transition: (1) validates preconditions, (2) flips `status` inside `transaction.atomic()`, (3) writes one `TournamentStateTransition` row, (4) `emit_audit(event_type='tournament_state_changed', ...)`, (5) `transaction.on_commit` → notification fan-out + Redis publish (invariant #4 — publish AFTER commit; delivery is `apps.notifications`/`apps.live`).

| # | Transition | Trigger | Preconditions (enforced) | Notifications (on_commit) | Audit event_type |
|---|---|---|---|---|---|
| 1 | `draft → published` | Admin clicks Publish | wizard complete + validation pass (§4.2: required fields, ≥1 venue, ≥1 day, valid reg window) | Org members | `tournament_published` |
| 2 | `published → registration_open` | reaches `registration_open_at` (cron) OR Admin force-opens | status still `published` | all assigned roles | `tournament_state_changed` |
| 3 | `registration_open → registration_closed` | reaches `registration_close_at` (cron) OR Admin force-closes | status still `registration_open` | all members | `tournament_state_changed` |
| 4 | `registration_closed → bracket_generated` | Admin/Coordinator generates+locks bracket (calls `apps.fixtures`) | `team_count ≥ min_teams_to_start` | coordinator, scorers, referees, team managers | `bracket_generated` |
| 4b | `registration_closed` w/ teams `< min_teams_to_start` | auto-prompt | — | Admin: "extend window OR cancel" | `tournament_min_teams_unmet` (notice only; no status change) |
| 5 | `bracket_generated → scheduled` | Admin/Coordinator locks schedule | schedule has **zero hard conflicts** (`ScheduleRun.infeasible_core` empty) | all assigned roles + team managers | `schedule_locked` + `tournament_state_changed` |
| 6 | `scheduled → live` | reaches `first_match.scheduled_at − 1h` (cron) OR Admin force-opens | ≥1 match has assigned scorer + referee | all | `tournament_state_changed` |
| 7 | `live → completed` | all matches terminal (`final`/`walkover`/`cancelled`/`abandoned`) | **no** `disputed` matches outstanding (`has_open_dispute=False`) | all members | `tournament_state_changed` |
| 8 | `completed → archived` | after `archive_after_days` (cron) OR Admin force-archives | — | Admin | `tournament_state_changed` |

**Side effects at boundaries:**
- On **entering `registration_open`** (transition 2): set `rule_freeze_at = now()` if null (rule freeze activates, §3.3).
- On **entering `scheduled`** (transition 5): set `tz_locked = True` (invariant #14 — TZ change blocked once scheduled).
- Transition 4 and 5 **delegate** the actual draw/solve to `apps.fixtures` (v1Fixtures §2, §4); this app only flips status after `apps.fixtures` returns a locked artifact.

### 3.2 Side / overlay transitions

| Transition | Trigger | Preconditions | Notif | Audit |
|---|---|---|---|---|
| `* → cancelled` | Admin cancels w/ reason ≥20 chars | not already terminal (`completed`/`archived`/`cancelled`) | all | `tournament_state_changed` (to=`cancelled`) |
| `* → paused` (overlay) | Admin pauses w/ reason | not terminal | all | `tournament_paused` |
| `paused → prior_state` (overlay clear) | Admin resumes | `is_paused=True` | all | `tournament_resumed` |
| `* → disputed` (overlay set) | any match enters `disputed` (signal from `apps.matches`) | — | affected parties | `tournament_disputed` |
| `disputed` cleared (overlay) | all disputes resolved | no open `Dispute` for tournament | affected parties | `tournament_dispute_cleared` |
| `* → orphaned` (overlay) | Org has no active Admin (mirrors `Organization.status=orphaned`) | — | Super-admin queue | `tournament_orphaned` |

Pause/dispute/orphan are **overlay booleans** (§2.1) — they do not overwrite `status`. `paused → prior_state` restores from `paused_from_status`. Cancellation IS a real terminal `status` value.

### 3.3 Rule freeze + 24h-grace amend (invariant #7, PRD §5.2 rule-freeze policy)

```
Mutable freely:        status ∈ {draft, published}
Frozen (amend only):   status ≥ registration_open  (rule_freeze_at set)
Never amendable:       format, structured_rules.tie_breaker_order   (Super-admin override only)
Always amendable:      dispute_window_hours, dispute_cascade_policy, archive_after_days
                       (the "strictly amendable post-live" ancillary set)
```

**Edit path (status ∈ {draft, published}):** direct `PATCH /api/tournaments/{id}/`. Re-derives `inputs_hash`; if a manual prose edit exists and structured fields change, set the `#10` conflict banner flag (`last_manual_edit_at` checked).

**Amend path (status ≥ registration_open):** `POST /api/tournaments/{id}:amend-rules/`
1. Reject if any changed key ∈ never-amendable set (unless `request.user.is_superuser` — Super-admin override, audit `rule_amend_override`).
2. Require `reason` ≥20 chars (DRF validation).
3. Stage the diff in `Tournament.pending_amend = {fields:{...}, before:{...}, after:{...}, effective_at, requested_by, reason}`. **Do not apply yet.**
4. `effective_at = now() + 24h` (configurable via `RULE_AMEND_GRACE_HOURS`; Super-admin can waive → `effective_at = now()`, audit `rule_amend_grace_waived`).
5. `emit_audit('rule_amend_proposed', payload_before/after per field)` + `on_commit` notify all affected roles.
6. A `ScheduledNotification`-style cron (or `apps.notifications` scheduler) fires at `effective_at` → `apply_pending_amend()` writes the staged fields onto `structured_rules`, clears `pending_amend`, `emit_audit('rule_amend_effective')`, notifies.
7. Amend can be **withdrawn** before `effective_at`: `POST /api/tournaments/{id}:withdraw-amend/` (audit `rule_amend_withdrawn`).

**Per-match rule freeze (#7 second boundary)** is enforced in `apps.matches` (PRD §5.5) — once a match is `live_first_half`, no amend reaches it retroactively; this app's amend never rewrites already-played match snapshots (`MatchEvent.payload` snapshots stand).

### 3.4 Guard implementation pattern

```python
# tournaments/services/state.py
ALLOWED = {
    "draft": {"published", "cancelled"},
    "published": {"registration_open", "cancelled"},
    "registration_open": {"registration_closed", "cancelled"},
    "registration_closed": {"bracket_generated", "cancelled"},
    "bracket_generated": {"scheduled", "cancelled"},
    "scheduled": {"live", "cancelled"},
    "live": {"completed", "cancelled"},
    "completed": {"archived"},
    "archived": set(), "cancelled": set(),
}

def transition(*, tournament, to_state, actor, actor_role, trigger,
               reason="", event_id=None, request=None):
    if tournament.is_paused and to_state not in {"cancelled"}:
        raise StateError("Tournament is paused; resume before transitioning.")
    if to_state not in ALLOWED[tournament.status]:
        raise StateError(f"{tournament.status} → {to_state} not allowed")
    _check_preconditions(tournament, to_state)        # per-row in §3.1 table
    with transaction.atomic():
        if event_id and TournamentStateTransition.objects.filter(
                idempotency_key=event_id).exists():
            return tournament                          # idempotent #3
        frm = tournament.status
        tournament.status = to_state
        if to_state == "registration_open" and not tournament.rule_freeze_at:
            tournament.rule_freeze_at = timezone.now()
        if to_state == "scheduled":
            tournament.tz_locked = True
        tournament.save(update_fields=[...])
        TournamentStateTransition.objects.create(
            tournament=tournament, from_state=frm, to_state=to_state,
            actor=actor, actor_role=actor_role, trigger=trigger,
            reason=reason, idempotency_key=event_id)
        emit_audit(actor_user=actor, actor_role=actor_role,
                   event_type="tournament_state_changed",
                   target_type="tournament", target_id=tournament.id,
                   organization_id=tournament.organization_id,
                   tournament_id=tournament.id,
                   payload_before={"status": frm}, payload_after={"status": to_state},
                   reason=reason, idempotency_key=event_id, request=request)
        transaction.on_commit(lambda: notify_state_change(tournament, frm, to_state))
    return tournament
```

A **`safe_migrate`** management command (B.18) aborts `migrate` if any `Tournament.objects.filter(status='live').exists()` — wired here because this app owns the `status` column.

---

## 4. Setup wizard (PRD §5.1)

### 4.1 Steps (all resumable via `Save draft`; tournament stays `draft`)

1. **Basics** — name, slug (auto, editable), Org (pre-filled = workspace or selected real Org), sport, description, start/end dates, time_zone (default Org TZ), visibility, `min_teams_to_start`.
2. **Format** — `single_elimination` / `round_robin_*` / `groups_knockout` selectable v1; `double_elimination`/`swiss`/`multi_stage` shown "Coming soon" (gated by `apps.fixtures` build phase, v1Fixtures §8).
3. **Structured rules** — full catalog (§5.13) rendered from `SportRuleDefaults` (football plugin); defaults inherited; written to `structured_rules` JSONB.
4. **Prose rulebook** — auto-generated from structured fields + Sport prose template; editable; `#10` conflict warning if structured fields change after manual edit.
5. **Venues** — create `Venue` rows (+ `VenueAvailability`).
6. **Days available** — calendar → `VenueAvailability(is_blackout=True)` and/or tournament-level blackout list.
7. **Roles** — invite Co-organizers (Org-level), Game coordinator(s) → creates `OrganizationMembership(role='game_coordinator')` + `TournamentMembership` (reuses `organizations.services.invitation`).
8. **Team registration** — open vs invite-only, approval-required toggle, registration window dates (`registration_open_at`/`registration_close_at`).
9. **Review & publish** — preview + validation gate → `transition(to_state='published')`.

### 4.2 Publish validation gate (PRD §5.1 step 9)

All enforced in `tournaments/services/validation.py::validate_publishable(tournament)` returning a structured field-error list:
- All required basics present (name, slug, sport, dates, time_zone).
- `structured_rules` passes the sport's JSON-schema.
- ≥1 `Venue`.
- ≥1 day available (≥1 non-blackout `VenueAvailability`).
- Registration window valid (`registration_open_at < registration_close_at`, both within `[start_date, end_date)` where applicable).
- `min_teams_to_start ≥ 2`.

---

## 5. DRF API (AIP-136 colon verbs — Appendix B.3)

Mounted at `/api/tournaments/`. Same conventions as `apps.organizations.urls` (verb routes BEFORE catch-all). Every endpoint `@extend_schema`-annotated (drf-spectacular, B.3). Idempotent writes accept `event_id` (header `Idempotency-Key` or body `event_id`).

### 5.1 Collection + resource

| Method + path | Action | Module gate | Notes |
|---|---|---|---|
| `GET /api/tournaments/` | List (scoped) | `org.tournament_list` | `TournamentQuerySet.visible_to(user, org)` (B.2) — Admin/Co-org see all org tournaments; GC sees assigned; scorer/ref/TM see via match/team. `?org=<slug>` selects active Org context. |
| `POST /api/tournaments/` | Create (self-serve) | `tournament.editor` OR none (auto-provisions workspace) | `creation.create_tournament` (§1.4). 201, or 200 on idempotent replay. |
| `GET /api/tournaments/{id}/` | Read | `org.tournament_list` (scoped) | slug-or-uuid like orgs; `SlugRedirect`-style 301 for renamed slugs. |
| `PATCH /api/tournaments/{id}/` | Update basics/rules | `tournament.editor` | only in `draft`/`published`; post-freeze fields rejected (use `:amend-rules`). |
| `DELETE /api/tournaments/{id}/` | Soft-delete | `tournament.editor` (owner-confirm) | sets `deleted_at`; only allowed in `draft`/`cancelled`. |

### 5.2 State + rule verbs

| `POST /api/tournaments/{id}:publish/` | → `published`; runs publish validation gate |
| `POST /api/tournaments/{id}:open-registration/` | force `published → registration_open` |
| `POST /api/tournaments/{id}:close-registration/` | force `registration_open → registration_closed` |
| `POST /api/tournaments/{id}:generate-bracket/` | `registration_closed → bracket_generated` (delegates `apps.fixtures`; body=draw params) |
| `POST /api/tournaments/{id}:lock-schedule/` | `bracket_generated → scheduled` (delegates `apps.fixtures`; precondition zero hard conflicts) |
| `POST /api/tournaments/{id}:go-live/` | force `scheduled → live` |
| `POST /api/tournaments/{id}:complete/` | `live → completed` (auto-fired when last match terminal; manual fallback) |
| `POST /api/tournaments/{id}:archive/` | `completed → archived` |
| `POST /api/tournaments/{id}:cancel/` | `* → cancelled` (reason ≥20) |
| `POST /api/tournaments/{id}:pause/` | overlay pause (reason) |
| `POST /api/tournaments/{id}:resume/` | overlay resume |
| `POST /api/tournaments/{id}:amend-rules/` | stage amend + 24h grace (§3.3) |
| `POST /api/tournaments/{id}:withdraw-amend/` | cancel staged amend |
| `GET /api/tournaments/{id}/transitions/` | append-only transition history |

### 5.3 Nested collections

| `GET/POST /api/tournaments/{id}/memberships/` | Game-coordinator assignments (`TournamentMembership`) |
| `POST /api/tournaments/{id}/memberships/{mid}:revoke/` | revoke assignment |
| `GET/POST /api/tournaments/{id}/stages/` · `/groups/` | structural containers |
| `GET/POST /api/tournaments/{id}/venues/` · `DELETE` | venues + availability |
| `GET /api/tournaments/{id}/validate/` | dry-run publish gate (returns field errors) |
| `GET /api/tournaments/{id}/audit/` | tournament-scoped audit (`tournament.audit_log` module) |

### 5.4 Permission classes

Reuse `apps.permissions.permissions` module-gate DRF permission classes. Pattern: a `RequiresModule("tournament.editor")` permission + the `TournamentQuerySet.visible_to` row filter (B.2). Multi-tenancy: **every** view resolves `request.org_context` from the tournament's `organization` and asserts the user has an active membership there; cross-org access → 404 (not 403, to avoid existence leak). One isolation test per endpoint (invariant #2).

---

## 6. SPA routes & pages (extends `frontend/src/lib/routes.ts`)

Today `routes.ts` has `orgTournamentsComingSoon`. Replace/augment with the real tournament surface. Feature folder: `frontend/src/features/tournaments/`. shadcn/ui + lucide + framer-motion per the Pro SaaS overhaul decision.

```ts
// additions to routes.ts
tournaments:        (slug)        => `/o/${slug}/tournaments`,
tournamentNew:      (slug)        => `/o/${slug}/tournaments/new`,
tournament:         (slug, tslug) => `/o/${slug}/t/${tslug}`,
tournamentEdit:     (slug, tslug) => `/o/${slug}/t/${tslug}/edit`,        // wizard
tournamentBracket:  (slug, tslug) => `/o/${slug}/t/${tslug}/bracket`,     // apps.fixtures
tournamentSchedule: (slug, tslug) => `/o/${slug}/t/${tslug}/schedule`,    // apps.fixtures
tournamentTeams:    (slug, tslug) => `/o/${slug}/t/${tslug}/teams`,       // apps.teams
tournamentRules:    (slug, tslug) => `/o/${slug}/t/${tslug}/rules`,
tournamentAudit:    (slug, tslug) => `/o/${slug}/t/${tslug}/audit`,
// public (slug,uuid) pair per #2.8 / PRD §5.10-§5.11
publicTournament:   (tslug, uuid) => `/t/${tslug}/${uuid}`,
```

| Page | Route | Key behaviour |
|---|---|---|
| **Tournament list** | `/o/:slug/tournaments` | cards by status; status filter; empty state ("Create your first tournament" → auto-provisions workspace on first create); module-gated by `org.tournament_list`. |
| **Setup wizard** | `/o/:slug/tournaments/new` + `/edit` | 9-step stepper (§4.1) w/ react-hook-form + zod per step; `Save draft` after each; sport-rule step renders from `SportRuleDefaults`; review step calls `GET .../validate/`. |
| **Tournament detail** | `/o/:slug/t/:tslug` | header w/ status badge + overlay chips (paused/disputed); action bar exposes only the legal next transitions (mirrors §3.1 `ALLOWED`); tabs → bracket/schedule/teams/rules/audit. |
| **Rules / amend** | `/o/:slug/t/:tslug/rules` | pre-freeze: inline edit; post-freeze: "Propose amendment" → reason ≥20 + 24h-grace banner showing `effective_at` + Withdraw; never-amendable fields disabled w/ tooltip. |
| **Bracket / Schedule** | `.../bracket`, `.../schedule` | owned by `apps.fixtures` UI; dnd-kit; regenerate/keep-manual/view-diff banner (#10). |
| **Public match center** | `/t/:tslug/:uuid` | PRD §5.10/§5.11 — SSE live (invariant #11); viewer-TZ render w/ tournament-TZ tooltip (#14); WCAG 2.1 AA (#13). |

All strings via `t()` (react-i18next, invariant #13). Org switcher + role-context indicator already exist in the layout shell (Appendix B.20) — tournament pages live inside it.

---

## 7. Tests to write

Mirrors the existing per-app `tests/` layout (`organizations/tests/`, etc.). pytest + factory_boy.

**Models / constraints**
- `unique_tournament_slug_per_org` + cross-org same-slug allowed.
- `unique_tournament_event_id_per_org` (idempotent create).
- `unique_active_tournament_role` (`TournamentMembership`).
- `TournamentStateTransition` append-only: `UPDATE`/`DELETE` raises at DB role level (#5).

**Self-serve provisioning (§1)**
- First-ever create for a user with no Admin Org → exactly one `is_personal_workspace=True` Org, status `active`, one admin membership.
- Second self-serve create by same user → **reuses** the workspace, no new Org, no constraint violation.
- A user already Admin of a real Org → self-serve create lands in the real Org, no workspace.
- `single_org_per_admin_user` never violated across the above.

**State machine (every transition + every blocked transition — PRD test layer)**
- Parametrized over `ALLOWED`: each legal transition succeeds + writes one transition row + one audit row; each illegal transition raises.
- Preconditions: `min_teams_to_start` gate on `:generate-bracket`; zero-hard-conflict gate on `:lock-schedule`; no-open-dispute gate on `:complete`; ≥1 assigned scorer+ref on `:go-live`.
- Overlays: pause blocks transitions; resume restores `paused_from_status`; cancel from any non-terminal; disputed overlay set/clear.
- Side effects: `rule_freeze_at` set on `registration_open`; `tz_locked` on `scheduled`.

**Rule freeze / amend (#7)**
- Pre-freeze PATCH applies directly.
- Post-freeze PATCH of frozen field rejected; `:amend-rules` stages it.
- Never-amendable (`format`, `tie_breaker_order`) rejected even via amend (allowed for superuser w/ override audit).
- 24h grace: staged amend not applied before `effective_at`; applied after; `:withdraw-amend` cancels.
- reason <20 chars rejected.

**RBAC / modules (parametrized over both layers, invariant #12)**
- `effective_modules` gates: Admin/Co-org full; GC sees only assigned-tournament rows; scorer/ref/TM scoped.
- Game-coordinator dual-membership invariant: Org-row-only = no access; Org+Tournament rows = access; revoking `TournamentMembership` removes access next request (B.2 contract).

**Multi-tenancy isolation (NOT optional, invariant #2)**
- For EVERY endpoint: user A in Org X cannot read/mutate Org Y tournament (404). `TournamentQuerySet.scoped_for_user` returns zero cross-org rows.

**API contract**
- AIP-136 colon verbs route correctly; idempotent replay returns 200 with same body; drf-spectacular schema present for each endpoint.

**i18n/a11y (#13)** — wizard + detail pages: all strings wrapped; axe checks on non-scorer pages.

---

## 8. Migration / build order

Slots into the locked B.18 sequence (tournament skeleton was `0009`/`0010`; this is the **full** realisation in Phase 1B, after the sport-football base migrations begin at `0016+`).

```
# Prereq (organizations app, ships with this phase):
000X_org_is_personal_workspace      # Organization.is_personal_workspace + index

# tournaments app:
0001_tournament                     # Tournament (full) + constraints + indexes
0002_tournament_state_transition    # TournamentStateTransition
0003_state_transition_append_only   # RunSQL: REVOKE UPDATE,DELETE (#5)
0004_tournament_membership          # TournamentMembership (replaces 1A stub fields)
0005_stage_group                    # Stage, Group
0006_venue_availability_blackout    # Venue, VenueAvailability, TeamBlackout
# (apps.fixtures migrations: SchedulingConstraint, ScheduleRun — separate app)
# (apps.teams / sport module: Team, Player, Person — fill TeamBlackout.team_id FK)
```

**Build order (TDD, tests-first per CLAUDE.md):**
1. Models + constraints + the append-only RunSQL + factories. (migrations 0001-0006)
2. `services/creation.py` (self-serve + workspace) — the blocker resolution; tests first.
3. `services/state.py` (transitions + guards + audit + on_commit) — state-machine test suite.
4. `services/validation.py` (publish gate).
5. `services/amend.py` (freeze + 24h grace + scheduled apply).
6. DRF serializers + views + urls (colon verbs) + module-gate permissions; contract + isolation tests.
7. `safe_migrate` management command (live-tournament guard).
8. SPA: routes + list + wizard + detail + rules/amend pages.
9. Wire `:generate-bracket`/`:lock-schedule` to `apps.fixtures` once that app lands (v1Fixtures §8 MVP).

**`safe_migrate` guard** (B.18): wrap `migrate`; abort if any `status='live'` tournament.

---

## 9. Reused chassis (do not rebuild)

| Need | Reuse |
|---|---|
| UUID v7 PK | `apps.accounts.models.uuid7` |
| Org tenancy + soft-delete + scope filter | `apps.permissions.scope.ScopedManager`/`ScopedQuerySet` (B.2) |
| Module gating + resolver | `apps.permissions.services.resolver.effective_modules`, `has_module`; `Module`/`MembershipModuleGrant` |
| Audit emission (service-layer, idempotent) | `apps.audit.services.emit_audit`; `ActorRole` taxonomy (B.5); event_type catalog (B.6) |
| Org create / slug validation / SlugRedirect | `apps.organizations.services.lifecycle.create_organization`, `services.slug.validate_slug`/`change_slug`/`resolve_slug` |
| Invites (Co-org / Game coordinator) | `apps.organizations.services.invitation` + `AdminInvitation` |
| OrganizationMembership + `single_org_per_admin_user` | `apps.organizations.models` (unchanged) |
| Sport reference | `apps.sports.models.Sport` |
| DRF colon-verb routing + extend_schema pattern | `apps.organizations.urls` / `views` as template |
| SPA route helpers + layout shell + Org switcher | `frontend/src/lib/routes.ts`, `features/layout`, `features/orgs` |

New event_types to add to B.6 catalog: `workspace_provisioned`, `tournament_min_teams_unmet`, `tournament_paused`, `tournament_resumed`, `tournament_disputed`, `tournament_dispute_cleared`, `tournament_orphaned`, `rule_amend_withdrawn`, `rule_amend_grace_waived`, `rule_amend_override` (the rest — `tournament_created/published/state_changed`, `bracket_*`, `schedule_*` — already catalogued).

---

## 10. Invariant compliance checklist

1. UUID v7 PKs ✓ (`uuid7`). 2. Org tenancy + isolation tests ✓ (ScopedManager + per-endpoint test). 3. Idempotent writes ✓ (`idempotency_key` on create + transitions). 4. DB-first; Redis publish in `on_commit` ✓. 5. Append-only at DB role ✓ (RunSQL REVOKE on transition table; AuditEvent already). 6. State machines not flags ✓ (`status` enum + guarded transitions + transition log). 7. Rule freeze at boundary ✓ (`rule_freeze_at` on `registration_open`; 24h grace amend; per-match freeze in matches app). 8. Person↔Player split — n/a here (sport module). 9. Typed match deps — `apps.matches`/`apps.fixtures`. 10. inputs_hash + last_manual_edit_at + regenerate banner ✓. 11. SSE one-way / WS two-way ✓ (public match center = SSE). 12. Module RBAC default-deny ✓ (`effective_modules`, dual GC membership). 13. i18n + a11y ✓ (`t()`, WCAG on non-scorer). 14. UTC storage + tournament/viewer TZ render + `tz_locked` on scheduled ✓. 15. Session auth no-JWT ✓ (inherits SPA cookie/CSRF chassis).

---

## 11. Open questions (deferred; non-blocking)

- **Workspace ↔ real-Org collision:** a self-serve user with a personal workspace who later accepts a Super-admin Admin invite — must transfer/leave the workspace first (blocked by `single_org_per_admin_user`). Recommend: on invite-accept, offer "convert workspace to this Org" or "demote workspace admin". Defer to invite-flow polish.
- **`tie_breaker_order` lives inside `structured_rules` JSONB** — never-amendable enforcement must inspect a JSON key, not a column. Acceptable; documented in the amend service.
- **Demo tournament (PRD §5.17)** lifecycle (`is_demo=True`) — auto-archive cadence; defer to onboarding milestone.
- **Cron transport** for auto-transitions (2,3,6,8) and amend-apply — reuse `apps.notifications` `ScheduledNotification` queue vs. a dedicated Channels worker — decide at `apps.fixtures`/`apps.live` integration.
- **Multi-stage `Stage.params` schema** — finalise with v1Fixtures phase 2 (groups→knockout, multi_stage).
```
