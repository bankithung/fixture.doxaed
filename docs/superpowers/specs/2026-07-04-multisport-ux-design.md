# Multisport Ux Design

**Date:** 2026-07-04 · **Provenance:** Opus 4.8 design agent (gate-passed; grounded in the fact-checked sport dossiers + code map with file:line anchors). Build blueprint for the sport-first master plan.

## The scoping model: two tiers plus a facet

One tournament is "one Games, N autonomous sport competitions" (ODF/Asian-Games model). Every surface falls into one of three buckets:

- TOURNAMENT-SCOPED (combined, never splits): the Today day-timeline/venue-lane spine, the flat Matches board, public schedule, the schedule-changes feed, Members/Settings, the switcher itself. This is ODF's shared DT_SCHEDULE layer and the owner's explicit "combined schedule is fine."
- SPORT-SCOPED (splits per sport): Standings, Leaders, Crew/officials, per-sport dashboard summary, fixtures generation/preview per competition, and the public standings/bracket/leaders. This mirrors "one Competition Manager per sport" (KIYG: 20 sports, 20 managers).
- FACETED (combined default, per-sport breakdown available): the Today header band metrics and the Matches board — combined by default, filterable by the active sport.

## Navigation model: a sport switcher facet, not new routes

Do NOT add a `/:sport` path segment — it breaks every current bookmark and forces redirects (rollout constraint). Instead sport is an OPTIONAL query facet `?sport=<key>` on the existing flat ops routes (`/tournaments/:id/{control,matches,standings,crew,leaders}`, routes.ts:80-95, App.tsx:198-203), driven by a persistent Sport switcher. This is exactly the pattern OpsStandingsPage already prototypes as local state (OpsStandingsPage.tsx:133-171: `sport` state + picker deriving sport from `leafSegments(key)[0]`); we lift that state to the URL param and a small Zustand store so it persists as the user moves Standings→Leaders→Crew.

The single "Operations" nav group (computeNavItems.ts:187-284) stays UNCHANGED — the sidebar is tournament-level; sport scopes *content*, not chrome. The switcher renders in a new `<OpsScopeBar>` sub-header wrapper shared by the sport-scoped ops pages: a segmented control `[All · Sepak Takraw · Table Tennis]` with sport icons (Sport.icon, sports/models.py). Each ops page reads `useOpsSport()` (search param first, store fallback, first-sport default).

SINGLE-SPORT COLLAPSE: when `sports.length <= 1` the switcher renders `null` and `?sport` is implicit — every surface shows that sport's native columns with zero switcher chrome. A football-only tournament is byte-for-byte what ships today; football feels football-native for free, no regression.

## The sport descriptor (the shared contract)

The frontend cannot render sport-native columns without a descriptor. Promote SPORT_PROFILES (set_scoring.py:33; resolved via rules_for_match, set_scoring.py:121) into a `sport_descriptor(sport_key, tournament)` resolver and ship it to the client. Shape:

```
SportDescriptor {
  key: string            // "sepak_takraw"
  name: string           // "Sepak Takraw"
  icon: string           // Lucide name / emoji (sports/models.py)
  scoring_family: "target" | "timed" | "innings"
  standings_columns: Col[]   // sets sports: SW/SL, PF/PA, ratio, Pts
                             // football: P/W/D/L/GF/GA/GD/Pts
  leaders_schema: StatDef[]  // football: top_scorer; net: most_points, best_serve_win_pct, sets_won
  officials_roles: string[]  // football: referee, assistant, fourth
                             // net: umpire, service_judge
  has_draw: boolean          // net sports false → hide draw points
  period_labels: string[]    // "Set 1", "Set 2"… vs "1st half"
}
```

Delivery: a new `GET /api/tournaments/{id}/sports-meta/` returning `{sports: [{key,name,icon,leaf_count}], descriptors: {key: SportDescriptor}}`, built from `iter_leaves` (sports.py:312, which already yields `{sport_key, sport_name, leaf_key, path, label}`). Also embed the descriptor for a match's sport in the live snapshot so consoles stay data-driven. The frontend keys a component registry off `descriptor.scoring_family` → `{StandingsTable, LeadersBoard}`, with a generic descriptor-driven fallback (ODF's "generic envelope + per-sport dictionary" — never a per-sport schema fork).

## Backend changes (additive, no migration — sport is already on Match)

ControlRoomDayView (fixtures/views.py:690-820): in `row()` (fixtures/views.py:768) add `data["sport"] = sport_for_leaf(t.sports, m.leaf_key)` (sports.py:340) and `data["sport_name"]`. Add a top-level `"sports": [...]` array and per-sport counts to the day metrics (fixtures/views.py:747-757). Accept an optional `?sport=` filter that scopes `day_rows`/`queue` while leaving the venue-lane grouping intact (the combined spine stays; the filter is a facet). MatchSerializer (serializers.py:25-31) already exposes `sport`, `set_scores`, `leaf_key`, `scoring`; add `sport_name` only. Standings/leaders endpoints gain optional `?sport=` filters; compute reads the descriptor's `has_draw`/`standings_columns` so net-sport standings stop emitting football GF/GA/GD.

`useControlRoom(id, day)` (useControlRoom.ts:31-48) gains a `sport` arg threaded into the query key `[...qk.controlRoom(id), day, sport]` and the fetch — a one-line change, no structural churn.

## Screen-by-screen

TODAY / control room: unchanged combined day timeline + venue lanes (the schedule spine). The OpsScopeBar switcher sits above it. Header band (ControlRoomPage) gains a per-sport breakdown chip row: "On now 12 · Court 1 TT 6 · Court 2 Takraw 6". CompetitionProgressPanel already groups by sport (TodayWidgets.tsx:147-160) — it becomes the per-sport progress readout, unchanged. Selecting a sport filters lanes to that sport's matches but keeps the venue structure.

MATCHES board: combined bulk find-and-act; the switcher acts as a filter. Score column already renders per-sport via liveSetView/isSetSport — reused as-is.

STANDINGS: fully sport-scoped. Switcher picks sport; the existing leaf/competition picker (OpsStandingsPage.tsx:133) narrows to a competition within it. Table columns come from `descriptor.standings_columns` — a registry component per scoring_family. This is the highest-effort gap (football GF/GA/GD is meaningless for takraw).

LEADERS: sport-scoped; NEVER mix sports into one attack/defence table (today LeadersPage sorts all sports by goal diff). Renders `descriptor.leaders_schema`: football top scorers / attack-defence; net sports most-points / best-serve-win% / sets-won. Empty state when a sport has no per-player stat family yet.

CREW / officials: sport-scoped; role vocabulary from `descriptor.officials_roles` (referee/AR vs umpire/service-judge). Assignments filter to the active sport.

FIXTURES hub: already leaf-scoped (competition = sport+category). Group the hub by sport under the switcher; per-competition generate/preview stays; the combined preview-all (routes.tournamentFixturesPreviewAll) stays for cross-sport publish.

PUBLIC pages: schedule stays combined and already ships a sport-grouped competition map with a sport sidebar (PublicSchedulePage.tsx:42 `sportOf`, :564-672). Public standings/bracket/leaders adopt the same `?sport=` facet; PublicViewerTabs grows a sport sub-nav only when `>1` sport. FotMob feel preserved: sport tabs, chip labels, no dashed strings.

## How Dimapur reads (sepak + TT, 2 venues, 122 matches)

Ops lands on Today: one combined day board, two venue lanes (Court 1, Court 2), a header band that breaks the live count down per sport, and a switcher `[All · Sepak Takraw · Table Tennis]`. The TT coordinator taps "Table Tennis" once; Standings, Leaders, and Crew all scope to TT with TT-native columns (sets W/L, points for/against, best server) and umpire roles — it reads as a TT workspace. The sepak coordinator does the identical thing for their sport. The combined Matches board and the public schedule stay whole-tournament so a spectator sees all 122 matches in one timeline. This is precisely the "combined services + autonomous per-sport competitions" federation model.

## Rollout (non-breaking, incremental)

- Phase 0 (backend, no migration): add `sport`/`sport_name` to control-room + match rows via `sport_for_leaf`; add `sports[]` + per-sport counts; ship `/sports-meta/` with descriptors; accept optional `?sport=` filters. All additive; absent facet = today's combined behavior.
- Phase 1 (nav): add the OpsScopeBar switcher reading `?sport=` + a persistent store; collapse when `<=1` sport; promote OpsStandingsPage's local sport state to the shared param. Current URLs unchanged.
- Phase 2 (columns): descriptor-driven Standings + Leaders registries per scoring_family (the real per-sport work).
- Phase 3: per-sport Crew role vocabulary; public sport sub-nav.

At every phase current URLs resolve and the facet is optional, so a half-migrated deploy is safe.

## Key decisions

- Sport is an OPTIONAL query facet (?sport=<key>) on existing flat ops routes, NOT a new /:sport path segment — keeps every current bookmark working (rollout constraint) and lifts OpsStandingsPage's existing local-state prototype (OpsStandingsPage.tsx:133-171) to the URL
- Three scoping tiers: tournament-scoped/combined (Today spine, Matches board, public schedule), sport-scoped/split (Standings, Leaders, Crew, per-sport dashboards, fixtures gen), and faceted (Today header metrics, Matches — combined default with a per-sport breakdown)
- A persistent Sport switcher lives in a shared <OpsScopeBar> content sub-header, NOT the sidebar — the single 'Operations' nav group (computeNavItems.ts:187-284) stays unchanged because sport scopes content, not chrome
- Single-sport tournaments collapse the switcher to null and imply ?sport — a football-only tournament is byte-identical to today, so football stays football-native with zero regression
- Introduce a SportDescriptor (scoring_family, standings_columns, leaders_schema, officials_roles, has_draw, period_labels) resolved from SPORT_PROFILES (set_scoring.py:33) and shipped via a new GET /api/tournaments/{id}/sports-meta/ built on iter_leaves (sports.py:312)
- Frontend keys a component registry off descriptor.scoring_family (target/timed/innings) with a generic descriptor-driven fallback — ODF 'generic envelope + per-sport dictionary', never a per-sport schema fork
- Backend changes are additive with no migration: sport already lives on Match; add sport/sport_name to control-room rows via sport_for_leaf (sports.py:340) and a sports[] array + per-sport counts to ControlRoomDayView (fixtures/views.py:768,802)
- useControlRoom(id, day) gains a sport arg threaded into the query key and fetch (useControlRoom.ts:41-48) — a one-line change, no structural churn
- Standings/Leaders read descriptor.has_draw and column/stat schemas so net sports stop emitting football GF/GA/GD and stop mixing all sports into one attack/defence table
- Public schedule stays combined (already has a sport-grouped competition map, PublicSchedulePage.tsx:564-672); public standings/bracket/leaders adopt the same ?sport= facet with a sport sub-nav shown only when >1 sport
- Dimapur: combined Today board + venue lanes + per-sport header breakdown; each coordinator taps their sport once and Standings/Leaders/Crew become a native single-sport workspace, while Matches board + public schedule stay whole-tournament
- Four-phase rollout (backend-additive → switcher → descriptor-driven columns → per-sport crew/public) where every phase leaves current URLs resolving and the facet optional, so a half-migrated deploy is safe

## Risks

- Descriptor-driven Standings/Leaders columns are the highest-effort gap: football GF/GA/GD/W-D-L is hardcoded (OpsStandingsPage GroupCard) and leaders derive only from GOAL events (leaders.py:35-56), so net sports render empty/nonsensical until the registry lands — Phase 2 is the real cost
- Only 5 sports have profiles (set_scoring.py:33); any unlisted sport falls through to goal-based football, so /sports-meta/ must return a safe generic descriptor rather than leaking football columns for an unmodelled sport
- The ?sport= facet default must be deterministic: 'All'/combined for Today+Matches vs first-sport for Standings/Leaders/Crew — an inconsistent default makes deep links ambiguous; the store+param precedence must be specified per surface
- Sport is derived from leaf_key prefix (sport_for_leaf) and client code today string-splits leaf labels (leafSegments[0], TodayWidgets.tsx:154) — these two derivations must converge on sport_for_leaf or a mislabelled leaf mis-buckets matches
- Crew role vocabulary is a fixed map today (referee/umpire/commissioner); making it descriptor-driven risks orphaning existing assignments if a sport's role set changes — needs a migration-free fallback to the current union of roles
- Public SSE tick invalidates tournament-wide queries; a ?sport= facet must not fragment the query cache into per-sport keys that each re-open a stream (SSE connection-exhaustion history) — filter client-side off one tournament-wide fetch where possible
- 'Feels like a per-sport workspace' is a UX claim a query facet may under-deliver versus a path-based workspace; if owner testing says it reads as a filter not a workspace, the OpsScopeBar branding (sport name + icon as a page title, not a chip) must carry the workspace feel
