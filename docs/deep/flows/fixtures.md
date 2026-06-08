# Flow: Fixture generation + bracket advancement

Round-robin / knockout / groups→knockout generation → typed source pointers → on-commit advancement.

> Scope: this document traces the *real* call chain from the React UI through DRF, the
> fixture/match service layer, the DB, the post-commit advancement hook, and live fan-out.
> Every claim cites `file:symbol` with line ranges and was verified against source on 2026-06-08.
> Source of truth is the code; where CLAUDE.md / model comments diverge from code that is
> flagged under "Parity / divergence notes".

---

## Participants (concrete modules)

| Alias | Concrete file / symbol |
|---|---|
| UI-Detail | `frontend/src/features/tournaments/TournamentDetailPage.tsx` (`generate` mutation, `ScoreRow.save`) |
| UI-Bracket | `frontend/src/features/tournaments/BracketPage.tsx` + `BracketView.tsx` |
| UI-Console | `frontend/src/features/matches/MatchConsolePage.tsx` (`tr` / `ev` mutations) |
| API-Tourn | `frontend/src/api/tournaments.ts` (`tournamentsApi.generateFixtures` / `.score` / `.matches` / `.standings`) |
| API-Live | `frontend/src/api/live.ts` (`liveApi.transition` / `.recordEvent` / `.snapshot`) |
| URLs | `backend/apps/tournaments/urls.py`, `backend/apps/matches/urls.py` |
| GenView | `backend/apps/fixtures/views.py::GenerateFixturesView.post` |
| Scope | `backend/apps/tournaments/scope.py::accessible_tournaments` + `permissions.py::can_manage_tournament` |
| Generate | `backend/apps/fixtures/services/generate.py` (`generate_round_robin`, `generate_single_elimination`, `generate_knockout_from_groups`) |
| Standings | `backend/apps/matches/services/standings.py::compute_standings` |
| MatchView | `backend/apps/matches/views.py` (`RecordScoreView`, `TransitionMatchView`, `RecordMatchEventView`, `TournamentMatchListView`, `TournamentStandingsView`) |
| Scoring | `backend/apps/matches/services/scoring.py::record_score` |
| State | `backend/apps/matches/services/state.py` (`transition_match`, `_fire_advancement`) |
| Events | `backend/apps/matches/services/events.py` (`record_match_event`, `recompute_score`, `publish_match_event`) |
| Advance | `backend/apps/fixtures/services/advance.py::advance_from_match` |
| Model | `backend/apps/matches/models.py::Match` (`home_source`/`away_source`, `winner_id`/`loser_id`) |
| DB | PostgreSQL (`matches_match`, `matches_match_event`, `audit_*`) |
| Channels | `backend/apps/live/consumers.py::MatchConsumer` (group `match_<id>`) via Redis/in-memory channel layer |

---

## Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    actor Mgr as Manager (browser)
    participant UID as TournamentDetailPage
    participant APIT as tournamentsApi
    participant GV as GenerateFixturesView
    participant SCOPE as accessible_tournaments / can_manage_tournament
    participant GEN as services.generate
    participant STD as compute_standings
    participant MatchView as MatchView (Score/Transition)
    participant Advance as advance_from_match
    participant DB as PostgreSQL

    Note over Mgr,DB: PHASE 1 — Fixture generation (round-robin / knockout / groups→knockout)
    Mgr->>UID: click "Generate round-robin / knockout / knockout_from_groups"
    UID->>APIT: generateFixtures(id,{format,group_size})
    APIT->>GV: POST /api/tournaments/{id}/generate-fixtures/  {format, group_size}
    GV->>SCOPE: accessible_tournaments(user).filter(id).exists()
    SCOPE-->>GV: ok (else 404 tournament_not_found)
    GV->>SCOPE: can_manage_tournament(user, t)
    SCOPE-->>GV: ok (else 403 not_tournament_manager)
    alt format == round_robin
        GV->>GEN: generate_round_robin(t, group_size)
        GEN->>DB: SELECT existing matches (idempotency gate)
        GEN->>GEN: _round_robin(circle method) per group
        Note over GEN,DB: BEGIN transaction.atomic()
        GEN->>DB: UPDATE Team.pool; bulk_create(group matches, source=concrete teams)
        Note over GEN,DB: COMMIT
    else format == knockout
        GV->>GEN: generate_single_elimination(t, registered teams)
        Note over GEN,DB: BEGIN atomic — bulk_create round 1 (source=team), then rounds 2..N (source=winner_of)
        GEN->>DB: bulk_create per round
        Note over GEN,DB: COMMIT
    else format == knockout_from_groups
        GV->>GEN: generate_knockout_from_groups(t)
        GEN->>STD: compute_standings(t, group_label) per group
        STD->>DB: SELECT completed group matches
        STD-->>GEN: ranked rows → top-N team ids (cross-seeded)
        GEN->>GEN: generate_single_elimination(seed teams, stage=knockout)
        GEN->>DB: bulk_create knockout matches
    end
    GV-->>APIT: 201 {generated, format}
    APIT-->>UID: onSuccess → invalidate ["t-matches"],["t-standings"]
    UID->>APIT: GET /api/tournaments/{id}/matches/ (refetch)

    Note over Mgr,DB: PHASE 2 — Result entry → typed-pointer advancement
    rect rgb(240,240,255)
    alt Score via TournamentDetailPage (RecordScoreView)
        Mgr->>UID: enter home/away, Save
        UID->>APIT: score(matchId,{home,away,event_id})
        APIT->>GV: (MatchView) POST /api/matches/{id}/score/
    else Complete via MatchConsolePage (TransitionMatchView)
        Mgr->>UID: (Console) "Complete match"
        UID->>APIT: (liveApi) POST /api/matches/{id}/transition/ {to_status:"completed"}
    end
    end
    APIT->>MatchView: dispatch
    MatchView->>SCOPE: _match_or_404 + _can_score
    SCOPE-->>MatchView: ok (else 404 / 403)
    Note over MatchView,DB: BEGIN atomic() — select_for_update(match)
    MatchView->>DB: set status=COMPLETED/WALKOVER (+scores for record_score); emit_audit
    Note over MatchView,DB: register transaction.on_commit(_fire_advancement(mid))
    Note over MatchView,DB: COMMIT
    MatchView->>Advance: on_commit → _fire_advancement(mid) → advance_from_match(mid)
    Advance->>DB: SELECT match → winner_id/loser_id (property)
    alt winner_id is not None
        Advance->>DB: SELECT dependents in same tournament
        Advance->>DB: for each dep whose *_source.match_id==mid & type∈{winner_of,loser_of}: set *_team_id, save
    else draw / not final
        Advance-->>MatchView: [] (no resolution)
    end
    MatchView-->>APIT: 200/201 MatchSerializer(match)
    APIT-->>UID: onSuccess → invalidate caches; bracket refetch shows filled dependents
```

---

## Ordered walkthrough

### Phase 1 — Fixture generation

1. **UI trigger.** `TournamentDetailPage.tsx` defines `generate = useMutation(...)` calling
   `tournamentsApi.generateFixtures(id,{format})` (`TournamentDetailPage.tsx:283-290`). Three buttons map to the three
   formats: `generate.mutate("round_robin")` / `"knockout"` / `"knockout_from_groups"`
   (`TournamentDetailPage.tsx:466,475,485`). On success it invalidates `["t-matches", id]` and
   `["t-standings", id]` (`:287-288`), which forces the matches/standings queries (`:267-273`) to refetch.

2. **API contract.** `tournamentsApi.generateFixtures` (`api/tournaments.ts:158-168`) issues
   `POST /api/tournaments/{id}/generate-fixtures/` with body
   `{ group_size: opts?.groupSize ?? 5, format: opts?.format ?? "round_robin" }` and types the response
   `{ generated: number; format?: string }`.

3. **Route.** `apps/tournaments/urls.py:77-81` maps `<uuid:tournament_id>/generate-fixtures/` to
   `GenerateFixturesView.as_view()` (mounted under `/api/tournaments/`).

4. **Authorization (two gates).** `GenerateFixturesView.post` (`apps/fixtures/views.py:23-46`):
   first `accessible_tournaments(request.user).filter(id=tournament_id).exists()` → `NotFound("tournament_not_found")`
   on miss (`:24-25`, no existence leak — invariant #2). Then `can_manage_tournament(request.user, t)` →
   `PermissionDenied("not_tournament_manager")` (`:27-28`).

5. **Format dispatch.** `:29-43` reads `request.data.get("format","round_robin")` and branches:
   - `"knockout"` → loads `Team` rows where `status=REGISTERED, deleted_at IS NULL` ordered by `("seed","name")`,
     then `generate_single_elimination(tournament=t, teams=...)` (`:31-37`).
   - `"knockout_from_groups"` → `generate_knockout_from_groups(tournament=t)` (`:38-39`).
   - else (round-robin default) → `generate_round_robin(tournament=t, group_size=int(request.data.get("group_size",5)))` (`:40-43`).
   - `ValueError`/`TypeError` are converted to `DRFValidationError({"detail": str(e)})` (`:44-45`).

6. **Round-robin generation.** `generate_round_robin` (`apps/fixtures/services/generate.py:40-87`):
   - **Idempotency gate:** `existing = Match.objects.filter(tournament, deleted_at IS NULL)`; if any exist it
     returns them unchanged (`:42-46`) — re-POST is a no-op that still returns 201 with the existing count.
   - Loads registered teams ordered `("seed","name")`; raises `ValueError("Need at least 2 …")` if `<2` (`:48-54`).
   - **Transaction boundary:** `with transaction.atomic():` (`:59`) — splits teams into `group_size` chunks,
     stamps each team's `pool` to `Group A/B/…` (`Team.save(update_fields=["pool","updated_at"])`, `:63-66`),
     computes a per-group `inputs_hash = sha256(sorted team ids)` (invariant #10, `:67-69`), generates pairings
     via `_round_robin` (circle method, home/away alternated by round, `:21-37`), and `Match.objects.bulk_create`
     all rows (`:86`). Each match is `stage="group"`, `status=SCHEDULED`, with **concrete** `home_team`/`away_team`
     (no source pointers set → `home_source`/`away_source` default to `{}`).

7. **Single-elimination generation.** `generate_single_elimination` (`generate.py:90-143`):
   - Validates a power-of-2 team count `>=2` else `ValueError` (`:97-98`).
   - `match_no` continues after any existing matches (`Match.objects.filter(tournament).count()`, `:103`).
   - **Transaction boundary:** `with transaction.atomic():` (`:105`). **Round 1** pairs concrete teams and sets
     `home_source={"type":"team","team_id":…}` / `away_source={"type":"team",…}` (`:107-119`), then `bulk_create`.
     **Rounds 2..N** loop while `len(prev) > 1`, creating matches with **typed pointers**
     `home_source={"type":"winner_of","match_id":str(prev[i].id)}` and `away_source` for `prev[i+1]`
     (`:125-141`) — `home_team`/`away_team` left `None` until resolved. Each round `bulk_create`d before
     building the next so `prev[i].id` is populated.

8. **Groups→knockout generation.** `generate_knockout_from_groups` (`generate.py:146-189`):
   - **Idempotency gate:** returns existing `stage="knockout"` matches if present (`:153-159`).
   - Collects distinct non-empty `group_label`s from `stage="group"` matches; `ValueError` if none (`:161-171`).
   - For each group calls `compute_standings(tournament, group_label=g)` and takes the top `advance_per_group`
     (default 2) `team_id`s; `ValueError` if a group can't supply 2 (`:173-179`).
   - **Cross-seed:** group `i` winner vs group `(i+1)%n` runner-up, building `seed_ids` (`:181-187`).
   - Resolves `Team` objects and delegates to `generate_single_elimination(..., stage="knockout")` (`:188-189`)
     — so the knockout round-1 has **concrete** teams (`source=team`) drawn from group results, later rounds
     carry `winner_of` pointers.

9. **Standings used during seeding.** `compute_standings` (`apps/matches/services/standings.py:32-83`) reads
   `Tournament.rules` via `merge_rules` (data-driven points/tiebreakers, `:33-38`), aggregates only
   `status=COMPLETED, deleted_at IS NULL` matches (optionally filtered by `group_label`, `:40-47`), builds per-team
   rows, computes `GD`, and sorts by `_sort_key` over the configured tiebreaker list (`:79-83`).
   `team_id` in each row is a **string** (`:58`).

10. **Response + cache refresh.** `GenerateFixturesView` returns `Response({"generated": len(matches),
    "format": fmt}, status=201)` (`views.py:46`). The UI's `onSuccess` invalidation (step 1) refetches matches
    via `TournamentMatchListView` (`apps/matches/views.py:86-96`, ordered `("group_label","match_no")`,
    serialized by `MatchSerializer`).

### Phase 2 — Result entry → typed-pointer advancement

There are **two distinct code paths** to a terminal-with-result state, both of which arm the advancement hook:

11. **Path A — record_score (direct completion).** `ScoreRow.save` (`TournamentDetailPage.tsx:41-52`) calls
    `tournamentsApi.score(matchId,{home_score,away_score,event_id:newEventId()})`
    (`api/tournaments.ts:175-179`) → `POST /api/matches/{id}/score/` → `RecordScoreView.post`
    (`apps/matches/views.py:138-160`). Guards: `_match_or_404` (`:142`, scope check at `:58-68`) and
    `_can_score` (`:143`, manager/assigned-scorer/active match_scorer at `:71-83`). Body validated by
    `RecordScoreSerializer` (`serializers.py:41-44`: `home_score`/`away_score` 0..99, optional `event_id`).
    Calls `record_score(...)` (`scoring.py:53-103`):
    - **Idempotency point:** if `event_id` already exists as an `AuditEvent(event_type="match_scored")`, returns
      the match unchanged (`scoring.py:64-69`) — replay-safe (invariant #3).
    - **Transaction boundary:** `with transaction.atomic():` + `Match.objects.select_for_update().get(pk)`
      (no TOCTOU between scorers, `:71-72`). Rejects re-scoring unless current status ∈ `{SCHEDULED, LIVE}`
      (`:73-76`). Sets scores + `status=COMPLETED`, saves, `emit_audit("match_scored", idempotency_key=event_id)`
      (`:82-97`).
    - **on_commit arm:** `transaction.on_commit(lambda: _fire_advancement(mid))` (`:99-102`).

12. **Path B — transition_match (state machine).** `MatchConsolePage` `tr` mutation
    (`MatchConsolePage.tsx:99-102`) calls `liveApi.transition(matchId, to)` (`api/live.ts:57-59`) →
    `POST /api/matches/{id}/transition/ {to_status}` → `TransitionMatchView.post`
    (`apps/matches/views.py:224-247`, same `_match_or_404` + `_can_score` guards). Body validated by
    `TransitionSerializer` (`serializers.py:56-58`). Calls `transition_match(...)` (`state.py:40-70`):
    - **Transaction boundary:** `with transaction.atomic():` + `select_for_update` on the match (`:41-42`).
    - Validates against `ALLOWED_TRANSITIONS` (`:22-31`); illegal → `ValidationError` (`:44-45`). Allowed
      terminal-with-result targets from `SCHEDULED`/`LIVE`/`HALF_TIME`: `WALKOVER` / `COMPLETED`.
    - Sets status, maintains `current_period`, saves, `emit_audit("match_status_changed")` (`:47-65`).
    - **on_commit arm:** only when `to_status in _TERMINAL_WITH_RESULT == (COMPLETED, WALKOVER)`
      → `transaction.on_commit(lambda: _fire_advancement(mid))` (`:67-69`).

13. **Live-event path (score derivation, no direct completion).** `RecordMatchEventView`
    (`views.py:163-221`) → `record_match_event` (`events.py:77-128`) appends an immutable `MatchEvent`
    with a **gapless `sequence_no`** (`select_for_update` on match + `Max(sequence_no)+1` under
    `transaction.atomic()`, `:88-94`), then `recompute_score` derives `home_score`/`away_score` from
    non-voided GOAL-type events (`events.py:49-74`). **Idempotency point:** prior `MatchEvent.event_id`
    short-circuits and returns the existing row (`events.py:83-86`). This path **does not** change status to
    COMPLETED and therefore **does not** arm advancement — advancement only fires through Path A or Path B.

14. **Post-commit hook fan-in.** Both paths register `_fire_advancement(match_id)` (`state.py:73-80`), which
    swallows all exceptions (post-commit hooks must never crash the request, `:79-80`) and calls
    `advance_from_match` (`apps/fixtures/services/advance.py:16-46`):
    - Loads the match; reads `winner_id`/`loser_id` (**model properties**, `models.py:107-124`): these return
      `None` unless `status ∈ {COMPLETED, WALKOVER}` AND both scores are non-null AND scores differ
      (a draw → `winner_id is None`).
    - If `winner_id is None` → returns `[]` (draw or not-yet-final ⇒ nothing resolves, `advance.py:23-24`).
    - Otherwise selects all non-deleted matches in the **same tournament** (`:28`), and for each dependent and
      each side (`home`/`away`) whose `*_source.get("match_id") == str(this_match.id)`: if
      `type=="winner_of"` sets `*_team_id = winner_id`; if `type=="loser_of"` sets `*_team_id = loser_id`
      (`:33-42`). Changed dependents are saved with
      `update_fields=["home_team","away_team","updated_at"]` (`:43-45`) and returned.

15. **Response + UI propagation.** `RecordScoreView`/`TransitionMatchView` `refresh_from_db()` and return
    `MatchSerializer(match)` (`views.py:159-160,246-247`). The `MatchSerializer` exposes
    `home_team`/`away_team` as `{id,name,short_name}` minis (`serializers.py:16-38`) but **does not serialize
    `home_source`/`away_source`** — pointers are server-internal. Resolved dependents become visible to the UI
    only on the next `GET /api/tournaments/{id}/matches/`.

### Bracket rendering (read side)

16. **Bracket fetch.** `BracketPage` (`BracketPage.tsx:11-14`) queries `["t-matches", id]` →
    `tournamentsApi.matches` → `GET /api/tournaments/{id}/matches/` → `TournamentMatchListView`
    (`views.py:86-96`).

17. **Bracket layout.** `BracketView` (`BracketView.tsx:205-245`) groups matches by `group_label`
    (fallback "Bracket"), then by `round_no` into columns; a band is a knockout tree if any match has
    `stage==="knockout"` (`:220`). `KnockoutTree` (`:50-110`) draws connectors with fixed geometry; a
    round-robin band renders `GroupTable` (`:155-198`) with the top-`advance` (default 2) rows marked
    "▲ Advances". `winnerSide` highlights the winner from `home_score`/`away_score` when `status==="completed"`
    (`:14-21`).

---

## Transaction boundaries & `transaction.on_commit` points

| Boundary | Location | Notes |
|---|---|---|
| Round-robin write | `generate.py:59` `transaction.atomic()` | Team `pool` updates + `bulk_create` group matches atomically. |
| Single-elim write | `generate.py:105` `transaction.atomic()` | Per-round `bulk_create` inside one txn (round N built after round N-1 has ids). |
| Groups→knockout | inherits `generate_single_elimination`'s atomic block | Standings reads happen *before* the atomic write. |
| record_score | `scoring.py:71` `transaction.atomic()` + `select_for_update` (`:72`) | **on_commit:** `_fire_advancement(mid)` (`scoring.py:99-102`). |
| transition_match | `state.py:41` `transaction.atomic()` + `select_for_update` (`:42`) | **on_commit:** `_fire_advancement(mid)` only for `COMPLETED`/`WALKOVER` (`state.py:67-69`). |
| record_match_event | `events.py:88` `transaction.atomic()` + `select_for_update` (`:89`) | **on_commit:** `publish_match_event(mid,eid)` (`events.py:127`) — live fan-out only, NOT advancement. |
| advance_from_match | **no explicit atomic** | Runs post-commit (outside the request txn). Each dependent `save()` is its own autocommit write. Exceptions are swallowed by `_fire_advancement` (`state.py:79-80`). |

---

## Idempotency points

| Point | Mechanism | Result on replay |
|---|---|---|
| `generate_round_robin` | `if existing: return existing` (`generate.py:42-46`) | No new matches; view still returns `201 {generated:<existing count>}`. |
| `generate_knockout_from_groups` | `if existing(stage="knockout"): return existing` (`generate.py:153-159`) | Same as above. |
| `record_score` | `AuditEvent(idempotency_key=event_id, event_type="match_scored")` lookup (`scoring.py:64-69`) | Returns the match unchanged; advancement NOT re-armed. |
| `record_match_event` | `MatchEvent.event_id` unique lookup (`events.py:83-86`; DB unique constraint `models.py:284`) | Returns the prior event; no duplicate, no re-publish. |
| `advance_from_match` | Naturally idempotent: re-resolving a dependent sets the same `*_team_id` (`advance.py:33-45`) | Safe to run twice (e.g. Path B after Path A on same match). |
| `set_lineup` / `confirm_lineup` / `file_incident` | `event_id` on the respective models | (adjacent to flow; not core here) |

---

## Client ↔ server contracts this flow depends on

1. **Generate:** `POST /api/tournaments/{id}/generate-fixtures/`
   - Request: `{ format: "round_robin"|"knockout"|"knockout_from_groups", group_size?: number }`
     (`api/tournaments.ts:158-168`; server reads `format` + `group_size` at `fixtures/views.py:29,42`).
   - Response: `201 { generated: number, format: string }` (`fixtures/views.py:46`).
   - Errors: `404 "tournament_not_found"`, `403 "not_tournament_manager"`, `400 {detail:<ValueError msg>}`.

2. **List matches (bracket source):** `GET /api/tournaments/{id}/matches/`
   - Response: `MatchRow[]` = `{id, stage, group_label, round_no, match_no, status, home_team|null,
     away_team|null, home_score|null, away_score|null, scheduled_at|null}`
     (`MatchSerializer` `serializers.py:16-38` ↔ TS `MatchRow` `api/tournaments.ts:69-81`).
     **Note:** `current_period` is serialized by the backend (`serializers.py:25`) but absent from the TS
     `MatchRow` interface. `home_source`/`away_source` are **not** exposed.

3. **Standings:** `GET /api/tournaments/{id}/standings/` → `{ groups: [{group_label, rows: StandingRow[]}] }`
   (`TournamentStandingsView` `views.py:99-114` ↔ `StandingsGroup`/`StandingRow` `api/tournaments.ts:83-100`).

4. **Score (Path A):** `POST /api/matches/{id}/score/`
   - Request: `{ home_score:int(0..99), away_score:int(0..99), event_id:UUID }`
     (`RecordScoreSerializer` `serializers.py:41-44`; UI always sends `event_id: newEventId()` `TournamentDetailPage.tsx:46`).
   - Response: `200 MatchSerializer(match)`. Errors: `404 "match_not_found"`, `403 "not_allowed_to_score"`,
     `400 {detail:"Cannot score a match in status '<x>'."}`.

5. **Transition (Path B):** `POST /api/matches/{id}/transition/`
   - Request: `{ to_status: string, reason?: string }` (`TransitionSerializer` `serializers.py:56-58`;
     UI sends only `to_status` `api/live.ts:57-59`).
   - Response: `200 MatchSerializer(match)`. Errors: `404`, `403 "not_allowed_to_transition"`,
     `400 {detail:"Illegal match transition: <from> -> <to>"}`.

6. **Live event / snapshot:** `POST /api/matches/{id}/events/` (`RecordEventSerializer` `serializers.py:47-53`)
   and `GET /api/live/match/{id}/` → `LiveSnapshot` (`api/live.ts:26-42`). The console polls the snapshot every
   5s (`MatchConsolePage.tsx:74-78`) and invalidates on mutation (`:97,101`).

7. **Live fan-out (server→server, not consumed by these pages):** `publish_match_event`
   (`events.py:27-46`) does `channel_layer.group_send("match_<id>", {type:"match.event", data:{match_id,event_id}})`;
   `MatchConsumer` (`live/consumers.py:10-28`) joins group `match_<id>` and forwards. The score/bracket pages use
   HTTP polling + TanStack invalidation, **not** this WebSocket.

8. **Auth/transport invariants:** session cookie + CSRF header (invariant #15), same-origin SPA; all match/tournament
   resolution goes through `accessible_tournaments` (404-on-no-access, no existence leak — invariant #2).

---

## Parity / divergence notes (for the restructuring)

1. **Documented pointer types vs. implemented.** `models.py:73` and CLAUDE.md list five `*_source` types:
   `winner_of` / `loser_of` / `group_position` / `team` / `tbd`. The generators only **emit** `team`
   (round 1, `generate.py:115-116`) and `winner_of` (later rounds, `generate.py:133-134`).
   `advance_from_match` only **resolves** `winner_of` and `loser_of` (`advance.py:37-42`). **`group_position`
   and `tbd` are never produced or consumed anywhere in code** — groups→knockout instead pre-resolves group
   standings into concrete `team` pointers at generation time (`generate.py:188-189`), so a group-stage
   re-score does NOT propagate into an already-generated knockout. `loser_of` is supported by the resolver but
   no generator emits it (no 3rd-place / double-elim path exists).

2. **Two advancement entry points, subtle asymmetry.** `record_score` (Path A) sets scores **and** completes in
   one call, so `winner_id` is well-defined when advancement fires. `transition_match` to `COMPLETED`/`WALKOVER`
   (Path B) does **not** set scores — if a match is completed via transition without scores having been recorded
   (e.g. no events / no prior `record_score`), `winner_id` is `None` (`models.py:107-117`) and
   `advance_from_match` resolves nothing (`advance.py:23-24`). A WALKOVER similarly needs scores set elsewhere to
   produce a winner. The restructuring should unify "set result" and "advance" into a single explicit result verb.

3. **Frontend cache gap after console completion.** `MatchConsolePage` mutations invalidate only
   `["live", matchId]` (`MatchConsolePage.tsx:97,101`); they do **not** invalidate `["t-matches"]`/`["t-standings"]`.
   So completing a match from the console resolves dependents server-side, but the bracket page won't reflect the
   newly filled team until it independently refetches. `ScoreRow.save` in `TournamentDetailPage` does invalidate
   both (`:49-50`). Inconsistent client-side invalidation across the two completion UIs.

4. **`advance_from_match` scan cost / lack of txn.** It loads *every* non-deleted match in the tournament and
   iterates in Python (`advance.py:28-42`) with no `select_for_update` and no wrapping transaction; each resolved
   dependent is a separate autocommit `save`. Two terminal events committing near-simultaneously could each run
   the scan post-commit; resolution is idempotent (note above) but there is no locking and no batching.

5. **Round-robin is single-elimination's only group source, but pointers aren't wired between stages.** Because
   `generate_knockout_from_groups` snapshots standings into concrete teams, the typed-pointer machinery
   (invariant #9) is effectively used **only within** a single knockout bracket, never to bridge group→knockout.
   This is the biggest gap relative to the "flexible FET-style constraint engine" vision in the memory note.

6. **Idempotent generate returns 201 with a misleading `generated` count.** A replayed generate returns
   `{generated: <count of pre-existing matches>}` at `status=201` (`fixtures/views.py:46`), not a 200 — the
   client can't distinguish "freshly generated" from "already existed".

7. **No `transaction.on_commit` for generation.** Generation has no post-commit side effects (no notifications,
   no live publish). Only the result/event paths use `on_commit`.
