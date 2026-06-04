# v1Disputes.md — Dispute lifecycle, resolution & cascade engine (DEEP DESIGN)

Status: design draft v1 (2026-06-04). Phase 1B. Sport-agnostic chassis; football is the
first consumer. This document is implementation-ready: models with fields, services,
API, SPA, tests, migration/build order, and exactly which chassis it reuses.

Canonical sources, with line cites:
- PRD `docs/superpowers/specs/2026-04-30-fixture-platform-prd.md`
  - §5.7 Score correction & dispute workflow — PRD:493-516
  - §5.5 Match state machine + `disputed` overlay — PRD:391-423 (overlay PRD:401,423)
  - §5.2 Tournament side state `disputed` — PRD:295,314
  - §8 data model `Dispute` baseline — PRD:957
  - §5.14 notification recipients `dispute_raised` / `dispute_resolved` — PRD:703-704
  - §10 domain-event hook `dispute_resolved → propagate advancement per dispute_cascade_policy` — PRD:862
  - §3.2 RBAC verbs "Raise dispute" / "Resolve dispute" — PRD:173-174
  - §11 phasing: text-only v1.0, photo/video evidence v1.5 — PRD:239,508,1057
- v1Users.md `docs/superpowers/specs/v1Users.md`
  - GameCoord resolve-dispute scope = tournament-scoped — v1Users.md:876,938,1069
  - Referee can raise but not resolve — v1Users.md:1344, PRD:174
  - `TournamentMembership` shape — v1Users.md:959-977
  - `MatchAssignment` shape — v1Users.md:1173-1195
  - Module catalog A.2 / role→module map A.3 — v1Users.md:2105-2168
  - `effective_modules()` resolver + override layer A.4 — v1Users.md:2174-2252
  - Scope-filter pattern B.2 — v1Users.md:2277-2318
  - event_type catalog B.6 (`dispute_resolved` present; `dispute_raised` MISSING) — v1Users.md:2452,2455-2461
  - Migration order B.18 — v1Users.md:2672-2693
- v1Fixtures.md `docs/superpowers/specs/v1Fixtures.md`
  - Typed pointers + advancement is a `transaction.on_commit` hook, never inferred — v1Fixtures.md:16,39
  - `Match.home_source`/`away_source` JSONB, advancement edges — v1Fixtures.md:182

Existing chassis read and reused (verbatim integration points):
- `apps.audit.services.emit_audit(...)` — backend/apps/audit/services.py:24-77 (the ONLY way to write audit)
- `apps.audit.models.AuditEvent` + append-only DB trigger — backend/apps/audit/models.py:35-100, backend/apps/audit/migrations/0002_audit_append_only.py
- `apps.accounts.models.uuid7` PK helper — imported by every model (e.g. backend/apps/organizations/models.py:26)
- `apps.permissions.permissions.HasModule(code)` DRF class factory + `get_organization()` hook — backend/apps/permissions/permissions.py:30-83
- `apps.permissions.services.resolver.effective_modules / has_module` — backend/apps/permissions/services/resolver.py:107-137
- `OrganizationMembership` / `MembershipRole` — backend/apps/organizations/models.py:44-52,169-239
- `ActorRole` taxonomy for audit `actor_role` snapshot — backend/apps/audit/models.py:22-32

---

## 0. Scope of this document

In scope (v1.0):
- Post-final **Dispute** entity, its lifecycle state machine, the **multiple-simultaneous-dispute**
  policy, anti-spam, the dispute window, and the `disputed` overlay on `Match` / `Tournament`.
- **Resolution outcomes** (`score_amended`, `walkover_awarded`, `match_replayed`, `dispute_dismissed`).
- The **cascade engine**: when a resolution changes a match outcome, how the change propagates
  to standings and to dependent matches per `dispute_cascade_policy`.
- Audit at every transition; notifications; RBAC; multi-tenant isolation.
- Models, services, DRF API, SPA routes/pages, tests, migration/build order.

Out of scope (deferred, with the same boundaries the PRD already drew):
- **Pre-final correction** (referee/scorer edits an event → `corrected` event) — that is a
  `matches`-app concern (PRD:495-496, event_status `corrected` at PRD:455). Disputes are strictly
  **post-`final`** (PRD:498-500). This doc references it only at the boundary.
- **Photo / video evidence uploads** — v1.5 (PRD:239,508). v1.0 is **text only**. Schema is
  designed forward-compatible (a `DisputeEvidence` table is specified but flagged v1.5; v1.0 stores
  description text on the `Dispute` row).
- The bracket/schedule **generator** itself (v1Fixtures.md). The cascade engine *invokes*
  advancement that the fixtures engine owns; it does not reimplement draw logic.

LOCKED project decision honored: self-serve workspace model — there is **no super-admin approval
gate**; dispute resolution authority is the tournament Admin / Co-organizer / scoped Game
coordinator, reusing the 5 in-org roles + `TournamentMembership` scope.

---

## 1. Domain model & invariants

### 1.1 Where a dispute lives in the graph

```
Organization ──< Tournament ──< Match ──< Dispute
                        │            │        └─< DisputeResolution (0..1, terminal)
                        │            └─ status overlay: `disputed` (PRD:401)
                        └─ side state overlay: `disputed` (PRD:295) — set when ≥1 match disputed
```

A `Dispute` is **always** rooted at a `Match` (PRD:957 `Dispute(match, …)`). The Match's
`tournament` and `tournament.organization` give the tenant scope — no separate `organization` FK
is stored on `Dispute` (derive via `match.tournament.organization_id`), matching how `AuditEvent`
carries denormalized scope ids only for indexing (audit/models.py:62-65). For query performance we
**do** denormalize `tournament_id` and `organization_id` onto `Dispute` (set in the create service,
never editable) so the scope-filter querysets (B.2) avoid a 3-join on every list.

### 1.2 Invariants this feature must uphold (mapped to the 15)

| # | Invariant | How disputes honor it |
|---|-----------|------------------------|
| 1 | UUID v7 PK | `id = UUIDField(default=uuid7)` on every model (accounts.uuid7). |
| 2 | Multi-tenant isolation | `organization_id`/`tournament_id` denormalized + `DisputeQuerySet.visible_to()` (B.2). Mandatory cross-org leak test on every endpoint. |
| 3 | Idempotent writes | Raise + every resolution accepts client `event_id` UUID with unique DB constraint → resubmit returns existing row (200). |
| 4 | DB-first event log | `Dispute`/`DisputeResolution` rows are system of record; Redis publish (`match:<uuid>` SSE) only in `transaction.on_commit`. |
| 5 | Append-only audit | Every transition calls `emit_audit()`; AuditEvent UPDATE/DELETE denied at DB role level (already enforced). |
| 6 | State machines | `DisputeStatus` enum with an explicit `ALLOWED_TRANSITIONS` table + a guarded `transition()` service (no boolean flags). |
| 7 | Rule freeze | Cascade resolution that "amends score" must NOT mutate frozen match rules; it amends the *result*, audited (PRD:427 per-match freeze stands). |
| 8 | Person↔Player | Disputes never touch identity; resolution outcomes that re-award reference Team, not Person. |
| 9 | Typed match deps | Cascade re-runs advancement over `home_source`/`away_source` typed pointers (v1Fixtures.md:39) — never re-infers from bracket shape. |
| 10 | inputs_hash + manual edit | A cascade that recomputes a downstream bracket/schedule sets the regenerate banner state (stores `inputs_hash`); never silently clobbers manual edits. |
| 11 | SSE one-way / WS two-way | Dispute status changes broadcast to public via SSE `match:<uuid>` (status only, no details) and to organizers via `user:<uuid>:notifications` SSE. No WebSocket. |
| 12 | Module RBAC default-deny | New module `match.dispute_console`; raise/resolve verbs gated by `HasModule` + scope filter. |
| 13 | i18n + a11y | All strings `gettext`/`t()`; resolution forms WCAG 2.1 AA. |
| 14 | UTC | All datetimes UTC; window math in UTC; rendered in tournament TZ for organizers, viewer TZ for public. |
| 15 | Session auth | Same DRF + session cookie + CSRF; no JWT. |

---

## 2. Dispute lifecycle state machine

### 2.1 States (PRD:502)

```
raised ──► under_review ──► resolved   (terminal)
   │             │
   └─────────────┴──► withdrawn  (terminal; raiser cancels before resolution)
```

`DisputeStatus` (TextChoices):
- `raised` — created by an eligible party within the window; match flips to `disputed`.
- `under_review` — a resolver has claimed/opened it (optional but recorded; can resolve directly from `raised`).
- `resolved` — terminal; carries exactly one `DisputeResolution`.
- `withdrawn` — terminal; raiser (or Admin) cancels before resolution; counts toward neither outcome.

> Added beyond PRD:502 (`raised → under_review → resolved`): a **`withdrawn`** terminal state.
> Rationale: the anti-spam rule (PRD:505 "1 active + 1 resolved per match") needs a way for a
> raiser to retract a mistaken dispute without consuming their "resolved" slot. This is a new
> decision — log it in PRD §14 when folding in. It does not contradict PRD:502; it adds an escape
> edge. (`withdrawn` is treated as terminal-but-not-resolved for advancement: it does NOT trigger
> cascade.)

### 2.2 Transition table (every transition specifies trigger / precondition / actor / notify / audit)

| From | To | Trigger | Preconditions | Allowed actor | Notifies | event_type |
|------|----|---------|---------------|---------------|----------|------------|
| (none) | `raised` | Party raises dispute | Match in `final`/`walkover`/`abandoned`; now ≤ `final_at + dispute_window_hours`; raiser within anti-spam quota; raiser eligible (own-team TM / referee-of-match / GC-of-tournament / Admin / Co-org); description ≥30 chars | TM(own team), Referee(assigned), GameCoord(tournament), Admin, Co-org (PRD:499) | `dispute_raised`† | `dispute_raised`† |
| `raised` | `under_review` | Resolver opens it | Resolver has resolve authority + scope | resolver, opposing TM, organizers | `dispute_under_review`† | `dispute_under_review`† |
| `raised` | `resolved` | Resolver resolves (skip review) | Resolver authority + scope; outcome valid; reason ≥20 | raiser, opposing TM, Admin, GameCoord (PRD:704) | `dispute_resolved` | `dispute_resolved` |
| `under_review` | `resolved` | Resolver resolves | same as above | same as above | `dispute_resolved` | `dispute_resolved` |
| `raised`/`under_review` | `withdrawn` | Raiser cancels (or Admin force-withdraw) | Actor == raiser OR Admin/Co-org; dispute not yet resolved | raiser, organizers | `dispute_withdrawn`† | `dispute_withdrawn`† |

† **event_type gap**: v1Users.md B.6 catalog (line 2452) contains only `dispute_resolved`.
`dispute_raised`, `dispute_under_review`, `dispute_withdrawn` are **NOT** in B.6. ACTION: add these
four strings to the B.6 event_type catalog (and `dispute_raised`/`dispute_resolved` are already in
PRD §5.14 at PRD:703-704). Confidence: high (B.6 is incomplete for §5.7).

The machine is implemented exactly like the existing pattern intent (invariant 6): a module-level
`ALLOWED_TRANSITIONS: dict[DisputeStatus, set[DisputeStatus]]` and a single
`transition(dispute, to_state, *, actor, role, reason, request)` service that:
1. asserts `(dispute.status, to_state)` is in `ALLOWED_TRANSITIONS` else raises `IllegalTransition`;
2. checks preconditions (window, quota, authority) — see §5;
3. mutates the row inside a `transaction.atomic()`;
4. calls `emit_audit(...)` inline (audit/services.py:24) with `payload_before`/`payload_after`;
5. schedules notifications + SSE publish via `transaction.on_commit` (invariant 4, 11);
6. recomputes the Match/Tournament `disputed` overlay (§4).

### 2.3 Match & Tournament `disputed` overlay (PRD:401,295,314,506)

`disputed` is an **overlay**, not a primary state — the match keeps its underlying terminal state
(`final`/`walkover`/`abandoned`) and gains a boolean-derived overlay. Two acceptable
implementations; we pick **(B)** for auditability:

- (A) a `Match.status` side-value `disputed` (PRD models it as a side state).
- (B) **chosen:** a derived overlay computed from open disputes, surfaced as `Match.is_disputed`
  (a `@property` / annotated field) AND, because PRD:506 says "Match enters `disputed` state",
  a persisted `Match.disputed_overlay: bool` field maintained by the dispute service so the public
  Match Center and SSE payload can read it without a subquery.

Rule (PRD:506, 504):
- On first `raised` for a match → set `match.disputed_overlay = True`; **advancement is paused**
  for that match (a downstream-pause flag; see §6.2).
- The overlay **auto-clears** only when **all** disputes for that match are terminal
  (`resolved` or `withdrawn`) (PRD:295 "auto-clears when all resolved", PRD:504 "advancement only
  recomputes once after all resolved").
- Tournament side state `disputed` (PRD:314) is itself derived: tournament `is_disputed` =
  `Match.objects.filter(tournament=t, disputed_overlay=True).exists()`. Maintained by the same
  service on every overlay change.

### 2.4 The dispute window (PRD:500, glossary PRD:1210)

- Source of truth: `Tournament.dispute_window_hours` (PRD:653, default 24).
- Window opens at the Match's `final_at` transition timestamp (the `matches` app records this;
  for `walkover`/`abandoned` use the analogous terminal timestamp).
- `window_closes_at = match.final_at + timedelta(hours=tournament.dispute_window_hours)`.
- Raise is **blocked** (validation error, HTTP 422) once `now() > window_closes_at`, EXCEPT an
  Admin/Co-org may raise out-of-window with reason (audit `dispute_raised` + `out_of_window=True`
  flag in payload). This mirrors PRD:505's "third blocked unless Admin overrides" override posture.
- Computed in UTC (invariant 14). Window math is a pure function `is_window_open(match, now)` so it
  is unit-testable without DB.

### 2.5 Anti-spam quota (PRD:505)

Rule: **same party limited to 1 active + 1 resolved per match; third blocked unless Admin overrides.**

- "Party" = `raised_by_user`. "Active" = status in (`raised`, `under_review`).
  "Resolved" = status `resolved`. `withdrawn` does NOT count toward either bucket.
- Enforced at TWO layers:
  - **Service layer**: count query before insert; raise `DisputeQuotaExceeded` (HTTP 409) unless
    actor is Admin/Co-org passing `override_quota=True` + reason.
  - **DB layer (partial unique constraint)**: at most one *active* dispute per
    `(match, raised_by_user)`:
    `UniqueConstraint(fields=['match','raised_by_user'], condition=Q(status__in=['raised','under_review']), name='one_active_dispute_per_party_per_match')`.
    This is the hard guarantee; the "1 resolved" cap is service-only (a partial unique on a count
    isn't expressible as a single constraint — covered by service + test).

---

## 3. Resolution outcomes & the cascade engine

### 3.1 Resolution outcomes (PRD:502)

`ResolutionOutcome` (TextChoices):

| Outcome | Meaning | Result mutation | Triggers cascade? |
|---------|---------|-----------------|-------------------|
| `dispute_dismissed` | Dispute rejected; original result stands | none | No |
| `score_amended` | Result corrected to a new scoreline | new home/away score applied to the match result via the matches-app `amend_result` service | Yes (if winner changes) |
| `walkover_awarded` | One side awarded a walkover | match → `walkover` terminal + `walkover_score`; loser eliminated | Yes |
| `match_replayed` | Match must be replayed | match result voided; match returned to a re-playable state; a replay match/slot is flagged | Yes (downstream marked replay-required / pending) |

The mutation of the **match result** itself is owned by the **matches** app
(`apps.matches.services.amend_result / award_walkover / order_replay`). The dispute resolution
service **calls** those and is responsible only for: recording the `DisputeResolution`, choosing the
cascade policy, and invoking the cascade engine on `on_commit`. This keeps the match state machine
(PRD §5.5) the single owner of match-result transitions (invariant 6) and avoids two code paths that
mutate scores.

### 3.2 `DisputeResolution` record

One per resolved `Dispute` (1:1). Captures everything needed to reconstruct the decision and audit
the cascade:

- `outcome` (enum above)
- `resolution_notes` (text, ≥20 chars, required) — PRD:957 `resolution_notes`
- `new_home_score` / `new_away_score` (nullable; required when outcome=`score_amended`)
- `awarded_winner_team_id` (nullable; required when outcome=`walkover_awarded`)
- `cascade_policy_applied` — enum `dispute_cascade_policy` snapshotted at resolution time
  (PRD:512-516, default from `Tournament.dispute_cascade_policy` PRD:654 but organizer may override
  per resolution — PRD:516 "Organizer chooses at resolution time; default applied if unspecified").
- `result_changed` (bool) — did the winner/advancement-relevant outcome actually change? Computed;
  drives whether cascade runs at all.
- `cascade_report` (JSONB) — machine record of what the cascade did (list of affected match ids +
  action taken + before/after). Written by the cascade engine; used by audit + the UI diff banner.

### 3.3 Cascade policy semantics (PRD:510-516)

`Tournament.dispute_cascade_policy` (PRD:654), three values; the resolution may override:

| Policy | Unplayed dependents | Already-played dependents | History |
|--------|---------------------|---------------------------|---------|
| `strict_unplayed_lenient_played` (default) | **Recomputed** via advancement | **Stand historically** (flagged inconsistent, not replayed) | preserved |
| `strict_all` | Recomputed | **Flagged `replay_required=True`** on each downstream Match (organizer schedules replays) | preserved + flags |
| `lenient_all` | **No propagation**; amend recorded only | stand | amend audited, nothing recomputed |

### 3.4 Cascade engine algorithm

Entry point (domain-event hook, fires on `transaction.on_commit` after the resolution commits —
PRD:862, invariant 4):

```
def cascade_after_resolution(resolution):  # apps.disputes.services.cascade
    match = resolution.dispute.match
    if not resolution.result_changed:
        return  # dismissed, or amend that didn't change winner → nothing to do
    policy = resolution.cascade_policy_applied
    if policy == 'lenient_all':
        record_cascade_report(resolution, action='no_propagation')
        return

    # 1. Compute the NEW advancement outputs for `match` from its typed sources.
    #    Advancement resolution is OWNED by the fixtures/matches engine
    #    (v1Fixtures.md:16,39). We call it; we do not re-infer bracket shape.
    affected = find_dependent_matches(match)   # matches whose home_source/away_source
                                               # reference winner_of/loser_of/group_position(match)

    for dep in affected:
        played = dep.is_played()               # terminal result exists
        recomputed_source = resolve_typed_pointer(dep, changed_match=match)
        if not played:
            apply_recomputed_participant(dep, recomputed_source)   # safe: re-point + notify
        else:
            if policy == 'strict_all':
                dep.replay_required = True
                dep.save(update_fields=['replay_required'])
            else:  # strict_unplayed_lenient_played
                dep.history_inconsistent = True   # advisory flag; UI shows banner; no mutation
                dep.save(update_fields=['history_inconsistent'])

    # 2. Group/league standings: if `match` is a group match, recompute standings
    #    atomically (PRD:529 recompute trigger == every result change).
    if match.is_group_stage():
        recompute_standings(match.group)        # owned by fixtures/standings module

    # 3. Record machine report + audit + notify advanced/eliminated teams.
    record_cascade_report(resolution, affected=affected)
```

Key properties:
- **Single recompute after all disputes settle** (PRD:504): the cascade engine is only invoked from
  the resolution `on_commit` of the *last* terminal dispute for that match. Guard:
  `if match.has_open_disputes(): defer`. Advancement stays paused until the overlay clears (§2.3).
- **Typed pointers only** (invariant 9, v1Fixtures.md:39): `resolve_typed_pointer` reads
  `dep.home_source`/`away_source` JSONB (`winner_of`/`loser_of`/`group_position`/`team`/`tbd`) and
  re-resolves; it never reads bracket adjacency.
- **inputs_hash / manual-edit guard** (invariant 10): when a recompute would change a downstream
  match whose `last_manual_edit_at` is set, the engine does NOT clobber — it sets the
  regenerate/keep-manual/view-diff banner state and records it in `cascade_report`.
- **Idempotent**: cascade keyed off `resolution.id`; re-running (e.g. retried on_commit) detects an
  existing `cascade_report` and no-ops.
- **Already-played dependents never auto-mutate** under the default policy — only flagged. This is
  the "default lenient-for-played" risk mitigation (PRD:1078).

### 3.5 Domain-event hooks (wired into the §10 hook list, PRD:859-862)

- `dispute_resolved` → `cascade_after_resolution` (this doc). PRD:862 already names this hook.
- Reuses existing `match_finalized → propagate advancement; update standings; update leaderboard`
  (PRD:860) — the cascade for unplayed dependents funnels through the SAME advancement function so
  there is one advancement code path (no divergence between first-time advancement and re-advancement).

---

## 4. Models (apps/disputes/models.py)

All PKs `UUIDField(primary_key=True, default=uuid7, editable=False)` (accounts.uuid7).

### 4.1 `Dispute`

```python
class DisputeStatus(models.TextChoices):
    RAISED = "raised", _("Raised")
    UNDER_REVIEW = "under_review", _("Under review")
    RESOLVED = "resolved", _("Resolved")
    WITHDRAWN = "withdrawn", _("Withdrawn")

class Dispute(models.Model):
    id = uuid7 PK
    # Idempotency (invariant 3): client-supplied event_id, unique.
    event_id = models.UUIDField(unique=True, db_index=True)

    match = FK("matches.Match", on_delete=PROTECT, related_name="disputes")
    # Denormalized scope (set in service, never editable) for B.2 filters + isolation tests.
    tournament_id = UUIDField(db_index=True)
    organization_id = UUIDField(db_index=True)

    raised_by_user = FK(User, on_delete=SET_NULL, null=True, related_name="disputes_raised")
    raised_by_role = CharField(choices=ActorRole.choices)   # role snapshot at raise time
    # Which team this raiser represents, when raiser is a TM (nullable for referee/organizer).
    raised_for_team_id = UUIDField(null=True, blank=True)

    status = CharField(choices=DisputeStatus.choices, default=RAISED, db_index=True)
    description = TextField()                 # ≥30 chars (PRD:501); validated in serializer+service
    out_of_window = BooleanField(default=False)   # True iff admin-override raise past window

    raised_at = DateTimeField(auto_now_add=True)
    under_review_at = DateTimeField(null=True, blank=True)
    under_review_by = FK(User, null=True, on_delete=SET_NULL, related_name="+")
    closed_at = DateTimeField(null=True, blank=True)   # resolved_at OR withdrawn_at
    withdrawn_reason = TextField(blank=True)

    created_at = DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "disputes_dispute"
        constraints = [
            UniqueConstraint(fields=["match", "raised_by_user"],
                             condition=Q(status__in=["raised", "under_review"]),
                             name="one_active_dispute_per_party_per_match"),
        ]
        indexes = [
            Index(fields=["tournament_id", "status"]),
            Index(fields=["match", "status"]),
            Index(fields=["organization_id", "-created_at"]),
        ]
```

### 4.2 `DisputeResolution` (1:1 terminal)

```python
class ResolutionOutcome(models.TextChoices):
    SCORE_AMENDED = "score_amended", _("Score amended")
    WALKOVER_AWARDED = "walkover_awarded", _("Walkover awarded")
    MATCH_REPLAYED = "match_replayed", _("Match replayed")
    DISPUTE_DISMISSED = "dispute_dismissed", _("Dispute dismissed")

class CascadePolicy(models.TextChoices):
    STRICT_UNPLAYED_LENIENT_PLAYED = "strict_unplayed_lenient_played", _("Strict unplayed / lenient played")
    STRICT_ALL = "strict_all", _("Strict (all dependents)")
    LENIENT_ALL = "lenient_all", _("Lenient (no propagation)")

class DisputeResolution(models.Model):
    id = uuid7 PK
    event_id = UUIDField(unique=True)              # idempotent resolution
    dispute = OneToOneField(Dispute, on_delete=PROTECT, related_name="resolution")
    outcome = CharField(choices=ResolutionOutcome.choices)
    resolution_notes = TextField()                 # ≥20 chars
    resolved_by_user = FK(User, on_delete=SET_NULL, null=True, related_name="disputes_resolved")
    resolved_by_role = CharField(choices=ActorRole.choices)

    new_home_score = PositiveSmallIntegerField(null=True, blank=True)
    new_away_score = PositiveSmallIntegerField(null=True, blank=True)
    awarded_winner_team_id = UUIDField(null=True, blank=True)

    cascade_policy_applied = CharField(choices=CascadePolicy.choices)
    result_changed = BooleanField(default=False)
    cascade_report = JSONField(default=dict, blank=True)   # written by cascade engine

    resolved_at = DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "disputes_resolution"
        constraints = [
            # score_amended requires both scores; walkover requires a winner team.
            CheckConstraint(
                name="resolution_payload_matches_outcome",
                condition=(
                    (Q(outcome="score_amended") & Q(new_home_score__isnull=False) & Q(new_away_score__isnull=False))
                    | (Q(outcome="walkover_awarded") & Q(awarded_winner_team_id__isnull=False))
                    | Q(outcome__in=["match_replayed", "dispute_dismissed"])
                ),
            ),
        ]
```

### 4.3 `DisputeEvidence` — DEFERRED to v1.5 (PRD:239,508)

Specified now for forward-compat; **not migrated in v1.0**. v1.0 stores text in
`Dispute.description`. v1.5 adds:

```python
class DisputeEvidence(models.Model):   # v1.5 ONLY
    id = uuid7 PK
    dispute = FK(Dispute, related_name="evidence")
    uploaded_by = FK(User, on_delete=SET_NULL, null=True)
    file = FileField(...)              # MIME-sniff + size + dimension cap (PRD:1079)
    kind = enum("photo", "video")
    caption = TextField(blank=True)
    created_at = DateTimeField(auto_now_add=True)
```

### 4.4 Manager / QuerySet (scope-filter, B.2 — v1Users.md:2277-2318)

```python
class DisputeQuerySet(models.QuerySet):
    def for_org(self, org):
        return self.filter(organization_id=org.id)

    def visible_to(self, user, org):
        modules = effective_modules(user, org)            # resolver.py:107
        base = self.filter(organization_id=org.id)
        # Admin / Co-org: all org disputes (they hold tournament.editor).
        if "tournament.editor" in modules:
            return base
        # Game coordinator: disputes in assigned tournaments.
        gc_tids = TournamentMembership.objects.filter(
            user=user, status="active", tournament__organization=org
        ).values_list("tournament_id", flat=True)
        # Referee / Scorer: disputes on matches they are assigned to.
        ma_mids = MatchAssignment.objects.filter(
            user=user, status="assigned", match__tournament__organization=org
        ).values_list("match_id", flat=True)
        # Team manager: disputes on matches involving their team, or raised by them.
        tm_tids = TeamMembership.objects.filter(
            user=user, status="active", team__tournament__organization=org
        ).values_list("team__tournament_id", flat=True)
        return base.filter(
            Q(tournament_id__in=set(gc_tids) | set(tm_tids))
            | Q(match_id__in=set(ma_mids))
            | Q(raised_by_user=user)
        ).distinct()
```

(`TournamentMembership` v1Users.md:959; `MatchAssignment` v1Users.md:1173; `TeamMembership`
referenced in B.2 v1Users.md:2304 — all Phase-1B siblings.)

---

## 5. Authorization (RBAC)

### 5.1 New module (add to v1Users.md Appendix A.2 / A.3)

Add one match-scoped module: **`match.dispute_console`** — "Dispute Console: raise, review, and
resolve disputes on a match." Default role→module map (A.3 conventions):

| Module | Admin | Co-org | GameCoord | Scorer | Referee | TeamMgr |
|--------|:-----:|:------:|:---------:|:------:|:-------:|:-------:|
| `match.dispute_console` | ✅ | ✅ | 🔵 assigned tournament | — | 🔵 assigned (raise-only) | 🔵 own team (raise-only) |

> This brings the module catalog 22 → 23. ACTION: add to A.2/A.3 and to
> `apps/permissions/fixtures/modules.json` (loaded by `load_modules`,
> backend/apps/permissions/management/commands/load_modules.py). Confidence: high — PRD:173-174
> already separates "Raise" from "Resolve"; module gives surface visibility, verb gates the action.

Module visibility ≠ verb authority. Two distinct checks (PRD §3.2 verbs are the canonical authority,
CLAUDE.md invariant 12):

- **Raise** (`HasModule("match.dispute_console")` + verb check `can_raise_dispute`):
  TM(own team), Referee(assigned match), GameCoord(tournament), Admin, Co-org (PRD:499,173).
- **Resolve** (`HasModule("match.dispute_console")` + verb check `can_resolve_dispute`):
  Admin, Co-org, **GameCoord scoped to their assigned tournament** (PRD:174,503; v1Users.md:876,938,
  1069 promotes "sport-scoped" → "tournament-scoped" in v1.0). Referee/Scorer/TM CANNOT resolve
  (PRD:174; v1Users.md:1344,1167).

### 5.2 Verb predicates (apps/disputes/permissions.py)

Reuse the `HasModule(code)` class factory (permissions.py:30) for surface gating, and add
function predicates for the verb layer, parametrized in the matrix test:

```python
def can_raise_dispute(user, match) -> bool: ...     # role ∈ {admin,co_org} OR
                                                    #   (gc & TournamentMembership active) OR
                                                    #   (referee & MatchAssignment active) OR
                                                    #   (tm & TeamMembership in match.teams)
def can_resolve_dispute(user, match) -> bool: ...   # role ∈ {admin,co_org} OR
                                                    #   (gc & TournamentMembership(match.tournament) active)
```

Both resolve org via `match.tournament.organization`, then call `effective_modules` + role checks.
DRF views expose `get_organization()` so `HasModule` resolves scope (permissions.py:52-80).

### 5.3 Sensitive-action friction

Resolving with a result-changing outcome (`score_amended`/`walkover_awarded`/`match_replayed`):
require `reason` (=`resolution_notes`) ≥20 chars (mirrors module-grant reason policy
permissions/models.py:132-136). No password re-prompt required (that posture is reserved for team
disqualification, v1Users.md:875). Out-of-window raise + quota override are Admin-only and audited
with explicit payload flags.

---

## 6. Interaction with the Match / Tournament state machines

### 6.1 Raising

- Precondition: match is in a terminal state eligible for dispute (`final`/`walkover`/`abandoned`,
  PRD:415-422) AND within window (§2.4). Disputing a `live`/`scheduled` match is rejected (use
  pre-final correction instead, PRD:495).
- Effect: `match.disputed_overlay = True` (§2.3); tournament overlay derived True. Public SSE
  `match:<uuid>` emits status `disputed` with **no details** (PRD:507,556).

### 6.2 Advancement pause

- While `match.disputed_overlay` is True, **advancement is paused** for that match (PRD:506,423).
  Implementation: the matches/fixtures advancement hook checks `match.disputed_overlay` before
  propagating; if paused, it records `advancement_pending=True` on dependent matches (which the
  public bracket renders as "pending"). No new code path — the existing `match_finalized` hook gains
  a guard `if match.disputed_overlay: return` (PRD:860).

### 6.3 Resolving & cascade

- On the LAST dispute for a match reaching `resolved`/`withdrawn`, overlay clears, and (if any
  resolution `result_changed`) the cascade engine runs once on `on_commit` (§3.4, PRD:504).
- A `withdrawn`-only settlement (no resolution changed anything) simply clears the overlay and
  resumes normal advancement via the standard `match_finalized` path.

### 6.4 Rule-freeze respect (invariant 7, PRD:427)

A `score_amended`/`walkover_awarded` resolution amends the **result**, never the frozen match
**rules**. The matches-app `amend_result` service asserts it touches only score/outcome fields and
audits before/after. Replays create a NEW match instance/slot under the (still-frozen) original
rules rather than unfreezing.

---

## 7. API (DRF, session auth, CSRF — invariant 15)

Base: `/api/v1/`. All list/detail endpoints run through `DisputeQuerySet.visible_to` (§4.4) →
isolation guaranteed. All mutation endpoints accept `event_id` (idempotency) and resubmission
returns the existing row with **200** (invariant 3).

### 7.1 Endpoints

| Method | Path | Module gate | Verb gate | Notes |
|--------|------|-------------|-----------|-------|
| `GET` | `/matches/{match_id}/disputes/` | `match.dispute_console` (or `tournament.editor`) | visible_to filter | list disputes for a match (organizers/parties only); public gets none |
| `POST` | `/matches/{match_id}/disputes/` | `match.dispute_console` | `can_raise_dispute` | raise. Body: `{event_id, description(≥30), raised_for_team_id?, override_window?, override_quota?}` → 201 (or 200 on idempotent replay). 422 window closed; 409 quota |
| `GET` | `/disputes/{id}/` | `match.dispute_console` | visible_to | detail incl. resolution + cascade_report |
| `POST` | `/disputes/{id}/claim/` | `match.dispute_console` | `can_resolve_dispute` | `raised → under_review` |
| `POST` | `/disputes/{id}/resolve/` | `match.dispute_console` | `can_resolve_dispute` | Body: `{event_id, outcome, resolution_notes(≥20), new_home_score?, new_away_score?, awarded_winner_team_id?, cascade_policy?}` → resolves + schedules cascade |
| `POST` | `/disputes/{id}/withdraw/` | `match.dispute_console` | raiser OR admin/co_org | Body: `{event_id, withdrawn_reason}` |
| `GET` | `/tournaments/{id}/disputes/` | `tournament.editor`/`tournament.audit_log` | visible_to | tournament-wide dispute queue (organizer dashboard) |

Public Match Center (`GET /public/matches/{slug}-{uuid}/`, no auth) returns
`{ ..., "disputed": true|false }` ONLY — never dispute details (PRD:507,556).

### 7.2 Serializers (apps/disputes/serializers.py)

- `DisputeRaiseSerializer` — validates `description` length ≥30 (gettext error), window, quota.
- `DisputeResolveSerializer` — validates outcome↔payload coherence (mirror of the DB CheckConstraint),
  `resolution_notes` ≥20, `cascade_policy` ∈ enum (defaults to `tournament.dispute_cascade_policy`).
- `DisputeDetailSerializer` — nests `resolution`, `cascade_report`, raiser identity (organizers only).
- `DisputePublicSerializer` — `{disputed: bool}` only.

### 7.3 Views

`generics.ListCreateAPIView` / `RetrieveAPIView` + `APIView` action endpoints. Each sets
`permission_classes = [IsAuthenticated, HasModule("match.dispute_console")]` and implements
`get_organization()` returning `match.tournament.organization` (permissions.py:52). Verb predicates
run in the view body before calling the service. Services live in `apps/disputes/services/` (mirrors
accounts/organizations service-layer convention) — `lifecycle.py` (transition machine),
`raise.py`, `resolve.py`, `cascade.py`.

---

## 8. Notifications (PRD §5.14, B.7)

Recipient lists are canonical (PRD:703-704):
- `dispute_raised` → Admin, Game coordinator, opposing TM, Referee (PRD:703).
- `dispute_resolved` → Raiser, opposing TM, Admin, Game coordinator (PRD:704).
- New: `dispute_under_review` → raiser + organizers; `dispute_withdrawn` → organizers + opposing TM.
- **Always-on** (cannot be disabled, PRD:726): "dispute affecting your team" — so a TM whose team
  is in a disputed match always gets `dispute_raised`/`dispute_resolved` regardless of prefs.
- Cascade results: when advancement changes downstream, reuse existing `your_team_advanced` /
  `your_team_eliminated` / `your_next_match_set` events (PRD:705-707) — no new event types for the
  cascade fan-out; the cascade engine just calls the same notification dispatcher.

Transport: in-app only in v1 (PRD:725); delivered via SSE `user:<uuid>:notifications` (invariant 11),
published in `transaction.on_commit` (invariant 4). Public match status via SSE `match:<uuid>`.

---

## 9. Audit (every transition; invariant 5)

Every service mutation calls `emit_audit(...)` inline (audit/services.py:24) with:
- `actor_user`, `actor_role` (snapshot from ActorRole, audit/models.py:22),
- `event_type` ∈ {`dispute_raised`, `dispute_under_review`, `dispute_resolved`, `dispute_withdrawn`},
- `target_type="dispute"`, `target_id=dispute.id`,
- `organization_id`, `tournament_id`, `match_id` (scope, audit/models.py:62-65),
- `payload_before`/`payload_after` (status + key fields),
- `reason` (resolution_notes / withdrawn_reason / override reason),
- `idempotency_key=event_id` (audit emit is idempotent on this, audit/services.py:45).

The cascade engine emits an additional `dispute_resolved` audit row variant with the
`cascade_report` in `payload_after` so the downstream blast radius is permanently recorded. AuditEvent
remains UPDATE/DELETE-denied at the DB role level (migration 0002 already in place).

---

## 10. Frontend (React SPA — shadcn/ui + lucide + framer-motion, i18n + a11y)

### 10.1 Routes (under the org-scoped SPA, slug+UUID URLs — invariant 1)

| Route | Page | Who |
|-------|------|-----|
| `/o/:orgSlug/t/:tournamentId/disputes` | **Dispute Queue** — table of all tournament disputes (status filter chips, age vs window) | Admin / Co-org / scoped GameCoord |
| `/o/:orgSlug/m/:matchId/disputes` | **Match Disputes** — disputes for one match + "Raise dispute" CTA | parties + organizers |
| `/o/:orgSlug/disputes/:disputeId` | **Dispute Detail** — timeline, description, resolve panel, cascade preview/diff | per visible_to |
| (public) `/:orgSlug/match/:slug-:uuid` | Match Center shows a **"Result disputed — pending resolution"** badge; current score visible; details hidden (PRD:556) | anyone |

### 10.2 Components

- `RaiseDisputeDialog` — react-hook-form + zod; `description` ≥30 chars with live counter; team
  selector when raiser is a TM; window-countdown banner; submits `event_id` (uuidv7) for idempotency.
- `ResolveDisputePanel` — outcome radio (4 options); conditional score inputs (`score_amended`) /
  team picker (`walkover_awarded`); `cascade_policy` select pre-filled from tournament default;
  `resolution_notes` ≥20; **Cascade Preview** showing which downstream matches will be recomputed
  vs flagged (dry-run call) before confirm.
- `CascadeDiffBanner` — the regenerate / keep-manual / view-diff banner (invariant 10) on any
  downstream match touched by a cascade that had a manual edit.
- `DisputeStatusBadge` — `raised`/`under_review`/`resolved`/`withdrawn` + outcome chip.
- `DisputedOverlayBadge` — public match badge.

State: TanStack Query for fetch/mutate (optimistic on raise/withdraw; pessimistic on resolve since
cascade has side effects). Zustand only for the resolve-panel local wizard state. All strings via
`t()`. Forms keyboard-navigable, labelled, error-announced (WCAG 2.1 AA, invariant 13).

### 10.3 Live updates (SSE, invariant 11)

- Organizer dispute queue subscribes to `user:<uuid>:notifications` → re-fetches on
  `dispute_*` notifications.
- Public Match Center subscribes to `match:<uuid>` → flips the disputed badge on/off. No WebSocket.

---

## 11. Tests to write

Backend (pytest; factories under `apps/disputes/tests/factories.py`):

State machine suite (`test_dispute_state_machine.py`) — invariant 6, mirrors PRD §5.2/§5.5 test rigor:
- Every allowed transition succeeds; every disallowed transition raises `IllegalTransition`
  (parametrized over the full `DisputeStatus × DisputeStatus` cross-product).
- `raised → resolved` (skip review) and `under_review → resolved` both work.
- `resolved`/`withdrawn` are terminal (no outgoing edges).

Window & quota (`test_dispute_window.py`, `test_dispute_quota.py`):
- raise allowed at `final_at + 0`; blocked at `+window+1s`; 422.
- Admin out-of-window override succeeds with `out_of_window=True` + audit.
- 2nd active dispute by same party blocked at DB constraint AND service (409); 1 active + 1 resolved
  allowed; 3rd blocked unless admin override; `withdrawn` doesn't consume a slot.

Idempotency (`test_dispute_idempotency.py`) — invariant 3:
- Re-POST raise with same `event_id` → 200, same row, no duplicate.
- Re-POST resolve with same `event_id` → 200, no double cascade (cascade_report idempotent).

RBAC matrix (`test_dispute_permission_matrix.py`) — parametrized like
`apps/permissions/tests/test_module_matrix.py` (referenced CLAUDE.md):
- For each role × {raise, resolve, withdraw} → expected allow/deny (Referee can raise not resolve;
  GameCoord resolve only within assigned tournament; Scorer/TM cannot resolve).
- `match.dispute_console` default map asserted via `effective_modules()`.

Multi-tenant isolation (`test_dispute_isolation.py`) — invariant 2, NOT optional:
- User in Org X cannot GET/POST/resolve/withdraw any Org Y dispute via every endpoint (list, detail,
  raise, claim, resolve, withdraw, tournament queue). Asserts 404/403 and empty `visible_to`.
- SSE: Org X user cannot subscribe to Org Y `match:<uuid>` dispute stream.

Cascade engine (`test_dispute_cascade.py`) — the heart:
- `dispute_dismissed` → no cascade.
- `score_amended` with winner change, default policy → unplayed dependent re-pointed via typed
  source; already-played dependent flagged `history_inconsistent`, NOT mutated.
- `strict_all` → already-played dependents flagged `replay_required`.
- `lenient_all` → nothing propagated; report says `no_propagation`.
- Group-stage `score_amended` → standings recomputed atomically (PRD:529).
- Cascade respects `last_manual_edit_at` → sets banner state, does not clobber (invariant 10).
- Single-recompute-after-all-disputes: 2 disputes on one match; cascade runs once after the second
  settles (PRD:504); advancement paused until overlay clears.
- Cascade re-resolves ONLY via typed pointers, never bracket adjacency (invariant 9) — test feeds a
  match with `winner_of` source and asserts the dependent's participant changed accordingly.

Overlay (`test_dispute_overlay.py`):
- First raise sets `match.disputed_overlay`/tournament derived True; advancement guard pauses.
- Overlay auto-clears only when ALL disputes terminal (PRD:295,504).

Audit (`test_dispute_audit.py`):
- Each transition emits exactly one AuditEvent with correct event_type/target/scope/reason.
- Attempt to UPDATE/DELETE the audit row fails at DB (reuses audit append-only guarantee).

Frontend (vitest + Playwright):
- `RaiseDisputeDialog` validation (≥30 chars), idempotency key sent, optimistic update.
- `ResolveDisputePanel` outcome↔payload conditional fields; cascade preview render.
- Public Match Center shows disputed badge, hides details (PRD:507).
- a11y: forms pass axe checks (WCAG 2.1 AA).
- Playwright E2E: TM raises → GameCoord resolves `score_amended` → downstream bracket updates +
  advanced-team notification appears.

---

## 12. Migration / build order

Disputes are Phase 1B and depend on `matches`, `tournaments`, `teams` skeletons. Per v1Users.md B.18
(v1Users.md:2672-2693) the Phase-1A migrations 0001–0015 exist; Phase-1B sport migrations are
`0016+`. Disputes slot AFTER Match/MatchEvent exist:

```
(Phase 1B prerequisites, owned by sibling specs)
0016_sport_football_person_player      # Person, Player (v1Fixtures / v1Sport)
0017_tournament_full                    # Tournament full fields incl. dispute_window_hours,
                                        #   dispute_cascade_policy (PRD:653-654)
0018_match_full                         # Match incl. home_source/away_source typed pointers,
                                        #   final_at, disputed_overlay, replay_required,
                                        #   history_inconsistent, advancement_pending
0019_matchevent                         # MatchEvent (DB-side uuid7 default, B.1)
0020_match_result_services              # amend_result / award_walkover / order_replay (no schema)

(This spec)
0021_permissions_dispute_module         # data migration: add match.dispute_console to modules.json
                                        #   + load_modules upsert (perm catalog 22→23)
0022_disputes_dispute                   # Dispute + one_active_dispute_per_party_per_match constraint
0023_disputes_resolution                # DisputeResolution + resolution_payload_matches_outcome check
# (0024_disputes_evidence — v1.5 ONLY, not built in v1.0)
```

Build sequence (TDD, tests-first per CLAUDE.md):
1. Add `match.dispute_console` to `apps/permissions/fixtures/modules.json` + A.2/A.3 doc fold-in.
2. Write `apps/disputes/models.py` (Dispute, DisputeResolution) + migrations 0022/0023.
3. Write `services/lifecycle.py` (state machine + `ALLOWED_TRANSITIONS`) tests-first.
4. Write `services/raise.py` (window, quota, overlay set) + `services/resolve.py` (outcome,
   resolution record, on_commit cascade hook).
5. Write `services/cascade.py` (typed-pointer recompute, policy branches, manual-edit guard,
   standings recompute call) — most heavily tested.
6. Wire match-result mutation calls into `apps.matches.services` (amend_result etc.).
7. DRF serializers/views/urls + `HasModule` + verb predicates.
8. Notifications wiring (reuse dispatcher; add new event_types to B.6 + §5.14 fold-in).
9. SSE publish in on_commit (`match:<uuid>`, `user:<uuid>:notifications`).
10. Frontend routes/pages/components + tests + Playwright E2E.

---

## 13. Spec fold-ins required (track in PRD §14 / v1Users.md)

1. **B.6 event_type catalog** (v1Users.md:2452): add `dispute_raised`, `dispute_under_review`,
   `dispute_withdrawn` (only `dispute_resolved` present today).
2. **A.2/A.3 module catalog** (v1Users.md:2105,2148): add `match.dispute_console` (22→23 modules) +
   role-default row.
3. **PRD §5.7 / §5.2** (PRD:502,295): add `withdrawn` terminal state + its semantics (does not
   trigger cascade, does not consume anti-spam "resolved" slot).
4. **PRD §5.14** (PRD:703-707): confirm cascade fan-out reuses `your_team_advanced/eliminated/
   next_match_set`; add `dispute_under_review`/`dispute_withdrawn` recipients (B.7 table).
5. **PRD §8 Dispute model** (PRD:957): extend with `event_id`, `out_of_window`, denormalized scope
   ids, and split resolution fields into `DisputeResolution`.

---

## 14. Open questions (defer-list)

- **Replay scheduling**: `match_replayed` flags `replay_required` but who schedules the replay
  match (auto-slot vs organizer manual)? Lean organizer-manual in v1.0 (consistent with PRD:514
  "organizer scheduling effort"); confirm against v1Fixtures scheduler.
- **Cascade dry-run endpoint**: the SPA "Cascade Preview" needs a read-only simulation. Proposal:
  `POST /disputes/{id}/resolve/?dry_run=true` returns the would-be `cascade_report` without
  committing. Confirm this is acceptable vs a dedicated `/preview` action.
- **Out-of-window override audit weight**: should out-of-window raise require the same friction as
  team disqualification (password re-prompt)? Currently reason-only. Confidence: medium.
