# Results: the medal tally, category champions and student contributions

Status: design of record, 2026-08-25. Owner ask of the same date, sourced from
the ANPSA Dimapur District Sports Meet 2025 medal-tally sheets (two Word
tables, senior + junior).

## The sheet we are replacing

The reference is a Word table the host retypes after every meet:

```
             ANPSA DIMAPUR DISTRICT SPORTS MEET 2025 (MEDAL TALLY SENIOR)
SL.NO. SCHOOL NAME          100m 400m 1500m L/J S/P 4X100M | ... girls ... | Gold Silver Bronze
  2.   Christian Hr. Sec.     1    3    1     1            |  3            |   3    -      2
  8.   Greenwood School            2    2     1   1        |  1  2  1 2 2 2|   4    6      -
```

Schools down, one column per event, the events banded by gender, and the cell
holds the **placing** (1, 2, 3) rather than a tick. The row ends in medal
counts. It is the same grid as the public Schools tab (`PublicEntriesPage`),
with a different thing in the cell, so it is built from the same parts.

Two things the sheet cannot do, and we do: it has no points column (ANPSA rank
by medal counts and argue about it), and it cannot say which *student* earned
what.

## What we build

A fourth public tab, **Results** (`/t/:slug/:id/results`), with three views over
one payload:

1. **Tally** - the grid above, cell = placing, row ends in Gold/Silver/Bronze
   and **Points**, ranked; a points bar chart across the top.
2. **Champions** - one podium per authored category group ("U-14 Boys"),
   1st/2nd/3rd school with crests and points.
3. **Students** - every student who won something: their events, their medals,
   the points their teams earned.

Plus a **Settings > Results** section where the host edits the points ladder and
authors the groups.

## Decisions

### D1. A placing is DERIVED from the fixture, with an override layer

Nothing new records who won. For each competition leaf:

- **Knockout** (all 8 table-tennis categories here, and the sepak takraw
  knockout stage): the last `(stage_no, round_no)` step holds the final and,
  when the draw was configured with `third_place`, the playoff beside it. The
  playoff is the match whose BOTH sides are `loser_of` pointers - the same test
  `scheduler._is_third_place` already uses, not the `· 3rd Place` group label,
  which is a display string. 1st = final winner, 2nd = final loser, 3rd =
  playoff winner, 4th = playoff loser.
- **No playoff**: `awards.bronze` decides - `shared` (both losing semi-finalists
  take 3rd, the racket-sport norm), or `none`. Default `shared`.
- **Round robin / groups with no knockout**: `compute_standings` order, which
  already reads the tournament's own `rules.points` and tiebreakers.

A host override (`awards.overrides`) replaces a derived placing for one
(leaf, place). It exists because a meet has events the fixture never saw (the
reference sheet is athletics: 100m, Long Jump, Shot Put have no matches at all)
and because a mis-scored final must be correctable on the day without amending
a match. An override records who set it and why.

**A competition still playing is PROVISIONAL**, and says so. Placings appear as
soon as the final is decided; the tally does not wait for the whole meet.

### D2. Points live OUTSIDE `rules`

`Tournament.rules` freezes at `registration_open` (invariant 7) and stays
frozen. A points ladder the host cannot change during the meet is the opposite
of the ask, so awards config is a new `Tournament.awards` JSONB with its own
unfrozen update path. It is not participant-facing in the invariant-7 sense: it
decides a trophy, not a result.

```jsonc
{
  "enabled": true,
  "ladder": [ {"place": 1, "points": 5, "label": "Gold"},
              {"place": 2, "points": 3, "label": "Silver"},
              {"place": 3, "points": 2, "label": "Bronze"} ],
  "by_competition": [ {"match": "sepak_takraw", "ladder": [...]} ],
  "bronze": "shared",
  "groups": [ {"key": "u14_boys", "label": "U-14 Boys",
               "include": ["table_tennis.u_14.boys", "sepak_takraw.u_14.boys"],
               "decide": "points"} ],
  "overrides": [ {"leaf_key": "...", "place": 1, "team_id": "...",
                  "label": "", "note": "", "by": "...", "at": "..."} ]
}
```

The ladder is a LIST, not a `{1:5,2:3,3:2}` map, so a meet that scores the top
six needs no schema change. `by_competition` entries are matched by
`sports.leaf_matches_prefix`, most specific wins - the same resolver courts,
`competition_priority` and `phased_finish` use, so a host can weight one sport
or one category without the engine learning what a sport is.

### D3. A group is an authored list of leaf prefixes

"Winner of U-14 table tennis" is not a thing the category tree knows; it is a
question the host asks of it. A group carries a label and `include` prefixes,
matched by the same `leaf_matches_prefix`. An empty `include` means every
competition, which is how "Overall Champion" is expressed without a special
case. `decide` is `points` (default) or `golds`.

Authored for both tournaments per the owner: **U-14 Boys, U-14 Girls, Open
Boys, Open Girls, Overall**. Each spans sports where the categories do (U-14
Boys covers both table tennis and sepak takraw), which is exactly the reference
sheet's own banding.

### D4. A student is credited the FULL team points

A doubles pair that wins gold shows 5 points against BOTH partners. The medal
is the team's and the school counts it once; the student view answers "what was
this child part of", not "how do we divide a medal". Splitting would make a
singles player look worth twice a doubles player. The view says so in as many
words rather than leaving the reader to reconcile two totals.

Students come from `Player` rows joined by `person_id` across the tournament,
so a child in three events is ONE row with three events - the participation
layer's whole point (`roster_first`, 2026-08-17). 147 students here, 18 of them
in more than one event.

### D5. It is one payload, three views

`GET /api/public/tournaments/{slug}/{id}/results/` returns competitions,
schools, groups and students together. The three views are filters over it, the
way the Schools tab's sport bookmarks are - there is no second fetch and the
views cannot disagree about who won.

## What this reuses

- `entriesMatrix.ts`'s column codes, sport bands and CSV shape: the Results grid
  IS the entries grid with a different cell, so the display model is shared
  rather than forked.
- `TeamCrest` for school logos, `compute_standings` for the round-robin path,
  `leaf_matches_prefix` for every prefix match, `iter_leaves` for the columns.
- The `PublicEntriesPage` findings of 2026-08-25 are fixed HERE rather than
  inherited: one scope per footer row, the CSV totals computed from the visible
  columns, a real heading that survives print, and a print path that uses
  `.print-doc`.
