# Flow — Tournament lifecycle (create → register → generate → score → standings → advance)

Exhaustive, source-verified sequence trace of one tournament from self-serve
creation through knockout advancement, across the Django (ASGI/Channels) backend
and the React/Vite frontend. **Every claim below is cited as
`path::symbol` with a line range and was read from source, not the breadth-pass
notes.** All paths are relative to `/home/ubuntu/Fixture`.

> Verified parity note vs the breadth-pass note
> (`docs/superpowers/analysis/flow-tournament.md`): its central finding is
> confirmed — **there is no Tournament status-transition machine in production.**
> The only writer of `Tournament.status` after creation is
> `apps/tournaments/services/create.py::create_tournament:71` (sets `DRAFT`).
> `grep` over `backend/apps` (excluding tests/migrations) finds no other
> production setter, and `apps/tournaments/services/rules.py::freeze_rules:66`
> has **zero** production callers. Consequences are flagged inline.

---

## Participants (concrete modules/files)

| Alias | Concrete module |
|---|---|
| CreatePage | `frontend/src/features/tournaments/CreateTournamentPage.tsx` |
| DetailPage | `frontend/src/features/tournaments/TournamentDetailPage.tsx` |
| RegPage | `frontend/src/features/registration/RegistrationFormPage.tsx` |
| Console | `frontend/src/features/matches/MatchConsolePage.tsx` |
| apiClient | `frontend/src/api/client.ts` (`apiFetch`) + `lib/eventId.ts::newEventId` |
| tApi / liveApi / regApi | `frontend/src/api/{tournaments,live,registration}.ts` |
| T_Views | `backend/apps/tournaments/views.py` |
| createSvc | `backend/apps/tournaments/services/create.py` |
| rulesSvc | `backend/apps/tournaments/services/rules.py` |
| wsSvc | `backend/apps/organizations/services/workspace.py::provision_personal_workspace` |
| regSvc | `backend/apps/teams/services/registration.py` |
| Teams_Views | `backend/apps/teams/views.py` (`PublicRegistrationView`, `RegistrationLinkCreateView`) |
| mapSvc | `backend/apps/forms/services/mapping.py` |
| Gen_View | `backend/apps/fixtures/views.py::GenerateFixturesView` |
| genSvc | `backend/apps/fixtures/services/generate.py` |
| M_Views | `backend/apps/matches/views.py` |
| scoringSvc | `backend/apps/matches/services/scoring.py` |
| eventsSvc | `backend/apps/matches/services/events.py` |
| stateSvc | `backend/apps/matches/services/state.py` |
| standingsSvc | `backend/apps/matches/services/standings.py` |
| advanceSvc | `backend/apps/fixtures/services/advance.py` |
| auditSvc | `backend/apps/audit/services.py::emit_audit` |
| Consumer | `backend/apps/live/consumers.py::MatchConsumer` + `routing.py` + `fixture/asgi.py` |
| LiveSnap | `backend/apps/live/views.py::LiveMatchSnapshotView` |

---

## Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    actor Organizer
    participant CreatePage as CreateTournamentPage.tsx
    participant tApi as api/tournaments.ts
    participant TViews as tournaments/views.py
    participant createSvc as services/create.py
    participant wsSvc as organizations/workspace.py
    participant rulesSvc as tournaments/services/rules.py
    participant audit as audit/services.py::emit_audit
    actor School
    participant RegPage as RegistrationFormPage.tsx
    participant TeamsV as teams/views.py
    participant regSvc as teams/services/registration.py
    participant GenView as fixtures/views.py::GenerateFixturesView
    participant genSvc as fixtures/services/generate.py
    participant DetailPage as TournamentDetailPage.tsx
    participant MViews as matches/views.py
    participant scoringSvc as matches/services/scoring.py
    participant stateSvc as matches/services/state.py
    participant eventsSvc as matches/services/events.py
    participant standingsSvc as matches/services/standings.py
    participant advanceSvc as fixtures/services/advance.py
    participant DB as Postgres
    participant Bus as transaction.on_commit
    participant Chan as channel layer (match_<id>)
    participant Console as MatchConsolePage.tsx

    rect rgb(235,245,255)
    note over Organizer,audit: 1) CREATE (auto-provision workspace, status=DRAFT)
    Organizer->>CreatePage: submit {name}
    CreatePage->>tApi: create({name, event_id=newEventId()})
    tApi->>TViews: POST /api/tournaments/ (cookie + X-CSRFToken)
    TViews->>TViews: gate request.user.email_verified_at (else 403 verify_email_first)
    TViews->>createSvc: create_tournament(user,name,sport_code,event_id)
    createSvc->>DB: AuditEvent replay lookup (idempotency_key,event_type=tournament_created)
    alt prior audit exists
        createSvc-->>TViews: return existing Tournament (idempotent)
    else fresh
        createSvc->>DB: BEGIN atomic
        createSvc->>wsSvc: provision_personal_workspace(user,name) -> Org + admin OrgMembership
        createSvc->>DB: Tournament(status=DRAFT, tz=org.tz)
        createSvc->>DB: TournamentMembership(ADMIN, ACTIVE)
        createSvc->>audit: emit_audit(tournament_created, idempotency_key=event_id)
        createSvc->>DB: COMMIT
    end
    TViews-->>tApi: 201 TournamentSerializer
    end

    rect rgb(240,255,240)
    note over Organizer,rulesSvc: 2) SETTINGS / RULES (freeze gate)
    Organizer->>tApi: PATCH /settings/ {rules?,constraints?,event_id,amend?,reason?}
    tApi->>TViews: TournamentSettingsView.patch
    TViews->>TViews: can_manage_tournament (else 403 not_tournament_manager)
    TViews->>rulesSvc: update_settings(...)
    rulesSvc->>DB: AuditEvent replay (tournament_settings_updated)
    rulesSvc->>rulesSvc: can_edit_rules == status in {DRAFT,PUBLISHED} (else PermissionError -> 409 rules_frozen)
    rulesSvc->>rulesSvc: merge_rules(partial,base) + validate_constraints (ValueError -> 400)
    rulesSvc->>DB: BEGIN atomic; save rules/constraints/last_manual_edit_at; emit_audit; COMMIT
    end

    rect rgb(255,250,235)
    note over School,regSvc: 3) REGISTER (public link OR form -> single writer)
    Organizer->>tApi: POST /registration-link/ -> {token} (shown once)
    School->>RegPage: GET /api/register/{token}/ (AllowAny) -> tournament context
    School->>TeamsV: POST /api/register/{token}/ {school_name,teams[],event_id}
    TeamsV->>TeamsV: resolve_registration_link (active/not-expired/under cap)
    TeamsV->>regSvc: register_school(... event_id)
    regSvc->>DB: AuditEvent replay (school_registered)
    regSvc->>DB: BEGIN atomic; Team(REGISTERED)+Person+Player rows; emit_audit; COMMIT
    TeamsV->>DB: RegistrationLink.submission_count = F()+1 (post-commit, separate UPDATE)
    TeamsV-->>RegPage: 201 {registered, teams[]}
    end

    rect rgb(245,240,255)
    note over Organizer,DB: 4) GENERATE FIXTURES (dispatch by `format`)
    Organizer->>DetailPage: click Round-robin / Knockout / Generate knockout
    DetailPage->>tApi: generateFixtures(id,{format,groupSize})
    tApi->>GenView: POST /generate-fixtures/ {format,group_size}
    GenView->>GenView: accessible + can_manage (404 / 403)
    GenView->>genSvc: dispatch round_robin | knockout | knockout_from_groups
    genSvc->>DB: presence-idempotency: if matches exist, return them
    genSvc->>DB: BEGIN atomic; bulk_create Match(SCHEDULED) (+ home_source/away_source typed pointers); COMMIT
    GenView-->>DetailPage: 201 {generated, format}; client invalidates t-matches/t-standings
    end

    rect rgb(255,240,245)
    note over Organizer,Console: 5) SCORE (two paths) — DB-first, publish/advance on_commit
    alt Aggregate score (DetailPage ScoreRow)
        Organizer->>tApi: score(matchId,{home,away,event_id})
        tApi->>MViews: POST /api/matches/{id}/score/
        MViews->>MViews: _can_score (manager | assigned scorer | MATCH_SCORER)
        MViews->>scoringSvc: record_score(...)
        scoringSvc->>DB: AuditEvent replay (match_scored)
        scoringSvc->>DB: BEGIN atomic; SELECT FOR UPDATE; guard status in {SCHEDULED,LIVE}
        scoringSvc->>DB: set scores + status=COMPLETED; emit_audit(match_scored); COMMIT
        scoringSvc->>Bus: on_commit(_fire_advancement(mid))
    else Live event-sourced (MatchConsolePage)
        Organizer->>liveApi: transition(matchId,"live") then recordEvent(goal,...)
        liveApi->>MViews: POST /transition/ -> transition_match (state machine)
        liveApi->>MViews: POST /events/ -> record_match_event
        MViews->>eventsSvc: record_match_event(...)
        eventsSvc->>DB: MatchEvent replay (event_id)
        eventsSvc->>DB: BEGIN atomic; SELECT FOR UPDATE; sequence_no=Max+1; insert MatchEvent
        eventsSvc->>eventsSvc: recompute_score (derive from non-voided GOAL/PENALTY/OWN_GOAL)
        eventsSvc->>DB: emit_audit(match_event_recorded); COMMIT
        eventsSvc->>Bus: on_commit(publish_match_event(mid,eid))
        Bus->>Chan: group_send match_<id> {type:match.event}
        Chan->>Consumer: match_event handler -> send_json
        Consumer-->>Console: WS frame {match_id,event_id}
        note over Console: Console actually POLLS snapshot every 5s (refetchInterval) — see contract notes
    end
    end

    rect rgb(235,255,250)
    note over Organizer,advanceSvc: 6) STANDINGS + 7) ADVANCE
    Organizer->>tApi: standings(id) -> GET /standings/
    tApi->>standingsSvc: compute_standings (rules.points + rules.tiebreakers, COMPLETED only)
    Bus->>stateSvc: _fire_advancement(match_id) [post-commit, try/except]
    stateSvc->>advanceSvc: advance_from_match(match_id)
    advanceSvc->>DB: read winner_id/loser_id; scan sibling matches
    advanceSvc->>DB: fill home_team/away_team where *_source.match_id==mid & type in {winner_of,loser_of}
    end
```

---

## Ordered, numbered walkthrough (file::function + line ranges)

### 1) CREATE — self-serve, auto-provision workspace, `status=DRAFT`

1. **Client mint + POST.** `CreateTournamentPage.tsx::onSubmit` (lines 34-52)
   collects only `name`, calls `tournamentsApi.create({name, event_id:
   newEventId()})`. `lib/eventId.ts::newEventId` (lines 6-11) mints the
   idempotency UUID. `api/tournaments.ts::tournamentsApi.create` (lines 120-121)
   → `api/client.ts::apiFetch` (lines 31-86) sends `credentials:"include"` +
   `X-CSRFToken` on the POST (lines 59-62, 69).
2. **Email-verified gate.** `tournaments/views.py::TournamentListCreateView.post`
   (lines 47-59) returns **403 `{detail:"verify_email_first"}`** if
   `request.user.email_verified_at` is falsy (lines 48-49) — *before* any write.
3. **Idempotency replay.** `services/create.py::create_tournament` (lines 40-93)
   first does an `AuditEvent` lookup keyed
   `(idempotency_key=event_id, event_type="tournament_created")` (lines 47-54);
   on a hit it returns the existing `Tournament` unchanged (invariant 3).
4. **Atomic provisioning.** Inside `with transaction.atomic()` (line 62):
   `provision_personal_workspace` resolves/creates the hidden org + admin
   `OrganizationMembership` (lines 63-65), then creates
   `Tournament(status=TournamentStatus.DRAFT, time_zone=org.time_zone)`
   (lines 66-74), the creator's `TournamentMembership(ADMIN, ACTIVE)`
   (lines 75-81), and `emit_audit("tournament_created",
   idempotency_key=event_id)` (lines 82-92). Slug is per-org unique via
   `_pick_unique_tournament_slug` (lines 28-37; matches the
   `unique_tournament_slug_per_org` partial constraint).
5. **Response.** 201 `TournamentSerializer` (view line 59). The serializer
   (`tournaments/serializers.py::TournamentSerializer` lines 13-29) exposes
   `status` **read-only** (`organization_slug`/`sport_code` are read-only source
   fields) — the client can never write status.

> **Status-machine gap (verified):** `models.py::TournamentStatus` (lines 24-33)
> declares 7 states, but no service/endpoint transitions them. `published →
> registration_open → scheduled → live → completed → archived` are unreachable
> in production; `rules.py::freeze_rules` is never called, so `rules_frozen_at`
> stays null forever.

### 2) SETTINGS / RULES — data-driven, freeze gate, idempotent

6. **PATCH route.** `tournaments/views.py::TournamentSettingsView.patch`
   (lines 132-151): `_get_tournament_or_404` (lines 62-71, access-scoped → 404
   no existence leak), then `can_manage_tournament` (else 403). Delegates to
   `rules.py::update_settings`.
7. **update_settings.** `rules.py::update_settings` (lines 73-124):
   - replay on `event_id` against `tournament_settings_updated` audit
     (lines 89-94) → returns unchanged on a hit;
   - **freeze gate** (lines 96-99): `can_edit_rules` (lines 61-63) is True only
     when `status in {DRAFT, PUBLISHED}`; otherwise raises
     `PermissionError("rules_frozen")` → caught at view line 147-148 → **409**,
     unless `amend=True` + a non-empty `reason` (else `ValueError
     amend_reason_required` → 400). (invariant 7);
   - `merge_rules(partial, base=tournament.rules)` (lines 33-58): layered merge
     `DEFAULT_RULES < stored < partial`, whitelisting every top-level + nested
     key (`_NESTED = {points,match,squad,discipline}`); unknown keys raise
     `ValueError` → 400 (view lines 149-150);
   - `validate_constraints` (from `fixtures/services/constraints.py`) for the
     constraints array;
   - `with transaction.atomic()` (lines 101-123): save
     `rules/constraints/last_manual_edit_at` + `emit_audit`.
8. **GET shape.** `_settings_payload` (views lines 109-116) returns
   `{rules: merge_rules(...), constraints, rules_frozen_at, can_edit}` where
   `can_edit = can_edit_rules(t) and can_manage_tournament(user,t)`.

### 3) REGISTER — two ingestion channels, one domain writer

9. **Mint link (organizer).** `teams/views.py::RegistrationLinkCreateView`
   (line 24+, mounted at `/api/tournaments/{id}/registration-link/`) →
   `registration.py::create_registration_link` (lines 26-41): sha256-hashed
   token, plaintext returned once. Frontend: `DetailPage` `createLink` mutation
   (lines 278-282) builds the share URL.
10. **Public resolve + submit.** `teams/views.py::PublicRegistrationView`
    (lines 52-92, `AllowAny` + `RegistrationRateThrottle`): GET returns
    `{tournament_name, tournament_id}` (lines 60-66); POST resolves the token via
    `resolve_registration_link` (lines 44-66: active / not-expired /
    under `max_submissions`), then calls `register_school` (lines 75-82). After
    the write it does `RegistrationLink.submission_count = F()+1` as a **separate
    UPDATE** (lines 87-89) — note this is *not* inside `register_school`'s
    transaction, so an `event_id` replay still increments the counter again.
    `IntegrityError` → 400 `duplicate_team_name_or_jersey_in_submission`
    (lines 83-86). Frontend: `RegistrationFormPage.tsx` via
    `api/registration.ts::registrationApi.{info,submit}`.
11. **The single writer.** `registration.py::register_school` (lines 86-159):
    replay on `event_id` against `school_registered` audit (lines 101-110)
    returns the existing teams; else `with transaction.atomic()` (lines 114-158)
    creates `Team(status=TeamStatus.REGISTERED)` + `Person` + `Player` rows
    (Person↔Player split = invariant 8) and `emit_audit("school_registered",
    actor_role=SYSTEM)`. **Teams are created directly as REGISTERED**, skipping
    any `pending_approval` path.
12. **Forms channel reuses the same writer.** `forms/services/mapping.py::
    _map_team_registration` (lines 41-80) maps a `team_registration`
    `FormResponse` and calls `register_school` with a **derived** event_id
    `uuid5(NAMESPACE_URL, f"formresp-teamreg:{resp.id}")` (line 65) so the form
    submit's globally-unique idempotency key does not collide with
    `register_school`'s own `school_registered` replay key (documented landmine
    in the module note, lines 12-17).

### 4) GENERATE FIXTURES — dispatch by `format`

13. **View dispatch.** `fixtures/views.py::GenerateFixturesView.post`
    (lines 23-46): `accessible_tournaments(...).exists()` (404) +
    `can_manage_tournament` (403). Reads `format` (default `round_robin`) and
    branches:
    - `knockout` → loads `TeamStatus.REGISTERED` teams ordered `(seed, name)`
      → `generate_single_elimination(tournament, teams)` (lines 31-37);
    - `knockout_from_groups` → `generate_knockout_from_groups(tournament)`
      (lines 38-39);
    - else → `generate_round_robin(tournament, group_size=int(...,5))`
      (lines 40-43). `ValueError/TypeError` → 400 (lines 44-45).
14. **round_robin.** `generate.py::generate_round_robin` (lines 40-87):
    **presence-idempotent** — if any matches exist, returns them (lines 42-46).
    Else loads REGISTERED teams `(seed,name)`, requires ≥2 (else ValueError),
    chunks into `group_size` groups, sets each `team.pool`, computes a per-group
    `inputs_hash` (sha256 of sorted team ids, lines 67-69, invariant 10), and
    via the **circle method** `_round_robin` (lines 21-37) emits
    `Match(status=SCHEDULED, stage="group", group_label=...)` — all inside
    `with transaction.atomic()` + `bulk_create` (lines 59-86).
15. **single_elimination.** `generate.py::generate_single_elimination`
    (lines 90-143): requires a **power-of-2** count (lines 97-98). Round 1 pairs
    concrete teams with `home_source/away_source = {"type":"team","team_id":...}`
    (lines 107-119); later rounds carry
    `{"type":"winner_of","match_id": <prev match id>}` typed pointers
    (lines 125-141, invariant 9). `match_no` continues after existing matches
    (line 103). Each round is its own `bulk_create` (so prior-round PKs exist to
    point at). All under one `transaction.atomic()` (lines 105-142).
16. **knockout_from_groups.** `generate.py::generate_knockout_from_groups`
    (lines 146-189): presence-idempotent on `stage="knockout"` (lines 153-159);
    for each group calls `compute_standings(tournament, group_label=g)`, takes
    top `advance_per_group` (default 2), requires ≥2 qualifiers each (else
    ValueError), **cross-seeds** group-i winner vs next group's runner-up
    (lines 181-187), then reuses `generate_single_elimination(..., stage=
    "knockout")`.
17. **Client.** `DetailPage` `generate` mutation (lines 283-290) →
    `tournamentsApi.generateFixtures` (api lines 157-168, body `{group_size,
    format}`); `onSuccess` invalidates `["t-matches",id]` + `["t-standings",id]`.
    Setup-step UI gates the buttons on team/match counts (lines 452-492).

### 5) SCORE — two convergent paths; DB-first, transport/advance on_commit

18. **`_can_score` gate.** `matches/views.py::_can_score` (lines 71-83): a
    tournament manager, the per-match assigned `scorer`, or any ACTIVE
    `MATCH_SCORER` member. Applied by `RecordScoreView` (143), `RecordMatchEventView`
    (171), `TransitionMatchView` (232).
19. **Aggregate path (DetailPage).** `ScoreRow.save` mutation
    (`DetailPage` lines 41-52) → `tournamentsApi.score(matchId,{home_score,
    away_score, event_id:newEventId()})` (api lines 175-179) →
    `RecordScoreView.post` (M_Views lines 138-160) → `scoring.py::record_score`
    (lines 53-103):
    - replay on `event_id` vs `match_scored` audit (lines 64-69) → returns
      `Match` unchanged;
    - `with transaction.atomic()` (line 71): `select_for_update().get(pk)`
      (line 72, no TOCTOU between scorers), guard `status in {SCHEDULED, LIVE}`
      (lines 73-76, else `ValidationError` → 400), capture before-image, set
      scores + `status=COMPLETED`, `emit_audit("match_scored")`;
    - **`transaction.on_commit(lambda: _fire_advancement(mid))`** (lines 98-102).
    On success the mutation invalidates `t-matches` + `t-standings`
    (DetailPage lines 48-51).
20. **Event-sourced path (Console).** `MatchConsolePage.tsx` uses `liveApi`:
    `tr` mutation → `liveApi.transition(matchId,to)` (Console lines 99-102) and
    `ev` mutation → `liveApi.recordEvent(...)` (Console lines 85-98).
    - **transition** → `TransitionMatchView` (M_Views 224-247) →
      `state.py::transition_match` (lines 40-70): `with transaction.atomic()` +
      `select_for_update`, validates against `ALLOWED_TRANSITIONS` (lines 22-31),
      updates `status`/`current_period`, `emit_audit("match_status_changed")`,
      and on a terminal `(COMPLETED, WALKOVER)` (`_TERMINAL_WITH_RESULT`, line 33)
      schedules `on_commit(_fire_advancement(mid))` (lines 67-69).
    - **record event** → `RecordMatchEventView` (M_Views 163-221, validates
      `side`/`player`/`related_player` membership) → `events.py::record_match_event`
      (lines 77-128): replay on `MatchEvent.event_id` (lines 83-86); inside
      `transaction.atomic()` + `select_for_update`, assign gapless
      `sequence_no = Max+1` (lines 90-93), insert immutable `MatchEvent`,
      `recompute_score` **derives** home/away from non-voided `GOAL`/
      `PENALTY_SCORED` (`SCORING_EVENT_TYPES`, models lines 47-49) and `OWN_GOAL`
      (counts for opponent, events lines 67-72), `emit_audit
      ("match_event_recorded")`, then
      **`on_commit(publish_match_event(mid,eid))`** (lines 126-127).
      Corrections are append-only `VOID` events (`void_match_event` lines 131-142).
21. **Score is derived, not stored as truth.** `recompute_score` (events
    lines 49-74) recomputes from the event log and writes a cached
    `home_score/away_score` via a bulk `.update`. `Match.winner_id`/`loser_id`
    (models lines 107-124) are **computed properties** returning None unless
    status ∈ {COMPLETED, WALKOVER} and there is no draw.

### 6) STANDINGS — rules-driven

22. **Endpoint.** `matches/views.py::TournamentStandingsView.get` (lines 99-114):
    access-scoped, gathers distinct `group_label`s, returns
    `{groups:[{group_label, rows: compute_standings(t, group_label=lbl)}]}`.
23. **compute_standings.** `standings.py::compute_standings` (lines 32-83):
    reads `merge_rules(tournament.rules)["points"]` + `["tiebreakers"]`
    (lines 33-38), tallies **only `MatchStatus.COMPLETED`** matches
    (lines 40-45), builds per-team P/W/D/L/GF/GA/Pts, derives GD, and sorts via
    `_sort_key` (lines 12-29). **`head_to_head` and unknown tiebreakers are a
    no-op in v1** (line 27) — tied teams fall through to GD/GF/name. Frontend:
    `DetailPage` `standings` query (lines 271-274) rendered by `StandingsTable`
    (lines 208-253), invalidated after each score.

### 7) ADVANCE — typed source-pointer resolution (post-commit)

24. **Trigger.** `state.py::_fire_advancement` (lines 73-80) is the **only**
    production entrypoint; it's invoked from the two `on_commit` hooks
    (`scoring.record_score` line 102 and `state.transition_match` line 69),
    wrapped in `try/except` so a failure logs but never crashes the request
    (lines 75-80).
25. **advance_from_match.** `advance.py::advance_from_match` (lines 16-46):
    loads the match, reads `winner_id`/`loser_id`; **returns early on a draw /
    non-final** (`winner_id is None`, lines 22-24). Otherwise scans **all**
    sibling matches in the tournament (lines 28-29, O(n) per completion) and for
    each side whose `*_source.match_id == mid` fills `*_team_id` with the
    winner (`type=="winner_of"`) or loser (`type=="loser_of"`), saving only
    changed rows (lines 31-45). **`group_position` and `tbd` pointer types are
    never resolved by code; draws in knockout leave dependents permanently null.**

---

## Explicit transaction boundaries & `transaction.on_commit` points

| # | Boundary | Location |
|---|---|---|
| TX-1 | `transaction.atomic()` wraps Org+OrgMembership+Tournament+TournamentMembership+audit | `create.py:62-92` |
| TX-2 | `transaction.atomic()` wraps rules/constraints save + audit | `rules.py:101-123` |
| TX-3 | `transaction.atomic()` wraps all Team/Person/Player rows + audit (one school) | `registration.py:114-158` |
| — | `submission_count` UPDATE is **outside** TX-3 (separate, runs on replay too) | `teams/views.py:87-89` |
| TX-4 | `transaction.atomic()` wraps round-robin pool updates + `bulk_create` | `generate.py:59-86` |
| TX-5 | `transaction.atomic()` wraps single-elimination (round-by-round `bulk_create`) | `generate.py:105-142` |
| TX-6 | `transaction.atomic()` + `select_for_update` for aggregate score | `scoring.py:71-102` |
| TX-7 | `transaction.atomic()` + `select_for_update` for event append + recompute | `events.py:88-127` |
| TX-8 | `transaction.atomic()` + `select_for_update` for state transition | `state.py:41-69` |
| OC-1 | `on_commit(_fire_advancement(mid))` after a final score | `scoring.py:98-102` |
| OC-2 | `on_commit(_fire_advancement(mid))` after terminal transition | `state.py:67-69` |
| OC-3 | `on_commit(publish_match_event(mid,eid))` → channel-layer fan-out (`match_<id>`) | `events.py:126-127` |

DB-first invariant (#4) holds throughout: every WS/SSE/advancement side effect
fires **after** commit, never inside the transaction. `advance_from_match` and
`publish_match_event` are best-effort (their hosts swallow exceptions:
`state.py:79`, `events.py:45`).

---

## Idempotency points (invariant 3 — client `event_id`)

| Operation | Replay key (AuditEvent.event_type unless noted) | Code |
|---|---|---|
| Create tournament | `tournament_created` | `create.py:47-54` |
| Update settings/rules | `tournament_settings_updated` | `rules.py:89-94` |
| Register school | `school_registered` | `registration.py:101-110` |
| Form→register (derived key) | `uuid5(NAMESPACE_URL,"formresp-teamreg:"+resp.id)` | `mapping.py:65` |
| Record (aggregate) score | `match_scored` | `scoring.py:64-69` |
| Record match event | `MatchEvent.event_id` (unique on the event row, **not** audit) | `events.py:83-86` |
| Member update | none (no `event_id`; not replay-guarded) | `views.py:210-281` |

Replay semantics return the existing record (the spec's "200 not 201" intent),
**but** the create/score/register views still wrap the service result in a fresh
`Response(..., status=201)` regardless of whether a replay occurred — i.e. the
backend returns the *same body* but does **not** downgrade the status code to 200
on replay. Generation is idempotent by **presence** (not by `inputs_hash`):
`generate_round_robin`/`generate_knockout_from_groups` short-circuit if matches
already exist (`generate.py:42-46`, `153-159`), so a manual-edit-then-regenerate
is a no-op and the stored `inputs_hash` is never compared (invariant-10
regenerate/keep/diff UX is unimplemented).

---

## Client ↔ server contracts this flow depends on

All requests go through `api/client.ts::apiFetch`: `credentials:"include"`
(Django session cookie), `X-CSRFToken` on POST/PUT/PATCH/DELETE
(`client.ts:59-62`), JSON bodies, `ApiError` on non-2xx. Session auth, no JWT
(invariant 15).

| Contract | Method + path | Request | Response | Source |
|---|---|---|---|---|
| Create | `POST /api/tournaments/` | `{name, sport_code?, event_id}` | 201 `TournamentSerializer` `{id,slug,name,status,organization_slug,sport_code,time_zone,created_at}`; **403 `verify_email_first`** | tApi:120, T_Views:47, serializers:13 |
| List/Get | `GET /api/tournaments/` | — | `Tournament[]` (client derives single via `.find`) | tApi:104-114, T_Views:43 |
| Settings GET | `GET /api/tournaments/{id}/settings/` | — | `{rules,constraints,rules_frozen_at,can_edit}` | T_Views:128 |
| Settings PATCH | `PATCH …/settings/` | `{rules?,constraints?,event_id,amend?,reason?}` | same payload; **409 `rules_frozen`**, 400 unknown-key/`amend_reason_required` | T_Views:132, rules:73 |
| Constraint catalog | `GET /api/tournaments/constraint-types/` | — | `CONSTRAINT_TYPES` | T_Views:154 |
| Reg link | `POST …/registration-link/` | `{label}` | `{token, path, tournament_id}` (token shown once) | regApi:38, Teams_Views:24 |
| Reg info | `GET /api/register/{token}/` (AllowAny) | — | `{tournament_name, tournament_id}` | regApi:30, Teams_Views:60 |
| Register | `POST /api/register/{token}/` (AllowAny, throttled) | `{school_name, teams[{name,short_name?,players[]}], event_id?}` | 201 `{registered, teams[]}`; 400 `duplicate_…`/`invalid_link` | regApi:32, Teams_Views:68 |
| Generate | `POST …/generate-fixtures/` | `{format:"round_robin"\|"knockout"\|"knockout_from_groups", group_size}` | 201 `{generated, format}`; 400 on bad team count | tApi:157, Gen_View:23 |
| Teams | `GET …/teams/` | — | `TeamRow[]` (`player_count` aggregate) | tApi:151 |
| Matches | `GET …/matches/` | — | `MatchRow[]` — **omits `home_source`/`away_source`** | tApi:153, M_Views:86, serializers:16-26 |
| Standings | `GET …/standings/` | — | `{groups:[{group_label, rows: StandingRow[]}]}` | tApi:155, M_Views:99 |
| Score (agg) | `POST /api/matches/{id}/score/` | `{home_score(0-99), away_score(0-99), event_id}` | `MatchSerializer`; 403 `not_allowed_to_score`; 400 on illegal status | tApi:175, M_Views:138 |
| Transition | `POST /api/matches/{id}/transition/` | `{to_status, reason?}` | `MatchSerializer`; 400 `illegal_transition` | liveApi:57, M_Views:224 |
| Record event | `POST /api/matches/{id}/events/` | `{event_type, side?, player_id?, related_player_id?, minute?, event_id}` | 201 `MatchSerializer`; 400 `player_not_on_team` etc. | liveApi:43, M_Views:163 |
| Events CSV | `GET /api/matches/{id}/events/export/` | — | `text/csv` (formula-injection-neutralized) | liveApi:56, M_Views:250 |
| Live snapshot | `GET /api/live/match/{id}/` (AllowAny) | — | `{match{…,current_period,home_score,away_score}, events[≤30, voided dropped]}` | liveApi:41, LiveSnap:47 |
| Live WS | `ws://…/ws/match/{id}/` | `{type:"ping"}` → `{type:"pong"}` | broadcast `{match_id, event_id}` | routing.py, consumers.py, asgi.py |

### Contract observations (verified, load-bearing)

- **The scoring console polls, it does not consume the WebSocket.**
  `MatchConsolePage.tsx` drives everything off `liveApi.snapshot` with
  `refetchInterval: 5000` (Console lines 74-79) and `onSuccess: refresh`
  invalidations (lines 97, 102). The WS room (`consumers.py`, `routing.py`,
  `asgi.py` `ProtocolTypeRouter`/`AuthMiddlewareStack`/`AllowedHostsOriginValidator`)
  exists and is fed by `publish_match_event`, but **no frontend file in this
  flow opens that socket** — so the on_commit fan-out (OC-3) currently has no
  in-flow consumer; the UI's "live" updates come from the 5s poll. This is the
  single biggest client↔server divergence in the live path.
- **Typed pointers are not on the wire.** `MatchSerializer` (serializers
  lines 16-26) omits `home_source`/`away_source`. `BracketView.tsx` therefore
  infers bracket shape from `round_no` geometry + `stage==="knockout"`
  (BracketView lines 216-220), not from the authoritative pointers that
  `advance_from_match` resolves. Generation seeding and advancement are the only
  pointer consumers, both server-side.
- **No single-tournament retrieve endpoint.** `tApi.get` (tApi lines 111-114)
  re-fetches the whole isolation-scoped list and `.find`s by id.
- **`MatchRow.scheduled_at`** is serialized but `current_period` is on the
  serializer too (used by Console via `liveApi`, not `MatchRow`).

---

## Subsystems crossed
`tournaments` (create/settings/scope/permissions), `organizations`
(workspace provisioning, invitation→membership activation), `audit` (idempotency
+ append-only log), `teams` (registration link + `register_school`), `forms`
(form-builder channel reusing `register_school`), `fixtures`
(generate/advance/constraints), `matches` (state/events/scoring/standings),
`live` (SSE snapshot + WS room), plus React features `tournaments`,
`registration`, `matches`.
