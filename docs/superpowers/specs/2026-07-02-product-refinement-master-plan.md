# Product Refinement Master Plan

**Date:** 2026-07-02 · **Author:** Claude Fable 5 (synthesis + design), with a 34-agent Opus 4.8 deep-read of the full codebase (11 domain analyses, 177 raw findings, 21/21 critical logic claims adversarially verified against the code, plus a completeness critic).
**Status:** Approved plan of record for the full-product refinement. Supersedes nothing; implements toward PRD Draft v3. Individual increments still bump the PRD decisions log as they land.

---

## 1. Executive summary

The platform's chassis is genuinely strong: event-sourced scoring, a guarded stage machine, a data-driven rules/constraints engine, deep fixture generation (byes, double elim, Swiss, plate, best-thirds), Argon2 access codes, and a preview-equals-commit fixture pipeline. The weaknesses are not scattered bugs; they are **eight systemic root causes**, each fixable once:

1. **Backend built, frontend never wired.** Undo/void, lineups, incidents, penalty shootouts, abandon/postpone/cancel/replay, dispute-match linkage, and the entire two-way scorer WebSocket layer exist server-side with zero UI. The live console is football-only, fails silently (no onError anywhere), and cannot correct a mistake.
2. **The tournament lifecycle never finishes.** No code path ever sets `LIVE` or `COMPLETED`. Dashboards show 0 live forever, the live-delete guard is dead, archiving 404s the public pages, and there is no results/champion page. One state-machine fix repairs five domains.
3. **Identity is recreated per tournament.** Institution is tournament-scoped; Person dedupe is per tournament+institution. Cross-year school history and player careers (the owner's explicit ask) are structurally impossible until a canonical School/Person layer exists.
4. **Rules are fragmented and football-hardcoded.** Three editing surfaces, a freeze-with-no-amend trap, set sports shown halves/penalties fields, and live-read rules that retroactively rewrite played standings.
5. **Notifications are a stub.** `_publish` is a no-op, delivery is a 30s poll, ~3 event types, mostly targeting only `created_by`, bell items never navigate, and schools (no accounts) receive nothing at all.
6. **Design-system rot is one enforcement gap.** 92 palette-class violations (including base primitives Toast/RoleBadge), ~34 em-dash strings + 7 arrows, h-10 vs h-9 density drift, 5 centered pages, 6 hand-rolled badge systems, 6 hand-rolled tab systems, tables that never stack on mobile.
7. **Authorization stops at the module layer.** Any active scorer can score ANY match; the PRD verb matrix is not enforced server-side.
8. **No safety net.** The "dev" DB on this box IS production and there are **no backups**, no offsite copy, no error monitoring, and uploaded documents sit unbacked on local disk. This is existential and comes first.

On top of the fixes, this plan designs the three features the owner asked for: **school-facing records ("who played, wins/losses any time")**, a **badges engine** for every badge in the 2026-06-29 messages, and **certificate/share-card generation**, plus a public-growth layer (discovery, share, OG cards, PWA) that turns the public side into a real sports product.

---

## 2. Verified critical findings (all confirmed in code)

Correctness, in order of blast radius. File refs are the confirmed anchors.

| # | Finding | Where |
|---|---------|-------|
| C1 | Scorer console mutations have **no onError**; every failure (set-sport rejection, permission, network, `knockout_draw_needs_shootout`) is silent | `features/matches/MatchConsolePage.tsx` |
| C2 | **No undo/void path**: `RecordEventSerializer` has no `voids` field; `void_match_event` unreachable; mis-taps permanent | `apps/matches/serializers.py`, `views.py` |
| C3 | **Penalty shootouts unrecordable** anywhere; level knockout with pens enabled stalls the bracket with no user path | `frontend/src/api/*` (no scoreShootout), `RecordShootoutView` unused |
| C4 | Console is **football-only**; never branches on `match.scoring`; set sports have no live console at all | `MatchConsolePage.tsx` |
| C5 | One-tap unconfirmed **Complete** is terminal + fires advancement; combined with C2, unrecoverable | `MatchConsolePage.tsx`, `services/state.py` |
| C6 | **Advancement race**: `advance_from_match` doesn't row-lock the dependent and writes both team fields; concurrent feeder finals can null a side permanently | `apps/fixtures/services/advance.py:60-66` |
| C7 | **Post-final corrections don't ripple**: `record_match_event` has no status guard; a scoring event on a COMPLETED match flips winner_id but advancement/group positions never re-fire (note: `record_score` DOES guard, confirming inconsistency) | `apps/matches/services/events.py:89-154` |
| C8 | **Tournament never LIVE/COMPLETED**; `_STAGE_STATUS` tops out at SCHEDULED; delete-block dead, KPIs permanently 0, archive = public 404 | `apps/tournaments/services/state.py` |
| C9 | **Required fields in repeatable groups never validated** (server or client): blank player names/DOB accepted; zero-player teams pass | `apps/forms/services/validation.py`, `lib/formLogic.ts` |
| C10 | **Unprotected schools**: any visitor can register teams for institutions without a code hash (no-email schools skipped by issuance) | `apps/teams/services/access.py`, `apps/forms/views.py` |
| C11 | **Publish-all ignores previewed seeds**: publishes different pairings than previewed, no drift 409 (single-leaf path is correct) | `DryRunPreviewPage.tsx`, `PublishAllFixturesView` |
| C12 | ResponsesPage renders rosters as `[object Object]`; admins cannot review submissions | `features/forms/ResponsesPage.tsx` |
| C13 | Second half shows "Live · half time" forever (`current_period` sticky); no period model | `services/state.py` |
| C14 | Manual free-text minute field, no running clock; stale minutes on every event | `MatchConsolePage.tsx` |
| C15 | Disputes: no outcome application, no cascade, no match `disputed` overlay, no 24h window/anti-spam; UI never links a match | `apps/disputes/*` |
| C16 | Lineups: backend complete, zero UI; validation missing all PRD §5.4 checks | `apps/matches/services/lineups.py` |
| C17 | Assignment is silent: scorers/referees never notified; `MatchOfficial.accepted_at` flow unsurfaced | `services/scoring.py`, `officials.py` |
| C18 | Shootout endpoint not idempotent (no audit pre-check; replay = IntegrityError 500 + double advancement) | `apps/matches/views.py` |
| C19 | Suspension engine absent: `yellow_suspension_threshold`/`red_matches_banned` rules have no consumer | `services/events.py`, `rules.py` |
| C20 | Match center (`/m/:id`) is orphaned (linked from nowhere) and renders none of the lineups/sets/venue data the backend already returns | `LiveViewerPage.tsx`, `api/live.ts` |
| C21 | Email is fire-and-forget: `fail_silently=True` counted as "sent"; bounced access codes shown as delivered | `apps/teams/services/access.py` |

Also verified as real by the critic's spot checks: **no backup automation anywhere in `deploy/`**, `t()` is an identity function (i18n is cosmetic), zero `WebSocket` usage in the frontend (the whole ASGI WS layer is dead code), and no logo/crest/photo field on any model.

---

## 3. Systemic fixes (do once, fix everywhere)

**S0 · Safety net (existential, before anything else).** Nightly `pg_dump` + `MEDIA_ROOT` tarball, rotated, with an **offsite copy** and a tested restore runbook in `deploy/`; Sentry (or equivalent) on backend + frontend. Nothing else in this plan is safe to build without this.

**S1 · Lifecycle spine.** `scheduled → live` on first kickoff (on_commit from `transition_match`), `live → completed` when the last match of the last stage is terminal (plus manual "Wrap up tournament" in OpsSettings). COMPLETED stays public read-only with a results page (champion, final standings, top scorers); ARCHIVED remains the separate "hide" action. Re-enables the delete guard and the migration pre-flight; fires completion notifications; fixes dashboard KPIs at the root.

**S2 · Wire-the-backend sweep.** Every orphaned endpoint gets its UI (undo/void, shootout, lineups, incidents, abandon/postpone/cancel/replay, dispute match linkage). Add a CI check listing mutation endpoints with no frontend caller so this class of gap cannot recur.

**S3 · Design-system reset.** (a) Density: `h-9` becomes the Button/Input default (`lg` = h-10 for hero CTAs only); Card retuned to rounded-xl / p-4-5 / text-base title + a `SettingsCard` composition. (b) New token-only primitives: `Badge` (semantic variants + one status registry), `Tabs`, `Skeleton`, `EmptyState` (promoted), `Textarea`, `Checkbox/Radio/Switch`, `PageHeader`, `DataTable` (auto-stacks to cards under `useBreakpoint().isMobile`). (c) A design-lint ESLint rule banning palette classes, raw hex, em/en dashes and arrows in strings, `mx-auto max-w-*` on app pages, and native selects/textareas (allowlist: FifaBracket, RTE content colors). (d) One mechanical sweep migrating the 92 palette + ~40 dash/arrow violations onto the new primitives. Fix the base primitives first (toast emerald → `success` tokens, RoleBadge dark-mode, dialog close icon).

**S4 · One rules studio.** Merge SettingsTab + CompetitionFormatBoard scoring + CompetitionFormatWizard knobs into a single sport-aware Rules surface: sets vs goals fields per competition, tiebreaker ordering, discipline thresholds, withdrawal policy, points. Freeze state shown inline; **amend-with-reason** works post-freeze everywhere; never-amendable keys gated; **rules snapshot onto the match at kickoff** so amendments never rewrite played results.

**S5 · Canonical identity.** `SchoolProfile` (platform/org-level) that tournament `Institution` rows FK into (resolved by normalized name + region, admin merge console); Person resolution widened to the canonical school scope guarded by dob_year; `starts_at`/`ends_at`/`season` on Tournament (backfilled). This is the enabling migration for everything the owner asked about school data.

**S6 · Real notifications.** A recipient resolver per event type (PRD §5.14): all admins/co-organizers, assigned crew, and **email for school contacts** (they have no accounts — email IS their channel). Implement `_publish` over the existing SSE layer; bell items navigate to their `url`; a full notifications inbox page; branded HTML email templates with real delivered/failed tracking (kill `fail_silently` reporting).

**S7 · Verb-matrix permissions.** `can_perform_verb` resolver from PRD §3.2 applied behind the module gates; scorer writes scoped to the assigned match; dispute resolution scoped per role.

**S8 · One match display/action kit.** A single canonical match row/tile + action menu (variant prop) shared by console, board, Today, crew, and public surfaces: one separator ("vs"), one score format (plain hyphen), one status registry, one shootout/walkover/transition dialog set. Deletes the duplicated `MatchActionsMenu`/`RowActions` pair.

---

## 4. Page-by-page redesign (Supabase-grade)

Design language everywhere: dense h-9 controls, `SettingsCard` panels, PageHeader, tokens only, Inter with semibold cap, `font-tabular` numbers, no dashes/arrows in strings, fill-width app pages, tables stack to cards on mobile. Public pages read as FotMob/ESPN, never as admin.

**P1 · Create → Basics.** Replace the name-only centered card with a dense Basics step: name, sport(s), date range, timezone; "Start from a previous tournament" (clone) and per-sport preset category trees (the Nagaland U-14/U-17 boys/girls trees ship as presets). On submit, land **inside the new workspace** (fixes the navigate-to-list bug). Friendly error mapping (`verify_email_first` → verify CTA).

**P2 · Overview → a real home.** Stage stepper stays as orientation; add dates, public links (schedule/live/bracket + copy), per-competition readiness checklist with fix deep-links, recent activity. One canonical Continue control; extract the STAGE_ROUTE map duplicated in four files.

**P3 · Sports step.** Collapse pick/configure/review modes into one persistent tree editor with a live competitions count and an inline confirm; keep auto-detection; hard-block leaving SETUP with zero sports; surface the rules-freeze warning at the team_registration advance instead of filtering it out.

**P4 · Registration workspace.** One **"Invite schools"** panel (access codes primary; per-institution links and single-use links demoted to advanced) with a delivered/failed/unprotected triage list. Protection default-closed (C10). Fix group validation (C9) on both sides. Responses becomes a dense full-width DataTable: bulk accept/reject/waitlist, search, sort, and a structured roster drawer (kills `[object Object]`). Add an **in-app roster editor** (diff-based save preserving Player IDs; relabel the misleading "Add team"). Generated player group gains jersey/position/captain/photo (sport-aware) and full DOB persisted + age-eligibility flags. Name normalization + near-duplicate warnings + merge action. Retire the legacy hardcoded `RegistrationFormPage`. Self-service "resend my code" on the public form.

**P5 · Fixture hub.** Fold the wizard's advanced draw knobs (third place, plate, legs, seeding method, best thirds) into the format board as per-format progressive disclosure; the wizard shrinks to a seed-order editor. Publish-all replays previewed seeds + hashes with a drift 409 (C11); single-leaf publish becomes one atomic endpoint. Second **schedule-drift hash** (calendar/venues/breaks/durations) raising a "re-run schedule" banner. Preview-all surfaces skipped leaves ("drawn N of M"). Add drag-to-reslot on the day grid + bulk tail-shift, and an **organizer export pack** (CSV, printable per-venue order-of-play, whole-tournament ICS).

**P6 · Ops cockpit.** Today becomes a place to **act**: inline primary verbs on Needs-attention rows; deep links land pre-filtered. Add everywhere the missing verbs: postpone/abandon/cancel with reason, manager replay, shootout entry from QuickResult on level knockouts, incident quick-file. Promote **Shift day / rain recovery** into the Today header and Board toolbar. New surfaces: per-court **day timeline** (delays visibly ripple), fullscreen **venue PA/kiosk display** (public-safe now/next/called), printable **ops day sheet** (crew + blank result column), announcements composer fanned over SSE. Crew: clear/None scorer option, one-step official swap, assignment notifications (C17) with accept/decline. Board stacks to cards on mobile.

**P7 · Match console rebuild** (the single highest-impact page). Staged, sport-aware, mistake-proof:
- *Pre-match:* Lineups tab (starters/bench/shirts, confirm both sides) feeding attribution; context strip (competition, round, venue, kickoff in tournament TZ, crew).
- *Live, goal sports:* big touch targets (Goal largest), running clock auto-filling minute (manual override), own_goal / penalty_scored / penalty_missed / assist, attribution constrained to on-pitch players, selection resets after each event.
- *Live, set sports:* per-set point steppers, set-end, timeouts, running tally via `record_set_result` — the console never shows buttons the backend rejects.
- *Safety:* onError toasts on every mutation, optimistic pending, **Undo last event** + per-row void (new `voids` field/endpoint), confirm-with-final-score for Complete/Walkover/Abandon, manager reopen path, `second_half`/extra-time period model (C13).
- *Transport:* subscribe to the match WS room; idempotent offline write queue (event_id makes replay safe) for weak venue connectivity.
- *Post:* Report tab — printable official match report (lineups, timeline, cards, subs, officials, incidents, result, MVP pick), raise-dispute pre-filled with the match.

**P8 · Public experience.** Landing rebuilt around live scores + a public **/explore tournament directory** (opt-in), organizer CTAs secondary. Tournament shell gains a **Standings tab**, a Share control (native share + copy), per-page `document.title`, and the bracket gets the tournament TZ (one clock everywhere). Match center (`/m/:id`) becomes the destination every score links to: lineups, venue, kickoff, competition chips, set-by-set scores, period-grouped timeline with icons, head-to-head. Team names link everywhere to **team/school profile pages** (§5). Platform layer: OG/Twitter meta + a server-rendered **OG scorecard image** endpoint (WhatsApp previews), PWA manifest + minimal service worker, robots + sitemap. AboutPage rewritten on tokens. Bracket tab hidden for league-only events.

**P9 · Root pages.** Dashboard becomes an operator command center: cross-tournament "Today" (live + next, deep links), a "Needs you" queue (invites, drafts, disputes, unassigned crew), recent activity — the tournament list lives only on /tournaments. Crew accounts see "Your matches" first (assignment inbox). Cull the vestigial org surface (OrgDashboardPage → redirect, role landings, OrgSwitcher, dashboardCards); resurface org settings/branding/audit under one deliberate "Workspace settings" entry. Profile rebuilt as dense tabbed Account/Security. Auth pages detoxed to tokens. Notifications: SSE push, click-through navigation, full inbox, "Notification settings" naming.

---

## 5. School data: durable records (owner requirement)

Owner: *"keep proper data in the fixture app so that schools can see their data — who played, wins/losses any time."*

1. **Identity spine (S5)** — canonical SchoolProfile + platform Person + Tournament season/dates. Without it, "any time" is impossible; with it, everything below is aggregation.
2. **Records service** (`apps/matches/services/records.py`): `team_record(team)` across all leaves/stages via winner_id/loser_id (P/W/D/L, GF/GA/GD, PF/PA points, recent form); `institution_record` rolling up a school's teams; `player_career(person)` from non-voided MatchEvents + LineupEntry appearances; `tournament_scorers`. Reliable "who played": derive an Appearance record and nudge lineup confirmation (lineups become first-class via P7).
3. **Public profiles** (FotMob-grade, token colors): school hub (crest header once branding lands, record strip, season-grouped tournament accordion, badges rail), team profile (record, form pills, fixtures/results, roster), player career page, per-tournament top scorers. Every team name across schedule/standings/bracket/live becomes a link — the single biggest navigation unlock.
4. **School portal (token-scoped, no account needed):** a "Your registration" page linked from every email a school receives: institution status, teams, upcoming fixtures, live scores, results, badges, certificate downloads, edit-with-code. Closes the dead-end where the primary external actor never hears anything after submitting.
5. **Season archive:** public past-tournaments index so history is browsable without a saved link.

---

## 6. Badges & certificates engine (owner requirement)

**Data reality (verified):** `Match.set_scores` stores ordered per-set points and is enforced (`set_scores_required`) for set sports; `compute_standings` already derives W/D/L, GF/GA/GD and raw points PF/PA/PD. So every badge below is computable **today**, with two guards: skip walkover/abandoned matches (empty `set_scores`), and add per-`leaf_key`/`stage_no` scoping to the aggregation (matches and teams both carry `leaf_key`).

**Engine** (`apps/badges`, consistent with house patterns): a code-defined `BADGE_TEMPLATES` catalog (like `SPORT_PROFILES`), enabled/tuned per tournament via a whitelisted `rules["badges"]` key (invariant-7 freeze applies; all thresholds are params, nothing hardcoded). A `BADGE_HANDLERS` metric registry evaluates criteria from `compute_standings` rows, `set_scores`, and `MatchEvent`. `BadgeAward` rows: UUIDv7, org+tournament FKs, `badge_key`, `leaf_key`, `stage_no`, subject (team/player), **evidence JSONB** (the actual numbers: "conceded 9", the set scores, match id), deterministic uuid5 idempotency key, `revoked_at` + audit for corrections. Triggers on `transaction.on_commit` after result commit (match badges) and on stage finalization inside the existing `advance_from_match` seam (stage/competition badges); `recompute_badges` reconciles award/revoke idempotently; ties co-award. Optional manager approval queue before public display; `badge_awarded` notifications; surfaces on team/school profiles, match report, and a public honours gallery.

**Catalog (every badge from the 2026-06-29 messages, mapped):**

| Badge | Subject · Scope | Criteria (params in brackets) | Feasible now |
|---|---|---|---|
| Best Defence / Toughest to Score Against / The Wall | team · competition or stage | min points conceded (PA_pts; GA for football) [min_matches] | Yes |
| Straight Set Winner | team · match | won with zero sets dropped (e.g. 2-0) | Yes |
| Clean Sweep Streak | team · competition | [N=2]+ consecutive wins without losing a set, in played order | Yes |
| Perfect Run | team · group stage | finished group stage, zero sets lost | Yes |
| Lockdown Match | team · match | won AND total points conceded ≤ [T] (sepak default 10, TT default 15 — params) | Yes |
| Comeback Kings / Never Give Up | team · match | lost set 1, won the match (ordered set_scores); football variant: trailed then won (goal-event ordering) | Yes |
| Group Stage Dominator | team · group stage | rank 1 AND zero losses AND highest PD AND zero sets lost (co-award ties) | Yes |
| Highest Point Difference | team · competition | max PF − PA (PD_pts / GD) | Yes |
| Golden Boot (football bonus) | player · competition | top scorer from non-voided GOAL events | Yes |
| Clean Sheet Streak (football bonus) | team · competition | [N]+ consecutive matches, zero conceded | Yes |

Player-level badges for set sports are the one thing NOT feasible yet (no per-point attribution) — team-level only there, by design.

**Certificates & share cards ("this creates nice social media posts"):**
- **Share card:** server-rendered 1200×630 PNG per award (Pillow is already installed) — badge art, tournament + team name, evidence numbers ("Conceded 9 points", "15-4, 15-5"), QR (qrcode dep exists) to the public verification/gallery URL. Doubles as the OG image when the award is shared.
- **Certificate:** an HTML print route on design tokens (Save as PDF) — zero new system deps on the live box; avoid WeasyPrint (pango/cairo install risk in prod).
- Stored under MEDIA_ROOT (nginx already serves /media/), regenerated idempotently per award id, optionally emailed to the school contact.
- **Prerequisite:** add `Tournament.branding` JSONB (crest upload + accent) — today no logo/crest field exists anywhere, so certificates would otherwise carry only a name.

---

## 7. Backend missing-logic fixes (verified)

Beyond §3: advancement row-lock + single-side update (C6) with a parallel-semifinal test; status guard on `record_match_event` + correction ripple re-firing advancement/group positions (C7, mirror `record_score`'s guard); shootout idempotency pre-check (C18); suspension engine (2nd yellow, accumulation from `rules.discipline`) feeding lineup/event warnings (C19); full PRD §5.4 lineup validation + deadline policy; dispute outcomes (score_amended / walkover_awarded / match_replayed) with cascade + `disputed` overlay pausing advancement + 24h window/anti-spam (C15); `double_walkover_policy` + `abandonment_policy` executors (double no-show currently strands the dependent match); LIVE/HALF_TIME → walkover/postponed/cancelled transitions per PRD §5.5; amend grace window + notifications + never-amendable keys (S4); TZ editability until `ready` then a real lock (invariant 14); eligibility freeze evaluator (PRD §5.3); disqualification executor mirroring withdrawal.

Platform gaps from the critic to schedule deliberately: real i18n (t() is currently an identity; Nagaland is multilingual), CSP header, media/photo fields (school crests, player headshots — also feeds the FotMob feel), import/export packs (schools currently re-key everything yearly), and a decision on the unused WS layer (P7 adopts it; otherwise delete it).

---

## 8. Roadmap

Every increment: pytest + vitest + type-check green before commit; permission-matrix, state-machine, multi-tenancy, and idempotency test axes are mandatory where touched. Migrations run as `fixture_owner` in a no-live-tournament window (real once S1 lands).

- **Phase 0 · Safety net (first, small):** backups + offsite + restore drill; Sentry. *No product risk, existential payoff.*
- **Phase 1 · Correctness core:** S1 lifecycle spine + results page; console rebuild P7 (undo, errors, sport-aware, shootout, clock, confirm); C6/C7/C18 advancement & correction integrity; C9/C10 registration validation + default-closed protection; C11 publish-all seed fidelity.
- **Phase 2 · Match-day completeness:** missing verbs everywhere (P6), incidents UI, rain-day promotion, crew assignment notifications + inbox, lineups UI, suspensions, dispute workflow, day sheet + match report exports.
- **Phase 3 · Design-system reset (S3):** primitives + lint + density defaults, then the mechanical sweep. *Gates all page redesigns so they're built once, on the final kit.*
- **Phase 4 · Page redesigns:** P1-P5, P9 on the new kit (Basics/templates, Overview home, Sports step, rules studio S4, registration workspace, fixture hub, dashboard/root cull).
- **Phase 5 · School data (§5):** identity migration → records service → public profiles + team links → school portal → archive.
- **Phase 6 · Badges & certificates (§6):** engine + catalog → share cards + certificates (needs branding field) → honours gallery + portal/profile integration.
- **Phase 7 · Public growth:** landing + /explore, match center rebuild, share + OG cards, standings tab, PWA, kiosk display, notifications S6 full rollout.

Phases 5-7 can interleave with 4 once Phase 3's kit exists. The badge engine has no hard dependency on Phase 5, but its display surfaces (profiles, portal) land there — build the engine any time after Phase 1, surface it with Phase 5/6.

---

## 9. Analysis provenance

Fleet: 12 read-only Opus 4.8 analysts (creation/setup, registration, fixture engine, ops, match console, public, root/nav, backend completeness, school data, design audit, e2e journey, badges design) + 21 adversarial verifiers (21/21 confirmed, 5 with corrective nuances folded in above) + 1 completeness critic. ~2.77M tokens, 691 tool calls. Raw structured outputs lived in the session scratchpad; everything actionable is distilled into this document. Synthesis, design decisions, badge catalog, and roadmap by Claude Fable 5.
