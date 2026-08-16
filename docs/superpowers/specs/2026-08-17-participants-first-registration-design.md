# Participants-first registration — design

**Date:** 2026-08-17
**Status:** built (backend + frontend, tested)
**Owner ask:** *"before they enter the teams and details … enter all the participants
names from their school, all necessary details, docs — even the teacher in charge.
Then in the next stage the teams can be created and the user only has to select the
names from the dropdown, so we can see if one student is in multiple sports."*

---

## 1. The problem this removes

A player's identity used to be **inferred from a typed string**.
`register_school` reused a `Person` by `full_name__iexact` within the institution,
so "Imliyanger Jamir" typed two ways became two people. Everything downstream that
depends on knowing *who* a competitor is was therefore standing on a guess — most
importantly the scheduler's `linked` graph, which keeps two teams sharing a player
from being drawn at the same time. A typo silently switched that protection off for
that child.

The domain expert's actual rule ("TT and Sepak not simultaneous — **unless the
players differ**") cannot be answered at all without exact identity. Answering it
with a blanket "these two sports never overlap" would waste half the day's courts.

## 2. The shape

One new layer, opt-in per tournament.

```
Tournament.roster_mode
  inline        names typed on the team form          (the original flow, default)
  roster_first  participants declared once, then picked
```

`roster_first` inserts ONE stage into the funnel, at slot 2 — after the schools (or
the houses) register, before team registration:

```
setup → org_registration/house_setup → roster → team_registration → fixtures → ready
```

Derived in `state.py::_order_for`; nothing else in the system hardcodes the list.
`flow_order(t)` is the single source, so the stepper, the nav rail and the server's
guards cannot drift.

### Models (`apps/teams`)

- **`RosterMember`** — one person a school declared for one tournament, *before any
  team exists*. Per (tournament, institution), optionally scoped to a `TeamGroup`
  (a house). `Person` stays the thin cross-tournament identity (invariant 8);
  everything a school knows a child by — class, roll number, DOB, documents — is
  per-event and lives here. Free-form `attributes` catches anything else the event
  asks for, so extending the sheet never needs a migration.
- **`TeamStaff`** — a teacher in charge of a team. Many per team on purpose: a
  school that sends two teachers can legitimately run two courts at once, and a
  single FK would have quietly forbidden that.

### Services

- `services/roster.py` — `declare_member` (idempotent on roll number, else name,
  *within one school*), `update_member` (corrects in place, keeping the same
  `Person` and therefore every team and scheduling edge), `withdraw_member`
  (soft, refused while the person is fielded or in charge), `roster_for`,
  `member_options`.
- `register_school` now accepts `member_id` on a player and `staff` on a team. A
  pick IS the identity: no matching, no dedupe pass. A picked id that does not
  belong to the submitting school is **refused**, not silently dropped — falling
  back to the typed name would restore the guess this layer exists to remove.

### Forms

- **Participants sheet** (`FormPurpose.PARTICIPANT_REGISTRATION`, stage `roster`)
  — a competitor picker plus two repeatable groups (students, teachers). Ordinary
  schema data on the existing engine, so the admin can rewrite any question in the
  builder. Every generated question names the `RosterMember` column it fills
  (`bind`); anything the admin adds lands on `attributes`.
  Deliberately asks **nothing** about competitions — that is the team form's job,
  and asking here would make every school answer twice.
- **Team form**, when `roster_mode == roster_first`: the player row becomes a
  `roster_students` dropdown (+ an optional jersey number, which is genuinely
  per-team), and the free-text coach group is **replaced** by a `roster_teachers`
  picker. Asking for both would collect the same teacher twice under two
  identities.
- The mapper reads a picked member where it finds one and falls back to the typed
  name otherwise, so **both** shapes keep working — including every form generated
  before this existed.

### The PII boundary

A school's roll of children is never part of the public schema: schema resolution
happens before anyone proves who they are. The picker options ride back on
`POST /api/forms/{id}/team-access/` — the endpoint that already verifies the
school's mailed access code — and are scoped to that one institution (and, in a
within-school event, to that one house). The public form grafts them onto the
schema client-side.

The submit gate was widened from "team registration" to a `COMPETITOR_PURPOSES`
set, so the participants sheet is protected exactly as the team list is. Submission
+ mapping now run in ONE transaction: a submission the mapper cannot turn into
domain rows answers 400 and leaves nothing behind, instead of recording a response
the respondent believes succeeded.

### The rules it makes possible

Each is a **constraint record**, off by default, never implicit
(owner: *"no hard-coded rules — let the user decide"*):

| record | edge added to the `linked` graph |
|---|---|
| `no_person_overlap` | teams sharing a declared **player** |
| `no_staff_overlap` | teams sharing a **teacher in charge** |
| `no_institution_overlap` | teams from the **same school** (blunt; rarely wanted) |

`no_staff_overlap` is keyed on the teacher, not the school — which is exactly why a
school that sends two teachers keeps both its courts.

## 3. Surfaces

- **Participants page** (`/tournaments/:id/participants`) — the organizer's console.
  Its reason to exist is the one column a team list cannot have: **every
  competition each person ended up in**, plus a count of how many people are in more
  than one. That is the owner's question, answered as data.
  House-scoped for a house captain (`manageable_house_ids`), whole-event for a
  manager.
- **Create tournament** asks the question; **Settings** keeps it changeable until
  the first team is registered (409 `roster_mode_locked` after that — by then the
  team form's dropdowns are bound to the list and the declared people would be
  stranded).

## 4. What deliberately did NOT change

- A tournament that never turns the layer on behaves **exactly** as before: same
  funnel, same forms, same typed names, same dedupe.
- Nobody is removed from a roster by omission. A re-submitted sheet updates in
  place; withdrawing someone fielded on a team is refused outright, because a squad
  quietly one player short is worse than an error.
