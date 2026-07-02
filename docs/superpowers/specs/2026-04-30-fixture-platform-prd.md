# Fixture Platform — Product Requirements Document (PRD)

> **Status:** Draft v5 — all logic-flow gaps folded in; v4 (2026-06-12) adds the `abandoned → scheduled` replay transition (§5.5, decision 71); v5 (2026-06-12) adds the `called_at` operational annotation note (§5.5, decision 72)
> **Date:** 2026-04-30
> **Owner:** graceschooledu@gmail.com (Super-admin)
> **Working directory:** `C:\Users\Asus\Desktop\fixture.doxaed.com`

---

## 1. Vision

A web-based, multi-tenant **sports fixture & tournament management platform** focused initially on sports popular in **Nagaland**. It lets organizing bodies (schools, colleges, district associations) create tournaments, register teams and players, auto-generate fixtures, run matches with live scoring, and broadcast live updates to a public audience — while preserving an immutable audit trail for dispute resolution.

The platform is multi-tenant from day one (one Super-admin curates many Organizations) but ships **v1 as a single-sport vertical slice (Football)** to prove the chassis end-to-end before expanding to other sports.

---

## 2. Identity, signup, and the Admin lifecycle

### 2.1 Tier hierarchy

| Tier | Who | How they appear | Scope |
|------|-----|-----------------|-------|
| **Super-admin** | You (the platform operator) | `manage.py createsuperuser` on the server | Platform-wide |
| **Admin (Organizer)** | Owner of an Organization | (a) Super-admin invite, OR (b) self-signup + Super-admin approval (feature flag, default ON for v1 with manual approval) | One Organization |
| **All other roles** | Co-organizer, Game coordinator, Match scorer, Referee, Team manager, Player, Media | Invited by Admin / Co-organizer (or by Game coordinator within their sport) | Per-Org, per-Tournament, or per-Match |
| **Viewer (public)** | Anyone on the internet | No login | Public read |

### 2.2 Admin signup flows

#### Flow A — Super-admin invite (canonical)

1. Super-admin opens **Super-admin → Organizations → Invite Admin**.
2. Enters: invitee email + claimed Organization name + (optional) note.
3. System sends invite email with single-use, **7-day-expiry** token (stored as `AdminInvitation` row).
4. Invitee clicks link → fills password (subject to password policy) + name + (optionally) edits Org name + Org slug + Org timezone.
5. Submit → User created, Organization created, OrganizationMembership(user, org, role=admin, status=active) created. Super-admin and invitee both receive confirmations.
6. Invite expiry → token invalid; Super-admin can revoke or re-send before expiry; pending invites visible in Super-admin console.

#### Flow B — Self-signup (feature flag; v1 default = ON, requires Super-admin approval)

1. Visitor at `/signup` enters: email, password, name, claimed Organization name, optional message.
2. Account created with `User.is_active = false`, Organization created with `Organization.status = pending_approval`, OrganizationMembership(role=admin, status=pending).
3. Email verification sent. After verification, status remains `pending_approval`; user sees "Awaiting approval" page on login attempts.
4. **Super-admin approval inbox** lists: email, claimed Org name, IP, timestamp, optional message.
5. Super-admin **Approve** → User activated, Org activated, welcome email with login link sent.
6. Super-admin **Reject** → User soft-deleted, Org soft-deleted, rejection email with reason sent.
7. Self-signup rate-limited (3/hour/IP, 1/day/email) and protected by basic anti-bot (honeypot field + time-to-submit check).
8. **Account-enumeration safe**: signup with already-registered email sends a "you tried to sign up but already have an account" email to the existing user; the signup form returns the same generic confirmation regardless.

#### Pending-invite hygiene

- Invites and pending Orgs auto-archive after 30 days of inactivity (token expiry + 23 days). Super-admin can purge sooner.

### 2.3 Organization slug

- Globally unique (URL is `/o/<org-slug>/...` for org pages).
- Auto-generated from Org name (lowercase, hyphenated, ASCII-only).
- User-editable at creation; locked after first tournament published, then change requires Super-admin (with redirect entry preserved — see §2.7).

### 2.4 Single-Org-per-Admin rule (v1)

- A single User can be Admin of **at most one Organization** in v1 to prevent abuse.
- A User can hold non-Admin roles in any number of other Orgs.
- Multi-Org-Admin lifted in v1.5 once we have moderation tools.

### 2.5 Email change flow

- Admin / any user can request email change → verification link to the *new* email (24h expiry) → on verification, email replaced and a notification to the *old* email confirming the change. Change is audit-logged.

### 2.6 Account deletion

- User-initiated deletion is **v1.5**. In v1, only Super-admin can delete users (via support tooling), and only after handling Org ownership.
- Deletion is **soft-delete**: `User.deleted_at` set; PII anonymized (`email = "deleted-<uuid>@invalid"`, `name = "[Deleted]"`); audit entries referencing them retain the snapshot of `actor_role` + a stable `deleted_user_handle` so history remains coherent.

### 2.7 Ownership transfer & orphan handling

#### Transfer

- Admin → **Org settings → Transfer ownership** → pick a Co-organizer in the same Org.
- Two-step: outgoing Admin initiates with password re-prompt → incoming Co-organizer accepts via in-app + email confirm → atomic swap. Outgoing user becomes Co-organizer (or chosen role); incoming becomes Admin.
- Audit-logged with both actors.

#### Orphans

- If an Org's only Admin deletes their account or is suspended:
  - If a Co-organizer exists → first-by-`created_at` is auto-promoted to Admin (with audit entry + notification to all Org members).
  - If no Co-organizer → Org enters `orphaned` status. Super-admin sees it in **orphaned-orgs** queue and can reassign to any user (must consent via email confirmation).

### 2.8 Slug & URL stability

- All public URLs use **(slug, UUID) pairs**: `/t/<slug>/m/<uuid>`. UUID is canonical; slug is for humans.
- Slug rename creates a `SlugRedirect` row (old → new) so old URLs 301-redirect indefinitely.
- Tournament slug must be unique within Org; org slug must be unique globally.

### 2.9 Authentication mechanics

- Email + password (Django `AbstractUser` extended).
- **Email verification mandatory** before first login.
- **Password reset** via single-use token, 1-hour expiry, identical response for known/unknown emails (anti-enumeration).
- **Session-based auth** for the SPA (cookie + CSRF) — no JWT in v1.
- **"Remember me"** 30-day session; sensitive actions (rule edits, deletes, role changes, ownership transfer) re-prompt for password regardless.
- **Rate limiting**: login (5/min/IP, 20/min/email), signup (3/hour/IP, 1/day/email), password reset (3/hour/email), token verify (10/min/IP).
- **Brute-force lockout**: 10 failed logins in 30 min → 15-min cooldown for that account; surfaces "account temporarily locked" without confirming account existence.
- **Optional 2FA (TOTP)**: enabled for Super-admin and Admin in v1; rolled to other roles in v1.5. **Recovery codes** (8 single-use, downloadable .txt) generated at 2FA enrollment.
- **Lost 2FA**: user uses recovery code → 2FA reset; Super-admin can also force-disable 2FA on a Tier-2+ Admin account with audit entry + email to user.
- **Force-logout-all-sessions**: Super-admin tool for compromised accounts; user-self in Account Settings.

### 2.10 Password policy (v1)

- Minimum 12 characters, ≥1 letter and ≥1 digit.
- Checked against **Have I Been Pwned** (k-anonymity API; no full hash leaves the server).
- Hashed with `argon2`.
- Password change resets all active sessions except the current one.

---

## 3. Roles & permission matrix (canonical)

The system supports **10 roles** scoped per Organization (and often per Tournament / Match).

### 3.1 Role catalog

| # | Role | Scope | Created by |
|---|------|-------|-----------|
| 1 | **Super-admin** | Platform | `createsuperuser` |
| 2 | **Admin (Organizer)** | One Org (owner) | Super-admin invite OR self-signup approval |
| 3 | **Co-organizer** | One Org | Admin invite |
| 4 | **Game coordinator** | One sport within one Tournament | Admin / Co-organizer invite |
| 5 | **Match scorer** | Assigned matches only | Game coordinator / Admin assigns |
| 6 | **Referee / verifier** | Assigned matches only | Game coordinator / Admin assigns |
| 7 | **Team manager** | Their own team | Admin invite OR self-register if tournament is open-registration |
| 8 | **Player** | Their own profile | Team manager creates `Person`; Player claims (v1.5) |
| 9 | **Viewer (public)** | Public read | No login |
| 10 | **Media / press** | Public read enhanced | Admin invite |

### 3.2 Permission matrix (v1, action × role)

Legend: ✅ allowed · ⚠️ allowed with audit + reason · ❌ denied · n/a not applicable

| Action | SAdmin | Admin | Co-org | GameCoord | Scorer | Referee | TM | Player | Media | Viewer |
|--------|:------:|:-----:|:------:|:---------:|:------:|:-------:|:--:|:------:|:-----:|:------:|
| Create Organization | ✅ | self-signup only | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Approve / suspend Org | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Edit own Org settings | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Delete Org | ✅ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Transfer Org ownership | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Invite Co-organizer | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Invite Game coordinator | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Invite Scorer / Referee | ✅ | ✅ | ✅ | ✅ (own sport) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Invite Team manager | ✅ | ✅ | ✅ | ✅ (own sport) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Invite Media / Player | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Revoke any role | ✅ | ✅ | ✅ | scoped | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Create Tournament | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Edit Tournament basics (pre-publish) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Edit structured rules (pre-freeze) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Amend rules (post-freeze) | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Lock / unlock bracket | ✅ | ✅ | ✅ | scoped | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Generate / drag-drop bracket | ✅ | ✅ | ✅ | scoped | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Generate / edit schedule | ✅ | ✅ | ✅ | scoped | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Register team (open-registration) | ✅ | ✅ | ✅ | scoped | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Approve team registration | ✅ | ✅ | ✅ | scoped | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Withdraw team | ✅ | ✅ | ✅ | scoped | ❌ | ❌ | ✅ (own) | ❌ | ❌ | ❌ |
| Disqualify team mid-tournament | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Add / edit player (pre-freeze) | ✅ | ✅ | ✅ | scoped | ❌ | ❌ | ✅ (own team) | ❌ | ❌ | ❌ |
| Edit player (post-freeze) | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Submit lineup | ✅ | ✅ | ✅ | scoped | ⚠️ | ❌ | ✅ (own team) | ❌ | ❌ | ❌ |
| Confirm lineup at kickoff | ✅ | ✅ | ✅ | scoped | ✅ (assigned) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Live scoring (enter events) | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ (assigned) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Correct event pre-final | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ (assigned) | ❌ | ❌ | ❌ | ❌ |
| Approve / reject final score | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ | ✅ (assigned) | ❌ | ❌ | ❌ | ❌ |
| Force-finalize after timeout | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Raise dispute | ✅ | ✅ | ✅ | scoped | ❌ | ✅ (assigned) | ✅ (own team) | ❌ | ❌ | ❌ |
| Resolve dispute | ✅ | ✅ | ✅ | sport-scoped | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Override player suspension | ✅ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| View Org audit log | ✅ | ✅ | ✅ | sport-scoped | ❌ | own matches | ❌ | ❌ | ❌ | ❌ |
| View platform audit log | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Impersonate user | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| View opposing lineup pre-kickoff | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| View own player DOB | ✅ | ✅ (own org) | ✅ (own org) | ❌ | ❌ | ❌ | ✅ (own team) | ✅ (self) | ❌ | ❌ |
| View public match data | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Download CSV / PDF export | ✅ | ✅ | ✅ | scoped | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Delete `MatchEvent` row | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Void `MatchEvent` (mark voided) | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ (assigned) | ❌ | ❌ | ❌ | ❌ |

"scoped" = within the role's natural scope (Game coordinator → own sport; Scorer/Referee → assigned matches; Team manager → own team).

### 3.3 OrganizationMembership status enum

```
status ∈ { invited, pending_email_verification, pending_approval, active, suspended, revoked, declined, left }
```

- `invited` — token sent, not yet accepted.
- `pending_email_verification` — accepted but email unverified.
- `pending_approval` — Self-signup awaiting Super-admin approval.
- `active` — full role privileges.
- `suspended` — temporarily revoked by Admin / Super-admin (reason audit-logged); user sees "your access is suspended".
- `revoked` — permanently revoked.
- `declined` — invitee declined the invite.
- `left` — user voluntarily exited the org.

### 3.4 Member directory

- Admin / Co-organizer view at `/o/<org-slug>/members`:
  - Search by name / email.
  - Filter by role, status, last-active.
  - Bulk actions: revoke, change role, resend invite.
  - Per-row: profile, role(s), status, joined date, last login, "view audit history" link.

### 3.5 Bulk invite (CSV) — v1.5

- v1: one-at-a-time invite UI.
- v1.5: CSV upload (email, suggested_role) with row-level validation and per-row send.

---

## 4. v1 scope — vertical slice boundary

| In scope (v1) | Out of scope (v1) |
|---------------|-------------------|
| Football | Cricket / basketball / volleyball / indigenous sports (v2+) |
| All three formats configurable: **Knockout, Round-robin, Group→Knockout** | Double-elim, Swiss, Ladder, Multi-stage custom (schema-ready, UI deferred) |
| All 10 roles + full permission matrix | Multi-Org-Admin (v1.5) |
| Hybrid live updates: SSE for viewers, WebSocket for scorers/referees | Polling fallback as primary |
| Strong reconnect + localStorage queue for scorer | Full offline-first PWA / IndexedDB |
| Auto-generate everything; manual edit with conflict warnings | CP-SAT / Z3 constraint solver |
| Soft constraint avoidance (same school, same region) | Hard constraint solver |
| Full Match Center (lineups, formation, events, stats, H2H, tournament context) | Live video streaming |
| Stadium / broadcast mode | Per-match custom branding |
| Structured rule fields + rendered prose (3 layers: sport → tournament → match) | AI-drafted rulebook |
| Standard audit log, append-only at DB layer | Forensic / signed / hash-chained |
| Referee approval flow per-tournament toggle | Two-person verification (stored, enforcement v1.5) |
| In-app notifications via SSE | Email / WhatsApp / SMS (schema ready) |
| Multi-tenancy by Organization | Cross-org user federation |
| OG share cards, QR codes, PDF brochure | Embed iframes |
| Player suspensions auto-applied from cards | Doping / disqualification workflows |
| **Person ↔ Player split** | Player claim workflow (v1.5) |
| **Score correction & dispute lifecycle (text only)** | Photo / video evidence on disputes (v1.5) |
| **Tournament & match state machines** | Mid-tournament re-seeding on disqualification (manual only) |
| **Match dependencies (winner_of / loser_of / group_position)** | Cross-tournament dependencies |
| **Rule freeze + formal amend workflow** | Mid-match rule edits (always blocked) |
| **Stoppage / injury time on clock** | VAR / disallowed-goal review |
| **GK distinction; own goals; penalty goals; voided events** | Free kicks awarded / throw-ins (v1.5) |
| **Time-zone aware scheduling/display** | Multi-time-zone tournaments (v2) |
| **i18n scaffolding (`gettext` from day 1)** | Non-English translations (v3) |
| **WCAG 2.1 AA baseline** | Full screen-reader scorer optimization (v1.5) |
| **Mobile-first responsive design** | Native mobile apps |
| **Lineup deadline mechanic + auto-action on miss** | Per-half sub limits (v1.5) |
| **Walkover, double-walkover, no-show advancement** | Lineup-version history beyond last-edit |
| **Three-way+ tied teams mini-league algorithm** | Goal-difference cap |
| **Approval timeouts (referee 24h, force-finalize)** | Auto-approve scorer events |
| **Open vs. invite-only team registration toggle** | Team library / cross-tournament team reuse (v1.5) |
| **Min-teams-to-start gate per tournament** | — |
| **Captain-armband-transfer event (with or without sub)** | — |
| **"Another scorer present" indicator** | — |
| **Server-vs-local clock drift display** | — |
| **2FA recovery codes at enrollment** | — |
| **Empty / error / loading state catalog** | — |
| **Welcome wizard + demo tournament seed** | — |
| **Bulk invite via CSV (v1.5)** | — |
| **Org / tournament / player export (v1.5)** | — |
| **Account compromise procedure (Super-admin tools)** | — |

---

## 5. Functional requirements (by subsystem)

### 5.1 Tournament setup wizard

Multi-step wizard (Admin / Co-organizer):

1. **Basics** — name, slug (auto from name, editable), Organization (pre-filled), sport (Football v1), description, dates (start/end), **time zone** (default = Org's TZ), visibility (public / unlisted / private), `min_teams_to_start` (default 4).
2. **Format** — Knockout / Round-robin (single or double) / Group→Knockout (other formats listed "Coming soon").
3. **Structured rules** — full catalog (§5.13). Defaults inherited from Sport defaults.
4. **Prose rulebook** — auto-generated from structured fields + Sport's prose template; editable; conflict warnings if structured fields change post-edit.
5. **Venues** — add venues (name, address, capacity, time windows).
6. **Days available** — calendar for blackout dates.
7. **Roles** — invite Co-organizers, Game coordinator(s).
8. **Team registration** — open vs. invite-only toggle; approval-required-on-self-register toggle; registration window (start/end dates).
9. **Review & publish** — preview; validation gate (all required fields, ≥1 venue, ≥1 day available, registration window valid).

Each step has inline help, field-level validation, and **Save draft** (resumable).

### 5.2 Tournament state machine

```
draft → published → registration_open → registration_closed
  → bracket_generated → scheduled → live → completed → archived
```

Side states:
- `cancelled` (terminal; with reason)
- `paused` (whole tournament paused, e.g., weather; resume returns to prior state)
- `disputed` (≥1 open dispute; auto-clears when all resolved)
- `orphaned` (Org has no active Admin)

#### Transition triggers, preconditions, and actions

| Transition | Trigger | Preconditions | Notifications | Audit |
|------------|---------|---------------|---------------|-------|
| `draft → published` | Admin clicks "Publish" | Wizard complete + validation pass | Org members | ✅ |
| `published → registration_open` | Reaches `registration_window_start` (auto) OR Admin force-opens | Tournament still `published` | All assigned roles | ✅ |
| `registration_open → registration_closed` | Reaches `registration_window_end` (auto) OR Admin force-closes | Tournament still `registration_open` | All members | ✅ |
| `registration_closed → bracket_generated` | Admin / Coordinator generates+locks bracket | Teams ≥ `min_teams_to_start` | Coordinator, scorers, referees, team managers | ✅ |
| If teams < `min_teams_to_start` at `registration_closed` | Auto-prompt Admin: extend window OR cancel | — | Admin | ✅ |
| `bracket_generated → scheduled` | Admin / Coordinator locks schedule | Schedule has zero hard conflicts | All assigned roles + team managers | ✅ |
| `scheduled → live` | Reaches first match's `scheduled_at - 1h` (auto) OR Admin force-opens | At least one match assigned scorer + referee | All | ✅ |
| `live → completed` | All matches in terminal state (`final` / `walkover` / `cancelled` / `abandoned`) | No `disputed` matches outstanding | All members | ✅ |
| `completed → archived` | After `archive_after_days` (default 90) auto OR Admin force-archives | — | Admin | ✅ |
| `* → cancelled` | Admin cancels with reason ≥20 chars | Not already terminal | All | ✅ |
| `* → paused` | Admin pauses with reason | Not terminal | All | ✅ |
| `paused → prior_state` | Admin resumes | — | All | ✅ |
| `* → disputed` (overlay) | Any match enters `disputed` | — | Affected parties | ✅ |
| `* → orphaned` | All Admins removed/suspended without successor | — | Super-admin queue | ✅ |

#### Rule-freeze policy

- **Mutable**: `draft`, `published`.
- **Frozen except via formal amend**: `registration_open` and beyond.
- **Amend workflow**:
  - Required reason ≥20 chars.
  - Notifications fan-out to all affected roles.
  - **24-hour grace period** before amend takes effect (configurable; Super-admin can waive in emergencies with reason).
  - Audit `before` / `after` of every changed field.
- **Never amendable post-freeze**: `format`, `tie_breaker_order` (Super-admin override only).
- **Strictly amendable post-`live`**: only ancillary fields like `dispute_window_hours`, `archive_after_days`.

### 5.3 Person, Team, and Player registration

#### Person ↔ Player split

- **`Person`** = stable platform-scoped human identity (name, dob [encrypted], photo, optional `user_id` FK).
- **`Player`** = per-tournament registration referencing a `Person` (jersey_no, position, team, captain, eligibility).
- One `Person`, many `Player` rows (one per tournament played).
- **Player claim flow** v1.5: allows the actual person to sign up and link their `User` to their `Person`.

#### Team registration

- Admin / Co-organizer / Game coordinator OR (if open-registration toggle is on) Team manager registers a team:
  - Team name, short name, crest (≤2 MB, PNG/JPG/SVG, MIME-sniffed), primary color, school, region/district, pool/category, free-form tags, time zone (default = tournament TZ).
- **Approval flow** (if `team_registration_requires_approval = true`): Team manager submits → Admin reviews → approve / reject.
- **Late registration** (after window): Admin override only, audit-logged.
- **Team cannot be on multiple pools/categories within a tournament.**

#### Player addition

- Team manager adds players (each maps to a `Person`):
  - Name, jersey number (unique within team for the tournament — enforced server-side), position (default list in §5.13), DOB, photo (≤2 MB, MIME-sniffed), captain flag, `is_goalkeeper` flag.
- Squad must have ≥1 GK in starters and ≥1 GK on bench when bench size > 0.
- Squad size enforced per tournament rules.
- **Hard constraint**: a `Person` cannot be on two `Team`s in the same tournament (server-side check at registration).
- **Captain change between matches**: edit Player.captain pre-freeze freely; post-freeze with audit.
- **Jersey number change between matches**: Player.jersey_no edit (audit-logged); previous matches retain their snapshot via `MatchEvent.payload` snapshots.

#### Eligibility freeze

- Tournament-configurable: `no_freeze` / `after_registration` / `after_group_stage` / `after_round_of_16` / `custom`.
- Once freeze date/round is reached, roster locked. Admin override only with reason + audit.

#### Withdrawal & disqualification

- **Pre-bracket-locked withdrawal**: just remove team. No bracket impact.
- **Post-bracket-locked withdrawal**: opposing team's match becomes a walkover; advancement fires; downstream matches updated.
- **Mid-tournament disqualification** (Admin only, audit-logged with required reason):
  - Already-played matches' scores stand for stats.
  - Future scheduled matches: opponents get walkover.
  - Active player suspensions earned by DQ'd team's players carry across stages per `suspension_carries_across_stages`.
  - Goals scored against DQ'd team: stat-snapshot decision per tournament — **`dq_stats_policy`** field with options `keep_all`, `void_against_dq`, `void_all` (default `keep_all`).
- **Soft-delete semantics**: Team withdrawn/DQ'd row stays in DB (filtered from default queries) so audit + stats remain coherent.

### 5.4 Lineup submission

- **Both team managers must submit** lineups before the match transitions `lineup_pending → lineup_submitted`.
- **Deadline**: configurable per tournament — `lineup_deadline_minutes_before_kickoff` (default 60).
- **Deadline-miss policy** — `lineup_miss_policy`:
  - `auto_walkover_against_missing` (default): missing-lineup team forfeits.
  - `auto_postpone`: match postponed; Admin must reschedule.
  - `notify_admin_only`: no auto-action; Admin decides.
- **Notifications**: T-2h "lineup deadline approaching", T-0 "lineup deadline passed".
- **Late edit** (after deadline, before kickoff): allowed only with referee approval; audit-logged.
- **Submitted by**: Team manager or Admin override (audit-logged).
- **Validation at submit**:
  - All players in registered squad.
  - No suspended players.
  - Squad size within rules.
  - ≥1 GK in starters; ≥1 GK on bench (if bench size > 0).
  - Captain ∈ starters.
  - Jersey numbers unique per team.

### 5.5 Match state machine

```
scheduled → lineup_pending → lineup_submitted → live_pre_kickoff
  → live_first_half → live_halftime → live_second_half
  → [live_extra_time] → [live_penalty_shootout]
  → awaiting_referee_approval → final → archived
```

Side states (any active state):
- `postponed`, `walkover`, `abandoned`, `cancelled`, `disputed`.

#### Transition triggers

| Transition | Trigger | Notes |
|------------|---------|-------|
| `scheduled → lineup_pending` | T-`lineup_deadline_minutes_before_kickoff*2` (auto) | Triggers lineup-deadline-approaching notification at -2h |
| `lineup_pending → lineup_submitted` | Both lineups submitted AND validation passed | OR `lineup_miss_policy` triggers walkover/postpone |
| `lineup_submitted → live_pre_kickoff` | Scorer presses "Begin pre-kickoff" (after on-site coin toss) | Coin toss recorded |
| `live_pre_kickoff → live_first_half` | Scorer presses "Kick off" | Match clock starts |
| `live_first_half → live_halftime` | Scorer presses "End half" (with optional stoppage time, e.g., "+3") | Clock pauses |
| `live_halftime → live_second_half` | Scorer presses "Kick off 2nd half" | Clock resumes |
| `live_second_half → live_extra_time` | Scorer presses "Start ET" | Only if rules permit and scores are level |
| `live_extra_time → live_penalty_shootout` | Scorer presses "Start penalties" | Only if rules permit |
| `* live → awaiting_referee_approval` | Scorer presses "Full time" (or end ET / pen shootout) | Match clock stops |
| `awaiting_referee_approval → final` | Referee approves | Triggers advancement domain event |
| `awaiting_referee_approval → live_*` | Referee rejects with reason | Returns to most recent live state |
| Force-finalize | After `referee_approval_timeout_hours` (default 24), Admin can force-finalize with reason | Audit-logged |
| `* → postponed` | Admin / Coordinator with reason | Schedule update; notifications |
| `* → walkover` | Scorer / Coordinator with reason | Awarded score applied; advancement fires |
| `* → abandoned` | Scorer / Coordinator with reason | Per `abandonment_policy` |
| `abandoned → scheduled` | Admin / Coordinator with reason (**required**) | Replay — the abandoned result is void: scores/pens/sets/period cleared; the original event log is retained (append-only, strikethrough in UI); advancement never fires from `abandoned` |
| `* → cancelled` | Admin with reason | Bracket-aware: opponents in dependent matches get bye-equivalent or walkover |
| `* → disputed` (overlay) | Dispute raised | Advancement paused |

#### "Called" annotation (not a state)

- The control room can mark a `scheduled` match as **called to its venue** (`Match.called_at`, decision 72). This is an operational *annotation of* `scheduled`, **not** a lifecycle state: it does not appear in the transition table above, never gates a transition, and the state machine is untouched. The UI renders "Called" while `status == scheduled` and `called_at` is set; the annotation auto-clears on the transition to live (kickoff consumes the call).

#### Per-match rule freeze

- Once a match enters `live_first_half`, **its rules are immutable** for that match. Even an active tournament-level rule amend won't apply retroactively to a match that's already started.

### 5.6 Match-day operations

#### Pre-match
- **Pre-match referee briefing screen** — referee confirms roster + rule overrides + weather + special instructions.
- **Coin toss** — recorded by referee (which team kicks off, which side they defend).
- **Scorer confirms lineup** at match start; if mismatch with submitted lineup, scorer + referee resolve.

#### Live scoring (scorer screen)

- Tap-friendly UI; phone/tablet-optimized.
- **Match clock** — start, pause, resume, end half (with stoppage time announce, e.g., `45+3`), start 2nd, full time, ET, penalties. Server computes authoritative clock from `started_at`, `paused_intervals[]`, `current_period`.
- **Stoppage time** — explicit on public clock.
- **Event types (v1)**:
  - `goal_open_play` (scorer + optional assist + minute)
  - `goal_penalty` (scorer + minute)
  - `goal_own_goal` (credited to opposing side; player who scored own goal recorded but no goal-credit)
  - `goal_voided` (links to voided event; original retained with strikethrough)
  - `card_yellow` (player + minute)
  - `card_red` (player + minute) → triggers suspension calc
  - `card_second_yellow` (player + minute) → equivalent to red for suspension; logged distinctly for stats
  - `substitution` (out + in + minute) → captain transfer if captain subbed off
  - `captain_armband_transfer` (without sub — armband moves to another on-field player)
  - `period_event` (`kickoff`, `half_end`, `half_resume`, `full_time`, `extra_time_start`, `pen_shootout_start`, `match_end`)
  - `walkover_declared` (by scorer/coordinator with reason)
  - `match_abandoned` (with reason)
  - Optional (gated by `detailed_stats_enabled`): `corner`, `foul`, `offside`, `shot`, `shot_on_target`, `possession_sample`
- **`event_status`**: `active` / `voided` / `corrected` (voided events stay in history).
- **Optimistic UI** + **status pill** (Live ✓ / Reconnecting… / Offline N).
- **Idempotency**: every event has client-generated UUID; server idempotent dedupe.
- **localStorage queue** survives reload; flushed on reconnect.
- **Penalty shootout UI**: alternating team rounds, first 5 each then sudden death; running total; visual sequence of made/missed.
- **Concurrent scorer indicator**: "Scorer X is also viewing this match" badge.
- **Server-vs-local clock drift**: if delta > 60s, scorer UI shows banner "your device clock differs from server by Ns"; events use server timestamp regardless.
- **GK red-carded with no GK on bench**: scorer must designate outfield-GK substitute; UI flags and audit-logs.

#### Referee screen

- Sees scorer's submitted events in real time over WebSocket.
- Can flag scorer's draft entries pre-submission.
- Can **correct** mistakenly-entered events (e.g., wrong card color) — creates `corrected` event linked to original; original retained.
- **Post-match approval UI**: form summarizing all events grouped (goals / cards / subs / period). Per-event approve/flag, plus "Approve all & finalize".
- **Rejection**: returns to relevant `live_*` state; audit-logged with reason.
- **Recusal**: referee can decline assignment with reason; coordinator reassigns.

#### Conflict scenarios (covered)

- Network blip → idempotent retry → no duplicate.
- Tab reload during outage → events restored from `localStorage`.
- Two scorers active → server orders by `(sequence_id, server_timestamp)`; UI shows other-scorer indicator.
- Long outage (>15 min) → soft warning to verify with referee.
- Suspended player in lineup → hard block.
- Sub beyond allowed count → hard block.
- Match ended early → soft warning + reason field.
- Team falls below `min_players_to_continue` (red cards) → opponent wins; awarded score per rule.
- Mid-match rule change attempted → blocked; tournament-amend doesn't retroactively apply.
- Two simultaneous matches by same team (rescheduling bug) → schedule re-validation blocks.

#### Walkover / abandonment / postponement

- **Walkover** (single team no-show): scorer / coordinator marks; system applies `walkover_score` (default 3-0); advancement fires.
- **Double walkover** (both teams no-show): match `cancelled`; both teams eliminated; dependent match has bye for whoever was supposed to feed in. Tournament-level `double_walkover_policy` field, default `cancel_match`.
- **Abandonment** per `abandonment_policy`: `replay` / `awarded_to_leader` / `replay_from_score` / `organizer_decides`.
- **Postponement**: schedule update with audit-logged reason.

### 5.7 Score correction & dispute workflow

#### Pre-final correction
- Referee or scorer (with referee approval) edits an event → creates a `corrected` event linking to original; original marked `corrected`.

#### Post-final dispute
- **Raisers**: Team manager (own team), Referee, Game coordinator, Admin / Co-organizer.
- **Window**: configurable per tournament, default **24 hours after `final` transition**.
- **Payload**: text description ≥30 chars.
- **States**: `raised` → `under_review` → `resolved` (outcome: `score_amended`, `walkover_awarded`, `match_replayed`, `dispute_dismissed`).
- **Resolver**: Admin / Co-organizer; Game coordinator can resolve sport-scoped disputes per matrix.
- **Multiple simultaneous disputes**: same match can have multiple disputes from different parties; each tracked separately; advancement only recomputes once after all resolved.
- **Anti-spam**: same party limited to 1 active + 1 resolved per match; third blocked unless Admin overrides.
- **Match enters `disputed` state** while open; advancement is paused; dependent matches show pending.
- **Dispute visibility**: open disputes visible to organizers, coordinators, raising party, opposing TM. Public view shows match in `disputed` state without dispute details.
- **Photo / video evidence**: text only in v1; uploads in v1.5.

#### Dispute cascade policy

When a resolution changes the match outcome, dependent matches are affected. Tournament-level field **`dispute_cascade_policy`**:
- `strict_unplayed_lenient_played` (default): unplayed dependents are recomputed; already-played dependents stand historically.
- `strict_all`: all dependents replayed (organizer scheduling effort); a flag is set on each downstream `Match` indicating "replay-required".
- `lenient_all`: history stands; amend recorded but no propagation.
- Organizer chooses at resolution time; default applied if unspecified.

### 5.8 Suspension calculation

- Yellows accumulate within stage (or tournament if `suspension_carries_across_stages = true`); reaching `yellow_cards_to_suspension` (default 2) → suspended next match.
- Red / second-yellow → suspended next `red_card_suspension_matches` matches (default 1).
- Domain-event hook fires after each card event; creates `PlayerSuspension(player, tournament, applies_to_match, source_event, status)`.
- Lineup submission validates against active suspensions; hard-block.
- **Admin override** with reason + audit (e.g., disciplinary committee overturns).

### 5.9 Tiebreakers (group / round-robin)

- Configurable ordered list per tournament; default: `[head_to_head, goal_difference, goals_scored, wins, fewer_cards, coin_toss]`.
- **Recompute trigger**: every `match_finalized` in a group/league; standings updated atomically.
- **Three-or-more-way tie algorithm** ("mini-league"):
  1. Filter to only the tied teams' head-to-head matches.
  2. Recompute stats within that subset.
  3. Apply tiebreakers in order; teams that resolve are removed from the tie set; rebuild remaining tie sub-set.
  4. If all tiebreakers exhausted and ≥2 teams remain tied → `coin_toss` step → manual organizer action with audit log.
- **Standings UI**: shows current order + which tiebreaker is currently determining each row's position (visible chip).
- **Goal-difference cap**: not in v1.

### 5.10 Public live-view — Full Match Center

Tabs:
1. **Summary** — hero, latest 5 events, scorers per side, card summary, "next match for winner".
2. **Live commentary / Event feed** — chronological with icons; filter chips (All / Goals / Cards / Subs / Other); voided events struck through.
3. **Lineups** — formation graphic (SVG), starting XI, subs with arrows, bench, captain badge (transferable).
4. **Stats** — possession, shots, shots on target, corners, fouls, cards, offsides, pass accuracy. Gated by `detailed_stats_enabled`.
5. **Head-to-Head** — last 5 cross-tournament meetings (using Person + Team identity).
6. **Tournament context** — mini bracket, path-to-final, top scorer, standings.

**Stadium / broadcast mode**: `?mode=broadcast` for projector-friendly Summary.

#### Public-view edge cases (handled)

- Tournament not yet `published` → 404.
- `private` tournament + unauth viewer → login prompt with redirect.
- Match scheduled but no lineups → "Lineups pending" panel.
- Match `cancelled` → "Cancelled — reason: …".
- Match `disputed` → "Result disputed; pending resolution"; current score visible; dispute details hidden.
- Bracket regenerating → viewer sees "Regenerating…" toast for ~10s; auto-refresh on `bracket_locked` SSE event.
- Stadium mode → SSE primary; on disconnect, falls back to 5s polling with reconnect indicator.
- Old/archived tournament → URLs continue to resolve; OG cards continue to render from archived state.

#### Accessibility

- All live regions `aria-live="polite"`.
- Keyboard navigable.
- WCAG 2.1 AA color contrast.
- Match clock has visual + text representation.
- Formation graphic has accessible alt-text fallback.

### 5.11 Tournament-wide live page

- "Now playing" strip with live matches.
- Interactive bracket (zoomable, mobile-friendly, live matches glow).
- Today's schedule (chronological in viewer's TZ, with tournament-TZ tooltip).
- Recent results (last 10).
- Standings (group/league) with current-tiebreaker indicator.
- Top scorers / cards leaderboards (tournament-wide).

### 5.12 Empty / error / loading state catalog

#### Empty states

| State | Where | Copy |
|-------|-------|------|
| No tournaments yet | Org dashboard | "No tournaments yet — create your first to get started" + CTA |
| No teams yet | Tournament page | "No teams registered yet" + CTA (open registration / invite TMs) |
| Bracket not yet generated | Bracket page | "Bracket will appear once registration closes and you generate it" |
| No live matches | Tournament-wide live page | "No matches in progress right now" + next-match preview |
| No notifications | Bell dropdown | "You're all caught up" |
| No audit entries match filter | Audit log search | "No matching audit entries" |
| No standings yet | Standings tab | "Standings appear after the first match completes" |

#### Error states

| Code | Page | Behavior |
|------|------|----------|
| 401 | API | SPA shows global "session expired, please log in" banner; redirect to login with return-to |
| 403 | Any | Designed page: "You don't have permission to view this" + "Back to dashboard" |
| 404 | Any | Designed page: "Not found" + "Back" |
| 500 | API / page | Designed page + Sentry error ID; "If this persists, contact support" |
| 503 | App | "Briefly unavailable due to maintenance" with status link |
| Network down | SPA | Persistent banner: "You're offline" |
| Stale data | Live screens | Toast: "Data updated; refresh to see latest" with refresh button |
| Optimistic-action rejected | Scorer / forms | Inline error + revert UI + "Retry" button |
| Scoring locked by another user | Scorer | "Another scorer is currently entering events; sync first" with sync action |

#### Loading states

- **Page-level**: skeleton screens for known shapes (bracket, match center, standings, lists).
- **Component-level**: inline spinners for buttons / lazy-loaded panels.
- **Optimistic update**: action reflects immediately; on server reject, rollback + inline error.

### 5.13 Structured rule field catalog (v1, football)

```
match_length_minutes: int (default 90)
halves: int (default 2)
half_length_minutes: int (default 45)
half_time_break_minutes: int (default 15)
stoppage_time_announced: bool (default true)
extra_time_enabled: bool (default false)
extra_time_minutes: int (default 30)
extra_time_when: enum(never, knockout_only, all_matches, finals_only)
penalty_shootout_enabled: bool (default true)
penalty_shootout_when: enum(after_extra_time, after_regulation, never)
penalty_shootout_initial_rounds: int (default 5)
golden_goal: bool (default false)
players_on_field_per_team: int (default 11)
min_players_to_start: int (default 7)
min_players_to_continue: int (default 7)
substitutes_allowed: int (default 5)
rolling_substitutions: bool (default false)
yellow_cards_to_suspension: int (default 2)
red_card_suspension_matches: int (default 1)
suspension_carries_across_stages: bool (default true)
squad_size_min: int (default 11)
squad_size_max: int (default 25)
gk_min_in_squad: int (default 1)
eligibility_freeze_round: enum (no_freeze, after_registration, after_group_stage, after_round_of_16, custom)
walkover_grace_minutes: int (default 30)
walkover_score: string (default "3-0")
abandonment_policy: enum(replay, awarded_to_leader, replay_from_score, organizer_decides)
double_walkover_policy: enum(cancel_match, replay, both_eliminated) (default cancel_match)
two_legged_aggregate: bool (default false)
away_goals_rule: bool (default false)
third_place_playoff: bool (default false)
detailed_stats_enabled: bool (default false)
referee_approval_required: bool (default true)
referee_approval_timeout_hours: int (default 24)
two_person_verification: bool (default false)  # stored, enforcement v1.5
tie_breaker_order: ordered list [head_to_head, goal_difference, goals_scored, wins, fewer_cards, coin_toss]
default_formations: list (default ["4-4-2", "4-3-3", "3-5-2", "4-2-3-1", "5-3-2", "4-5-1"])
default_positions: list (default ["GK", "CB", "LB", "RB", "DM", "CM", "AM", "LW", "RW", "ST", "CF"])
dispute_window_hours: int (default 24)
dispute_cascade_policy: enum(strict_unplayed_lenient_played, strict_all, lenient_all)
dq_stats_policy: enum(keep_all, void_against_dq, void_all) (default keep_all)
lineup_deadline_minutes_before_kickoff: int (default 60)
lineup_miss_policy: enum(auto_walkover_against_missing, auto_postpone, notify_admin_only)
team_registration_requires_approval: bool (default false)
min_teams_to_start: int (default 4)
archive_after_days: int (default 90)
```

Stored as JSONB with JSON-schema validation. New fields = zero migrations.

### 5.14 Notifications

#### Architecture
- Central `Notification` + `NotificationDispatcher`.
- v1: in-app channel only.
- v2+: email/WhatsApp/SMS plug-in via dispatcher.

#### Bell + page
- Bell with unread count + 10 most recent.
- Full `/notifications` page: filter by category (Tournaments / Matches / Account / Disputes / Roles), date grouping, bulk mark/archive, infinite scroll.
- SSE on `user:<uuid>:notifications` for live bell updates.

#### Recipient list per event type (canonical)

| Event | Recipients |
|-------|------------|
| `invitation_received` | Invitee |
| `role_assigned` | Assignee |
| `role_revoked` | Affected user |
| `account_approved` | Admin |
| `tournament_created` | All Org Admins/Co-organizers |
| `assigned_to_tournament` | Assignee |
| `assigned_as_scorer` | Scorer |
| `assigned_as_referee` | Referee |
| `team_invited` | TM |
| `team_registered` | Org Admins, Game coordinator |
| `team_approved` / `team_rejected` | TM |
| `match_scheduled` | TMs (both), Scorer, Referee, Game coordinator |
| `match_rescheduled` | Same as `match_scheduled` |
| `match_postponed` | Same |
| `match_cancelled` | Same |
| `lineup_deadline_approaching` (T-2h) | TMs (both) |
| `lineup_deadline_passed` | TMs (both), Game coordinator, Admin |
| `match_starting_soon` (T-15min) | TMs, Scorer, Referee, Game coordinator |
| `score_pending_approval` | Referee |
| `score_approved` | Scorer, TMs |
| `score_rejected` | Scorer (with reason) |
| `match_ended` | TMs, Scorer, Referee, Game coordinator |
| `dispute_raised` | Admin, Game coordinator, opposing TM, Referee |
| `dispute_resolved` | Raiser, opposing TM, Admin, Game coordinator |
| `your_team_advanced` | TM + Players (claimed) |
| `your_team_eliminated` | TM + Players (claimed) |
| `your_next_match_set` | TM + Players (claimed) |
| `tournament_published` | Org members |
| `tournament_locked` / `bracket_locked` | All assigned roles |
| `account_security_alert` | Affected user (always-on, non-disableable) |
| `impersonation_session_started` | Impersonated user (always-on) |
| `rule_amend_proposed` / `rule_amend_effective` | All affected roles |

#### Grouping

- ≥5 notifications of the same `event_type` to the same user within 1 minute collapse into one summary row ("5 matches scheduled in Inter-College Cup 2026"); details on click.

#### Self-suppression

- A user does not receive notifications about their own actions.

#### Preferences

- Matrix `(event_type × channel) → enabled`.
- v1 only `in_app` column active; others grayed "Coming soon".
- Always-on events (`account_security_alert`, `impersonation_session_started`, dispute affecting your team) cannot be disabled.

#### Retention
- 90-day archive, 1-year delete.

### 5.15 Audit log

- Append-only `AuditEvent`; `UPDATE` / `DELETE` denied at Postgres role level.
- Captures: identity, tournament setup, team/player events, bracket/schedule edits, match runtime, approval/dispute, conflict resolution, notification dispatch, manual overrides, **Super-admin impersonation**, **rule freeze / amend**, **state transitions**, **role changes**.
- Each row stores: actor, role snapshot, IP, user-agent, before/after JSONB, reason (required for sensitive overrides).
- **GDPR-style anonymization (v1.5)**: data deletion for a user does not delete audit entries; instead, `actor_user_id` is nulled and a `deleted_user_handle` (stable per-deletion UUID) is preserved.
- **Search & filter UI**: by actor, target, time range, event type. CSV/JSON export (permission-gated).
- Pagination + indexes on `(org_id, created_at DESC)` and `(target_type, target_id, created_at DESC)`.

### 5.16 Conflict-warning system (cross-cutting)

Every auto-generated artifact stores `inputs_hash` + `last_manual_edit_at`. On view:
- Inputs changed *after* manual edit → banner "⚠️ Edited manually but inputs changed. [Re-generate] [Keep manual] [View diff]".
- Never edited → silent regenerate on demand.
- Edited and inputs unchanged → no warning.

Applied to: prose rulebook, bracket, schedule, group composition, match clock state, suspensions, slugs. Read-only computed (leaderboards, standings) → no banner.

### 5.17 Welcome wizard & demo tournament

#### First Admin login
- **Welcome wizard**: 3 steps — set Org logo + brand color, set Org timezone, optionally seed a "Demo tournament" labeled `demo: true`.
- **Demo tournament**: pre-populated with 4 teams + ~40 players + a knockout bracket; matches in mixed states (one live, one final, one upcoming); explicitly labeled "Demo data — safe to delete".
- "Skip" exits wizard; can re-launch from settings.

#### Demo tournament lifecycle
- Cannot be `published` (always private to the Org).
- Tagged `demo` so it's excluded from public listings, exports, leaderboards.
- Admin can delete at any time; soft-deleted normally.

### 5.18 Data export (v1.5)

- Org admin → **Org settings → Export data**: ZIP containing JSON for tournaments, teams, players, match events, audit log (last 1 year).
- Per-tournament archival export: PDF brochure + JSON snapshot.
- Per-Person stats export: CSV of all matches involved + aggregated career stats.

### 5.19 Account compromise procedure

- User self-tool: **Account Settings → Security → Force-logout-all-sessions** (re-prompts password).
- Super-admin tool: per-user **Force logout** button + audit entry.
- Email change requires verification on the new email + notification to old.
- Suspicious-login email (>1 country/day or new device) — out-of-scope of v1; flagged as v1.5.

---

## 6. Non-functional requirements

| Requirement | Target |
|-------------|--------|
| Availability | 99% uptime during tournament windows; planned maintenance outside event hours |
| SSE viewer event latency | < 1 sec median |
| Scorer WebSocket round-trip | < 200 ms median on stable connection |
| Concurrent viewers per match | 5,000 (single VPS + Redis cache) |
| Concurrent live matches | 50 |
| Backup RPO | 24h (nightly `pg_dump` to S3-compatible storage) |
| Backup RTO | 4h |
| Audit retention | Indefinite |
| Notification retention | 90d archive, 1y hard-delete |
| Multi-tenancy isolation | DB-level FK + default manager filter; CI assertion tests |
| Data privacy | Encrypted DOB; PII flagged in schema; minor consent v2 |
| Localization | English v1; i18n scaffolded |
| Accessibility | WCAG 2.1 AA on all non-scorer UIs |
| Time zones | UTC storage; tournament-TZ default; viewer-TZ display |
| VPS sizing v1 | 4 vCPU / 8 GB RAM / 80 GB SSD |
| DR drill | Monthly restore test on throwaway VPS |
| Migration policy | Blocked while any tournament `live`; maintenance windows otherwise |
| Application logs | Structured JSON; 30-day retention; ELK in v2 |
| Access logs | nginx access logs; 90-day retention |
| Database indexes | `MatchEvent(match_id, sequence_id)`, `Match(tournament_id, scheduled_at)`, `AuditEvent(org_id, created_at DESC)`, `AuditEvent(target_type, target_id, created_at DESC)`, `Notification(user_id, read_at, created_at DESC)`, partial `MatchEvent(match_id) WHERE event_status='active'` |
| N+1 mitigation | `select_related` / `prefetch_related` discipline; query-count assertions in CI |
| Redis memory budget | ~50 MB / 100 live matches; 4 GB Redis instance comfortable |
| SSE worker ceiling | ~5,000 connections / ASGI worker |

---

## 7. Architecture

### 7.1 Topology

```
                   ┌────────────────────────────────────┐
                   │           VPS (Ubuntu)             │
   ┌────────┐      │  ┌──────────────────────────────┐  │
   │ Browser│ ──► nginx (TLS 80/443, static SPA)     │  │
   │  (SPA) │      │  └──────────┬───────────────────┘  │
   │  React │      │             │                      │
   │+TS+Vite│ ◄─── │  Django ASGI (Daphne / Uvicorn)    │
   └────────┘      │  ├─ DRF (JSON API)                 │
       ▲          │  ├─ Channels (WebSockets: scorer)  │
       │ SSE      │  └─ async views (SSE: viewers)     │
       │          │             │                      │
       │          │  ┌──────────┴──────────┐           │
       │          │  │ Postgres │  Redis   │           │
       │          │  │  (UUID v7│ (channel │           │
       │          │  │   JSONB) │  layer + │           │
       │          │  │          │ pub/sub +│           │
       │          │  │          │  cache)  │           │
       │          │  └──────────────────────┘          │
       │          │                                    │
       │          │  systemd: asgi-app, notif-cron     │
       │          │  pg_dump → S3 nightly              │
       │          └────────────────────────────────────┘
       │
       └─ Public viewers (no login, read-only via SSE)
```

### 7.2 Live transport split

| Audience | Transport | Direction |
|----------|-----------|-----------|
| Public viewers | SSE | Server → Client |
| Scorer + Referee | WebSocket | Bidirectional |
| Coordinator dashboards | SSE | Server → Client |
| TMs (own match) | SSE | Server → Client |
| Notification bell | SSE (`user:<uuid>:notifications`) | Server → Client |

### 7.3 Event-log architecture

`MatchEvent` (Postgres) is the system of record.

```
Scorer action → DRF endpoint → INSERT MatchEvent (idempotent on event_id)
                            └─► AuditEvent (transaction.on_commit)
                            └─► Redis pub/sub "match:<uuid>"
                                 ├─► WebSocket consumer (scorer/referee)
                                 └─► SSE endpoint (viewers)
```

Domain-event hooks (on `transaction.on_commit`):
- `match_finalized` → propagate advancement; update standings; update leaderboard; fire notifications.
- `card_issued` → recompute suspensions.
- `dispute_resolved` → propagate advancement per `dispute_cascade_policy`.
- `tournament_state_changed` → role notifications + rule freeze/unfreeze.
- `team_disqualified` → walkovers for future matches; stat policy applied.

### 7.4 Multi-tenancy enforcement

- `Organization` is the tenant boundary.
- Every tenant-scoped model has `organization` FK (denormalized on `MatchEvent` for query speed).
- Default manager filtered by current user's accessible orgs.
- `django-rules`-based per-object permissions.
- CI test suite asserts: user A in Org X cannot access any object in Org Y via DRF, SSE, or WebSocket.

### 7.5 RBAC layering

```
User
 ├── OrganizationMembership(user, organization, role, status)
 │     └── role ∈ {admin, co_organizer, media}     -- org-level
 │
 ├── TournamentMembership(user, tournament, role)
 │     └── role ∈ {game_coordinator}               -- tournament-level
 │
 ├── TeamMembership(user, team, role)
 │     └── role ∈ {team_manager}                   -- team-level
 │
 ├── PersonAccount(user, person)
 │     └─ role = player                            -- claimed player
 │
 └── MatchAssignment(user, match, role)
       └── role ∈ {match_scorer, referee}          -- match-level
```

Authorization resolves the user's effective permissions across all scopes for any action+object pair; cross-checked against the matrix in §3.2.

### 7.6 Idempotency

- Every write endpoint accepts `event_id` (UUID v4/v7 from client).
- DB unique constraint on `event_id`.
- Re-submission returns existing record (200 not 201).

### 7.7 Security baseline

- Cookies: `Secure`, `HttpOnly`, `SameSite=Lax` (Strict for sensitive endpoints). CSRF token in custom header.
- Headers: HSTS (1y), strict CSP, `X-Frame-Options: DENY` (override for v1.5 embeds), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` deny-by-default.
- CORS: dev-only `localhost:5173`; prod same-origin (CORS off).
- File uploads: 2 MB images, MIME-sniff via `python-magic`, dimension cap, content-type allowlist.
- Rate limits: login (5/min/IP, 20/min/email), signup (3/hour/IP, 1/day/email), password reset (3/hour/email), public SSE (100 conns/IP), public API read (60/min/IP).
- Brute-force lockout: 10 fails in 30 min → 15-min cooldown.
- Field-level encryption: `Person.dob` (`cryptography.fernet`).
- PII annotations: `Person.dob`, `Person.photo_url`, `User.email`.
- API key system: scoped (`read:public`, `read:tournament`, `write:scoring`); revocable; logged. v1.5.

### 7.8 Time zones

- All `DateTimeField`s UTC (`USE_TZ = True`).
- `Tournament.timezone` defaults to Org's TZ.
- Display: tournament-TZ on admin/scorer; viewer-TZ on public (with tournament-TZ tooltip).
- Date format: ISO on the wire; locale-formatted on display.
- **TZ change after `scheduled`**: blocked.

### 7.9 i18n

- `gettext` / `gettext_lazy` wraps from day 1; English-only catalog v1.
- Frontend: `react-i18next` (or `@lingui/react`); single English locale.
- v3: add Nagamese / Hindi / regional locales.

---

## 8. Data model — high level

| Entity | Notes |
|--------|-------|
| **User** | Django `AbstractUser` extended (email, name, photo, 2FA secret, recovery codes, deleted_at) |
| **Person** | Stable platform-scoped human (name, dob [encrypted], photo, optional `user_id`, deleted_at) |
| **Organization** | Tenant boundary; logo, brand color, status, timezone, slug, created_by, deleted_at |
| **OrganizationMembership** | (user, organization, role, status, invited_at, accepted_at, suspended_at, revoked_at) |
| **AdminInvitation** | (email, claimed_org_name, token_hash, expires_at, accepted_at, revoked_at, sent_by) |
| **SlugRedirect** | (entity_type, old_slug, new_slug, redirected_at) |
| **Sport** | Reference (`football` v1) |
| **SportRuleDefaults** | (sport, structured_rules JSONB, prose_template) |
| **Tournament** | (org, sport, name, slug, format, dates, time_zone, visibility, structured_rules JSONB override, prose_rules text, status, registration_open_at, registration_close_at, rule_freeze_at, dispute_window_hours, dispute_cascade_policy, lineup_miss_policy, team_registration_requires_approval, min_teams_to_start, archive_after_days, deleted_at, is_demo) |
| **TournamentMembership** | (user, tournament, role, scope) |
| **TournamentStateTransition** | (tournament, from_state, to_state, actor, reason, created_at) |
| **Venue** | (org, name, address, capacity, time_windows) |
| **Stage** | (tournament, name, format, order) |
| **Group** | (stage, name, ordinal) |
| **Team** | (org, tournament, name, short_name, crest_url, color, school, region, pool, tags, time_zone, registered_at, withdrawn_at, disqualified_at, deleted_at) |
| **TeamMembership** | (user, team, role=team_manager) |
| **Player** | (org, team, person, jersey_no, position, captain, is_goalkeeper, eligibility_status, deleted_at) |
| **Match** | (tournament, stage, round, slot, home_source JSONB, away_source JSONB, home_team, away_team, venue, scheduled_at, status, score_home, score_away, periods JSONB, lineup_home_id, lineup_away_id, two_legged_aggregate JSONB, is_bye, parent_match_id, kicks_off_team_id, defends_side_team_id) |
| **MatchStateTransition** | (match, from_state, to_state, actor, reason, created_at) |
| **MatchAssignment** | (match, user, role) |
| **Lineup** | (match, team, formation, starters JSON, bench JSON, captain_id, gk_id, submitted_at, submitted_by, version) |
| **MatchEvent** | (match, sequence_id, event_id UUID UNIQUE, type, minute, stoppage_time, payload JSONB, actor_user, server_ts, event_status, voided_by_event_id, corrected_from_event_id) |
| **PlayerSuspension** | (player, tournament, applies_to_match, reason, source_event, status) |
| **Dispute** | (match, raised_by, raised_at, description, status, resolution_outcome, resolved_by, resolved_at, resolution_notes) |
| **AuditEvent** | (org, tournament, match, actor_user, actor_role, event_type, target_type, target_id, payload JSONB, reason, ip, ua, created_at, deleted_user_handle) |
| **Notification** | (user, org, tournament, match, event_type, title, body, link, payload, priority, read_at, archived_at, created_at, group_key) |
| **NotificationPreference** | (user, event_type, channel, enabled) |
| **ScheduledNotification** | (notify_at, dispatch_payload, status) |
| **GenerationRun** | (target_type, target_id, inputs_hash, generated_at, last_manual_edit_at, report JSONB) |
| **APIKey** | (org, name, scopes, hashed_key, created_at, revoked_at) — v1.5 |

All primary keys = **UUID v7** (time-ordered).

---

## 9. Tech stack

### Backend
- Python 3.13, Django 5.x, DRF.
- Channels (WebSockets), `StreamingHttpResponse` async generators (SSE).
- Postgres 16 (JSONB, UUID v7).
- Redis 7 (channel layer, pub/sub, cache, scheduled-notification queue).
- `django-rules`, `django-axes`, `python-magic`, `cryptography`, `pwned-passwords-django`.
- pytest + pytest-django + factory_boy.
- ruff + mypy.

### Frontend
- React 18 + TypeScript + Vite.
- TanStack Query (server state), Zustand (UI state), React Router.
- TailwindCSS + shadcn/ui.
- react-hook-form + zod.
- dnd-kit.
- EventSource + native WebSocket.
- vitest + Playwright.
- eslint + prettier.
- react-i18next (English-only catalog v1).

### Deployment
- Single VPS (Ubuntu) — Postgres + Redis + Django ASGI + nginx + systemd.
- TLS via Caddy (preferred) or Certbot.
- Nightly `pg_dump` → S3-compatible (Backblaze B2 / Cloudflare R2).
- Sentry (errors), UptimeRobot / Healthchecks.io (uptime).
- VPS sizing: 4 vCPU / 8 GB / 80 GB SSD.

### Development
- Local Windows machine.
- Docker Compose for Postgres + Redis.
- Django runs natively for fast reload.
- Vite dev server `localhost:5173`; CORS for `localhost:8000` in dev only.
- `make dev` / `npm run dev:all`.
- Seed fixture: Super-admin, sample Org, demo users for each role, sample tournament.

### CI
- GitHub Actions: ruff, eslint, mypy, tsc, pytest, vitest on every PR.
- No CD pipeline in v1; manual deploy.

### Testing matrix

| Layer | Tool | Purpose |
|-------|------|---------|
| Backend unit | pytest | Pure logic |
| Backend integration | pytest-django | DRF + DB |
| Backend live | pytest + Channels test client + httpx SSE | WS/SSE correctness |
| Multi-tenancy isolation | pytest | Cross-org access denied (every endpoint) |
| Constraint solver | pytest | Bracket gen with team counts {3, 4, 5, 8, 13, 16, 17, 32} |
| Conflict-warning | pytest | Hash detection across edits |
| Idempotency | pytest | Replay same `event_id` → no duplicates |
| State machine | pytest | Every transition + every blocked transition |
| Permission matrix | pytest | Every cell of §3.2 (role × action) |
| Frontend unit | vitest | Components, hooks |
| E2E | Playwright | Full user journeys |
| Performance / load | k6 or Locust | SSE 5k concurrent |
| Manual QA | Pre-tournament checklist | Dry-run procedure |

---

## 10. Cross-cutting principles

1. **UUID v7 everywhere** (no sequential IDs).
2. **Auto-generate everything; manual edit allowed; conflict warnings.**
3. **Idempotent writes.**
4. **DB-first event log.**
5. **Append-only audit at DB level.**
6. **Multi-tenancy by Organization, day 1.**
7. **Separation of duties** (Scorer enters → Referee approves).
8. **Optimistic UI + reconnect resilience** with localStorage queue.
9. **SSE for one-way; WebSocket for two-way.**
10. **Schema-ready for future channels and formats.**
11. **State machines (not boolean flags) with audit-logged transitions.**
12. **Rule freeze at right boundary** (`registration_open` + per-match freeze on `live_first_half`).
13. **Person ↔ Player split** for cross-tournament identity.
14. **Match dependencies as typed references.**
15. **i18n + a11y from day 1.**
16. **Permission matrix is source of truth** for RBAC tests.
17. **Empty / error / loading states are part of v1**, not polish.

---

## 11. Phased delivery

| Phase | Scope | Done when |
|-------|-------|-----------|
| **v1.0** | Football vertical slice — everything in §4 In scope | One real tournament runs end-to-end |
| **v1.5** | Email channel + push fallback + iframe embed + Player claim flow + dispute photo/video evidence + API key system + scorer screen WCAG polish + two-person verification + bulk invite CSV + multi-Org-Admin + suspicious-login email + per-half sub limits + free-kicks-awarded event + goal-difference cap + data export tooling | First email-notified tournament |
| **v2.0** | Basketball / volleyball / badminton + full PWA offline scorer + multi-TZ + minor-consent flow + ELK observability | Inter-college multi-sport meet |
| **v2.5** | Cricket + voice notes + sponsor banners + full event taxonomy | Cricket tournament |
| **v3.0** | Indigenous Naga sports + Nagamese / Hindi localization | First indigenous-sport tournament |

---

## 12. Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Scorer network drops | Lost events, dispute | Idempotent retries + localStorage queue + 15-min outage warning |
| Indigenous sport rules undocumented | v3 stalls | Domain experts engaged in v2; explicit research budget |
| Group-stage tiebreaker disputes | Trust loss | Configurable order + mini-league algorithm + visible current-tiebreaker indicator |
| Audit log tampering | Credibility | Postgres-role append-only; v2 hash-chaining if needed |
| Backup failure during tournament | Catastrophic data loss | Verified nightly `pg_dump` + monthly restore drill |
| Single VPS overload during viral match | Public viewers locked out | Redis-cached state + horizontal-scale path |
| Organizer mis-edits bracket post-lock | Unfair advancement | Audit + amend workflow + Super-admin override |
| Multi-tenant data leak | Catastrophic privacy breach | Default manager filtering + CI assertion tests |
| Mid-tournament rule change corrupts results | Tournament invalidation | Rule freeze + amend workflow + grace + per-match freeze |
| Match dependency miscomputed | Wrong team in next match | Typed references + integration tests across formats |
| Disputed result cascades chaotically | Public-facing chaos | `dispute_cascade_policy` field; default lenient-for-played |
| File upload abuse | Server compromise | MIME-sniff + size + dimension cap + content-type allowlist |
| Account enumeration | Spam, social engineering | Generic error messages + same response time |
| DB migration during live tournament | Data corruption / downtime | Pre-flight check blocks; maintenance windows |
| PII leak via API | Privacy breach | Field-level encryption + serializer redaction + PII flag |
| Lineup never submitted | Tournament stalls | `lineup_miss_policy` auto-action + notifications |
| Referee never approves | Match stuck | `referee_approval_timeout_hours` + force-finalize |
| Orphaned org | Lost tenant | Auto-promote Co-organizer or Super-admin reassignment queue |
| Two-team-from-same-school accidental match | Soft-constraint violation | Generation report flags relaxed constraints; organizer can re-roll |
| Player on two teams in same tournament | Data corruption | Hard server-side constraint at registration |
| Lost 2FA device | User locked out | Recovery codes + Super-admin force-reset with audit |
| Account compromise | Data exposure | Force-logout-all-sessions tool (user + Super-admin) |

---

## 13. Open questions (deferred to design / planning phase)

- Per-object permission library: `django-rules` vs `django-guardian`. Preference: `django-rules`.
- Scheduled-task runner: DB+cron vs Django-Q2 vs Celery beat. Preference: DB+cron for v1.
- TLS terminator: Caddy vs nginx+Certbot. Preference: Caddy.
- Frontend folder structure: feature-folders vs layered.
- Test DB strategy for live-update tests.
- Crest / photo storage: S3-compatible vs local FS.
- Sport defaults seed format: YAML vs Django fixture.
- Field-level encryption library: `django-cryptography` vs raw `cryptography`.
- i18n FE library: `react-i18next` vs `@lingui/react`.
- Observability: Sentry-only vs Sentry + OpenTelemetry.

---

## 14. Decisions log (chronological)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Vertical slice, one sport e2e | Prove chassis before scaling sports |
| 2 | Football for v1 | Universally understood; well-documented |
| 3 | All three formats configurable + extensibility hook | Real tournaments use varied formats |
| 4 | Full role set (10 roles) | Granular permissions prevent retrofits |
| 5 | Hybrid live: SSE viewers + WS scorers | Right tool per use case |
| 6 | Online-required scorer + strong reconnect | 90% offline pain solved with 20% effort |
| 7 | Full Match Center for public live view | Best viewer UX |
| 8 | Knockout B + Round-robin B' (auto + drag-drop) | Standard workflow |
| 9 | UUID v7 everywhere | Time-ordered, indexable, leak-resistant |
| 10 | Soft constraint avoidance (school/region) | Real Nagaland tournaments need this |
| 11 | Structured rules + prose | System enforces what it can; prose covers human-only |
| 12 | Auto-generate everything; manual edit; conflict warnings | Coherent UX pattern |
| 13 | Standard audit log; append-only at DB level | Sufficient for college tournaments |
| 14 | Three-tier identity (Super-admin → Admin per Org → invited roles) | Multi-tenant by design |
| 15 | In-app notifications v1; preferences matrix scaffolded | Zero external deps; future-proof |
| 16 | DRF + React SPA | Mobile / rich-client future ambitions |
| 17 | Single VPS prod; local Windows dev | Cheap, simple, sufficient for v1 |
| 18 | React + TypeScript over Vue | Bigger ecosystem |
| 19 | Fold all PRD gap items (🔴+🟡+🟢) | Implementation plan as mechanical translation |
| 20 | Person ↔ Player split | Cross-tournament career stats |
| 21 | Tournament + Match state machines | Avoid haphazard status fields |
| 22 | Rule freeze at `registration_open` + per-match freeze | Prevent mid-tournament corruption |
| 23 | Match dependencies as typed refs | Schema-modeled, not inferred |
| 24 | Score correction & dispute lifecycle in v1 (text only) | Disputes happen; design once |
| 25 | GK / own-goal / penalty / voided event taxonomy | Football accuracy |
| 26 | Stoppage time on clock | Standard football UX |
| 27 | UTC storage; tournament-TZ default; viewer-TZ display | Cheap now, painful to retrofit |
| 28 | i18n scaffolding from day 1 | v3 = translation, not refactor |
| 29 | WCAG 2.1 AA baseline | Accessibility as principle |
| 30 | Field-level encryption for DOB; PII annotations | Privacy posture v1 |
| 31 | Migration policy: blocked while any tournament `live` | Operational safety |
| 32 | Soft-delete for Team / Player / Person / Tournament / User | Preserve history for audit + replay |
| 33 | File upload validation | Security baseline |
| 34 | Password policy (12 chars + breach check + argon2) | Modern auth baseline |
| 35 | Account-enumeration prevention | Modern auth baseline |
| 36 | Strict security headers | Modern web baseline |
| 37 | Multi-tenancy isolation tests in CI | Continuous validation of catastrophic failure class |
| 38 | Fold ALL logic-flow gaps (🔴+🟡+🟢) | Comprehensive PRD; no per-feature back-and-forth |
| 39 | Admin signup flows: Super-admin invite (canonical) + self-signup with approval | Curate Admins; flag-controlled openness |
| 40 | 7-day token expiry, 30-day pending-org auto-archive | Hygiene |
| 41 | Single-Org-per-Admin in v1 | Anti-abuse; relaxed v1.5 |
| 42 | Org ownership transfer + orphan auto-promotion | Org continuity |
| 43 | SlugRedirect on rename | URL stability |
| 44 | Membership status enum (8 values) | Accurate lifecycle modeling |
| 45 | Permission matrix as canonical source-of-truth (§3.2) | RBAC testability |
| 46 | Tournament transition triggers/preconds/notifs/audit fully specified | State machine completeness |
| 47 | Lineup deadline + miss policy (3 options) | Match progression guarantee |
| 48 | Match transition triggers similarly specified | State machine completeness |
| 49 | Per-match rule freeze on `live_first_half` | Mid-match safety |
| 50 | Walkover, double-walkover, abandonment, postponement policies | Real-world coverage |
| 51 | Score correction & dispute cascade with `dispute_cascade_policy` | Deterministic propagation |
| 52 | Three-or-more-way tied teams: mini-league algorithm | Tiebreaker correctness |
| 53 | Notification recipient list per event canonicalized | Notification correctness |
| 54 | Notification grouping (≥5/min same type → collapse) | UX polish |
| 55 | Self-suppression on own actions | UX polish |
| 56 | Always-on notifications for security + impersonation + own-team disputes | Safety |
| 57 | Empty / error / loading state catalog | v1 UI completeness |
| 58 | Welcome wizard + demo tournament seed | Onboarding |
| 59 | 2FA recovery codes at enrollment + Super-admin force-reset | Security baseline |
| 60 | Force-logout-all-sessions (user + Super-admin) | Compromise response |
| 61 | Captain armband transfer event (with or without sub) | Football accuracy |
| 62 | Concurrent scorer indicator + clock drift warning | Multi-scorer UX |
| 63 | DQ stats policy field | Stat-history hygiene |
| 64 | Min teams to start gate at `registration_closed` | Tournament viability |
| 65 | Open vs invite-only registration toggle + approval-required toggle | Tournament setup flexibility |
| 66 | Team disqualification cascades to walkovers | Bracket integrity |
| 67 | Lineup version field; late edits with referee approval | Auditable lineup edits |
| 68 | Org slug locked after first publish; rename = Super-admin + redirect | URL stability |
| 69 | TZ change blocked after `scheduled` | Schedule integrity |
| 70 | Audit log GDPR anonymization on user deletion (v1.5 prep) | Privacy + history |
| 71 | `abandoned → scheduled` guarded replay transition (reason required; scores/pens/sets/period cleared; original events retained in the immutable log; no advancement from `abandoned`) — draft v4 | Real tournaments replay abandoned matches; without this the only escape was cancel + manually recreate, losing the match's history |
| 72 | "Called to venue" is a nullable `Match.called_at` timestamp — an operational annotation of `scheduled`, NOT a new match status (§5.5 note); auto-clears on the transition to live — draft v5 | A `MatchStatus.CALLED` would ripple through every transition table, movability check, standings filter and status pill for what is presentation-only ops metadata; the control room needs only the flag |
| 73 | Tournament lifecycle is SELF-DRIVING (2026-07-02): `scheduled → live` fires on the first match kickoff, `live → completed` when every match is terminal (with a deferred-multi-stage guard), both post-commit from the match state machine; a manual audited "Wrap up tournament" endpoint force-completes with reason; COMPLETED stays public read-only, ARCHIVED remains the separate hide | The §5.2 tail was dead code — nothing ever set LIVE/COMPLETED, so the live-delete guard, migration pre-flight, dashboards, and public archives were all built on a status that never occurred |
| 74 | In-play interruptions (2026-07-02): LIVE/HALF_TIME may transition to WALKOVER/POSTPONED/CANCELLED (reason required from play; postpone keeps the partial score, replay-from-scratch stays the abandoned path); postpone/cancel are manager verbs, abandon stays pitch-side | §5.5 full matrix; a mid-match weather hold previously had ABANDONED as its only legal exit |
| 75 | Team-form protection is DEFAULT-CLOSED (2026-07-02): every institution needs a code token, bound link, or manager to submit/edit its teams; `has_code` drives the "ask the organizer" message | Opt-in protection let anyone register teams for any school that had no code issued |
| 76 | Discipline, badges, and school records are DERIVED, never stored (2026-07-02): suspensions compute from the card log per `rules.discipline`; badge awards reconcile idempotently from final results (append-only revocation); team/school records aggregate on demand, cross-year via normalized institution name (a canonical SchoolProfile FK can replace the resolver without changing API shapes) | Same invariant-4 discipline as scores/standings: corrections and voids converge automatically, no counters drift |
| 77 | Publish-all replays previewed per-leaf seeds + inputs hashes with a 409 drift guard (2026-07-02) | Preview ≡ commit (tenet 3) held only for the single-leaf path; publish-all silently re-rolled seeds |

---

## 15. Glossary

| Term | Meaning |
|------|---------|
| Organization (Org) | Tenant boundary; one Admin owns one Org |
| Tournament | Competitive event hosted by an Org |
| Stage | Sub-phase within a tournament |
| Group | Pool of teams in group-stage format |
| Bracket | Diagram of which match feeds which |
| Schedule | Time/venue allocation atop the bracket |
| Person | Stable platform-scoped human identity |
| Player | A Person's registration in a tournament for a team |
| Match Event | Immutable, ordered fact (goal, card, sub, etc.) |
| Generation Run | Record of an auto-generation; used by conflict-warning system |
| Soft constraint | Avoidance preference (same school, same region); may be relaxed |
| Hard constraint | Invariant the system never violates (different pools never play) |
| Eligibility freeze | Round after which rosters can no longer be edited |
| Rule freeze | Tournament state at which structured rules become immutable except via amend |
| Per-match rule freeze | Tighter freeze: a match's rules immutable once `live_first_half` |
| Match Center | Public detailed view of a single match |
| Stadium mode | Projector-friendly CSS variant of Match Center summary |
| SSE | Server-Sent Events — one-way HTTP push |
| Idempotency key | Client-generated UUID for safe retries |
| Domain-event hook | Function fired on `transaction.on_commit` after a state-changing action |
| Advancement | Propagation of a match result to dependent matches |
| Dispute window | Time post-`final` during which a dispute may be raised |
| Voided event | Previously-recorded event marked invalid; remains in history |
| WCAG 2.1 AA | Web accessibility baseline |
| Mini-league algorithm | Tiebreaker resolution among 3+ tied teams using only their head-to-head stats |
| Permission matrix | Canonical action × role authorization table (§3.2) |
| SlugRedirect | Mapping from old slug to new; preserves URL stability |
| Orphan org | Org without an active Admin; goes to Super-admin queue |

---

*End of PRD draft v4. All identified logic-flow gaps folded in.*
