# Fixture Setup UX Clarity Redesign

**Date:** 2026-06-12 · **Status:** Draft v1 (binding once executed)
**Scope:** FRONTEND ONLY. No API, model or backend change. The server readiness
contract (`fixture_readiness`: check ids, statuses, hints, `fix` keys,
`summary`) stays exactly as is; everything here is a presentation-layer
re-mapping of what the server already says.
**Owner feedback driving this:** "the current UI/UX is not good, it's hard to
understand." The organizer persona is a school-tournament admin in Nagaland,
often non-technical, often on a phone.

Builds on `2026-06-11-fixture-engine-redesign.md` (the engine + screens spec).
That spec's §6 screens are functionally complete; this spec changes how they
read, not what they can do. **Nothing is dropped** (see §8 capability map).

---

## 1. Audit findings (what makes it hard to understand)

Read against the live code in `frontend/src/features/fixtures/`:

1. **Engineer jargon as primary copy.**
   - `ReadinessChecklist.tsx` CHECK_LABELS: "Constraints reviewed",
     "Existing draw", "Seeds set", "Calendar set", "Format chosen",
     "Enough teams" - noun-phrase audit items, not sentences a person says.
   - Hub row badge renders the raw server `summary` ("3/5") with no unit a
     non-technical reader can parse (`FixtureSetupHub.tsx:671-678`).
   - "Inputs changed", "inputs hash", "dry-run", "Constraints", "Hard/Soft",
     "Weight (1-10)", "seed 1733...", "Demote to soft" all surface verbatim.
2. **No visible journey.** The hub subtitle says "Set the globals once, then
   every competition runs its own readiness → draw → schedule funnel" - a
   sentence about architecture, not a path. The organizer cannot answer
   "where am I, what's next?"
3. **Too many simultaneous affordances.** The hub header alone offers
   Schedule all / Shift a day / Share schedule / Print / View bracket; each
   expanded row adds Schedule, Re-preview, Keep, Advance, Console, a repair
   overflow, Preview & generate; below that a 3-tab bar. Five-plus primary
   colored buttons compete on one screen.
4. **Status as a checklist, not a verdict.** Five icon rows + a progress bar
   answer "is this competition ready?" - the user has to compute the answer
   themselves.
5. **Advanced concepts in the main path.** Constraint records (scope, hard,
   weight), fairness tables, change history, seed lists and draw seeds are
   visible at the same altitude as "pick your dates".
6. **Em-dashes and middot chains everywhere** ("Asked once, edited forever —
   calendar...", "0 · 2 · 1") - dense, telegraphic, hard for ESL readers.
7. **The per-leaf `ScheduleWizard` re-asks dates/venues/rest** that the
   global setup already stored (violates the asked-once tenet from the
   engine spec) - confusing duplicate questions.

## 2. Design principles (binding)

1. **A visible numbered journey.** Three steps, always on screen:
   Step 1 "When & where" · Step 2 "How each competition plays" ·
   Step 3 "Preview & publish". A persistent progress header says where you
   are and what's next.
2. **ONE primary action per view.** Exactly one `variant="default"` button
   visible at a time per surface; everything else is `outline`, `ghost`,
   a text link, or inside an overflow/Advanced area.
3. **Plain language for every label, status and error.** Exact strings are
   specified in §7. Full sentences, present tense, no noun-phrase audit
   items, no internal vocabulary (inputs, hash, dry-run, leaf, constraint,
   demote, seed-the-number vs seed-the-RNG ambiguity).
4. **Progressive disclosure.** Scheduling rules (constraints), fairness,
   change history, seed order, draw seed, schedule quality are "Advanced":
   discoverable in one tap, never in the main path.
5. **One sentence + one button per competition.** The 5-item checklist
   renders only inside an expanded "Why can't I continue?" detail, and only
   when something blocks.
6. **Celebrate states.** Empty, in-progress and done each get a distinct,
   friendly visual (icon + heading + one line + one action).
7. **Mobile-first stacking.** Every new layout is a single column by
   default; desktop is the enhancement (`useBreakpoint` for JS decisions,
   Tailwind `sm:`/`md:` otherwise).

House rules honored throughout: tokens only, `components/ui/Select`,
`dialog`/`useToast` (no native controls), every string through `t()`,
`font-tabular` for numbers, zero em-dashes in any user-visible string
(rewrite with periods or plain hyphens), no emojis (lucide icons - the
project's established icon family - carry the celebration visuals).

---

## 3. The journey model (new, client-side derivation)

New file `frontend/src/features/fixtures/setupJourney.ts` - pure functions,
unit-tested. The FE still never recomputes readiness; it only *maps* the
server's checks + match data into presentation state.

```ts
type JourneyStep = 1 | 2 | 3 | "done";

function journeyStep(readiness, competitions): JourneyStep
// 1   while global checks calendar_set or venues_defined are "fail"
// 2   while any competition with enough_teams ok has no matches yet
// 3   while at least one competition has matches and another is mid-path
//     (collapsed with 2 in the header: the header highlights 2 and 3
//      simultaneously per-competition; the tournament-level pointer is the
//      FIRST incomplete step)
// done when every competition that has enough teams has a draw

function competitionSentence(c: Competition, drawFormat: string): {
  sentence: string;        // §7.2 exact strings
  action?: { label: string; kind: "primary" | "secondary"; fix: FixKey };
  blocked: boolean;        // true => "See what's missing" detail available
}
```

### 3.1 `SetupJourneyHeader.tsx` (new component)

Rendered at the top of the hub (below the page title) and, in compact form,
at the top of `DryRunPreviewPage`.

- Three numbered circles + labels, reusing the `StepRail` visual language
  (numbered dot → check on completion) but with the journey's own copy:
  1. **When & where** · 2. **How each competition plays** · 3. **Preview & publish**
- Under the rail, one "next" line in `text-sm text-muted-foreground`:
  - Step 1: `Next: set your tournament dates and venues.`
  - Step 2: `Next: choose how each competition plays.`
  - Step 3: `Next: preview the schedule and publish it.`
  - done: `All set. Your schedule is published.`
- Steps already completed are tappable and deep-link back (step 1 opens the
  Step 1 wizard; step 2 scrolls to the competition list; step 3 opens the
  preview for the first previewable competition).
- Mobile: the three labels stack under the dots exactly as `StepRail`
  already degrades (`hidden sm:block` labels become a single current-step
  label: `Step 2 of 3: How each competition plays`).
- Tokens: current dot `bg-primary/15 text-primary ring-1 ring-primary/40`,
  done `bg-primary text-primary-foreground`, upcoming `bg-muted
  text-muted-foreground` (identical to `StepRail`).

---

## 4. Screen-by-screen changes

### 4.1 `FixtureSetupHub.tsx` - the hub

**Page header.**
- Title stays `Fixture setup`. Subtitle replaced (was the "globals →
  readiness → draw → schedule funnel" sentence):
  `Three steps: set dates and venues, choose each competition's format, then preview and publish the schedule.`
- `SetupJourneyHeader` directly below.

**Toolbar (ONE primary).** The current five-button row collapses:
- While journey < done: **no** toolbar buttons at all (the journey content
  carries the single primary action). "View bracket" moves into the drawn
  competition card (it only matters once a bracket exists).
- When journey = done: primary `Share schedule` (the celebrate state's
  action, §6); everything else - `Print`, `Shift a day`, `Re-run schedule`
  (old "Schedule all"), `View bracket` - lives in one `More` overflow menu
  (same pattern/markup as `MatchRepairMenu`: `aria-haspopup="menu"`,
  popover `bg-popover`). On mobile the overflow is the only toolbar item
  besides the primary.
- All five verbs keep their existing `data-testid`s and handlers; only
  their container changes.

**Stage gate (empty state)** - kept, recopy per §6.1. Its CTA opens the
Step 1 wizard (unchanged behavior).

**Global summary strip (`GlobalSetupCard.tsx`).**
- Reframed as the Step 1 receipt: leading label becomes
  `Step 1 · When & where` (replaces "Global setup"; `Settings2` icon →
  `CalendarRange`).
- Chip labels recopy (§7.4); the `0 · 2 · 1` middot triplet is split into
  three separate chips (`Days off 2`, `Spare days 1`, `Ceremonies 1`) -
  each still deep-links to its wizard step. Chips that are zero/unset are
  hidden instead of showing "Not set"/counts of 0 (less noise); the strip
  always shows Dates, Venues and Play times.
- Edit affordance unchanged (`Edit` outline button + per-chip click).

**Competition list = `CompetitionCard.tsx` (new; replaces row + accordion
expansion).** The four `GROUPS` sections survive with renamed titles (§7.1)
and the same collapse behavior ("Waiting for teams" starts collapsed). Each
competition renders as a card, not a table row:

- Line 1: competition name (`text-sm font-semibold`) + status chip
  (right-aligned, §7.1 labels). The raw `n/5` summary badge is **removed
  from the collapsed view** (it remains inside the blocked detail).
- Line 2: ONE human sentence (`text-sm text-muted-foreground`), from
  `competitionSentence` (§7.2).
- Line 3: ONE action button matching the sentence (primary only if this is
  the journey's current step for this card; otherwise outline). Optional
  quiet secondary as a text link.
- Blocked competitions add a `See what's missing` ghost toggle that expands
  the existing `ReadinessChecklist` (now recopied per §7.3, Fix buttons and
  deep-links intact). The checklist no longer renders by default for
  ready/drawn competitions.
- Quiet format note: when the server's `format_chosen` check is `warn` and
  the card is otherwise ready, line 2 gets a second, smaller line
  (`text-xs text-muted-foreground`):
  `You haven't picked a format. Round robin will be used.` with an inline
  `Choose format` text button (opens the Step 2 wizard). This is a note,
  not a blocker - the primary stays `Preview the draw`.
- Drawn cards keep, inside the card body (expand on tap, same accordion -
  one open at a time):
  - the recopied inputs-changed banner (§7.6) with Re-preview / Keep,
  - the "group stage finished" / "Swiss round finished" prompt + button
    (§7.2 D3/D4) - these ARE the card's single action when they apply,
  - `CompetitionResultCard` unchanged structurally (read-only rows, R{n},
    lock icon, Console link, `MatchRepairMenu`), plus a `View bracket`
    text link when knockout matches exist,
  - `Adjust this competition's schedule` text link → per-leaf re-run
    confirm (§4.6).

**Tabs → Advanced.** The `Constraints / Schedule changes / Standings` tab
bar is replaced by a single collapsed disclosure at the bottom of the hub:

```
Advanced tools                                          [chevron]
  · Scheduling rules        (ConstraintBuilder, §4.5)
  · Change history          (ScheduleChangesPanel, recopied §7.8)
  · Group tables            (StandingsTable grid, unchanged)
```

Closed by default; opens to the same three panels behind the same
`role="tablist"` (keep `hub-tab-*` testids). The `onFix("constraints")`
deep-link now opens the disclosure first, then scrolls (logic already does
the tab-switch + scroll; add the disclosure open).

### 4.2 Step 1 wizard - `GlobalSetupWizard.tsx`

Structure (4 steps, StepRail, three-channel save, amend-on-409) unchanged.
Copy and grouping change:

- Dialog title: `Step 1 · When & where`. Description:
  `Answer these once. Every competition's schedule is built from them, and you can come back and change them any time.`
- `setupSteps.ts` step labels: `Dates`, `Venues`, `Play times`,
  `Check & save` (keys unchanged so `SETUP_STEP` deep-links keep working).
- Field/label recopy per §7.5. "Blackout dates" → `Days off`; "Reserve
  days" → `Spare days (rain buffer)`; ceremonies unchanged.
- Defaults step: the three numeric fields (`Match length`, `Shortest break
  between a team's matches`, `Most matches a team plays in one day`) sit
  under a tiny heading `Pace`; the Sunday checkbox keeps its existing
  plain sentence.
- Review step `Row` dl: arrows `→` in values become the word `to`
  (`12 Jun to 18 Jun`); `0 / 2` splits into labeled rows.
- Footer primary: `Save` on the last step (was "Save global setup" +
  Sparkles; keep the icon). One primary per view holds: Next/Save is the
  only default-variant button.

### 4.3 Step 2 wizard - `CompetitionFormatWizard.tsx`

Structure (format radio cards, conditional knobs, persist-then-act)
unchanged. Three changes:

1. **Title/desc.** Title: `Step 2 · How {leafLabel} plays` (fallback
   `Step 2 · How this competition plays`). Description:
   `{n} teams are in. Pick how they play each other. Each competition can be different.`
   The globals strip stays (read-only Step 1 receipt) with copy
   `Dates and venues come from Step 1.` + `Edit` link.
2. **Progressive disclosure.** The main path is ONLY the six format cards
   (hints recopied, §7.5) plus the per-format essential knob
   (`Teams per group` + `How many advance` for groups formats; `Rounds`
   for Swiss). Everything else moves into an `Advanced options` disclosure
   (closed by default) inside the dialog: seeding method Select +
   `SeedListEditor`, two legs, third-place playoff, consolation plate,
   best next-placed qualifiers, bracket seeding. All knobs, testids and
   validation (`advanceInvalid` message) survive verbatim inside it.
   Exception: when the server readiness `seeds_set` check failed and the
   wizard was opened via its Fix action (`fix === "seeds"`), the wizard
   opens with Advanced options expanded and the seed list scrolled into
   view.
3. **One primary.** Footer becomes: `Cancel` (ghost) ·
   `Save for later` (ghost text button, was outline "Save format") ·
   primary `Preview the draw` (was "Preview & generate"). The non-preview
   fallback primary (`onPreview` absent) reads `Create the draw`.

### 4.4 Step 3 - `DryRunPreviewPage.tsx`

- Compact `SetupJourneyHeader` on top (step 3 active).
- Title: `Step 3 · Preview & publish` with the competition name beside it.
  Sub-line (kept, recopied): `This is a trial run. Nothing is saved until you publish.`
- **Verdict first.** `ViolationsPanel`'s summary strip becomes the page's
  lead sentence (§7.7): success
  `This schedule works. No rules are broken.` / failure
  `{n} problem(s) need fixing before you publish.` The
  `Schedule quality {pct}%` figure moves into the Advanced details row
  (below) - it is meaningless to the persona at this altitude.
- Violation cards keep their relaxation buttons but recopied (§7.7); the
  `{type} · {scope}` raw-token pill is removed from the card face (kept in
  a `title` tooltip for support/debugging).
- **Advanced details** disclosure (closed by default) between the verdict
  and the day grid, containing: `FairnessPanel` (unchanged inside),
  pairing warnings list (recopied §7.7), the draw-seed pill (moved out of
  the page header; label `Draw number {seed}`, tooltip
  `Saved when you publish, so this exact draw can be reproduced.`), and
  `Schedule quality {pct}%`. **Exception:** any fairness `flags` or hard
  violations force the disclosure open on load - problems are never
  hidden.
- Day grid (`MatchesByDayGrid`) unchanged - it is already the best part of
  the page (mobile stack included).
- Unscheduled section recopy (§7.7).
- **Sticky bar (ONE primary).** `Discard` (ghost, icon dropped - trash +
  "Discard" reads destructive for a no-op walk-away; recopy to
  `Back without saving`) · `Try another draw` (outline, was
  "Regenerate"/Dices - keep icon) · primary `Publish schedule` (was
  "Accept & save"). `Adjust constraints` leaves the bar and becomes a text
  link inside the failure verdict block: `Fix the rules in fixture setup`
  (same navigate target). When hard violations exist, `Publish schedule`
  is disabled with title text `Fix the problems above first.` (today it
  remains enabled - publishing a known-broken schedule should not be the
  easy path; force-style escape hatches stay in the repair dialogs).
- Stale (409) banner: recopy §7.6; `Re-preview` stays the banner's only
  primary and the sticky-bar primary disables while stale (existing
  behavior, kept).

### 4.5 `ConstraintBuilder.tsx` + `ConstraintRow.tsx` (Advanced home)

Moves under the hub's Advanced disclosure (§4.1). Internal recopy only:

- Header: `Scheduling rules` (was "Scheduling constraints"); sub
  `Rules the schedule must follow. "Must" rules block a time slot; "prefer" rules guide it.`
- `Mark reviewed` → `Mark rules as checked`; reviewed stamp:
  `Checked {date}`.
- Hard/Soft segmented toggle relabels to `Must` / `Prefer` (aria-label
  `How strictly this rule applies`); `Weight (1-10)` → `How strongly
  (1-10)`. Values persisted are untouched (`hard: boolean`, `weight`).
- Empty state: `No extra rules yet. Step 1 already added the common ones (days off, rest time, Sunday mornings). Add anything sharper here.`
- `Add constraint…` placeholder → `Add a rule…`; save button →
  `Save rules`.
- Provenance badge `From global setup` → `From Step 1`.
- `ConstraintRow` param labels stay (already plain); `Applies to` stays.

### 4.6 Re-run scheduling - `features/tournaments/ScheduleWizard.tsx`

Today this 4-step wizard re-asks dates, venues and rest. Frontend-only fix:

- Seed the form from `drawConfig["*"]?.calendar`, the stored venue pool and
  the stored `min_rest_minutes` / `max_matches_per_team_per_day` records on
  open (queries already exist elsewhere; add them here, `enabled: open`).
- Collapse to a single confirm screen: title `Re-run the schedule`
  (per-leaf: `Re-run the schedule · {leafLabel}`), description
  `Every unlocked match gets a fresh time and venue using your Step 1 answers. Locked matches stay where they are.`
  A read-only summary dl (dates, play times, venues count, rest, per-day
  cap) + an `Adjust before running` disclosure exposing the current
  editable fields (all of them - nothing dropped) for the rare override.
- Primary: `Re-run schedule`. Result screen unchanged (counts +
  explanation list), recopy `{n} matches scheduled`.
- Hub entry points rename: header "Schedule all" → `Re-run schedule`
  (inside More menu, §4.1); per-competition "Schedule" button →
  `Adjust this competition's schedule` text link (§4.1).

### 4.7 Dialogs (kept, copy polish only)

- **`AdvanceToKnockoutDialog`** - title `Build the knockout bracket`
  (per-leaf `Build the knockout bracket · {leafLabel}`); description
  `The top teams from each group go into the bracket. Group winners meet other groups' runners-up first.`; field `Teams advancing per group`,
  helper `Already set in Step 2. Change it here only if you mean to.`;
  primary `Build bracket`; error toast title
  `Could not build the bracket`.
- **`ShiftDayDialog`** - copy already strong; keep. Two tweaks:
  description's "movable" → `Move every match of a day onto another date. Matches keep their time and venue. Locked or finished matches stay.`;
  error strings per §7.9.
- **`MatchRepairControls`** - menu labels stay (`Move…`, `Delay…`,
  `Swap…`, `Lock slot`). Violation titles recopied per §7.9.
  `Force anyway` → `Move it anyway` (destructive variant kept);
  `ConflictsBlock` lead: `This change breaks the rules below. You can still force it, and the warnings are kept in the change history.`

---

## 5. Mobile rules (binding per surface)

- Hub: journey header stacks (single current-step label); competition cards
  are full-width; the action button is full-width (`w-full sm:w-auto`);
  the toolbar collapses to primary + `More`.
- Wizards already render in the `sheet` Dialog variant - keep; field grids
  `grid gap-3 sm:grid-cols-2` (already true) - no two-up on mobile.
- Preview: verdict, Advanced disclosure and day list stack; the sticky bar
  keeps max two visible buttons on mobile (`Try another draw` folds into a
  ghost icon-button with accessible label) - primary never shrinks.
- Tables (`FairnessPanel`, `StandingsTable`) stay inside `overflow-x-auto`
  (already true); no new tables are introduced in the main path.

## 6. Celebrate states (distinct visuals)

All built from tokens + lucide; no emojis, no illustrations to maintain.

1. **Empty (gate)** - `globalsUnset`: centered card (kept), `CalendarRange`
   icon in a `bg-primary/10 text-primary` circle, heading
   `Let's set up your fixtures`, body
   `Start with Step 1: pick your tournament dates and add your venues. Everything else builds on those.`,
   primary `Start Step 1`. Read-only visitors keep their explanatory line:
   `An organizer sets dates and venues before fixtures can be drawn.`
2. **In progress** - the journey header itself is the state visual: done
   dots filled, current ringed, the `Next:` line always states the single
   next action.
3. **Done** - when `journeyStep === "done"`: a slim banner above the
   competition list, `border-success/40 bg-success-muted`, `PartyPopper`
   icon (lucide) in `text-success`, heading `Your schedule is out`, body
   `Every competition is drawn and scheduled. Share it with schools, or print the order of play.`,
   primary `Share schedule` (toolbar primary doubles here), text links
   `Print` and `View bracket`. Dismissible per session (local state), like
   `keptDraws`.

## 7. Exact copy (the load-bearing section)

Every string below replaces its counterpart 1:1; all wrapped in `t()`.
No em-dashes anywhere; plain hyphens or periods only.

### 7.1 Hub chips + section titles

| Where (current) | New string |
|---|---|
| Section "Ready to draw" | `Ready to go` |
| Section "Needs setup" | `Needs your attention` |
| Section "Drawn" | `Scheduled` |
| Section "Needs teams" | `Waiting for teams` |
| Chip "Ready" | `Ready` |
| Chip "Needs setup" | `Action needed` |
| Chip "Needs teams" | `Waiting for teams` |
| Chip "Drawn" | `Scheduled` |
| Chip "Live" | `Live now` |
| Row meta "{n} teams · {m} matches" | unchanged (numbers are fine) |
| Badge "{n}/5" (collapsed row) | removed from collapsed view |

### 7.2 Competition sentence + action (priority order, first match wins)

Undrawn (no matches yet):

| # | Server condition | Sentence | Action |
|---|---|---|---|
| U1 | `enough_teams` fail | `Waiting for teams - {n} of 2 minimum.` | none primary; text link `See registered teams` (→ teams page, existing `fix:"teams"` route) |
| U2 | `seeds_set` fail | `{n} team(s) still need a seed number before this draw can run.` | `Set seed numbers` (opens Step 2 wizard with Advanced open, §4.3) |
| U3 | `calendar_set` / `venues_defined` fail at leaf level | (cannot occur past the gate; if it does) `Finish Step 1 first - dates or venues are missing.` | `Open Step 1` |
| U4 | ready | `Ready to preview. Nothing is saved until you publish.` | **`Preview the draw`** (primary) |
| U4-note | + `format_chosen` warn | quiet note under U4: `You haven't picked a format. Round robin will be used.` | inline text button `Choose format` |

Drawn (matches exist):

| # | Condition | Sentence | Action |
|---|---|---|---|
| D1 | any match live | `Matches are being played - {done} of {total} finished.` | text link `Open match console` (first live match) |
| D2 | `already_generated` warn (not kept) | banner §7.6 replaces the sentence | `Preview again` / `Keep` |
| D3 | `groupsDone` | `The group stage is finished. Build the knockout bracket from the standings.` | **`Build the bracket`** |
| D4 | swiss + `swissRoundDone` | `Round {r} is finished. Pair the next round from the standings.` | **`Pair the next round`** |
| D5 | otherwise | `Scheduled - {m} matches over {d} day(s).` (days derived from distinct `scheduled_at` dates; omit the clause when none scheduled: `Drawn - {m} matches, not yet scheduled.`) | text links `View matches` (expands card), `Adjust this competition's schedule` |

Blocked rows (U1-U3) show the `See what's missing` toggle → checklist.

### 7.3 Checklist labels (`ReadinessChecklist.tsx` CHECK_LABELS)

Server hints keep rendering after the label, unchanged.

| id | Current | New |
|---|---|---|
| `enough_teams` | Enough teams | `Teams registered` |
| `format_chosen` | Format chosen | `Format picked` |
| `seeds_set` | Seeds set | `Seed numbers` |
| `calendar_set` | Calendar set | `Tournament dates` |
| `venues_defined` | Venues defined | `Venues` |
| `constraints_reviewed` | Constraints reviewed | `Scheduling rules checked` |
| `already_generated` | Existing draw | `Current draw` |
| "{summary} ready" caption | `{ok} of {total} checks passed` |
| "Fix" button | `Fix this` |
| Hub hint "Resolve the failed checks above before generating." | `Fix the items marked above, then you can preview the draw.` |

### 7.4 Step 1 receipt chips (`GlobalSetupCard.tsx`)

| Current | New |
|---|---|
| "Global setup" | `Step 1 · When & where` |
| Dates value "a → b" | `{a} to {b}` |
| "Blackouts / reserves / ceremonies" "0 · 2 · 1" | three chips: `Days off {n}` / `Spare days {n}` / `Ceremonies {n}` (hidden when 0) |
| "Venues" "2 venues · 6 courts" | `Venues {n}` (+ ` · {u} courts` when u > n, kept) |
| "Daily window" "09:00–18:00 · 90 min slots" | `Play times {start} to {end}, {m} min per match` |
| "Rest & caps" "60 min rest · max 1/day" | `Breaks {m} min between matches, max {c} per day` |
| "Sunday mornings" "Blocked until 13:00"/"Open" | `Sunday mornings free until 13:00` / chip hidden when open |
| Button "Set up" / "Edit" | `Start Step 1` / `Edit` |

### 7.5 Wizard copy

Step 1 (`GlobalSetupWizard`):

| Current | New |
|---|---|
| Title "Global setup" | `Step 1 · When & where` |
| Desc "Asked once, edited forever — calendar, venues and defaults..." | `Answer these once. Every competition's schedule is built from them, and you can come back and change them any time.` |
| Steps Calendar/Venues/Defaults/Review | `Dates` / `Venues` / `Play times` / `Check & save` |
| "Blackout dates" + hint | `Days off` + `No matches on these days (exams, holidays).` |
| "Reserve days" + hint | `Spare days` + `Kept free as a buffer. If rain washes out a day, matches move here.` |
| Venues intro "Your venue pool — shared..." | `Your venues, shared by every competition. A hall with 4 courts runs 4 matches at the same time.` |
| "Earliest kickoff" / "Latest kickoff" | `First match of the day starts at` / `Last match must start by` |
| "Match length (minutes, incl. turnaround)" | `Minutes per match (including changeover)` |
| "Minimum rest between a team's matches (minutes)" | `Shortest break between a team's matches (minutes)` |
| "Max matches per team per day" | `Most matches a team plays in one day` |
| Sunday checkbox | unchanged (already plain) |
| "Save global setup" / toast "Global setup saved" | `Save` / `Step 1 saved` |
| Error toast "Could not save the global setup" | `Could not save. Try again.` (server detail kept as description) |

Step 2 (`CompetitionFormatWizard`) - format card hints:

| Format | New hint |
|---|---|
| League | `Everyone plays everyone once. The table decides the winner.` |
| Groups | `Teams split into groups and play within them. Each group gets its own table.` |
| Knockout | `Lose and you're out. Byes are added automatically if needed.` |
| Groups → Knockout | `Groups first, then the top teams from each group go into a knockout bracket.` |
| Swiss | `A set number of rounds. Each round pairs teams with similar results, never repeating a match.` |
| Double elimination | `Lose once and you drop to a second bracket. Lose twice and you're out.` |

| Other | New |
|---|---|
| "Advance per group" | `How many advance per group` |
| "→ {n} groups" helper | `That makes {n} group(s).` |
| "stored — 'Advance to knockout' prefills this, it never re-asks" | dropped (internal reassurance, says nothing to the persona) |
| "Advance per group must be smaller than the group size." | `Fewer teams must advance than the group holds. Lower this number or make groups bigger.` |
| Swiss helper "Suggested: {k} for {n} teams. Round 1 is drawn now; later rounds pair from the standings as results land." | `Suggested: {k} rounds for {n} teams. Round 1 is drawn now. You pair each next round after results come in.` |
| "Two legs — every pairing plays home & away (double round-robin)" | `Play each pairing twice (home and away)` |
| "Third-place playoff (semifinal losers)" | `Third-place match between the semifinal losers` |
| "Consolation plate — first-round losers play their own bracket" | `Plate bracket so first-round losers keep playing` |
| "Seeding method" options | `In registration order` / `Random draw` / `Spread the top seeds apart` / `Strict seed order (1 plays lowest)` |
| "Bracket seeding" options | `Winners meet other groups' runners-up` / `Best record plays worst record` |
| Seed list heading | `Seed order. 1 is your strongest team. Move rows with the arrows.` |
| Footer "Save format" / "Preview & generate" / "Save & generate draw" | `Save for later` / `Preview the draw` / `Create the draw` |
| Toast "Format saved" + "No draw generated yet — run it whenever you're ready." | `Format saved` + `No draw made yet. Come back and preview whenever you're ready.` |
| Toast "Draw generated — {n} matches" | `Draw created - {n} matches` |
| Groups-knockout follow-up toast | `Group stage created. When the groups finish, come back and tap "Build the bracket".` |
| Swiss follow-up toast | `Round 1 drawn. When every match finishes, tap "Pair the next round".` |

### 7.6 Inputs-changed banner (`InputsChangedBanner.tsx`)

| Context | New string |
|---|---|
| draw | `Things changed since this draw was made (a team or a setting). The current schedule is still valid. Preview again to see a fresh draw, or keep what you have.` |
| accept | `Something changed while you were looking (a team or a setting). Nothing was saved. Run the preview again to continue.` |
| Buttons "Re-preview" / "Keep" | `Preview again` / `Keep this draw` |

### 7.7 Preview page (`DryRunPreviewPage`, `ViolationsPanel`, `FairnessPanel`)

| Current | New |
|---|---|
| Title "Dry-run preview" | `Step 3 · Preview & publish` |
| "Nothing is saved until you accept — regenerate or adjust constraints freely." | `This is a trial run. Nothing is saved until you publish.` |
| "No hard violations" | `This schedule works. No rules are broken.` |
| "{n} hard constraint violation(s)" | `{n} problem(s) need fixing before you publish.` |
| "Schedule quality {pct}%" | `Schedule quality {pct}%` (moved into Advanced details) |
| Violation `pinned_round_unplaced` | `A round that is pinned to a date does not fit its day.` |
| Violation `session_window_starved` | `A "must" time rule leaves these matches no room.` |
| Violation `matches_unplaced` | `Some matches could not be given a time and venue.` |
| Relaxation "Make it a preference (soft)" | `Make this rule a preference instead` |
| Relaxations "Add a day" / "Add a venue" / "Raise the per-day cap" | `Add another day` / `Add another venue` / `Allow more matches per team per day` |
| "Try:" | `What you can do:` |
| Toast "Constraint demoted to soft" | `Done. That rule is now a preference, and the preview re-ran.` |
| Warning `keep_apart_relaxed` | `We could not fully keep those teams apart, so the rule was relaxed for this draw.` |
| Warning `keep_apart_missing_district` | `Some teams have no district saved, so the keep-apart rule skipped them.` |
| Warning `keep_apart_missing_seed` | `Some teams have no seed number, so the keep-apart rule skipped them.` |
| "{n} match(es) without a slot" | `{n} match(es) have no time yet` + sub `Add another day or venue in Step 1, then preview again.` |
| Fairness header + sub | `Fairness check` + `How evenly teams get rest, early starts and venues in this trial schedule.` |
| Flag `early_outlier` | `starts the day far more often than most teams` |
| Flag `rest_below_min` | `gets less rest than your minimum` |
| "Calendar not set" card | `Step 1 is not finished` + `The preview needs your tournament dates. Set them in Step 1 first.` + button `Open Step 1` |
| "The preview could not run." | `The preview could not run.` (kept) + `Try again` |
| Sticky bar "Discard" / "Adjust constraints" / "Regenerate" / "Accept & save" | `Back without saving` / (moved, §4.4) / `Try another draw` / `Publish schedule` |
| Toast "Draw accepted — {n} matches scheduled" | `Published. {n} matches are on the schedule.` (+ unscheduled description: `{u} matches still need a time. See fixture setup.`) |
| Seed pill "seed {n}" | `Draw number {n}` (Advanced details) |

### 7.8 Advanced area + history

| Current | New |
|---|---|
| Tab "Constraints" | `Scheduling rules` |
| Tab "Schedule changes" | `Change history` |
| Tab "Standings" | `Group tables` |
| History sub "every slot move, audited" | `Every time and venue change, with who did it and why.` |
| Empty history | `No changes yet. Any match you move or delay will show up here.` |
| Kind chips (Moved/Delayed/Swapped/Day shifted/Re-scheduled/Locked/Unlocked) | unchanged (already plain) |

### 7.9 Repairs + Swiss + shift-day errors

| Code (current string) | New |
|---|---|
| `venue_double_booked` "Venue double-booked" | `Two matches would share this venue at the same time` |
| `insufficient_rest` | `A team would get too short a break between matches` |
| `exceeds_max_per_day` | `A team would play more matches in one day than you allow` |
| `team_blackout` | `A team is not available on that date` |
| `shared_player_conflict` | `Two linked teams (shared player) would play at the same time` |
| `round_incomplete` | `This round still has unfinished matches. Finish or walk over every match first.` |
| `swiss_not_started` | `There is no Swiss round yet. Create the draw first.` |
| `swiss_complete` | `All planned rounds have been played.` |
| `reserve_day_unavailable` | `No spare day is free after that date. Pick the new date yourself.` |
| `no_matches_to_move` | `There is nothing to move on that day.` |
| `invalid_to_date` | `Pick a different date to move to.` |
| Toast "Round {r} generated — {n} matches" | `Round {r} paired - {n} matches` |
| "Force anyway" | `Move it anyway` |

### 7.10 Share / print / misc

| Current | New |
|---|---|
| Toast "Public schedule link copied" + "Anyone can open it — no login needed." | `Schedule link copied` + `Anyone with the link can see the schedule. No login needed.` |
| Print title tooltip | `Opens the public schedule. Print from there.` |
| Hub empty (no competitions) hint | `Add sports and categories in Settings. Teams then register into them, and each one gets its own draw here.` |
| Result card "{p}/{t} played · read-only — scores are entered in the match console" | `{p} of {t} played. Scores are entered in the match console.` |
| Lock tooltip | `This match is pinned. Re-runs and delays will not move it.` |

## 8. Capability map (NOTHING dropped)

| Existing capability | New home |
|---|---|
| Stage gate before dates/venues | §6.1 empty state (kept) |
| Global setup wizard (4 steps, 3-channel save, amend-on-409) | Step 1 wizard, recopied (§4.2) |
| Global summary chips + per-chip deep-link edit | Step 1 receipt strip (§4.1/§7.4) |
| Readiness checklist + Fix deep-links (`settings/venues/constraints/teams/format/seeds/diff`) | `See what's missing` detail on blocked cards; same `onFix` routing (§4.1) |
| `n/5` summary + progress bar | inside the blocked detail only (§7.3 caption) |
| Format wizard: 6 formats, group knobs, best thirds, bracket seeding, legs, 3rd place, plate, swiss rounds, seeding methods, SeedListEditor | Step 2 wizard; secondary knobs under `Advanced options` (§4.3) |
| Save format without generating | `Save for later` (§4.3) |
| Direct generate (no preview path) | `Create the draw` fallback (§4.3) |
| Dry-run preview, regenerate (re-roll), seed pill, accept w/ `expected_inputs_hash` | Step 3 page; seed pill in Advanced details (§4.4) |
| Violations + relaxations (demote / add day / add venue / raise cap) | verdict block, recopied; demote one-click kept (§4.4) |
| Fairness table + flags | Advanced details disclosure, auto-open when flagged (§4.4) |
| Pairing warnings (keep_apart_*) | Advanced details, recopied (§7.7) |
| Days × venues grid + mobile stack | unchanged (§4.4) |
| Unscheduled list | kept, recopied (§7.7) |
| Inputs-changed banner (draw + accept contexts, Keep dismissal) | kept, recopied (§7.6) |
| Advance to knockout (prefilled advance-per-group) | D3 card action + dialog recopy (§4.7) |
| Swiss next round + stable error codes | D4 card action + §7.9 |
| Constraint builder (catalog rows, scopes, hard/soft, weight, params, weekday chips, date chips, team select, provenance badge, Mark reviewed) | Advanced → `Scheduling rules` (§4.5) |
| Schedule changes feed (filter, load-more, actor, reason) | Advanced → `Change history` (§7.8) |
| Standings tables | Advanced → `Group tables` |
| Schedule all / per-leaf schedule | `Re-run schedule` confirm w/ stored-globals prefill + `Adjust before running` (§4.6) |
| Shift a day (rain), force path | More menu + dialog (§4.7) |
| Per-match Move/Delay/Swap/Lock + force + cascade | unchanged menu, recopied violations (§4.7) |
| Share public link / Print / View bracket | done-state primary + More menu + drawn-card link (§4.1, §6.3) |
| Match console links, lock badges, R{n} labels | `CompetitionResultCard` unchanged |
| RBAC gating (`canManage`, `canRepair`) | unchanged on every surface |

## 9. Implementation notes

- **New files:** `setupJourney.ts`, `SetupJourneyHeader.tsx`,
  `CompetitionCard.tsx`, plus `__tests__` for each (sentence table U1-D5
  fully parameterized).
- **Changed files:** `FixtureSetupHub.tsx` (compose new pieces; remove
  row/accordion markup), `GlobalSetupCard.tsx`, `GlobalSetupWizard.tsx`,
  `CompetitionFormatWizard.tsx` (Advanced disclosure), `ReadinessChecklist.tsx`
  (labels + caption), `InputsChangedBanner.tsx`, `DryRunPreviewPage.tsx`,
  `ViolationsPanel.tsx`, `FairnessPanel.tsx`, `ConstraintBuilder.tsx`,
  `ConstraintRow.tsx` (Must/Prefer), `ScheduleChangesPanel.tsx`,
  `ShiftDayDialog.tsx`, `AdvanceToKnockoutDialog.tsx`,
  `MatchRepairControls.tsx`, `features/tournaments/ScheduleWizard.tsx`,
  `setupSteps.ts` (labels only - keys/indices frozen).
- **Testids are API:** keep every existing `data-testid` (tests +
  potential analytics); new components add their own
  (`journey-step-{n}`, `competition-card-{key}`, `card-action-{key}`,
  `whats-missing-{key}`, `advanced-tools`, `advanced-options`).
- **Tests:** update the 17 existing suites for copy + structure; add
  `setupJourney.test.ts`. Full `npm --prefix frontend run test` +
  `type-check` green before each commit; commit per increment.
- **i18n:** every new string through `t()`; no `·` chains in new copy
  (max one per line where kept); zero em-dashes.
- **No backend edits.** Where current FE copy quotes server `hint` text
  (e.g. "No format chosen — the default (round robin) will be used."),
  the FE now renders its own §7 string keyed off the check id/status and
  shows the server hint only inside the checklist detail (existing
  behavior - hints already render as secondary text there).

## 10. Build order (each independently shippable, tests green per step)

1. `setupJourney.ts` + tests (pure logic, zero UI risk).
2. Copy-only pass: §7 strings into the existing components (biggest
   clarity win, smallest diff).
3. `SetupJourneyHeader` + hub header/toolbar consolidation (§4.1) +
   celebrate states (§6).
4. `CompetitionCard` (sentence + one action + blocked detail) replacing
   the row/accordion.
5. Tabs → Advanced disclosure; preview-page Advanced details + verdict +
   sticky-bar changes.
6. Step 2 wizard Advanced-options disclosure; Step 1/2 retitling.
7. `ScheduleWizard` → prefill-from-globals re-run confirm (§4.6).
