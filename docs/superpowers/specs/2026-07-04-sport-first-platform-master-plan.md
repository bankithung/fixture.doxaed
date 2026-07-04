# Sport-First Platform Master Plan

**Date:** 2026-07-04 · **Author:** Claude Fable 5 (synthesis, conflict resolution, roadmap), from three quality-gated Opus 4.8 fleets: product deep analysis (104 agents: 30 delta auditors, 26 subsystem readers, 6 persona journeys, 8 cross-cutting critics, 5 benchmarks, 24 adversarial verifiers, 4 synthesizers + completeness critic; 4.83M tokens), sport-vertical research (24 agents: 12 rulebook researchers on IFAB/FIFA + ISTAF + ITTF, 4 code mappers, 3 fact-checking dossier compilers, 5 designers), institution-vertical research (3 agents), plus 1 recovery reader. Every fleet passed the research quality gate (sourced rules, resolved conflicts, verified file anchors — two criticals re-confirmed empirically on this box). Gate log + raw structured outputs in the session scratchpad.

**Status:** Plan of record for the sport-first re-architecture and product completion wave. Supersedes the **roadmap** of `2026-07-02-product-refinement-master-plan.md` (its unfinished items are folded in below); its designs (§5 school records, §6 badges) remain canonical where referenced. Implements toward PRD Draft v3; increments bump the PRD decisions log as they land.

---

## 1. Product thesis (what this software IS)

**The sports platform for educational institutions.** Schools and colleges are the main customers, in two roles: **operator** (running their own sport: annual sports days, inter-house leagues, inter-class knockouts, college fests) and **participant** (registering into and following external tournaments). District/association organizers are a second operator type on the same chassis. Competition scope is both **intra-school** (houses/classes as entrants) and **inter-school** (institutions as entrants) — the participant grouping is generic.

On that customer base sit four product layers:

1. **Sport verticals on one chassis.** Sport is a first-class product axis: each sport gets a native console, rule vocabulary, state machine, standings/leaders columns, awards, and officials — driven by a SportDefinition registry, never by `if setBased` branches. Sepak takraw + table tennis ship first (Dimapur, Aug 29); football is the reference vertical at a FIFA-grade bar.
2. **Flexibility first: presets never prisons.** Official rules (IFAB/ISTAF/ITTF) are named presets the user picks *and can then edit*; any NvN roster, any point/set targets, any stage graph, fully custom games via generic scoring families + a blueprint-driven console fallback.
3. **A public FotMob-grade layer as the growth loop.** WhatsApp-first sharing (score-card images, OG unfurls), login-free following, durable school/team/player records — parents and students are the audience; records are the retention spine.
4. **A sellable scheduling/constraints engine** under it all — explainable (minimal conflict sets), auditable (event-sourced, validator-gated), format-agnostic.

Benchmark verdict (5 competitive researchers): the engine already exceeds IMLeagues/SOCS/TeamSnap/Diamond/FET-class rivals on correctness and data ownership; no incumbent serves operator + participant + durable athlete identity in one product. The gap is seams, presentation, packaging — this plan.

**The proper flow is load-bearing.** Everything hooks into the existing staged lifecycle: setup (basics → sports/categories → rules) → publish → registration opens (**rules freeze**) → institution registration → team/roster registration (access codes) → entries confirmed → per-competition draw config → fixture generation → schedule → publish → live → results/advancement → completion. Sport presets and the custom-game designer live in setup; consoles activate at live; the institution vertical adds season/preset stages *before* the spine and house-points aggregation *after* it. No feature bypasses a stage gate.

---

## 2. Ground truth (2026-07-04 delta audit, 30/30 verified)

Of the 2026-07-02 plan's findings/fixes: **18 fixed** (C1-C11, C13, C14, C18, C19, C20 + S1 lifecycle spine, S7 verb matrix — the console-safety, advancement-integrity, registration-validation, and lifecycle work all verifiably landed), **10 partial**, **2 open**:

| Still open/partial | What remains |
|---|---|
| C12 open | ResponsesPage renders repeatable-group rosters as `[object Object]` (`formatAnswer` array branch, ResponsesPage.tsx:75) |
| C21 open | Email fire-and-forget; no delivered/failed tracking |
| C15/C16/C17 partial | Dispute outcomes don't cascade; lineup PRD §5.4 validation gaps; assignment notify partial |
| **S0 partial — existential** | Local backups exist but **no offsite copy, no restore drill, no error monitoring** |
| S2-S6, S8 partial | Wire-sweep CI check, design-lint unwired, rules studio not unified, SchoolProfile not built, notifications resolver partial, match-row kit duplicated |

**New verified findings** (24 adversarially checked: 22 confirmed, 1 refuted — resubmission IS atomic via `ATOMIC_REQUESTS` — 1 plausible-narrowed). The criticals, two re-confirmed empirically on this box:

- **N1 (SECURITY, live now):** nginx serves `/media/` publicly (no auth, 7d cache), exposing `form_uploads/` PII (rosters, ID documents) and bypassing the signed `ServeUploadView` — `deploy/nginx-fixture.conf:47`. Confirmed on this machine; real uploads present.
- **N2:** Scorer retry double-counts: `event_id` minted inside `mutationFn` (MatchConsolePage.tsx:260) defeats idempotency on retry-after-timeout; plus `retry: 0`, no fetch timeout, no offline queue (client.ts:66) — in the weak-connectivity courtside environment.
- **N3:** COMPLETED set-sport matches are **permanently uncorrectable** and the correction advancement re-fire is gated `not set_based` (events.py:130, set_scoring.py:316) — a wrong sepak/TT knockout result propagates forever. Aug-29 blocker.
- **N4:** Age eligibility displayed but never enforced against DOB anywhere (generation.py:333, mapping/validation) — the top school-trust no-op.
- **N5:** `TournamentSportsView.put` has no freeze gate and no event_id: the category tree can be silently rewritten at any stage including live (tournaments/views.py:442).
- **N6:** Accountless schools receive nothing: schedule-change/result notifications resolve only to User rows (schedule_changes.py:217); no submission receipt (responses.py); no accept/reject notice.
- **N7:** Leaders are structurally broken for the flagship sports: `top_scorers` counts only goal events (empty for set sports) and `compute_leaders` pools all sports into one table (leaders.py:34,57).
- **N8:** Standings re-merge live rules on every call — post-completion rule amendments retroactively rewrite history (standings.py:166; invariant-7 violation).
- **N9:** swiss/double_elim → knockout passes validation then silently never materializes; advancement exceptions swallowed (stages.py:170).
- **N10:** Zero code splitting — 1,359,126-byte single bundle (byte-confirmed), full admin app shipped to every spectator; plus SSE ticks blanket-invalidate 5 aggregates per client (useControlRoom.ts:55) and the matches endpoint is unpaginated.
- **N11:** Zero WebSocket clients — the entire scorer-room ASGI layer is dead infra; console polls at 5s. Resolution (owner vision = live-ops): **connect it**, don't delete it.
- **N12:** Org-member removal never invalidates the RBAC module cache (organizations/views.py:391); removed members keep module access up to 300s.
- Experience layer: no system-driven school invite (copy-link only, InstitutionsTab.tsx:287); `/m/:id` match center is a shareable dead-end (no share, no back-nav, 5s poll, static OG so WhatsApp forwards never show a score); no public standings tab; dispute resolution buried in Settings; 63% of query pages lack error states; touch targets below 44px on courtside surfaces; `t()` is an identity function (i18n is cosmetic); match audit rows omit tournament/match ids.

Analysis caveats (from the completeness critic, honestly held): no rendered-pixel review, no live-DB scale numbers, no real deliverability test, backup posture asserted not audited. These become **verification tasks in Phase H/1** below rather than blockers.

---

## 3. Phase H — hotfix wave (immediately, before all pillar work)

Small, high-severity, independently shippable. Tests-first where logic changes.

- **H1 · Close the /media hole (N1).** Serve `form_uploads/` only through the capability-gated view (nginx `internal` + X-Accel-Redirect), keep public media (crests) on a separate public prefix. Verify with a curl probe. *(nginx change on prod: needs owner go-ahead at execution.)*
- **H2 · Scorer write integrity (N2).** Mint `event_id` once per user intent (state, not per call), add fetch timeout, add a localStorage offline replay queue with a Saving/Offline/Synced pill (idempotent event_id makes replay safe).
- **H3 · Set-sport correction path (N3).** Audited amend for COMPLETED set matches (manager reopen → correct → recomplete) + drop the `not set_based` advancement re-fire gate.
- **H4 · Freeze-gate + idempotency on the sports tree (N5)**; block structural leaf edits once that leaf has registrations/fixtures (surgical: renames stay legal — keys are stable).
- **H5 · Age enforcement (N4).** Validate DOB against `leaf_age_rule` (configurable cutoff date, SGFI default 31 Dec) in `validate_answers` + `register_school`, dotted-path errors.
- **H6 · School lifecycle emails v1 (N6, C21).** Submission receipt with tokenized "your registration" link; accept/reject notice; schedule-change email fan-out to institution contacts; kill `fail_silently` masking (delivered/failed recorded). Deliverability verified against real SMTP on this box.
- **H7 · S0 completion (existential).** Offsite backup copy (encrypted, off-box), restore drill documented + executed once, Sentry (or equivalent) both sides.
- **H8 · C12 + roster drafts.** ResponsesPage renders group rows as a structured roster table; PublicFormPage localStorage draft persistence.
- **H9 · RBAC cache invalidation on removal (N12); audit rows carry tournament_id/match_id.**
- **H10 · MatchActionsMenu double-mounted dialogs fix** + extract the shared match-actions component (S8 start).

---

## 4. Pillar A — SportDefinition architecture (the chassis)

The keystone (full design: fleet `design-sport_plugin_architecture`, gate-passed). One registry makes sport a first-class axis:

- **`SPORT_DEFINITIONS`** in `apps/matches/services/sport_defs/` (one module per sport + `registry.py`), a frozen dataclass per sport: `code, version, participant_model, period_model (TIMED|TARGET|INNINGS), score_reducer, event_vocab, default_rules, rule_schema, period_sequence, allowed_transitions, interruptions, walkover_result(), standings_columns, default_tiebreakers, leaderboards, award_templates, officials_roles, terms, default_duration_minutes, venue_type, console_blueprint`. Supersedes the 5-entry `SPORT_PROFILES` dict (set_scoring.py:33); `Sport.python_module_path` (dormant since day 1) becomes the registration pointer; `Sport.status` gates liveness (no more silent football fallback for 54/59 catalog sports).
- **Code/data split (the flexibility contract):** behavior (reducers, period models, transition tables, validators, column semantics) is versioned code; every number (`best_of/points/win_by/cap/deciding`, `serves_per_turn`, roster shape, durations, tiebreaker order, points-for-win) stays per-tournament/per-leaf JSONB, resolved per-game → per-sport → definition default, frozen at the invariant-7 boundary. `definition.version` is stamped into the frozen match rules so vocabulary/reducer evolution never rewrites history.
- **Backend seams** (all verified): `rules_for_match` → `resolve_rules(match)`; `merge_rules(partial, base, sport_code)` validates against that sport's schema (football-only keys vanish for TARGET sports; `serve`, `format`, `match` blocks become legal — fixes the whitelist rejecting sport keys, rules.py:170); `state.py` reads per-definition transitions/period sequences (closes API-reachable HALF_TIME for set sports) and `walkover_result` (fixes the illegal 3-0 set-walkover, state.py:51); score derivation dispatches on `score_reducer`; `compute_leaders` reads `definition.leaderboards` **scoped per sport/leaf** (fixes N7); standings columns per definition.
- **Score-of-record decision (conflict resolved by synthesis):** v1 keeps `set_scores` as the source of truth for TARGET sports; per-point/per-action events (serve, ace, fault, kill, block, timeout, point-with-reason) are **non-scoring annotations** on the existing event log (`record_match_event` already rejects scoring events for set sports and skips recompute — the seam is proven). One tap = bump set progress AND log the annotated event. The TT point-*derived* umpire mode (events as source) is a later increment, only after `definition.version` stamping exists.
- **Frontend:** `MatchConsolePage` splits into a shared chassis (header, status, clock, event log, undo, terminal confirms) + `SPORT_CONSOLES` registry keyed on `match.sport`, with a **generic blueprint-driven fallback** so any data-only custom sport is fully playable; `liveSetView` generalizes to `sportView()` so viewer/venue-PA/match rows inherit sport-awareness; client `setsWon` reimplementation deleted in favor of server-resolved sets.
- **Multi-sport UX** (design gate-passed): sport is a **`?sport=` facet** on existing ops routes + a persistent `OpsScopeBar` switcher — Today/Board/public schedule stay combined (the shared spine), Standings/Leaders/Crew scope per sport with descriptor-driven native columns, served via `GET /tournaments/{id}/sports-meta/`. **Single-sport collapse:** ≤1 sport renders zero switcher chrome — a football-only tournament is byte-for-byte today's UI. No URLs break.
- **Migration safety:** Phase-1 architecture needs **zero schema migrations** (new event types ride the free-string event column; choices formalized in a later maintenance window). Football rows (`sport=""`) map to the default definition — all ~710 backend/~274+ frontend tests stay green through the refactor. Badge key mismatch (`sepaktakraw` vs `sepak_takraw`, catalog.py:28) normalized.

---

## 5. Pillar B — the three sport verticals

Grounded in fact-checked dossiers (ISTAF 2013 + 2024 mandate; ITTF Statutes 2025; IFAB LOTG + FIFA 2026 regulations). Every number below carries a source in the dossiers.

### B1 · Sepak takraw (ships first, Aug 29)
- **Two scoring regimes as named presets** — the dossier's key discovery: LEGACY (sets 1-2 to 21/win-by-2/cap 25; deciding set 15/win-by-2/cap 17; 3-serve blocks; ends change at 11, decider at 8) vs **ISTAF 2024 mandate** (all sets 15/17; single service alternating every point; effective 1 Feb 2024). Current schema already expresses both (`deciding` block exists); new `scoring.serve` rule block: `{serves_per_turn, alternate_every_point, change_ends_at:{regular, deciding}}`. **Owner must pick Dimapur's regime (D1).**
- **Console:** serve indicator with auto-advancing rotation; two big point buttons with fault-reason chips (`service_fault`, `three_touch`, `net`, `out`) that bump the set AND log the annotated event; ACE/KILL/BLOCK stat taps; score-triggered change-ends banner; per-set timeout (1) and substitution (2) counters; one-handed h-11+ layout.
- **Structure:** `format` per leaf `{players_per_side: regu 3|doubles 2|quad 4, reserves_max, subs_per_set, timeouts_per_set, event_type}`; lineup `positional_role` (tekong/left_inside/right_inside) — the one schema migration, landed pre-Aug-29; crew template (court referee, match referee, assistant, 2 linesmen, scorer; `LINESMAN` role added).
- **Standings/leaders:** tiebreakers `["wins","set_difference","point_difference"]` (tokens already whitelisted); set-sport standings columns; Best Server/Spiker/Blocker + MVP off annotation events.
- Team event (tie of 3 regus) = deferred composite (see MatchTie, B2).

### B2 · Table tennis (ships with sepak, Aug 29)
- **Rules:** 11-point games, win by 2, **uncapped deuce — `cap` must be null and the editor hides the field**; best-of as a configurable odd integer per leaf/stage (proposed defaults D2: BO3 pools, BO5 knockouts); ITTF group scoring **2 / 1 / 0** (win / played loss / walkover) — a real change to the standings loss branch; **ratio tiebreakers** (`ratio_matches`, `ratio_games`, `ratio_points`) computed over the tied-members mini-table with successive re-examination — new comparator family in `_sort_key` + whitelist.
- **Console:** serve indicator (every 2 points, every 1 at 10-10), ends-change prompts (every game; decider at 5, doubles receiver switch), toweling prompt (every 6 points), 1 timeout per side, warning→penalty-point discipline (yellow, then yellow+red = 1 point to opponent, then 2); set-total stepper mode (today's editor) as school default, point-by-point umpire mode as the later increment; expedite **stubbed v1** (visible flag, no 10-min clock) pending D2.
- **Team ties** (Olympic order ABXY+doubles, 2026-Worlds 5-singles, Swaythling/Corbillon as data presets; dead rubbers marked not-played; max-2-matches-per-player): first-class **`MatchTie`** parent model — post-Aug-29 phase with its migration window (D3: confirm out of scope for Dimapur).

### B3 · Football (reference vertical, after Aug 29)
Period phases (halves + per-half added time as referee-entered integers) → ET (2×15, config) → **KFPM as its own ordered event stream** (reduce-to-equate, alternating, early-clinch math, sudden death) with a console tab; two substitution budgets (5-in-3-windows + independent concussion subs; **youth rolling-subs mode**); discipline: second-yellow auto-red, min-7 auto-abandon guard, suspension accumulation with configurable wipe round; group tiebreakers as **selectable ordered presets** — FIFA-2026 (head-to-head first) vs classic (overall-GD first) vs UEFA-recursive — with per-criterion scope flags and fair-play points (-1/-3/-4/-5, most-severe-per-player); best-N-third-place advancement + published-lookup bracket seeding (48-team format); two-legged ties (away-goals off by default); awards: Golden Boot (goals → assists → fewer minutes), clean-sheet policy configurable, panel awards deferred (needs a voting entity).

---

## 6. Pillar C — the institution vertical (main customers)

Design gate-passed; all seams verified. Additive evolution, no rewrite:

- **Tenancy:** `Organization.kind {personal, institution}` + `branding` + `is_listed` (every existing org stays personal/hidden — zero behavior change); **`SchoolProfile`** as the canonical identity spine (operator orgs AND tournament `Institution` rows FK into it; backfilled by normalized name+region with an admin merge console); `Season` (org-scoped academic year); `Tournament.season_fk`.
- **Operator mode:** houses/classes as **`TeamGroup`** (org+season scoped, `Team.group` FK); **house points** as a season-level standings layer — per-group place points AND per-athlete Individual Champion per age-gender band from the same results, plus append-only judged **`HousePointEntry`** injections (march past, drill, discipline) — all data-driven off a `rules["place_points"]` profile (Indian convention preset: **7-5-4-3-2-1, ×2 relays**); roles map onto the existing 6-role RBAC (admin=HoD PE, game_coordinator=house master, team_manager=house captain…) — no new RBAC layer; **event presets** ("Annual sports day", "Inter-house league", "Inter-class knockout") pre-filling sports tree + draw_config + rules.
- **Meet mode (new competition primitive):** the anchor school event is an athletics meet — place-based scoring (heats/finals, place points, standards), not head-to-head fixtures. Ships as a third scoring family alongside timed-goals and target-sets (also completes the flexibility story).
- **Participant mode:** "claim your school" graduates the access-code portal into a real institution org (idempotent, audited, email-ownership-proofed — stronger than the 2h token); school dashboard across years (records, rosters, badges, certificates, edit-with-code).
- **Packaging:** per-org plan/entitlements flags, owner-configurable; free = participant mode + capped self-run events; paid = branded bulk certificates, unlimited seats/events, cross-year analytics, listing, ICS feeds, SSO/MIS. Never the IMLeagues ad model.
- **Hard constraint:** the additive schema (SchoolProfile, Season, TeamGroup, HousePointEntry, org fields, `positional_role`) must **migrate before Aug 29** (migrations are blocked while any tournament is live).

---

## 7. Pillar D — flexibility & the sellable engine

- **Custom-game designer** in setup: pick a scoring family (timed-goals / target-sets / meet-places) → set numbers → roster shape (any NvN + reserves) → stage graph → play; renders via the blueprint fallback console. Kills the silent football fallback.
- **Sport-scoped rule whitelists** (Pillar A) so custom keys validate instead of erroring; official presets are editable starting points everywhere.
- **Stage-graph integrity:** fix the swiss/double_elim→knockout bridge (dispatch on source-stage type; validation passes ⇒ advancement works, stages.py:170); stop swallowing advancement exceptions — surface an **advancement-health signal** in the control room.
- **Scheduler as product:** enforce constraint `params_schema` + scopes at PATCH (silent-accept today, constraints.py:209); implement or remove `avoid_back_to_back`/`even_spacing`; split the freeze gate so scheduling constraints stay editable until fixtures generate (rules.py:221); `validate_schedule` honors the person-gap constraints the greedy honors (scheduler.py:1553); cap CP-SAT candidate intervals (hang risk, optimizer.py:399).
- **Sellable differentiators** (benchmark consensus): minimal-conflict-set explainability via CP-SAT assumption literals ("these N constraints conflict — relax one") — the #1 lever nobody else has; drag-drop time×venue master grid over the existing repair/reslot APIs; searchable constraint library with plain-language templates; must/should/nice weight presets; per-assignment provenance.

---

## 8. Pillar E — trust, reach, live-ops, experience

**Trust/integrity:** snapshot resolved rules onto the match at go-live and read the snapshot in `compute_standings` (N8, completes invariant 7); idempotency checks inside the row lock (IntegrityError → return prior); suspension enforcement at the event layer; upheld-dispute cascade (score amend / walkover / replay actually execute) + dispute resolution surfaced in the control room; lifecycle edge: matches scored before READY never flip the tournament LIVE (state.py:552) — widen the hook.

**Reach (public growth loop):** server-rendered OG meta for public routes + a **1200×630 share-card PNG** per match/award (nginx bot branch or Django view) — the single highest ROI item for WhatsApp-first communities; `/m/:id` becomes a real hub (tabs: timeline/lineups/sets/H2H, SSE not 5s poll, share button, linked team names, back-nav); **public standings tab** + unified public chrome; login-free follow team/school + web push (device-keyed, per-event toggles); route-level code splitting (N10); PR/SR-style record markers on result rows; records service + public school/team/player profiles (2026-07-02 §5 design) as the retention spine.

**Live-ops:** connect the WS scorer room to console + control room (5s poll as fallback) — resolves N11 per the owner's live-ops vision; granular SSE ticks (use `match_id`/`kind` to patch one row instead of 5-aggregate blanket refetch) + paginate/window the matches feed (the Dimapur-scale fix); control-room verbs: kickoff/half-time inline, delayed-court cascade shift, dispute panel; TodayRail role-aware deep links.

**Experience hygiene:** shared ErrorState/EmptyState/Skeleton primitives (63% of pages lack error branches; VenueDisplay infinite-loads); 44px coarse-pointer touch floor + `touch-manipulation` on the shared controls; Dialog/menu focus traps; design-lint wired into CI/pre-commit + extended (bare hex, h-10, raw bg-primary, native selects — one `<select>` already regressed); retire the 24px shadcn Card for the 18px `.panel` standard (169 hand-copied card strings → one class); delete the legacy org surface + football-only `RegistrationFormPage`; auth bus `MutationCache.onError` (session-expiry-during-save); tournament-TZ rendering in schedule-change rows; i18n decision (D7): keep `t()` as boundary but make it real (LocaleMiddleware + catalogs) in Phase 7 — stop pre-interpolating now so strings stay translatable.

---

## 9. Roadmap

Every increment: pytest + vitest + type-check green before commit; permission-matrix, state-machine, multi-tenancy, idempotency axes mandatory where touched; migrations as `fixture_owner` in no-live windows. Analysis is Opus; **all execution is Fable 5**; research below the product-grade bar goes back for re-research.

- **Phase H · Hotfixes + safety (immediately, ~days):** H1-H10 above + the completeness critic's verification modalities (live-page screenshot review, prod-scale read-only queries, SMTP deliverability test, backup/restore audit → feeds H7).
- **Phase 1 · Chassis (before verticals):** SportDefinition registry + resolve_rules/merge_rules(sport) as a football-identical refactor (tests stay green), per-sport transitions/walkover, leaders/standings sport scoping, sports-meta endpoint + `?sport=` facet + OpsScopeBar + single-sport collapse, console chassis split + blueprint fallback.
- **Phase 2 · Sepak + TT verticals + institution schema (hard deadline: before Aug 29):** both sepak regime presets + serve/format rule blocks; sepak console module; TT console module (set-total default) + 2-1-0 points + ratio tiebreakers; `positional_role` + crew templates; **the entire additive institution schema migrates now** (SchoolProfile, Season, TeamGroup, HousePointEntry, org fields) even though its UI ships later; D1-D4 decided.
- **Phase 3 · Aug 29 operations hardening:** granular ticks + pagination, WS scorer rooms, offline queue burn-in, venue-PA sport-awareness, printable day sheets/scoresheets, advancement-health panel. *Dimapur runs here.*
- **Phase 4 · Institution operator vertical:** claim-your-school, houses/house-points UI + season table, event presets, **meet mode**, bulk certificates, school dashboard; first-class school invite flow with delivery tracker.
- **Phase 5 · Football reference vertical + flexibility:** period/ET/KFPM model, sub budgets, suspensions, tiebreaker presets, awards; custom-game designer; MatchTie composite (TT team events + sepak team regu); stage-bridge fix.
- **Phase 6 · Reach & records:** OG/share cards, /m/ hub, public standings, follow + push, records service + public profiles + badges surfaces (2026-07-02 §§5-6), code splitting.
- **Phase 7 · Platform & packaging:** plans/entitlements, public directory, SSO/MIS import, ICS feeds, real i18n, scheduler explainability + master grid + constraint library (sellable-engine cut), remaining S-items closed (S2 CI wire-sweep check, S4 rules studio unification).

Phases 4-6 can interleave once Phase 2's schema and Phase 1's chassis exist.

---

## 10. Owner decisions (D1-D7)

| # | Decision | Needed by | Proposed default |
|---|----------|-----------|------------------|
| D1 | Sepak regime for Dimapur: LEGACY (21/25 + 15/17 decider, 3-serve blocks) or ISTAF-2024 (all 15/17, single serve) | Phase 2, before rules freeze | ISTAF-2024 (current official law; shorter matches fit 2-court schedule) — but school convention may argue LEGACY |
| D2 | TT best-of defaults + expedite scope | Phase 2 | BO3 pools / BO5 knockouts; expedite stubbed (flag only) |
| D3 | TT team ties at Dimapur? | Phase 2 | No — singles/doubles only; MatchTie lands Phase 5 |
| D4 | Third-place policy defaults | Phase 2 | Football: 3rd-place match on; TT/sepak: two-bronze (no playoff), per-tournament toggle |
| D5 | Packaging free/paid boundary sign-off | Phase 7 | As §6 packaging |
| D6 | Org visibility amendment (invariant 2) — PRD §14 decision entry | Phase 4 | `kind=institution` orgs visible; personal stays hidden |
| D7 | i18n scope + languages | Phase 7 | English now, translatable-clean strings enforced from Phase 1 |

---

## 11. Provenance & quality gate

131 agents across three Opus 4.8 fleets + 1 recovery reader (~5.4M analysis tokens, ~1,260 tool calls), adversarial verification on 24 top claims (22 confirmed / 1 refuted / 1 narrowed), dossier-level fact-checking against IFAB/FIFA/ISTAF/ITTF primary sources with recorded corrections, and Fable-level empirical spot-checks (nginx media exposure, byte-exact bundle size, code anchors re-read). Gate log: session scratchpad `quality-gate-log.md`; raw structured outputs: `analysis-*.json`, `sport-*.json`, `design-*.md`, `product-*.{json,md}`, `institution-research.json`. Known analysis gaps (pixels, prod-data volumes, deliverability, backup posture) are scheduled as Phase-H verification tasks, not assumed away.
