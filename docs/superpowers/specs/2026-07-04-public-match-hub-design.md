# Public Match Hub + Tournament Panel + Per-Sport Visuals — Design Spec

**Date:** 2026-07-04 · **Provenance:** Opus 4.8 design agent (code-grounded, every claim carries file:line), commissioned on the owner's direction: the public experience must reach the bar of **Google's sports panel** ("fifa world cup games": Matches / Standings / Knockout / per-match detail as instant tabs), with **per-sport match visuals** — football keeps the pitch lineup graphic; table tennis and sepak takraw get native equivalents, never a reused pitch. Detail layer of the sport-first master plan (P6 public reach, riding the P1 SportDefinition chassis).

## 0. Where this sits

Rides the Phase-1 `SportDefinition` chassis: `SPORT_DEFINITIONS` carrying a `console_blueprint` per sport, a frontend `SPORT_CONSOLES` registry keyed on `match.sport`, `liveSetView` generalized to `sportView()`. This spec is the **public read surface** of that chassis. Current state: `/m/:id` (`frontend/src/features/live/LiveViewerPage.tsx`) is a dead-end — centered `max-w-2xl` column (line 64, violating fill-width), 5s poll (line 39), no tabs/share/back-nav/per-sport view.

## 1. The Match Hub (`/m/:id` rebuilt)

**Chrome.** Replace the bespoke header with the shared `PublicViewerHeader` pattern (`PublicViewerHeader.tsx:55`): brand + linked tournament name (back-nav to `routes.publicSchedule(slug,id)`), the connected "Live updates" badge, the existing `ShareButton` (`ShareButton.tsx:8`, native share + clipboard). The snapshot must return `tournament.{slug,id,name}` (absent today — `live/views.py:81-98`).

**Sticky match header (all statuses).** Google-style scoreline band: team names linked to `routes.publicTeam`, big tabular score via `sportView()` (running set points headline for set sports, `setDisplay.ts:37`), status pill + live pulse (reuse `statusMeta`/`LivePulse`, `PublicSchedulePage.tsx:62,421`), competition chips (`LabelChips`, :125), venue, kickoff in tournament TZ; live shows running clock (`started_at`, `live/views.py:90`) or Set N.

**Tab bar** (deep-linked `?tab=`, sticky): **Overview · Lineups · Timeline · Stats · H2H · Standings**, conditional on status:

| Tab | scheduled | live | final |
|---|---|---|---|
| Overview | kickoff card, venue, team-sheet summary, standings slice | live score + last 3 events + mini stats | final score, sets/pens, top events |
| Lineups | confirmed XI/bench (or "not yet announced") | XI + subs made | XI + subs |
| Timeline | empty state | reverse-chron, SSE-appended | full + period markers |
| Stats | hidden | live counts | full counts |
| H2H | prior meetings | prior meetings | + this result |
| Standings | group slice | group slice (live) | group slice |

**Live updates.** Drop the 5s poll: subscribe to the public SSE tick stream (`liveApi.streamUrl`, `live.ts:168`) via `useEventStream` (as `PublicSchedulePage.tsx:1022`), debounce-invalidating `["live", matchId]` on tick. Snapshot stays the system of record (invariant 4); SSE is the refetch nudge. Final matches stop refetching (keep the terminal guard, `LiveViewerPage.tsx:35-39`).

**Deep links / mobile.** `?tab=lineups` restores the tab; ShareButton forwards `window.location.href` so shares land on the right tab. Header stacks on mobile; tab bar = horizontal snap-scroller (pattern: mobile competition pills, `PublicSchedulePage.tsx:639-655`); tables → stacked cards via `useBreakpoint().isMobile`; ≥44px touch targets.

## 2. The Tournament Panel View (Google-style instant tabs)

Today three separate routes (`PublicSchedulePage`, `PublicLiveScoreboardPage`, `PublicBracketPage`) linked by `PublicViewerTabs` (`PublicViewerHeader.tsx:13`). Two changes:

1. **Reframe the tab set** to **Matches · Standings · Knockout** (drop the separate "Live" route; live matches already lift into the pinned `LiveBand`, `PublicSchedulePage.tsx:435`, on every tab). Standings becomes a first-class tab.
2. **Share one query.** All tabs read `tournamentsApi.publicSchedule` (+`publicStandings`); `PublicBracketPage.tsx:83` derives brackets from the same matches array. Hoist the fetch to a parent so tab switches are instant, Google-style.

Mapping (near-zero new backend): Matches = competition rail + day-grouped lists (`buildCompetitions:365`, `CompetitionRail:566`, `MatchCard:196`); Standings = `GroupTable` (:298) per group, surfaced from `CompetitionStandings:678`; Knockout = `FifaBracket` (`FifaBracket.tsx:424`, approved World Cup theme) per leaf via `BracketView.tsx:124` — switch the public bracket to FifaBracket. Every match row deep-links to the Match Hub (`routes.liveViewer`, `PublicSchedulePage.tsx:261`).

## 3. Per-sport lineup + match visuals (SPORT_CONSOLES view modules)

Each sport exports `LineupView` + `MatchView`; the hub picks by `match.sport`, generic fallback otherwise.

**Football (`sport==""`).** SVG pitch, starters positioned by formation, bench below, event badges (goal/card/sub) on player dots. Gaps: roster has free-string `Player.position` (`teams/models.py:211`) and lineup `role`/`shirt_no` (`matches/models.py:224,227`) but **no `Lineup.formation` and no structured positional slot** — add both (football vertical phase). v1 = 2-column XI/bench list (reuse `LineupPanel.tsx:110-159` read layout); pitch ships with the fields. Events already carry `related_player` + typed kinds (`matches/models.py:27-45,315-318`); snapshot must serialize `related_player`.

**Table tennis.** A **table/serve diagram** (two halves + net, server highlighted) + **game-by-game score strips** (11-8, 9-11, …) straight from `set_scores` (already in snapshot, `live/views.py:96`). Serve indicator needs the `scoring.serve` block (P2). Per-game sparkline = later (needs point events). Lineup = 1-2 players per side; doubles shows the pair.

**Sepak takraw.** Court diagram (net court), each **regu** placed at **Tekong / Left Inside / Right Inside**, set strips (21/win-by-2, `set_scoring.py:53-60`). Depends on the pre-Aug-29 `LineupEntry.positional_role` migration (`tekong|left_inside|right_inside`) + `format.players_per_side`. Until then: labeled 3-slot list per regu.

**Shared requirement:** the public snapshot must serve the **confirmed lineup**, not just the roster. `live/views.py:_team` (line 24) returns all players by jersey (no starter/bench split); the roled lineup endpoint (`MatchLineupView`, `matches/views.py:1004`) is `IsAuthenticated`. Fold confirmed-lineup entries (role, shirt_no, positional_role, formation) into the `AllowAny` snapshot, gated by `_ROSTER_VISIBLE` (`live/views.py:14`).

## 4. Implementation seams

**Reuse:** `ShareButton.tsx:8`; `PublicViewerHeader.tsx:55` + tabs `:13`; `statusMeta`/`LivePulse`/`LabelChips`/`MatchCard`/`LiveBand`/`GroupTable` (`PublicSchedulePage.tsx` 62/421/125/196/435/298); `FifaBracket.tsx:424` + `BracketView.tsx:124`; `LineupPanel.tsx:110-159`; `useEventStream`; `setDisplay.ts:37 → sportView()`; console scoreboard blocks.

**Snapshot extensions** (`LiveMatchSnapshotView`, `live/views.py:48`): tournament block {slug,id,name,time_zone}, `scheduled_at`, `venue`, resolved source labels; confirmed lineups (gated `_ROSTER_VISIBLE`); `related_player` on events; a stats block (event-type counts per team; per-set metrics for set sports; possession NOT tracked — omit); standings slice (reuse `compute_standings` or client-filter `publicStandings` by leaf/group). **H2H** has no data source (`head_to_head` exists only as a tiebreaker, `rules.py:23,67`) — new query: prior completed meetings of the two team_ids in-tournament (cross-tournament later via records service).

**Migrations:** `LineupEntry.positional_role` + `Lineup.formation` + `format.players_per_side`/`scoring.serve` rule blocks (P2/P5). Everything else additive serializer work.

**Rollout:**
1. Hub shell (tabs Overview/Timeline/Lineups, SSE, share, back-nav, deep links; snapshot + tournament block + confirmed lineups + related_player; football flat lineup). *(v1)*
2. Tournament panel (hoisted fetch, Matches/Standings/Knockout tabs, FifaBracket public). *(v1)*
3. Stats + Standings-slice tabs. *(v1)*
4. TT + sepak MatchView modules (strips + diagrams; sepak court dots after positional_role migration; TT serve indicator via scoring.serve). *(v1, Aug-29)*
5. Football pitch (formation + positional slot migration, SVG pitch + event badges). *(P5)*
6. H2H endpoint + tab; OG/share-card PNG per match. *(P6 reach)*

**Key finding:** public lineup data is locked behind `IsAuthenticated` while the public snapshot returns an unroled roster — every per-sport lineup visual depends on folding confirmed lineups into the `AllowAny` snapshot first. The two unblocking migrations: `LineupEntry.positional_role` (sepak, pre-Aug-29) and `Lineup.formation` (football, later).

## 5. Per-sport leaderboards (owner addendum, 2026-07-04)

The Leaders surface (ops + public) must also verticalize: "top scorers / best defence / best attack" is football vocabulary that mis-ranks set sports today (confirmed finding N7: goal-only top_scorers renders empty for set sports; compute_leaders pools all sports into one table). Leaders become `definition.leaderboards` per sport — **individual AND team boards** — populated by a dedicated stat-catalog research pass (individual stats, scorers, winners, team boards for football/TT/sepak at federation + school tiers). The catalog feeds `SportDefinition.leaderboards` + `award_templates` and the badges engine.
