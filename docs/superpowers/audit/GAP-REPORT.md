# Gap Report — fixture.doxaed.com

> Generated 2026-06-05 from the multi-agent `e2e-gap-audit` workflow (4 auditor agents). This is the authoritative remaining-work roadmap. Severities are the auditors' assessments; see notes where the main engineer has since revised or fixed an item.

**Totals:** 47 gaps — 10 blocker, 12 high, 14 medium, 11 low.

## Dimension summaries
### Acceptance-test coverage (owner's 10-step end-to-end flow) (10 gaps)

The happy-path spine of the owner's acceptance test exists end-to-end and is honestly unit-tested for most steps: signup/login, self-serve tournament create (creator becomes admin), tournament-scoped email invite -> accept -> role assignment, a public shareable registration link where schools self-enter multiple teams + players, round-robin fixture generation across groups, aggregate score recording, and group standings. A demo command (run_e2e_demo) actually drives 10 schools / 20 teams to completion. HOWEVER several items are partial or have real functional gaps, not just happy-path-only thinness: (a) per-match scorer ASSIGNMENT (#7) has a service (assign_scorer) and unit test but NO API endpoint and NO UI — and because of how RecordScoreView authorizes, an invited tournament-wide match_scorer who is not a manager literally cannot score any match through the API (the only path that sets match.scorer_id is the management command); (b) scoring (#8) records only a final aggregate home/away integer — there is NO MatchEvent model anywhere, directly violating architectural invariant #4 (DB-first event log as system of record) and meaning goals/cards/lineups/"real" event-level scoring do not exist; (c) advancement (#9) is unimplemented — home_source/away_source JSONB pointers exist on Match but no winner_of/loser_of resolution and no transaction.on_commit advancement hook (invariant #9); only round-robin group play + standings exist, no knockout bracket; (d) player detail depth (#4) captures name/jersey/position and birth-YEAR only (dob_year smallint), not a full date of birth, and the public form omits captain/goalkeeper flags that the model/serializer support; standings tiebreak is GD-then-GF only (no head-to-head/fair-play). Multi-tenant isolation is well-tested across the new endpoints. Item #10 ("all other events") is essentially the entire Phase-1B match domain (MatchEvent, MatchAssignment, Lineup, transitions, coin-toss, disputes, live SSE/WS) per v1Matches.md and is not built.

### Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures) (12 gaps)

Phase 1B's four new apps are clean, well-structured, and notably better than the 1A baseline on three fronts: every state-changing service is org-isolation-scoped through accessible_tournaments()/can_manage_tournament() with real cross-org tests (outsider→404), the main mutations (create_tournament, register_school, record_score) thread event_id, and DRF input serializers validate scores/jerseys/captains. Several 1A frontend-contract P0s (acceptInvitation org_slug, createInvitation roles[], setGrants reason) appear fixed. HOWEVER, the deploy-blocking 1A P0s are still OPEN: no backend/fixture/settings/prod.py exists, backend/.env still contains a plaintext super-admin password (DoxaEd33@) + dev SECRET_KEY + a Postgres-SUPERUSER DSN (which voids the append-only audit guarantee), the 2FA second factor still has zero rate-limiting, and the _OrgMembershipPermission org-is-None fail-open and emit_audit check-then-create TOCTOU are unchanged. The new code inherits the TOCTOU: its entire idempotency story (invariant #3) rests on a non-atomic AuditEvent.filter().first() guard with NO unique DB constraint on the domain rows, so concurrent event_id replays can double-create teams/matches and 500. RBAC invariant #12 is NOT honored by the new endpoints — they use the simpler tournament/org-role checks instead of the 22-module matrix (confirmed; this is a deliberate but undocumented divergence). The biggest NEW security gap is the AllowAny PublicRegistrationView: the registration link has no expiry, no usage cap, and the endpoint carries only the default anon:60/min throttle — a leaked/guessed-distribution link lets anyone create effectively unlimited teams/players/Person rows (storage-exhaustion / spam / DB bloat), with no email gate and no per-link rate limit. Risk: deploy-blocking config/secret/audit-role items remain; the new abuse surface and idempotency-race are HIGH.

### Test coverage & browser-verification gaps (11 gaps)

The codebase has grown well past the "greenfield" CLAUDE.md note and past the old cross-e2e-flow.md audit: the tournaments/teams/matches/fixtures apps now exist and are wired end-to-end (CreateTournamentPage, TournamentDetailPage with score inputs + Generate-fixtures button, public registration, unified invite-accept). Unit/component coverage is actually decent — every new backend domain app has tests (including cross-org isolation + idempotency cases) and most new frontend pages have vitest tests. HOWEVER, the brief's three concerns all hold up under verification: (a) a concrete set of backend views/services and frontend pages have NO automated test; (b) the one and only real-browser suite (frontend/e2e/role-smoke.spec.ts) is a login/role-landing smoke test — it does NOT drive tournament creation, the Generate-fixtures button, score entry, or invite→accept in a real browser, and the tournament-feature component tests all fully mock @/api/tournaments so they never hit the real DRF backend or run in a browser; (c) there are real cross-layer integration gaps — a dead duplicate API method, a service (assign_scorer) with no route or UI so the assigned-scorer score-entry path is unreachable without DB seeding, and no live/SSE/WebSocket layer despite invariants #4/#11. None of the four flagged flows (create tournament, generate fixtures, score entry, invite→accept) is covered by any test that actually executes them against the running stack in a browser; the demo seed (run_e2e_demo.py) pre-completes them, which is exactly why they were never browser-verified.

### Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes) (14 gaps)

The shipped Phase-1B slice is a thin happy-path demo, not the designed product. What is BUILT: tournament creation (DRAFT only), direct team/player registration, a fixed round-robin generator (circle method), a single final-score write that flips Match scheduled->completed, and league standings. The end-to-end demo (run_e2e_demo.py) proves exactly this narrow path: create tournament -> register schools -> generate round-robin -> record one score per match -> compute standings. Against the specs, the delta is enormous and structural, not cosmetic. Three entire designed apps DO NOT EXIST: apps/live (SSE+WebSocket+Redis pub/sub, v1Live.md), apps/notifications (bell+dispatcher+cron, v1Notifications.md), apps/disputes (lifecycle+cascade, v1Disputes.md) — confirmed absent from backend/apps and from LOCAL_APPS in settings/base.py (lines 48-58). CHANNEL_LAYERS is still InMemoryChannelLayer (base.py:190-191) — no Redis, no SSE, no WS consumer, so the entire live-scoring transport (invariant #11) is unbuilt. The Match state machine is 4 states (scheduled/live/completed/cancelled) vs PRD §5.5's ~12 live/terminal states; there is NO MatchEvent event log (invariant #4 event-sourcing is absent — scoring writes a final scalar score, not events with sequence_id), NO Lineup, NO MatchAssignment, NO clock. The Tournament state machine enum has 7 values but NO transition service exists — only create.py ever sets status (=DRAFT); no publish/registration/bracket-lock/go-live/complete transitions, no ALLOWED_TRANSITIONS table, no audited transitions (PRD §5.2 unimplemented), no side states (cancelled/paused/disputed/orphaned). Invariant #9 typed-dependency advancement is a no-op: home_source/away_source JSONB columns exist on Match but are NEVER written or read by any code; there is NO knockout/groups->knockout format, NO winner_of/loser_of resolution, NO transaction.on_commit advancement hook anywhere (grep for on_commit/advancement in apps yields nothing relevant). Rule freeze (invariant #7) is entirely absent: inputs_hash/last_manual_edit_at exist as unused columns; no rule_freeze_at, no roster freeze, no per-match freeze. The fixtures constraint DSL (v1Fixtures.md §3, the headline flexibility feature) is completely unbuilt — no SchedulingConstraint, no ScheduleRun, no Venue, no CP-SAT solver, no Phase B scheduling at all; the generator is a hardcoded round-robin. Player depth is shallow: Person uses plaintext dob_year (NOT Fernet-encrypted dob per v1Teams §7.3), no eligibility_status, no PlayerSuspension, no RosterSnapshot, no roster_schema validation, no TeamRegistration/approval state machine (register_school creates teams directly in REGISTERED, bypassing pending_approval/reject entirely), no TeamMembership two-layer TM auth. Multi-tenancy/idempotency/audit chassis IS present and reused well on the slice that exists, but most designed surfaces and their mandatory isolation/state-machine/cascade tests do not exist because the features do not exist.

## Gaps by severity

### BLOCKER

- **Per-match scorer assignment has no API endpoint or UI (acceptance item #7 only partially met)**  
  - _dimension:_ Acceptance-test coverage (owner's 10-step end-to-end flow)
  - _status:_ partial  
  - _area:_ `backend/apps/matches/services/scoring.py (assign_scorer), backend/apps/matches/urls.py, frontend/src/api/tournaments.ts, frontend/src/features/tournaments/TournamentDetailPage.tsx`  
  - _evidence:_ assign_scorer() exists in backend/apps/matches/services/scoring.py:34 and is unit-tested (backend/apps/matches/tests/test_scoring.py:94 test_assign_scorer_requires_tournament_membership), but matches/urls.py exposes ONLY '<uuid:match_id>/score/'. There is no '/assignments/' route (v1Matches.md:477 specifies POST /api/matches/{id}/assignments/). The ONLY caller of assign_scorer outside tests is backend/apps/tournaments/management/commands/run_e2e_demo.py:115. frontend tournamentsApi has no assignScorer method; TournamentDetailPage has no assignment UI.  
  - _fix:_ Add a POST /api/matches/{id}/scorer/ (or /assignments/) view delegating to assign_scorer with can_manage_tournament gating, plus a frontend control on the match list to pick from tournament match_scorer members. Add an API-level test asserting a manager can assign and that the assigned scorer is persisted.

- **Invited tournament-wide match_scorer cannot actually score any match via the API**  
  - _dimension:_ Acceptance-test coverage (owner's 10-step end-to-end flow)
  - _status:_ partial  
  - _area:_ `backend/apps/matches/views.py (RecordScoreView), backend/apps/tournaments/permissions.py (can_manage_tournament)`  
  - _evidence:_ RecordScoreView (backend/apps/matches/views.py:69-73) authorizes scoring only if can_manage_tournament(user, match.tournament) OR match.scorer_id == request.user.id. can_manage_tournament (backend/apps/tournaments/permissions.py:11-14) returns true only for tournament ADMIN/CO_ORGANIZER or org admin. Since no API/UI ever sets match.scorer_id (see prior finding), a user invited+accepted as role 'match_scorer' (the exact acceptance-test scenario) fails BOTH branches and gets 403 not_allowed_to_score. No test covers a non-manager match_scorer scoring via HTTP.  
  - _fix:_ After adding scorer assignment, add an end-to-end test: invite match_scorer -> accept -> assign to match -> that user POSTs /score/ and succeeds; and assert an unassigned match_scorer is rejected. This is the literal flow the owner described and is currently broken.

- **Knockout brackets + groups->knockout + typed-dependency advancement (invariant #9) entirely unbuilt**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ missing  
  - _area:_ `backend/apps/fixtures/services/generate.py, backend/apps/matches/models.py`  
  - _evidence:_ generate.py only implements _round_robin (circle method) producing concrete home_team/away_team rows; v1Fixtures.md §2 lists single/double-elim, groups->knockout, Swiss, multi-stage as designed formats. Match.home_source/away_source JSONB fields exist (models.py:45-46, commented 'invariant #9') but a repo-wide grep for home_source/away_source/winner_of/advancement/on_commit shows they are NEVER written or read by any service. No knockout generator, no winner_of/loser_of/group_position resolver, no transaction.on_commit advancement hook (the invariant-#9 / PRD §10 domain-event mechanism). compute_standings can rank a group but nothing consumes the ranking to seed a knockout stage.  
  - _fix:_ Build apps/fixtures Phase-A knockout + groups->knockout generators that emit Match rows with typed home_source/away_source pointers, and a matches/fixtures advancement service invoked via transaction.on_commit on match finalization that resolves winner_of/loser_of/group_position into concrete teams. This is the seam the whole tournament product hinges on; without it only single-group round-robins work.

- **Live scoring transport (SSE + WebSocket + Redis pub/sub) — apps.live does not exist (invariant #11)**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ missing  
  - _area:_ `backend/apps/live/ (absent), backend/fixture/settings/base.py:190-191, backend/fixture/asgi.py`  
  - _evidence:_ Glob of backend/apps/{live,notifications,disputes} returns nothing; LOCAL_APPS (base.py:48-58) ends at apps.fixtures with no apps.live. CHANNEL_LAYERS is still InMemoryChannelLayer (base.py:190-191) — v1Live.md §9.1 mandates replacing it with channels_redis. No MatchScoringConsumer, no SSE async views (match_stream/notification_stream/genrun_stream), no publish.py, no WSPresence/LiveConnectionAudit models, no ProtocolTypeRouter in asgi. The public viewer, scorer/referee WS room, notification bell SSE, and genrun-progress SSE specified across v1Live.md are 0% built.  
  - _fix:_ Implement apps.live per v1Live.md: swap CHANNEL_LAYERS to channels_redis, rewrite asgi.py with ProtocolTypeRouter+OriginValidator+session auth, add the three SSE endpoints, MatchScoringConsumer (relaying through the idempotent matches write path), and the publish-on-commit helper. Depends on MatchEvent existing first.

- **MatchEvent DB-first event log + clock + lineup + assignments unbuilt; scoring is a single scalar write (invariants #4)**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ partial  
  - _area:_ `backend/apps/matches/models.py, backend/apps/matches/services/scoring.py`  
  - _evidence:_ matches/models.py defines only Match (home_score/away_score scalars). v1Matches.md specs MatchEvent (sequence_id, event_id unique, type, payload, event_status, void/correct, lines 266-291), MatchAssignment (line 213), Lineup/LineupPlayer (line 241), MatchEventType taxonomy, and the per-match clock. None exist (grep for 'class MatchEvent|Lineup|MatchAssignment' across apps = No matches). scoring.record_score (scoring.py:53-98) just sets home_score/away_score and status=COMPLETED — there is no event stream, so invariant #4 ('MatchEvent rows are the system of record; WS/SSE are delivery only') has nothing to deliver. assign_scorer writes Match.scorer FK rather than a MatchAssignment row with referee/scorer roles + status.  
  - _fix:_ Build the MatchEvent event log with gapless sequence_id (select_for_update Max+1), the period/clock state transitions, Lineup submit+validation, and MatchAssignment. record_match_event must INSERT an event and publish on_commit. This is the prerequisite for live transport and disputes cascade.

- **Match state machine: 4 states vs PRD §5.5's ~12; no period/terminal states, no audited transitions**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ partial  
  - _area:_ `backend/apps/matches/models.py:16-20, scoring.py`  
  - _evidence:_ MatchStatus = {scheduled, live, completed, cancelled} (models.py:16-20). PRD §5.5 (lines 395-423) specifies lineup_pending -> lineup_submitted -> live_pre_kickoff -> live_first_half -> live_halftime -> live_second_half -> [live_extra_time] -> [live_penalty_shootout] -> awaiting_referee_approval -> final -> archived, plus postponed/walkover/abandoned/cancelled/disputed. v1Matches.md:59 references MatchStatus per PRD §5.5. The only transition implemented is scheduled/live -> completed inside record_score; there is no ALLOWED_TRANSITIONS table, no referee-approval gate, no walkover/abandonment/postpone verbs, no per-match rule freeze on live_first_half (invariant #7). PRD §5.5 lines 377/420-422/488-489 (walkover/double-walkover/abandonment policies) are unimplemented.  
  - _fix:_ Expand MatchStatus to the PRD §5.5 enum, implement a guarded transition service with audited transitions and the referee-approval -> final advancement trigger, and add walkover/abandoned/postponed/cancelled verbs with their policies.

- **Tournament state machine: enum exists but NO transition service; only DRAFT is ever set (PRD §5.2)**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ partial  
  - _area:_ `backend/apps/tournaments/models.py:24-33, services/create.py:71`  
  - _evidence:_ TournamentStatus has 7 values (draft..archived) but the ONLY assignment in the codebase is create.py:71 status=DRAFT (grep for 'TournamentStatus.' shows it referenced only in models, create.py, and one test). No publish/registration_open/registration_closed/bracket_generated/scheduled/live/completed/archived transition functions exist; v1Tournaments.md §3 specs a TournamentStateTransition model (line 300) + a guarded transition service (line 472) that sets rule_freeze_at on registration_open. Side states cancelled/paused/disputed/orphaned (PRD §5.2 lines 293-296) and their preconditions (min_teams_to_start gate, zero-hard-conflict gate, no-open-dispute gate) are absent. The Tournament model lacks the designed fields entirely: no registration window, min_teams_to_start, rule_freeze_at, dispute_window_hours, dispute_cascade_policy, structured_rules (v1Tournaments.md:211-256).  
  - _fix:_ Add the missing Tournament fields and implement the PRD §5.2 transition service with ALLOWED_TRANSITIONS, preconditions, audit, and side states. Wire rule_freeze_at on registration_open.

- **Plaintext super-admin password + dev SECRET_KEY + Postgres-superuser DSN still committed in backend/.env**  
  - _dimension:_ Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures)
  - _status:_ missing  
  - _area:_ `backend/.env (lines 2,3,6)`  
  - _evidence:_ backend/.env still reads: line2 SECRET_KEY=dev-only-not-for-prod-replace-me-please-change-this-now; line3 DATABASE_URL=postgres://postgres:postgress@localhost:5432/fixturedb (connects as the postgres SUPERUSER); line6 SUPERUSER_PASSWORD=DoxaEd33@ in cleartext. This is the #1 audit P0 and is UNCHANGED since the report. Connecting as postgres makes the append-only audit trigger (invariant #5) bypassable (TRUNCATE/DROP/DISABLE/REPLACE) and any future REVOKE a no-op.  
  - _fix:_ Rotate the SA password and DB credentials NOW; remove SUPERUSER_PASSWORD from .env (read interactively or one-time bootstrap then delete); generate a real SECRET_KEY; provision a NON-superuser, non-owner app DB role and switch DATABASE_URL to it; add a checked-in audit-hardening migration (BEFORE TRUNCATE trigger + REVOKE UPDATE,DELETE,TRUNCATE owned by a separate admin role). Scrub from git history.

- **No prod.py settings module — every entrypoint runs DEBUG=True with dev-only InMemory/LocMem backends**  
  - _dimension:_ Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures)
  - _status:_ missing  
  - _area:_ `backend/fixture/settings/ (only base.py + dev.py)`  
  - _evidence:_ ls of backend/fixture/settings/ shows only base.py and dev.py — no prod.py. backend/.env line1 is DEBUG=True. base.py:191 sets CHANNEL_LAYERS to InMemoryChannelLayer and base.py:195-200 CACHES to LocMemCache; the cache-backed throttles (60/min anon, signup 3/hr, feedback 10/hr) are therefore per-process and ineffective under multiple ASGI workers in prod. No SECURE_*/HSTS/CSP/NUM_PROXIES anywhere.  
  - _fix:_ Create backend/fixture/settings/prod.py: DEBUG off, SECURE_SSL_REDIRECT/HSTS/SECURE_PROXY_SSL_HEADER/NUM_PROXIES, Redis cache + channels_redis, real SMTP; move InMemory/LocMem to dev.py only; wire a deploy pre-flight (load_modules/load_sports + DB role provisioning + 'no tournament live' migration guard).

- **2FA second factor still has NO rate-limit (brute-forceable); recovery-code double-spend race unaddressed**  
  - _dimension:_ Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures)
  - _status:_ missing  
  - _area:_ `backend/apps/accounts/services/twofa.py, backend/apps/accounts/views.py (2FA branch)`  
  - _evidence:_ Grep of twofa.py for axes|rate|attempt|lock returns ZERO hits — the TOTP/recovery verification path is unthrottled. AXES_RESET_ON_SUCCESS=True (base.py:187) zeroes the counter on each correct password, and the 2FA branch never touches axes; only AnonRateThrottle 60/min applies. This is the report's auth-F1 P0, unfixed. _verify_recovery still has no select_for_update (double-spend race).  
  - _fix:_ Add a dedicated per-(user|ip) 2FA-attempt lockout that does NOT reset on password success; make recovery-code consumption a conditional UPDATE ... WHERE used_at IS NULL with rowcount check under select_for_update.

### HIGH

- **No MatchEvent model — scoring is aggregate only; violates invariant #4 (DB-first event log)**  
  - _dimension:_ Acceptance-test coverage (owner's 10-step end-to-end flow)
  - _status:_ missing  
  - _area:_ `backend/apps/matches/models.py, backend/apps/matches/migrations/0001_initial.py, backend/apps/matches/services/scoring.py`  
  - _evidence:_ Grep for 'MatchEvent' across backend returns no files. matches/models.py defines only Match (85 lines); migration 0001_initial.py CreateModel only 'Match'. record_score (scoring.py:82-85) sets Match.home_score/away_score integers directly and completes the match. CLAUDE.md invariant #4 and v1Matches.md:15 require MatchEvent rows as the system of record with Redis publish on transaction.on_commit; none of that exists. 'Record REAL scores' (#8) is therefore a single final scoreline, not goal/card/event-level data.  
  - _fix:_ Implement the MatchEvent model (goal/card/sub/etc.) as the system of record with idempotent event_id writes, derive home/away_score from events, and add the post-commit publish hook. Until then, document explicitly that scoring is MVP aggregate-only so it is not mistaken for the spec'd event log.

- **No advancement / knockout logic — typed deps unused (acceptance item #9 partial; invariant #9)**  
  - _dimension:_ Acceptance-test coverage (owner's 10-step end-to-end flow)
  - _status:_ partial  
  - _area:_ `backend/apps/fixtures/services/generate.py, backend/apps/matches/models.py (home_source/away_source), backend/apps/matches/services/standings.py`  
  - _evidence:_ Match.home_source/away_source JSONB fields exist (matches/models.py:45-46) but grep for 'winner_of|loser_of|advance|advancement|knockout|group_position' finds only the model field comment and an unrelated permissions test — no resolver and no transaction.on_commit hook (invariant #9). fixtures/generate.py produces round-robin group matches only; no bracket/knockout generation. compute_standings (#9 standings) works, but there is no progression from group standings into knockout matches.  
  - _fix:_ Implement the advancement domain-event hook that resolves winner_of/loser_of/group_position into concrete teams on match completion, and add knockout bracket generation. Add tests for advancement after a group concludes.

- **Rule freeze at boundaries (invariant #7) entirely unimplemented**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ missing  
  - _area:_ `backend/apps/tournaments/models.py, backend/apps/teams/models.py, backend/apps/matches/`  
  - _evidence:_ inputs_hash/last_manual_edit_at exist as columns on Tournament (models.py:77-78) and Match (models.py:62) but are written only by the generator's group-hash and never enforce anything. There is no rule_freeze_at field, no amend-with-reason+24h-grace flow (v1Tournaments.md §3.3 lines 420-441), no roster_is_frozen / freeze_roster / RosterSnapshot (v1Teams.md §2.6/§3.5), and no per-match rule freeze on live_first_half (PRD §5.5 line 427). The 'regenerate/keep-manual/view-diff' conflict banner (invariant #10) has no backend support.  
  - _fix:_ Implement the three freeze boundaries: tournament rule freeze at registration_open (with amend+grace), roster eligibility freeze with RosterSnapshot, and per-match rule freeze at live_first_half; plus the inputs_hash conflict-detection that drives the #10 banner.

- **Fixtures constraint DSL + CP-SAT scheduler (v1Fixtures.md §3-4, the headline feature) unbuilt**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ missing  
  - _area:_ `backend/apps/fixtures/services/generate.py`  
  - _evidence:_ v1Fixtures.md §3 defines a declarative JSON constraint DSL (SchedulingConstraint model, hard/soft, weighted, scoped) and §4 a CP-SAT solver assigning (datetime, venue, official) with infeasibility explainer. None exist: no SchedulingConstraint, ScheduleRun, Venue, VenueAvailability, TeamBlackout, Official models (grep = No matches); generate.py is a fixed circle-method round-robin with no scheduling phase (matches get no scheduled_at, venue, or officials from the generator). Phase B (when & where) is 0% built; the generator file itself acknowledges 'The full data-driven constraint scheduler ... layers on top later.' Even the MVP hard-constraint set (team/venue/official no-double-book, min_rest, within_window) from v1Fixtures.md §8.1 is absent.  
  - _fix:_ Build apps/fixtures Phase B: SchedulingConstraint + ScheduleRun + Venue/availability models, the generic AST compiler, and a CP-SAT backend (or a simpler greedy scheduler for MVP) with the hard-constraint starter library. This is what differentiates the product from a rigid round-robin tool.

- **Disputes lifecycle + cascade engine (apps.disputes) does not exist (PRD §5.7, v1Disputes.md)**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ missing  
  - _area:_ `backend/apps/disputes/ (absent)`  
  - _evidence:_ No apps/disputes directory; no Dispute/DisputeResolution models (grep = No matches). v1Disputes.md specs the full raised->under_review->resolved/withdrawn state machine, anti-spam quota (DB partial unique), dispute window, resolution outcomes (score_amended/walkover_awarded/match_replayed/dismissed), the cascade engine over typed pointers, the match.dispute_console module, and the disputed overlay on Match/Tournament. None built. The match.dispute_console module is not in permissions/fixtures/modules.json. Because there is no MatchEvent/advancement, the cascade has nothing to cascade over.  
  - _fix:_ Defer until matches event log + advancement exist (hard dependency per v1Disputes.md §12), then build apps.disputes with its state machine, anti-spam, and cascade engine.

- **Notifications subsystem (bell + dispatcher + cron) does not exist (PRD §5.14, v1Notifications.md)**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ missing  
  - _area:_ `backend/apps/notifications/ (absent), frontend/src/features/notifications/ (absent)`  
  - _evidence:_ No apps/notifications directory; no Notification/NotificationPreference/NotificationGroup/NotificationDelivery models (grep = No matches). v1Notifications.md specs the dispatch() service, the full NotificationEventType taxonomy, self-suppression, grouping, always-on security events, preferences matrix, SSE bell on user:<uuid>:notifications, and three cron commands (notify_due/purge/retry). None exist. Even the Phase-1A producers it lists as ship-now (invitation_received, role_assigned, tournament_created) are not wired — these flows currently emit audit only. No NotificationBell component in the SPA.  
  - _fix:_ Build apps.notifications engine (models + dispatch + templates + preferences + read API) and wire the Phase-1A always-on/security and role/invite/tournament producers immediately; SSE delivery follows once Redis lands.

- **Person DOB encryption + player eligibility/suspension depth (v1Teams §7.3, §2.5-2.7) shallow**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ partial  
  - _area:_ `backend/apps/teams/models.py:28-46 (Person), :96-144 (Player)`  
  - _evidence:_ Person stores plaintext dob_year only (models.py:32) — NO Fernet-encrypted dob_encrypted field despite v1Teams.md §2.1/§7.3 mandating 'plaintext DOB never persisted' via _crypto, and the model docstring itself admits 'full Fernet-encrypted DOB is a follow-up' (models.py:7). No DOB-view audit (person.dob_viewed), no photo/crest. Player has NO eligibility_status field (v1Teams §2.5 line 188 / PRD §8 line 950 require it), NO attributes JSONB, NO roster_schema validation. PlayerSuspension and RosterSnapshot models do not exist (grep = No matches), so the lineup hard-block on suspended players (PRD §5.4/§5.10) is impossible. register_school sets dob_year in plaintext (registration.py:117).  
  - _fix:_ Add Person.dob_encrypted via _crypto with gated/audited reads, Player.eligibility_status + attributes, PlayerSuspension, RosterSnapshot, and the generic roster_schema validator + football blob.

- **Team registration approval flow + TeamRegistration state machine bypassed**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ partial  
  - _area:_ `backend/apps/teams/services/registration.py:98-130, backend/apps/teams/models.py:19-25`  
  - _evidence:_ TeamStatus enum includes pending_approval/rejected/withdrawn/disqualified (models.py:19-25) but register_school creates every team directly with status=TeamStatus.REGISTERED (registration.py:109), so the self-register -> pending_approval -> approve/reject flow (v1Teams.md §3.1 transition table) never runs. There is NO TeamRegistration model (the auditable submission record with channel/is_late/reviewed_by/review_reason, v1Teams §2.3 — grep = No matches), NO approve/reject/withdraw/disqualify endpoints (v1Teams §5.1), NO TeamMembership model and NO two-layer is_team_manager_of TM authz (v1Teams §2.4/§5.4). team_registration_requires_approval toggle has no effect.  
  - _fix:_ Add the TeamRegistration record + state machine, the approve/reject/withdraw/disqualify verbs with reason+audit, and TeamMembership + the two-layer TM authorization helper and IsTeamManagerOfObject permission.

- **Public registration (AllowAny) can be spammed to create unlimited teams/players — no link expiry, no usage cap, only default 60/min throttle**  
  - _dimension:_ Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures)
  - _status:_ missing  
  - _area:_ `backend/apps/teams/views.py:51-87 PublicRegistrationView; backend/apps/teams/models.py:146-173 RegistrationLink; backend/apps/teams/services/registration.py:70-143`  
  - _evidence:_ PublicRegistrationView has permission_classes=[AllowAny] and NO throttle_classes/throttle_scope, so it inherits only DEFAULT_THROTTLE_RATES anon:60/min (base.py:168) — which is per-process LocMem in current config. RegistrationLink model has only is_active (no expires_at, no max_uses/use_count); resolve_registration_link() never decrements or checks a cap. register_school() bulk-creates Team+Person+Player rows with no per-link/per-IP cap and no email gate. A single leaked link → 60 submissions/min/worker, each creating arbitrarily many Person/Player rows (storage exhaustion, DB bloat, garbage data). No test asserts a spam/abuse cap (test_registration_link.py covers only happy path + 404 + non-manager 403).  
  - _fix:_ Add a ScopedRateThrottle (e.g. register:10/hour keyed by token+IP) to PublicRegistrationView; add expires_at and max_submissions/submission_count to RegistrationLink and enforce in resolve_registration_link/register_school; cap teams-per-submission and players-per-team in SchoolRegistrationSerializer (currently unbounded list lengths); consider a lightweight CAPTCHA/proof-of-work for the public POST. Move throttle backend to Redis in prod so the limit is global.

- **Idempotency (invariant #3) relies on a non-atomic check-then-create with no DB uniqueness on domain rows — concurrent event_id replay double-creates and 500s**  
  - _dimension:_ Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures)
  - _status:_ partial  
  - _area:_ `backend/apps/audit/services.py:45-48; backend/apps/{tournaments/services/create.py:47-54, teams/services/registration.py:85-94, matches/services/scoring.py:64-69}`  
  - _evidence:_ emit_audit() guards on AuditEvent.objects.filter(idempotency_key=...).first() (services.py:46) — a TOCTOU; the unique constraint is on AuditEvent.idempotency_key only (models.py:48), NOT on the domain rows. Each Phase 1B service repeats the same pattern: it queries a PRIOR AuditEvent BEFORE its transaction.atomic() block (create.py:48, registration.py:86, scoring.py:65). Two concurrent requests with the same event_id can both miss the prior row, both enter the transaction, and both attempt to create — the second hits AuditEvent.idempotency_key IntegrityError, raising 500 and rolling back the whole verb instead of returning the existing record (the report's audit/idempotency P0, now inherited by 1B). register_school's replay path is also unsafe: it returns Team.filter(tournament, school=school_name) — ALL teams for that school name, which can include rows from a DIFFERENT prior submission, returning a wrong/over-broad set.  
  - _fix:_ Make emit_audit an atomic get-or-create (try INSERT / except IntegrityError → SELECT and return). Better: introduce a real cross-cutting Idempotency table (unique event_id) checked+inserted at the start of each verb's transaction so the domain create is guarded by a DB constraint, returning 200 with the prior result on replay. For register_school, key the replay lookup on the event_id-linked target rather than school_name.

- **No real-browser E2E coverage for the four flagged flows (create tournament, generate fixtures, score entry, invite→accept)**  
  - _dimension:_ Test coverage & browser-verification gaps
  - _status:_ missing  
  - _area:_ `frontend/e2e/role-smoke.spec.ts; frontend/playwright.config.ts`  
  - _evidence:_ The only Playwright suite is role-smoke.spec.ts (8 tests: super-admin sadmin login, 6 role-landing checks, sign-out). 5 of its 7 role checks are test.fixme-skipped. It never navigates to /tournaments/new, never clicks 'Generate fixtures', never types into the home/away score inputs, never exercises /accept. The matching component tests (CreateTournamentPage.test.tsx, TournamentDetailPage.test.tsx, TournamentsListPage.test.tsx) all `vi.mock("@/api/tournaments")`, so they assert the component CALLS the API with the right args but never run in a browser nor hit the real DRF endpoints. This is the brief's gap (b), confirmed: these paths were only ever exercised by the demo seed, not driven in a browser.  
  - _fix:_ Add Playwright e2e specs that drive against the running Django+Vite stack with a clean DB (not the pre-completed demo seed): (1) login as a fresh user → /tournaments/new → create → land on detail; (2) register 2+ teams via the public /register/:token link → click 'Generate fixtures' → assert fixtures render; (3) enter home/away scores → Save → assert standings update; (4) create a tournament invite → open /accept with the token as a logged-out new user → set password → land on /tournaments. Run them in CI.

- **assign_scorer service has no API route and no UI — assigned-scorer score-entry path is unreachable end-to-end**  
  - _dimension:_ Test coverage & browser-verification gaps
  - _status:_ partial  
  - _area:_ `backend/apps/matches/services/scoring.py (assign_scorer); backend/apps/matches/urls.py; frontend (no consumer)`  
  - _evidence:_ scoring.py:34 defines assign_scorer() and it is unit-tested in test_scoring.py (test_assign_scorer_requires_tournament_membership), but matches/urls.py exposes ONLY /matches/<uuid>/score/. There is no assign-scorer route and no frontend call anywhere (grep for assign-scorer/AssignScorer in views/urls/api returns nothing). RecordScoreView (views.py:71) authorizes by `match.scorer_id == request.user.id` OR admin — but nothing in the API/UI can SET match.scorer except the demo seed. So a real scorer user cannot be assigned a match through the product, meaning the 'score entry by an assigned scorer through the UI' flow can only be reached by an admin/manager, never by a scorer, without DB seeding.  
  - _fix:_ Either expose an assign-scorer endpoint (e.g. POST /api/matches/<uuid>:assign-scorer/) plus a UI control on the match row, or document that scorer assignment is out of scope for this phase. Add an integration test that assigns a scorer via the API and then has that scorer record a score (currently impossible without direct ORM access).

### MEDIUM

- **Player detail depth shallower than design: birth-year only, no full DOB; public form drops captain/goalkeeper**  
  - _dimension:_ Acceptance-test coverage (owner's 10-step end-to-end flow)
  - _status:_ partial  
  - _area:_ `backend/apps/teams/models.py (Person.dob_year), backend/apps/teams/serializers.py, frontend/src/features/registration/RegistrationFormPage.tsx`  
  - _evidence:_ Person.dob_year is a PositiveSmallIntegerField (teams/models.py:32); the model docstring (lines 6-7) states full Fernet-encrypted DOB (v1Teams §7.3) is 'a follow-up'. The acceptance test asks for 'dob'. PlayerInSerializer accepts captain & is_goalkeeper (serializers.py:11-12) and the service stores them (registration.py:126-127), but RegistrationFormPage (frontend) only renders full_name/jersey_no/position/dob_year inputs — captain and goalkeeper cannot be set by a self-registering school via the link.  
  - _fix:_ Decide whether year-of-birth satisfies v1 (it likely fails age-eligibility checks needed for school sport); if full DOB is required, add an encrypted DOB field + validation. Add captain/goalkeeper toggles to the public registration form so the captured detail matches the model and the design.

- **Standings tiebreak is GD-then-GF only; no head-to-head or fair-play; no tie/draw resolution for knockout**  
  - _dimension:_ Acceptance-test coverage (owner's 10-step end-to-end flow)
  - _status:_ partial  
  - _area:_ `backend/apps/matches/services/standings.py`  
  - _evidence:_ compute_standings sorts by (-Pts, -GD, -GF, name) (standings.py:50). Grep for 'head.to.head|h2h|tiebreak|fair.play' finds only the standings.py docstring. Football group standings conventionally need head-to-head and disciplinary tiebreakers; the docstring acknowledges only 'GD then GF'. Draws produce no decider (winner_id returns None on a draw, matches/models.py:85) which blocks knockout advancement.  
  - _fix:_ Extend the tiebreaker chain (at minimum head-to-head among tied teams) and define draw resolution (extra time/penalties as a recorded outcome) before knockout advancement is built. Add parametrized standings tests for tie scenarios.

- **Scoring validation is happy-path: no guard that scoring only allowed for SCHEDULED matches with both teams set, and no completed-state correction path**  
  - _dimension:_ Acceptance-test coverage (owner's 10-step end-to-end flow)
  - _status:_ partial  
  - _area:_ `backend/apps/matches/services/scoring.py (record_score), backend/apps/matches/serializers.py (RecordScoreSerializer)`  
  - _evidence:_ record_score guards status in (SCHEDULED, LIVE) and blocks re-scoring (scoring.py:73-76; tested test_rescore_completed_match_is_blocked). But it does not require home_team/away_team to be non-null (a TBD knockout slot Match with home_team=None could be 'completed' with a score), and there is no amend/correction verb (comment at scoring.py:59-62 references one that doesn't exist). RecordScoreSerializer caps scores 0..99 only.  
  - _fix:_ Reject scoring when home_team or away_team is null (TBD), and implement the audited amend/correction verb the code comments promise so a mistyped final score can be fixed without raw DB edits.

- **Designed RBAC modules for Phase-1B surfaces + the module/verb matrix tests are absent**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ partial  
  - _area:_ `backend/apps/permissions/fixtures/modules.json, apps/teams|matches|fixtures permissions`  
  - _evidence:_ Permission scoping on the built endpoints uses ad-hoc can_manage_tournament / scorer FK checks (matches/views.py:69-73, fixtures/views.py:22) rather than the module-gated HasModule(...) layer the specs require (v1Teams §5 gates on tournament.team_registration/player_roster/lineup_manager; v1Disputes adds match.dispute_console; v1Live gates scoring.console/referee.review). Those module codes are not present in the catalog and no parametrized module-matrix tests exist for the new surfaces (CLAUDE.md invariant #12 mandates apps/permissions/tests/test_module_matrix.py coverage per module). Mandatory per-endpoint cross-org isolation tests (invariant #2) exist for Phase-1A apps but not for teams/matches/fixtures live/dispute/notification endpoints because those endpoints largely don't exist yet.  
  - _fix:_ As each Phase-1B surface lands, add its module to modules.json, gate the endpoint with HasModule, and add the module-matrix + cross-org isolation tests the specs require.

- **MatchAssignment (scorer/referee with status) modeled as a bare FK; double-grant invariant absent**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ partial  
  - _area:_ `backend/apps/matches/models.py:57-60, services/scoring.py:34-50`  
  - _evidence:_ Scorer is a single Match.scorer FK (models.py:57). v1Matches.md §line 213 and v1Live.md §5.3 require a MatchAssignment(match, user, role in {match_scorer,referee}, status=assigned) plus the double-grant invariant (OrganizationMembership AND MatchAssignment) that the WS connect-time authz depends on. assign_scorer (scoring.py:34) only checks tournament membership and overwrites a single scorer; there is no referee assignment, no per-match assignment lifecycle, and no revoke-mid-match path the live spec relies on.  
  - _fix:_ Replace the scorer FK with a MatchAssignment table supporting scorer+referee roles and an assigned/revoked lifecycle, and implement the double-grant authz used by both DRF and the (future) WS consumer.

- **Public viewer / Match Center, scoring console, and live SPA surfaces unbuilt**  
  - _dimension:_ Missing features: built vs. designed (PRD + v1Teams + v1Fixtures + v1Users + v1Live + v1Notifications + v1Matches + v1Tournaments + v1Disputes)
  - _status:_ missing  
  - _area:_ `frontend/src/features/ (no viewer/scoring/notifications/disputes folders)`  
  - _evidence:_ v1Live.md §10, v1Disputes.md §10, v1Notifications.md §7, and v1Teams.md §6 specify React feature folders for viewer (SSE match center), scoring/referee console (WS), notifications bell+page, roster manager, registration review queue, and dispute panels. The live transport hooks (useEventSource/useMatchStream/useMatchSocket/useNotificationStream) and these pages cannot exist because their backend endpoints do not. The shipped frontend covers Phase-1A account/org/permissions screens only.  
  - _fix:_ Build the SPA live/viewer/scoring/notifications/teams/disputes feature folders after their backend endpoints land; they are blocked on the backend gaps above.

- **New Phase 1B endpoints bypass the 22-module RBAC matrix (invariant #12) — use only tournament/org-role checks**  
  - _dimension:_ Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures)
  - _status:_ partial  
  - _area:_ `backend/apps/tournaments/permissions.py:17-36 can_manage_tournament; backend/apps/tournaments/scope.py:19-32 accessible_tournaments; consumed by all 4 apps' views`  
  - _evidence:_ Confirmed: tournaments/teams/matches/fixtures views authorize via can_manage_tournament() and accessible_tournaments() (which check TournamentMembership role + OrganizationMembership ADMIN) — NONE call effective_modules()/has_module() from apps.permissions.services.resolver. CLAUDE.md invariant #12 names the module catalog (Appendix A.2, 22 modules) as canonical RBAC truth and mandates apps/permissions/tests/test_module_matrix.py parametrization; the new endpoints are not covered by any module-matrix test. This is a deliberate simplification per the locked tournament-scoped TournamentMembership decision, but it is undocumented at the code level and means module-DENY overrides (MembershipModuleGrant) have ZERO effect on tournament/team/match/fixture surfaces.  
  - _fix:_ Either (a) explicitly document in CLAUDE.md/PRD §14 that tournament-scoped surfaces are governed by TournamentMembership roles, not the org module matrix, and state the threat-model implication; or (b) layer has_module() checks (e.g. tournaments.manage, matches.score) into these endpoints so per-user module overrides apply. Add tests asserting whichever model is chosen.

- **_OrgMembershipPermission still fail-OPEN when org is unresolved (returns True)**  
  - _dimension:_ Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures)
  - _status:_ missing  
  - _area:_ `backend/apps/organizations/permissions.py:85-89`  
  - _evidence:_ has_permission still does `org = _resolve_org_from_view(view); if org is None: return True` (permissions.py:88-89) — a non-existent/soft-deleted org UUID makes the guard pass; only handler-level 404s save it today. This is the report's latent default-deny violation (rbac N2), unflipped. (The new 1B views don't use this class, but it remains live on org endpoints.)  
  - _fix:_ Flip to `return False` (fail-closed). One-line hardening; default-deny is non-negotiable per invariant #12.

- **Mutations missing event_id idempotency: registration-link mint, assign_scorer, generate-fixtures, tournament invite**  
  - _dimension:_ Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures)
  - _status:_ partial  
  - _area:_ `backend/apps/teams/services/registration.py:25-35 create_registration_link; backend/apps/matches/services/scoring.py:34-50 assign_scorer; backend/apps/fixtures/services/generate.py:40-87 generate_round_robin; backend/apps/tournaments/views.py:59-91 invitation`  
  - _evidence:_ Invariant #3 says EVERY mutation accepts event_id. create_registration_link takes no event_id (replaying the POST mints a second link). assign_scorer takes no event_id and no replay guard. generate_round_robin is idempotent only by side-effect ('if existing matches return them') — not by event_id, and that check is also outside any select_for_update so two concurrent generate calls race to bulk_create duplicate match sets. TournamentInvitationCreateView passes event_id through to create_invitation but the serializer-level guarantee is partial across verbs.  
  - _fix:_ Thread event_id through every mutation verb (mint-link, assign-scorer, generate-fixtures) with the same get-or-create idempotency mechanism; guard generate_round_robin with select_for_update on the tournament or a unique (tournament, generation) marker to prevent concurrent double-generation.

- **No live/SSE/WebSocket layer despite invariants #4 and #11; record_score does not publish on commit**  
  - _dimension:_ Test coverage & browser-verification gaps
  - _status:_ missing  
  - _area:_ `backend/apps/matches/services/scoring.py:record_score; missing apps/live, apps/notifications, apps/disputes`  
  - _evidence:_ INSTALLED_APPS (settings/base.py:48-58) lists no `live`, `notifications`, or `disputes` app and none exist on disk. record_score() commits the Match + AuditEvent inside transaction.atomic() but has NO transaction.on_commit publish to Redis pub/sub (grep for on_commit/channel_layer/publish in scoring.py = none). Invariant #4 ('publish to Redis after commit') and #11 (SSE for match:<uuid>) are therefore unimplemented and untested. The MatchStatus enum (models.py:16-19) is also reduced to scheduled/live/completed/cancelled — it omits the half-time states the PRD §5.5 transition table mandates, so the state-machine suite the PRD calls for cannot exist for matches.  
  - _fix:_ Treat as a known Phase-1B scope item, but flag explicitly: until the live layer lands there is zero test coverage of live delivery, and the match state machine does not match PRD §5.5. If the simplified state machine is intentional for this slice, record that decision in the PRD §14 log; otherwise build apps/live with on_commit publish + a state-machine test suite covering every transition and every blocked transition.

- **Accounts 2FA HTTP endpoints, me_view (GET/PATCH last_active_org_id), verify_email view, reauth_view, and user_soft_delete_view have no view-level tests**  
  - _dimension:_ Test coverage & browser-verification gaps
  - _status:_ partial  
  - _area:_ `backend/apps/accounts/views.py (twofa_enroll/confirm/disable/recovery_regenerate, me_view, verify_email, reauth_view, user_soft_delete_view)`  
  - _evidence:_ test_twofa_service.py tests the twofa SERVICE (enroll/confirm/recovery hashing) but no test hits POST /api/accounts/auth/2fa/enroll|confirm|disable| or recovery_codes:regenerate over HTTP (grep of accounts/tests for those URLs = none). test_login_flow.py covers login/2FA-required-flag/logout only. me_view's PATCH last_active_org_id (views.py:418-441), verify_email (views.py:155), reauth_view (views.py:277), and user_soft_delete_view (views.py:452) have no test referencing their routes. These are auth-surface endpoints with auth/CSRF/permission concerns that the service tests don't exercise.  
  - _fix:_ Add DRF APIClient view-level tests for the 2FA enroll→confirm→disable→recovery-regenerate cycle (including auth + reauth gating), for me_view GET shape and PATCH last_active_org_id (incl. cross-org rejection), for verify_email activation, and for user_soft_delete_view authorization.

- **Frontend auth/recovery and org-admin pages with no component test**  
  - _dimension:_ Test coverage & browser-verification gaps
  - _status:_ missing  
  - _area:_ `frontend/src/features/auth/{VerifyEmailPage,TwoFactorEnrollPage,TwoFactorChallengePage,PasswordResetRequestPage,PasswordResetCompletePage,PasswordReauthModal}.tsx; frontend/src/features/orgs/{OrgAuditLogPage,InvitationsListPanel,OwnershipTransferModal}.tsx`  
  - _evidence:_ Case-insensitive basename match against frontend/src/**/__tests__ found NO test for: VerifyEmailPage, TwoFactorEnrollPage, TwoFactorChallengePage, PasswordResetRequestPage, PasswordResetCompletePage, PasswordReauthModal, OrgAuditLogPage, InvitationsListPanel, OwnershipTransferModal. (LoginPage, SignupPage, InviteAcceptPage, InviteCreateModal, MemberDirectoryPage, OrgBrandingPage, OrgSettingsPage, OrgSwitcher, the three tournament pages, RegistrationFormPage, and the role landings ARE tested.) The untested set is concentrated on the 2FA/password-reset/email-verify auth surface and three org-admin write surfaces (audit log paging, invitation revoke list, ownership transfer) — all high-consequence flows.  
  - _fix:_ Prioritize component tests for the 2FA enroll/challenge pages, password-reset request/complete, and OwnershipTransferModal (reason + reauth) since these are security-sensitive. OrgAuditLogPage needs at least a cursor-pagination test; InvitationsListPanel needs a revoke-confirm test.

- **Tournament invite→accept happy path lacks a backend HTTP-level test for the SPA's actual call path**  
  - _dimension:_ Test coverage & browser-verification gaps
  - _status:_ partial  
  - _area:_ `backend/apps/tournaments/tests/test_accept_api.py + test_tournament_invite.py; frontend InviteAcceptPage→orgsApi.acceptInvitation→POST /api/invitations:accept/`  
  - _evidence:_ Tournament invite-accept reuses the unified POST /api/invitations:accept/ (verified in test_accept_api.py:22 ACCEPT_URL). Backend tests cover: logged-out new email creates account (test_accept_api), existing-active email gets login_required, and tournament-membership creation (test_tournament_invite). Good. But the frontend InviteAcceptPage.tsx calls orgsApi.acceptInvitation (orgs.ts) and is itself untested for the tournament-invite variant, and no test ties the SPA's request shape to the backend serializer for a tournament invite specifically (vs org invite). The success redirect goes to routes.tournaments() regardless. Contract drift between the SPA payload and the unified endpoint would not be caught.  
  - _fix:_ Add an InviteAcceptPage component test (currently absent) and a contract/e2e test that mints a tournament invite, posts the exact SPA payload to /api/invitations:accept/, and asserts a TournamentMembership is created and the user lands on /tournaments.

- **No multi-tenant isolation test on several read endpoints (teams list, standings, matches list) beyond outsider-cannot checks**  
  - _dimension:_ Test coverage & browser-verification gaps
  - _status:_ partial  
  - _area:_ `backend/apps/matches/tests/test_match_api.py; backend/apps/teams/tests; tournaments scope.py`  
  - _evidence:_ test_create_api covers list isolation (user A cannot see B's tournament); test_match_api covers outsider-cannot-list-matches and outsider-cannot-generate. But CLAUDE.md says 'Every endpoint must be covered by a test that asserts user A in Org X cannot access org Y data.' There is no explicit cross-org test for GET /tournaments/{id}/teams/, /standings/, or the public /register/{token}/ resolving across orgs, nor for RecordScoreView rejecting a scorer from another org's tournament (the membership check is in _is_tournament_member but the score VIEW's cross-org rejection isn't directly asserted at HTTP level).  
  - _fix:_ Add parametrized cross-org isolation tests for every tournament-scoped read/write endpoint (teams, matches, standings, score, registration-link, invite), asserting 403/404 for a user whose membership is in a different org/tournament — per the non-negotiable isolation-test invariant.

### LOW

- **Tournament invite UI does not offer per-task/admin role granularity and no per-match referee assignment exists (acceptance item #3 'assigned to roles' is tournament-wide only)**  
  - _dimension:_ Acceptance-test coverage (owner's 10-step end-to-end flow)
  - _status:_ partial  
  - _area:_ `frontend/src/features/tournaments/TournamentsListPage.tsx (InviteByEmail), backend/apps/tournaments/views.py (TournamentInvitationCreateView)`  
  - _evidence:_ Invite->accept->assign-role IS wired and well-tested (test_invite_api.py, test_accept_api.py, test_tournament_invite.py): a tournament-scoped invite creates a TournamentMembership with the chosen role (organizations/services/invitation.py:291-315). However the role is a single tournament-WIDE role; the UI INVITE_ROLES list (TournamentsListPage.tsx:21) omits 'admin' (backend supports it) and there is no per-match/per-team assignment (MatchAssignment per v1Matches.md, TeamMembership for team_manager) — so 'assign to roles' means tournament-scope grant, not the per-task scoping the design and acceptance phrasing imply.  
  - _fix:_ Clarify with the owner whether tournament-wide role grants suffice for v1. If per-task (per-match referee, per-team manager) scoping is needed, build MatchAssignment/TeamMembership and the assignment UIs. At minimum document the current grant granularity.

- **Fixture generation has no precondition checks beyond team count; not gated on tournament status and silently fixed group_size**  
  - _dimension:_ Acceptance-test coverage (owner's 10-step end-to-end flow)
  - _status:_ partial  
  - _area:_ `backend/apps/fixtures/services/generate.py, backend/apps/fixtures/views.py`  
  - _evidence:_ generate_round_robin only checks >=2 registered teams (generate.py:53-54). It does not check tournament status (e.g. registration must be closed) and is idempotent by returning existing matches if any exist (generate.py:44-46) — so a re-generate after roster changes silently no-ops rather than offering the invariant-#10 regenerate/keep-manual/diff banner. group_size from the request is coerced with int() default 5 (views.py:26) with no upper bound or 'last group too small' handling tested.  
  - _fix:_ Gate generation on tournament state, surface a real regenerate path (honoring inputs_hash/last_manual_edit_at which are stored but never compared), and test uneven group sizes / odd team counts (bye handling exists in _round_robin but is untested for correctness of counts).

- **Acceptance item #10 'all other events' (full match domain) is unbuilt**  
  - _dimension:_ Acceptance-test coverage (owner's 10-step end-to-end flow)
  - _status:_ missing  
  - _area:_ `backend/apps/matches (no MatchEvent/MatchAssignment/Lineup/transitions), backend/apps/live (absent), backend/apps/disputes (absent), backend/apps/notifications (absent)`  
  - _evidence:_ ls of backend/apps shows no live/, disputes/, or notifications/ apps despite CLAUDE.md repo layout listing them. v1Matches.md:15 enumerates MatchEvent, MatchStateTransition, MatchAssignment, Lineup, MatchClock, PlayerSuspension, the state machine, the scorer/referee API, and the advancement hook — none present. ScorerLandingPage.tsx is an explicit Phase-1A 'coming soon' placeholder (lines 5-11).  
  - _fix:_ Treat 'all other events' as the Phase-1B match domain backlog; sequence MatchEvent + state machine + assignments first since they unblock real scoring (#8) and advancement (#9). This is expected per the phased plan but should be called out so the acceptance test is scoped to the spine, not the full event model.

- **post-write side effects not deferred to transaction.on_commit (invariant #4) in new services**  
  - _dimension:_ Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures)
  - _status:_ partial  
  - _area:_ `backend/apps/tournaments/services/create.py:62-92; backend/apps/teams/services/registration.py:98-142; backend/apps/audit/services.py:80-87 (emit_audit_on_commit defined but unused)`  
  - _evidence:_ The 1B services emit audit INSIDE transaction.atomic() (correct for atomicity) but emit_audit_on_commit remains never-called, and with ATOMIC_REQUESTS=True (base.py:106) plus nested service-level atomic() blocks, any future Redis pub/sub for live updates must use transaction.on_commit. No on_commit hook exists in any 1B service yet (invariant #4 / #11 publish-after-commit). Not yet wrong (no pub/sub in 1B), but the pattern is absent where invariant #4 will require it.  
  - _fix:_ When live (SSE/WS) delivery lands, publish via transaction.on_commit after the DB commit, not inline; add a test asserting no publish occurs on rollback.

- **Email-verification gate is inconsistent across self-serve mutations**  
  - _dimension:_ Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures)
  - _status:_ partial  
  - _area:_ `backend/apps/tournaments/views.py:33 (gated) vs registration-link mint, invite, score (ungated)`  
  - _evidence:_ TournamentListCreateView.post checks `if not request.user.email_verified_at: 403` (views.py:33-34), but RegistrationLinkCreateView, TournamentInvitationCreateView, RecordScoreView, and GenerateFixturesView do NOT gate on email_verified_at — an unverified user who somehow holds a manage role could mint public registration links, invite others, and score. Authorization is via can_manage_tournament, so reach is limited, but the verification policy is applied unevenly.  
  - _fix:_ Decide and apply a single policy: either gate all self-serve write entrypoints on email_verified_at or document that only workspace creation requires verification. Centralize via a permission class.

- **compute_standings omits registered-but-unplayed teams from the table**  
  - _dimension:_ Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures)
  - _status:_ partial  
  - _area:_ `backend/apps/matches/services/standings.py:7-51`  
  - _evidence:_ The table dict is populated only by iterating COMPLETED matches' participating teams (standings.py:33-45). A registered team with no completed match never appears (no zero-row). For a published group table this is a correctness/UX gap (teams vanish until they play). Not a security issue.  
  - _fix:_ Seed the table with all REGISTERED teams in the group (zeroed) before accumulating results, so standings show every entrant.

- **Cross-org isolation tests present for new endpoints but NOT exhaustive; no parametrized CI harness**  
  - _dimension:_ Production-Readiness & Security (Phase 1A residual P0s + Phase 1B tournaments/teams/matches/fixtures)
  - _status:_ untested  
  - _area:_ `backend/apps/{tournaments,teams,matches}/tests/`  
  - _evidence:_ Good coverage exists: test_match_api.py:62/72 (outsider→404 on list/generate), test_create_api.py:49 (cross-org list isolation), test_registration_link.py:68 (non-manager 403/404), test_scoring.py:94 (assign_scorer requires membership). BUT there is NO cross-org test for RecordScoreView POST (an outsider scoring another org's match), the standings endpoint, the teams-list endpoint, or the tournament-invite endpoint targeting another org's tournament; and no parametrized isolation harness over every endpoint as CLAUDE.md mandates ('not optional'). register_school replay/abuse and link-expiry are untested.  
  - _fix:_ Add the missing per-endpoint cross-org tests (outsider POST /matches/{id}/score/ → 404; outsider GET standings/teams → 404; invite to foreign tournament → 404). Build the parametrized cross-org isolation harness + CI gate covering all tenant-scoped endpoints (1A and 1B).

- **Dead/duplicate API method: registrationApi.createLink has zero consumers (UI uses tournamentsApi.createRegistrationLink)**  
  - _dimension:_ Test coverage & browser-verification gaps
  - _status:_ untested  
  - _area:_ `frontend/src/api/registration.ts (createLink) vs frontend/src/api/tournaments.ts (createRegistrationLink)`  
  - _evidence:_ Both registrationApi.createLink and tournamentsApi.createRegistrationLink POST to /api/tournaments/{id}/registration-link/. TournamentDetailPage.tsx:131 calls tournamentsApi.createRegistrationLink; grep for registrationApi.createLink across frontend/src returns no consumers. It is dead code and (being unused) untested — a maintenance/contract-drift hazard.  
  - _fix:_ Delete registrationApi.createLink (or consolidate both API clients onto one method) to prevent two divergent definitions of the same endpoint.

- **FeedbackSubmitView exists and is tested, but the SPA feedback widget (OrgDashboardPage) has no test for the submit path**  
  - _dimension:_ Test coverage & browser-verification gaps
  - _status:_ partial  
  - _area:_ `frontend/src/features/layout/OrgDashboardPage.tsx (feedback modal → feedbackApi.submit); backend FeedbackSubmitView (tested in sadmin/tests/test_feedback_submit.py)`  
  - _evidence:_ Backend POST /api/feedback/submit/ is routed (fixture/urls.py:46) and tested (test_feedback_submit.py, 5 tests). The SPA consumer is the feedback modal in OrgDashboardPage.tsx (imports feedbackApi at line 19, submit logic ~line 68). OrgDashboardPage has a test (OrgDashboardPage.test.tsx) but it is not clear it exercises the feedback submit/error path. The feedback.ts client even carries a stale comment ('backend endpoint is being created in parallel') — the endpoint now exists, so the comment is misleading but not a functional gap.  
  - _fix:_ Add a test covering the feedback modal submit (success + ApiError surface) in OrgDashboardPage, and remove the stale 'being created in parallel' comment in api/feedback.ts.

- **standings compute and fixtures generator: unit-tested, but no negative/edge tests for odd team counts, ties, or manual-edit conflict (invariant #10)**  
  - _dimension:_ Test coverage & browser-verification gaps
  - _status:_ partial  
  - _area:_ `backend/apps/matches/services/standings.py; backend/apps/fixtures/services/generate.py`  
  - _evidence:_ fixtures test_generate.py covers 4-team RR (6 pairings), 10-team split into two groups of 5, and idempotency. standings is tested via compute_standings (test_scoring.py) and the API flow. Not covered: odd team counts that don't divide evenly into groups, tie-breaking rules in standings (GD/head-to-head), and the invariant-#10 inputs_hash/last_manual_edit_at 'regenerate vs keep manual' conflict logic (no test references inputs_hash or last_manual_edit_at). If that conflict-warning machinery exists it is untested; if it doesn't, invariant #10 is unimplemented for fixtures.  
  - _fix:_ Add fixtures tests for odd/edge team counts and re-generate-after-manual-edit (assert inputs_hash/last_manual_edit_at behavior per invariant #10). Add standings tie-break tests. If the conflict-warning fields don't exist yet, flag invariant #10 as unimplemented for the fixtures engine.

- **drf-spectacular operation_id collisions on duplicated slug/uuid and colon/underscore routes (schema → generated FE types risk)**  
  - _dimension:_ Test coverage & browser-verification gaps
  - _status:_ untested  
  - _area:_ `backend/apps/accounts/urls.py, organizations/urls.py, permissions/urls.py; frontend/src/types/api.generated.ts`  
  - _evidence:_ Multiple endpoints share view callables across slug-vs-uuid and hyphen/underscore aliases (noted in cross-e2e-flow.md:227-230 and still present: organizations/urls.py has both UUID and by-slug invitation/member routes). The frontend consumes a generated types file (api.generated.ts) and generated-types.test.ts exists, but there is no test asserting `manage.py spectacular` generates a warning-free, collision-free schema. Operation-id collisions silently produce wrong/merged FE types.  
  - _fix:_ Add a CI check that runs spectacular with --fail-on-warn (or asserts zero collision warnings) and regenerates api.generated.ts, diffing it against the committed file so contract drift fails the build.
