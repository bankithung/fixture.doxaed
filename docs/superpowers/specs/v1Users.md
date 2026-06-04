# v1 — User Account Types

> **Status:** Draft v1 (in progress)
> **Date:** 2026-05-02
> **Owner:** graceschooledu@gmail.com (Super-admin / platform owner)
> **Companion to:** `2026-04-30-fixture-platform-prd.md` §2 and §3

This document defines every account type the Fixture Platform supports in v1.0. It is the authoritative source for the planning phase; PRD §2 and §3 reference it.

Each account type is specced along the same axes:

1. **Identity tier** — where this account sits in the platform hierarchy.
2. **Purpose** — what this account is for (and explicitly NOT for).
3. **Creation** — how the account comes into existence.
4. **Authentication** — login mechanics specific to this tier.
5. **Surface** — which UI this account uses (React SPA / custom Django templates / no UI).
6. **Capabilities** — what this account can do (links back to PRD §3.2 permission matrix where applicable).
7. **Schema** — which DB tables / fields back this account.
8. **Security boundary** — isolation, audit, threat model.

---

## 1. Super-admin (platform owner)

### 1.1 Identity tier

- **Top of the hierarchy.** Single human (you, the platform owner). Not multi-tenant; sits *above* the Organization boundary.
- Is **NOT** a tournament participant. Does not score matches, generate fixtures, manage teams, or run tournament workflows. Those are Admin (Org owner) responsibilities.
- Exists for **platform observability + targeted account intervention only**.

### 1.2 Purpose

**The Super-admin is a SaaS operator console user, not a tournament management user.**

In scope:
- Observe platform health: total users, active orgs, live matches, signup/retention KPIs, subscription metrics.
- Read user feedback / bug reports / feature requests submitted from inside the SPA.
- Respond to feedback messages.
- Intervene on account issues: suspend / unsuspend Org or User, reassign orphaned Orgs, force-logout-all-sessions, force-disable 2FA on a locked-out user, impersonate a user for debugging (audit-logged), approve / reject self-signup applications.
- Manage subscription lifecycle for Orgs: view payment status, cancel for refund, mirror payment-provider state.
- View the platform-wide audit log.
- Manage the Super-admin's own account (2FA, email, password).

Explicitly out of scope:
- Creating or editing tournaments, teams, players, brackets, matches, lineups, scores, disputes.
- Running fixture generation.
- Live scoring or refereeing.
- Anything in PRD §5.1–§5.13 (tournament/match operational flows).

### 1.3 Creation

- Single instance, created via Django management command:
  ```
  python manage.py createsuperuser
  ```
- Run **once** on the production VPS during initial deployment.
- `User.is_superuser = True`, `User.is_staff = True`.
- 2FA enrollment is **mandatory on first login** (cannot bypass).
- Recovery codes generated at enrollment (8 single-use, downloadable .txt) — stored offline by the operator.
- No self-signup path. No invite path. No second Super-admin in v1 (v1.5 may add a second-operator workflow).

### 1.4 Authentication

- Email + password (Django `AbstractUser` extended), same as all users.
- **2FA (TOTP) mandatory** — non-disableable for this tier.
- Sensitive verbs (suspend, impersonate, force-logout, refund) **re-prompt for password** regardless of session age.
- Session cookie scoped to the Super-admin subdomain (see §1.5). A Super-admin login does NOT grant SPA access; if you also hold an Admin role on an Org, you log into the SPA separately on the main domain.
- **IP allowlist** at nginx layer: only configured operator IPs (your home + office + VPN) can reach the Super-admin surface. Outside the allowlist returns 404 (not 403 — don't reveal the surface exists).
- Brute-force lockout: 5 failed logins in 30 min → 30-min cooldown for the Super-admin account specifically (stricter than the user policy in PRD §2.9).
- Lost 2FA: recovery code → 2FA reset. If recovery codes are also lost: SSH to the VPS + Django shell → `user.totp_devices.all().delete()`. No Super-admin can reset another Super-admin's 2FA via the UI in v1.

### 1.5 Surface

**Custom Django templates — NOT Django Admin, NOT the React SPA.**

#### Stack

- **Django 5** server-rendered views (class-based + function-based mix; class-based for list/detail, function-based for action endpoints).
- **TailwindCSS** — same design tokens as the React SPA so colors, spacing, typography are consistent. Tailwind compiled via the `django-tailwind` package or a standalone build step.
- **HTMX** — for partial page updates, AJAX submission, modal dialogs, inline edits, live KPI refresh. No SPA-style routing; URLs are real Django URLs.
- **Alpine.js** — for small client-side state (dropdowns, tabs, toggles). ~7 KB.
- **Chart.js** — for KPI visualizations. Server emits JSON; client renders charts.
- **Heroicons (SVG)** — same icon set as the React SPA.

This is sometimes called the **"DTH stack"** (Django + Tailwind + HTMX) or **"HOWL stack"** (HTMX + Tailwind + Alpine). Established 2026 pattern.

#### Mount point

- **Subdomain (locked):** `sadmin.fixture.doxaed.com`.
  - Separate Caddy/nginx virtual host with its own TLS cert.
  - Session cookie `Domain` attribute set to `sadmin.fixture.doxaed.com` only — does NOT leak to `fixture.doxaed.com` (the SPA).
  - Hard cookie isolation: a stolen Super-admin session cookie cannot be replayed against the SPA, and vice-versa.
- The default Django Admin URL `/admin/` is **disabled** in production (bot magnet).

#### Pages / sections

| # | Page | URL | Purpose |
|---|------|-----|---------|
| 1 | **Dashboard** | `/` | KPI overview: total users, active orgs, live matches, 30-day signup chart, recent feedback panel, pending approvals panel |
| 2 | **Users** | `/users/` | Searchable/filterable list; detail page shows orgs, last login, audit history; action buttons (suspend, force-logout, force-disable 2FA, impersonate) |
| 3 | **Organizations** | `/orgs/` | List with status filter (active / pending_approval / suspended / orphaned); approve/reject pending; reassign orphan; suspend |
| 4 | **Feedback inbox** | `/feedback/` | Unread/read/responded filters; row click → detail + reply form; backed by `Feedback` table (§1.7) |
| 5 | **Audit log** | `/audit/` | Global platform audit log; filterable by actor / target / event_type / date range; CSV export |
| 6 | **Analytics** | `/analytics/` | Deep-dive: cohort retention, DAU/MAU, churn rate, tournament throughput per org |
| 7 | **Settings** | `/settings/` | Super-admin's own account: 2FA management, email change, recovery codes regen, password change |
| — | ~~Subscriptions~~ | `/subscriptions/` | **Deferred to v1.5** along with monetization. Schema for `Subscription` / `Plan` is NOT created in v1.0 |

Every page uses a consistent shell: left sidebar (7 nav items in v1.0 — Subscriptions slot reserved for v1.5), top bar (account dropdown), main content area. Mobile-responsive but optimized for desktop (this is a desktop-first console).

#### Project structure

```
backend/
└── apps/
    └── sadmin/                        # Dedicated app — single-purpose
        ├── __init__.py
        ├── urls.py                    # All /sadmin/* routes
        ├── views/
        │   ├── dashboard.py
        │   ├── users.py
        │   ├── orgs.py
        │   ├── feedback.py
        │   # subscriptions.py — DEFERRED to v1.5
        │   ├── audit.py
        │   ├── analytics.py
        │   └── settings.py
        ├── decorators.py              # @superadmin_required, @password_reprompt
        ├── kpis.py                    # Pure functions: total_users(), dau(), mau(), tournament_throughput()
                                        # NOTE: churn_rate() and mrr() deferred to v1.5 (require monetization schema)
        ├── charts.py                  # Chart.js JSON serializers
        ├── actions.py                 # Domain logic for verbs (suspend_org, impersonate, etc.)
        └── templates/
            └── sadmin/
                ├── base.html          # Shell (sidebar + top bar)
                ├── dashboard.html
                ├── users/
                │   ├── list.html
                │   └── detail.html
                ├── orgs/
                ├── feedback/
                # subscriptions/ — DEFERRED to v1.5
                ├── audit/
                ├── analytics/
                ├── settings/
                ├── partials/          # HTMX partial templates
                │   ├── kpi_card.html
                │   ├── user_row.html
                │   ├── feedback_row.html
                │   └── ...
                └── components/        # Reusable template tags
                    ├── chart.html
                    ├── table.html
                    ├── modal.html
                    └── action_button.html
```

**Why a separate `sadmin` app:**
- Hard URL boundary; trivial to IP-allowlist at nginx (`location /sadmin/ { ... }` or virtualhost).
- Hard permission boundary; every view in the app gets `@superadmin_required`.
- Trivially extractable or deletable later if the design changes.

### 1.6 Capabilities (verbs)

Per PRD §3.2 the Super-admin has full row-1 privileges. The custom console exposes them as named, audit-logged actions:

| Verb | Target | Audit reason required | Re-prompt password | Notification fired |
|------|--------|----------------------|--------------------|--------------------|
| `approve_organization` | Org (pending_approval) | optional | no | Welcome email to Admin |
| `reject_organization` | Org (pending_approval) | required | no | Rejection email to Admin |
| `suspend_organization` | Org | required (≥20 chars) | yes | Email to all Org members |
| `unsuspend_organization` | Org | optional | yes | Email to Org Admin |
| `reassign_orphan_org` | Org (orphaned) | required | yes | Email to new Admin (consent flow) |
| `suspend_user` | User | required | yes | `account_security_alert` (always-on) |
| `unsuspend_user` | User | optional | yes | Email to user |
| `force_logout_all_sessions` | User | optional | yes | `account_security_alert` |
| `force_disable_2fa` | User | required | yes | `account_security_alert` + email |
| `impersonate_user` | User | required | yes | `impersonation_session_started` (always-on, to impersonated user) |
| `respond_to_feedback` | Feedback row | n/a | no | Email to feedback submitter |
| ~~`cancel_subscription`~~ | Subscription | required | yes | **Deferred to v1.5** (monetization) |
| ~~`refund_subscription`~~ | Subscription | required | yes | **Deferred to v1.5** (monetization) |

**All verbs:**
- Write an `AuditEvent` row with `actor_user = <super-admin>`, `actor_role = 'super_admin'`, `target_*`, `payload`, `reason`, `ip`, `ua`, `created_at`.
- Are gated by `@superadmin_required` + `@password_reprompt` decorators (where indicated).
- Cannot be performed against another Super-admin (in v1, there's only one anyway).

### 1.7 Schema additions (over current PRD §8)

These tables are needed to back the Super-admin console.

#### v1.0 (ships now)

| Entity | Fields | Notes |
|--------|--------|-------|
| **`Feedback`** | id (UUID v7), user_id (nullable for anonymous), org_id (nullable), type (enum: `bug`, `feature`, `complaint`, `question`, `other`), subject, body, status (enum: `unread`, `read`, `responded`, `closed`), created_at, page_context (URL submitted from), user_agent, responded_by, responded_at, response_body | Submitted via a "Feedback" widget in the SPA; visible only in Super-admin console |
| **`UsageEvent`** | id (UUID v7), user_id (nullable), org_id (nullable), event_type, payload JSONB, created_at | Append-only; feeds KPI dashboards. Cheap firehose; partitioned by month if it grows large |
| **`KPISnapshot`** | id (UUID v7), metric_name, value, computed_at, scope (enum: `platform`, `org`), scope_id | Optional: cached daily snapshots so dashboards don't re-query the firehose every load |

**No `SuperAdminAction` table.** Reuse `AuditEvent` with an `actor_role='super_admin'` filter. The Super-admin console's `/audit/` page is just a filtered view of `AuditEvent`.

#### v1.5 (deferred — monetization)

| Entity | Status |
|--------|--------|
| **`Subscription`** | NOT created in v1.0. Schema lands with monetization in v1.5. |
| **`Plan`** | NOT created in v1.0. Schema lands with monetization in v1.5. |

**Implication for v1.0:** every Org is implicitly on a "free / unlimited" tier. No feature gating, no plan limits, no MRR. KPI dashboard does NOT include monetization metrics (MRR, churn, ARPU, plan distribution). Those panels appear only in v1.5.

### 1.8 Security boundary

#### Network

- Caddy config (preferred per PRD §9):
  ```
  sadmin.fixture.doxaed.com {
      @allowed_ips remote_ip <operator_ip_1> <operator_ip_2>
      handle @allowed_ips {
          reverse_proxy django_asgi:8000
      }
      handle {
          respond 404  # don't reveal the surface to non-allowlisted IPs
      }
  }
  ```
- Equivalent nginx + Certbot setup also acceptable (per PRD §13 open question on TLS terminator).
- TLS via Caddy or Certbot (whichever the main app uses).
- HSTS, strict CSP (no inline JS except where HTMX needs `hx-*` attribute handling), `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin`.

#### Application

- `@superadmin_required` decorator: checks `request.user.is_superuser AND request.user.is_active AND not request.user.deleted_at` on every view in the `sadmin` app.
- `@password_reprompt(max_age_seconds=300)`: on sensitive verbs, the user must re-enter their password within the last 5 min.
- CSRF token in custom header (same pattern as PRD §2.9 / §7.7).
- Rate limit on the login endpoint: 5/min/IP.
- Session cookie scoped to `sadmin.fixture.doxaed.com` only; not sent to `fixture.doxaed.com`.

#### Audit

- Every action verb writes an `AuditEvent` row.
- Login + logout events for the Super-admin are themselves audit-logged.
- Failed logins audit-logged (separate event type).
- Impersonation sessions are flagged: the impersonated user receives an `impersonation_session_started` notification (always-on, non-suppressible per PRD §5.14); every action taken during impersonation has `actor_user = impersonator`, `payload.impersonating = <impersonated_user_id>`.

#### Threat model

- **Compromise of operator IP:** mitigated by 2FA. Even with stolen IP + password, no 2FA = no entry.
- **Compromise of Super-admin laptop:** force-logout-all from a second device or VPS shell; rotate password; regenerate 2FA recovery codes.
- **Insider risk (you):** there's only one of you in v1. v1.5 may add multi-operator + four-eyes confirmation on destructive verbs.
- **Postgres dump leak:** Super-admin password is argon2-hashed; 2FA secret encrypted at rest; recovery codes hashed.

### 1.9 What this account does NOT have

- No tournament-management UI. Cannot generate brackets, edit fixtures, score matches.
- No SPA login. Logging in at `fixture.doxaed.com/login` with the Super-admin credentials is rejected (the Super-admin tier is not a recognized SPA role).
- No mobile-optimized UX. Desktop-first console; mobile responsive is a courtesy, not a primary use case.
- No public profile, no public name. The Super-admin is invisible to all other users except via audit log entries (where `actor_role='super_admin'` appears).
- No org membership. The Super-admin is **not** a member of any Organization in `OrganizationMembership`. Authorization for Super-admin actions flows from `User.is_superuser`, not from any membership row.

### 1.10 Onboarding sequence (first-time setup)

1. Initial deploy: SSH to VPS → `python manage.py createsuperuser` → enter email + password.
2. First login at `https://sadmin.fixture.doxaed.com/login`.
3. **Forced 2FA enrollment** (cannot proceed past this screen).
4. Download recovery codes (.txt).
5. Land on `/dashboard/` — empty state if no users yet (PRD §5.12 catalog).
6. (Optional) Configure operator IP allowlist via a settings flag, OR maintain it in nginx config (recommended).

### 1.11 Build phase

- **v1.0** — Super-admin console ships in v1.0 alongside the rest of the platform.
- Cannot be deferred to v1.5: Org approval flow (PRD §2.2 Flow B) requires the Super-admin console to exist on day 1, since self-signup creates pending Orgs that need a UI to approve.
- Stopgap during early v1.0 development (before the custom console is ready): use the Django shell over SSH for the 2–3 verbs needed (approve_organization, suspend_user). This is acceptable for the first ~4 weeks of dev, not for production.

### 1.12 Decisions (locked) and remaining open questions

#### Locked decisions

| Decision | Outcome |
|----------|---------|
| Mount point | **Subdomain `sadmin.fixture.doxaed.com`** (cookie-isolated from SPA). |
| Build phase | **v1.0** (Org approval flow requires it on day 1). |
| Surface | **Custom Django templates** (DTH stack: Django + Tailwind + HTMX + Alpine + Chart.js). NOT Django Admin. NOT React. |
| Monetization | **Deferred to v1.5.** No `Subscription` / `Plan` tables in v1.0. No Subscriptions page. No MRR / churn / ARPU on the dashboard. Every Org is implicitly free-tier in v1.0. |
| Anonymous feedback | **Allowed.** `Feedback.user_id` is nullable; non-logged-in viewers can submit feedback. |
| `SuperAdminAction` table | **Not created.** Reuse `AuditEvent` filtered by `actor_role='super_admin'`. |

#### Remaining open questions (deferrable; not blocking)

- **Single Super-admin or pair in v1?** Currently single. v1.5 may add a second operator + four-eyes confirmation on destructive verbs (suspend, refund, force-disable 2FA). Decision: defer to v1.5 unless a reason emerges.
- **"As-Admin" preview tool?** A way to *preview* what an Org Admin sees without full impersonation. Useful for support without notification noise. Decision: defer to v1.5.
- **KPISnapshot caching cadence?** Daily? Hourly? On-demand-only? Decision: defer until first dashboard performance issue surfaces; start with on-demand SQL.

---

## 2. Admin (Organization owner)

### 2.1 Identity tier

- **Root of one Organization's user tree.** Every other in-Org account exists because an Admin (or someone Admin delegated to) created them.
- **Multiple Admins per Org allowed**, all with equal default access — except for a small set of **owner-only verbs** reserved to whichever Admin holds `is_org_owner = True`.
- **Exactly one Admin per Org has `is_org_owner = True`** at any time. Enforced by DB constraint.
- A user can be Admin of **at most one Organization** (PRD §2.4 unchanged). The same user may hold non-Admin roles in any number of other Orgs.
- Admin does NOT exist above the Org boundary. There is no "platform Admin" — that's Super-admin (§1).

### 2.2 Purpose

In scope:
- Operate one Organization end-to-end: create tournaments, manage members, configure rules, resolve disputes, oversee scoring.
- Invite/manage all sub-roles (Co-organizer, Game coordinator, Match scorer, Referee, Team manager) and additional Admins.
- Grant or revoke individual modules to specific users beyond their role's defaults (per-user module override; see Appendix A).
- Approve / reject team registrations, force-finalize stuck matches, override player suspensions (with audit + reason), amend rules post-freeze (with audit + grace period per PRD §5.2).
- Configure Org branding, time zone, slug, public-page settings.

Out of scope:
- Platform-wide visibility (other Orgs' data, total platform users, etc.) — that's Super-admin.
- Creating Organizations beyond their own — `is_org_owner = True` does NOT permit creating a second Org.
- Any verb scoped to a Match they aren't assigned to as Scorer/Referee — they retain *override* authority (audit-logged) but the Match is operationally owned by its assignees.

### 2.3 Creation paths

Two paths into the Admin role for a new Org (PRD §2.2):

**Path A — Super-admin invite (canonical):**
1. Super-admin invites email → claimed Org name.
2. Invitee signs up via invite link → `User` created → `Organization` created → `OrganizationMembership(user, org, role=admin, status=active, is_org_owner=True)`.

**Path B — Self-signup + Super-admin approval:**
1. Visitor signs up at `/signup` → `User(is_active=False)` + `Organization(status=pending_approval)` + `OrganizationMembership(role=admin, status=pending_approval, is_org_owner=True)`.
2. Super-admin approves via `/sadmin/orgs/` → status flips to `active` → welcome email.

**Path C — Promotion of an existing in-Org user to Admin:**
1. Existing Admin (any of the N Admins) invites a current Co-organizer (or directly invites a new email as Admin) → new `OrganizationMembership(role=admin, is_org_owner=False, invited_by=<inviter>)`.
2. Promoted Admin gets all default Admin modules (Appendix A) but cannot perform owner-only verbs.

**`is_org_owner` assignment rule:** the **first** Admin of an Org (whoever creates it via Path A or Path B) is automatically `is_org_owner=True`. Subsequent Admins added via Path C default to `is_org_owner=False`. Ownership transfer (§2.10) is the only way to flip the bit.

### 2.4 Authentication

- Email + password (PRD §2.9, §2.10 password policy).
- **2FA (TOTP) optional in v1.0 but strongly recommended** for any user holding `is_org_owner=True`. The SPA prompts on first login and again after 7 days if still un-enrolled (dismissable).
- Session cookie scoped to **`fixture.doxaed.com`** (the main SPA domain) — does NOT leak to `sadmin.fixture.doxaed.com`.
- "Remember me" 30-day session; sensitive verbs (delete Org, ownership transfer, role changes, rule amend post-freeze, override suspension) re-prompt for password regardless.
- Password change resets all active sessions except the current one.
- Lockout policy: 10 failed logins in 30 min → 15-min cooldown (PRD §2.9).

### 2.5 Surface

- **React SPA** at `https://fixture.doxaed.com`. Same SPA used by all in-Org roles; capabilities differ by `effective_modules(user, org)` (Appendix A).
- **Top-bar Org switcher** if user holds memberships in 2+ Orgs. Switching changes the active Org context and re-fetches data; URL reflects active Org slug.
- **Top-bar role context indicator** if user holds 2+ roles in the same Org. Shows "Acting as: Admin · Team manager (Bayavü FC)". Click → toggle which role's UI affordances are foregrounded. Note: this is a UX hint, not a permission boundary — the user still has the union of all their roles' modules at all times.
- **Welcome wizard on first login** (PRD §5.17): set Org logo + brand color, set Org timezone, optionally seed a demo tournament. Skippable; re-launchable from settings.

### 2.6 Capabilities

#### Default module access (all Admins, both `is_org_owner=True` and `False`)

By default, every Admin has access to **all Org-scoped, Tournament-scoped, and Match-scoped modules** for their Org. See **Appendix A** for the full module catalog and the role → default module mapping.

Concretely, an Admin's default modules cover:
- Org Settings, Member Directory, Org Audit Log, Tournament List, Org Branding.
- Tournament Editor, Bracket Editor, Schedule Editor, Team Registration Manager, Player Roster Manager, Lineup Manager, Tournament Audit Log.
- Scoring Console (override), Referee Console (override), Match Center admin view, Lineup Submission (override).
- Personal modules (notification preferences, profile, feedback widget).

#### Owner-only verbs (`is_org_owner=True` only)

| Verb | Notes |
|------|-------|
| **Delete Organization** | Soft-delete the entire Org; all tournaments archive; audit-logged with reason ≥20 chars; password re-prompt + email confirmation. |
| **Transfer ownership** | Pass `is_org_owner=True` to another Admin or Co-organizer. Two-step (initiate + accept). PRD §2.7 flow. |
| **Demote another Admin to non-Admin role** | Removing the Admin role from another `OrganizationMembership` row. Non-owner Admins can demote sub-roles but not other Admins. |
| **Change billing / subscription** | v1.5 (monetization deferred). Owner is the credit-card-on-file holder. |
| **Revoke ownership of the Org** *(implicitly via ownership transfer)* | Only the current owner can initiate transfer. |

All other Org verbs (invite/revoke sub-roles, create tournaments, edit rules, override suspensions, amend rules, etc.) are available to **all Admins equally**.

#### Per-user module overrides

The Admin can grant or revoke individual modules to/from any in-Org user (any role) via the Member Directory. See Appendix A §A.4 for the model. **Both schema AND Admin UI ship in v1.0.** Day-one capability for Admins to grant edge-case access without role promotion.

**UI surface (v1.0):**
- Member Directory row → "Manage modules" action → opens a per-user module matrix.
- Matrix shows every module from Appendix A §A.2 with three states per row: ✅ default (from role), ➕ granted-extra, ➖ revoked-default.
- Toggling any cell to a non-default state requires a **reason ≥20 chars** before submit.
- Grants/revokes are immediate; resolver picks them up on the next request.
- All grants/revokes are audit-logged with `actor`, `target_user`, `module_slug`, `granted` (bool), `reason`, `before`/`after` snapshots.
- Bulk actions (grant module X to N users): supported in v1.0 via multi-select in the matrix.

### 2.7 Schema

```python
# accounts/models.py
class User(AbstractUser):
    # email, name, photo, 2FA, recovery codes, deleted_at
    # (existing PRD §8 User entity)
    ...

# organizations/models.py
class OrganizationMembership(models.Model):
    id = UUID v7 PK
    user = FK(User)
    organization = FK(Organization)
    role = enum('admin', 'co_organizer', 'game_coordinator',
                'match_scorer', 'referee', 'team_manager')   # NOTE: 'media' deferred to v1.5
    status = enum(...)                                        # PRD §3.3 (8 values)
    is_org_owner = BooleanField(default=False)                # NEW for §2
    invited_by = FK(User, null=True, on_delete=SET_NULL)      # informational; survives inviter departure (Q5)
    invited_at = DateTimeField(null=True)
    accepted_at = DateTimeField(null=True)
    suspended_at = DateTimeField(null=True)
    revoked_at = DateTimeField(null=True)
    created_at = DateTimeField(auto_now_add=True)
    updated_at = DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            # A user can hold multiple memberships per (user, org), but only ONE row
            # per (user, org, role) — i.e., no duplicate role rows.
            UniqueConstraint(fields=['user', 'organization', 'role'],
                             condition=Q(status__in=['active', 'invited',
                                                     'pending_email_verification',
                                                     'pending_approval']),
                             name='unique_active_role_per_user_per_org'),

            # Exactly one is_org_owner=True per Org (among active admin memberships).
            # MUST be DEFERRABLE INITIALLY DEFERRED to allow atomic ownership-swap
            # within a single transaction (outgoing flips False, incoming flips True).
            UniqueConstraint(fields=['organization'],
                             condition=Q(is_org_owner=True, status='active', role='admin'),
                             deferrable=Deferrable.DEFERRED,
                             name='one_owner_per_org'),

            # User can be admin of at most ONE Org (PRD §2.4 unchanged).
            # Widened to include pending statuses to prevent race during simultaneous
            # signups: a user with pending_approval admin row in Org X cannot also
            # have a pending row in Org Y, eliminating dual-approval race.
            UniqueConstraint(fields=['user'],
                             condition=Q(role='admin',
                                         status__in=['active', 'invited',
                                                     'pending_email_verification',
                                                     'pending_approval']),
                             name='single_org_per_admin_user'),
        ]
```

**Permission resolution** for any (user, org) pair returns:
```
roles = [m.role for m in OrganizationMembership.objects.filter(
    user=user, organization=org, status='active')]
modules = effective_modules(user, org)  # see Appendix A §A.4
is_owner = OrganizationMembership.objects.filter(
    user=user, organization=org, role='admin', is_org_owner=True, status='active'
).exists()
```

### 2.8 Multi-Org rules (recap)

| Scenario | Allowed? |
|----------|----------|
| User A is Admin of Org X, Team manager in Org Y | ✅ |
| User A is Admin of Org X, Admin of Org Y | ❌ (PRD §2.4) |
| User A is Admin and Co-organizer in same Org X | ✅ (Q3 — multiple roles per (user, org)) |
| User A is Admin (`is_org_owner=False`) and Team manager in same Org X | ✅ |
| User A is Admin (`is_org_owner=True`) of Org X and Player (claimed Person) in Org Y | ✅ |
| Two users hold `is_org_owner=True` in same Org X | ❌ (DB constraint) |

### 2.9 Delegation (the invite tree)

Per Q1 (locked):

| Inviter | Can invite |
|---------|-----------|
| **Admin** | Admin (sub-Admin, `is_org_owner=False`), Co-organizer, Game coordinator, Match scorer, Referee, Team manager |
| **Co-organizer** | Co-organizer (peer), Game coordinator, Match scorer, Referee, Team manager |
| **Game coordinator** | Game coordinator (peer, same assigned tournament), Match scorer, Referee, Team manager (all scoped to own assigned tournament) |

**Rules:**
- Inviting an existing user (already has account) adds an `OrganizationMembership` row; no new account. Invitee accepts via in-app + email confirm.
- Inviting a new email creates a pending `User(is_active=False)` + pending membership; invitee completes signup via invite link.
- **Promotion to Admin** by a non-owner Admin: allowed (Q2 — multiple Admins, same access). New Admin defaults `is_org_owner=False`.
- **Promotion to `is_org_owner=True`**: only via ownership transfer initiated by current owner (§2.10). No direct invite path.
- Invite token: 7-day expiry, single-use (PRD §2.2).
- See §2.13 below for full invite flow.

### 2.10 Lifecycle

#### Status transitions

```
invited → pending_email_verification → active
                 ↓
            (Path B only)
                 ↓
         pending_approval → active
```

Any active membership can transition to:
- `suspended` (by another Admin or Super-admin; reason required, audit-logged)
- `revoked` (permanent; audit-logged)
- `left` (user voluntarily exits the Org)
- `declined` (only from `invited`, never from `active`)

#### Ownership transfer (PRD §2.7, refined)

Only `is_org_owner=True` Admin can initiate transfer.

1. Owner opens **Org settings → Transfer ownership** → picks any Admin or Co-organizer in same Org as recipient.
2. Owner re-prompts password + confirms.
3. Recipient gets in-app notification + email: "Accept ownership of {Org}? Yes / No". Token-gated.
4. On accept: atomic swap — `is_org_owner` flips to recipient; outgoing owner becomes regular Admin (or Co-organizer if recipient was previously a Co-organizer being promoted to Admin in the same step).
5. Audit-logged with both actors.

#### Orphan handling (PRD §2.7, multi-Admin refinement)

If `is_org_owner=True` Admin deletes account or is suspended:
- **If another active Admin exists** → first by `created_at` is auto-promoted to owner. No queue, no Super-admin involvement. Audit + email to all Org members.
- **If no other Admin but ≥1 active Co-organizer exists** → first Co-organizer by `created_at` is auto-promoted to Admin AND owner. Audit + notification.
- **If no Admin and no Co-organizer** → Org enters `orphaned` status. Surfaces in `/sadmin/orgs/` (Super-admin reassignment queue). Super-admin picks any user and reassigns; user must consent via email confirmation.

#### Suspension

- Other Admins can suspend each other (same access, Q2). Audit-logged.
- Owner cannot be suspended by non-owner Admins. To suspend the owner, ownership must first be transferred. *Or* Super-admin can suspend the owner directly (`/sadmin/users/`).
- A suspended Admin loses all module access immediately; the Org remains operational via other Admins.

### 2.11 What Admin does NOT have

- **No platform-wide visibility.** Cannot see other Orgs, total platform users, platform audit log. That's Super-admin.
- **No access to other Orgs' data.** Multi-tenancy isolation (PRD §7.4) enforces this regardless of role.
- **No Super-admin verbs.** Cannot impersonate users, force-disable 2FA on others (only Super-admin can), respond to platform-wide feedback.
- **No second Org.** `is_org_owner=True` does not enable creating another Org.
- **No bypass of rule freeze.** Even Admins follow the amend-with-grace workflow once a Tournament hits `registration_open` (PRD §5.2).
- **No bypass of append-only audit.** No Admin (including owner) can DELETE or UPDATE `AuditEvent` rows. DB role denies the operation.
- **No mid-match rule edit.** Per-match freeze applies to all roles (PRD §5.5).

### 2.12 Onboarding

First login as a newly-active Admin:

1. **Email verification screen** if not already verified.
2. **2FA enrollment prompt** (skippable; re-prompts in 7 days).
3. **Welcome wizard** (PRD §5.17, 3 steps):
   - Step 1: Org logo + brand color.
   - Step 2: Org timezone (defaults to inferred from browser).
   - Step 3: Optionally seed Demo tournament.
4. **Land on Org dashboard** (`/o/<org-slug>/`). Empty state per PRD §5.12 if no tournaments yet.

For sub-Admins added via Path C: same flow except the welcome wizard is skipped (Org is already configured).

### 2.13 Invite flow (canonical for all in-Org roles)

This flow is referenced by §3 (Co-organizer) and below — defined here once.

```
1. Inviter opens "Invite member" in Member Directory
   ├─ Form fields:
   │    • email (required)
   │    • role (required; constrained to inviter's invitable set per §2.9)
   │    • optional message (≤500 chars)
   │    • role-specific scope:
   │        - Scorer/Referee: list of matches to assign (or "assign later")
   │        - Team manager: team to manage (or "create new team")
   │        - Game coordinator: tournament(s) to coordinate (sport-narrowing deferred to sport module)
   │    • optional module overrides (v1.0 UI on invite form — pre-populates MembershipModuleGrant rows on accept)
   │
   ├─ Server-side validation:
   │    • Email format
   │    • Inviter has permission to invite this role (§2.9)
   │    • If role=admin: email is not already Admin elsewhere (PRD §2.4)
   │    • If user with email already in this Org with this role → reject
   │      "Already a member with this role"
   │
   └─ Submit

2. System checks if email already has a User account:
   ├─ EXISTING USER, NOT in this Org with this role:
   │    • Create OrganizationMembership(status=invited)
   │    • Send invite email (lighter copy: "You've been invited to {Org}")
   │    • Invite link: /invite/<token>
   │
   ├─ EXISTING USER, already in this Org with this role:
   │    • Reject at form validation (above)
   │
   └─ NO EXISTING USER:
        • Create User(is_active=False)
        • Create OrganizationMembership(status=invited)
        • Send invite email (full signup copy)
        • Invite link: /invite/<token>

3. Email contents:
   ├─ Subject: "{Inviter Name} invited you to join {Org Name} on Fixture"
   ├─ Body: role, optional message, accept/decline buttons, 7-day expiry note
   └─ Token: single-use, signed, 7-day expiry

4. Invitee clicks link → /invite/<token>:
   ├─ EXISTING USER:
   │    • Login prompt (or auto-login if already authenticated)
   │    • Accept screen: "Accept invite to {Org} as {Role}? Yes / No"
   │
   └─ NEW USER:
        • Signup form: name + password (email pre-filled, locked)
        • Email auto-verified (proven via invite token)
        • Acceptance is implicit on signup completion

5. On Accept:
   • OrganizationMembership.status = 'active'
   • OrganizationMembership.accepted_at = now
   • Audit log entry (event_type='member_invite_accepted')
   • Notification to inviter ("X accepted your invite")
   • Welcome notification to invitee ("Welcome to {Org}")
   • If role=admin: is_org_owner=False (only the FIRST admin or transfer can flip this)

6. On Decline:
   • OrganizationMembership.status = 'declined'
   • Token invalidated
   • Inviter notification ("X declined your invite")
   • Audit log entry

7. Token expiry (7 days, no action):
   • OrganizationMembership.status remains 'invited' but token rejected
   • Auto-archive after 30 days total inactivity (PRD §2.2)
   • Inviter sees "Invite expired" in Member Directory; can resend

8. Cancel by inviter (before acceptance):
   • OrganizationMembership.status = 'revoked'
   • Token invalidated
   • Audit log entry
```

**Edge cases handled:**
- Email already invited (still pending): show "Resend or cancel?" — no duplicate row.
- Inviter loses Admin role between sending and acceptance: invite still valid; accepted membership audit-tags `invited_by` as the now-non-Admin user.
- Org suspended between invite send and accept: invite blocked; user sees "This organization is currently suspended".
- Bulk invite via CSV: v1.5 (PRD §3.5).

### 2.14 Decisions (locked) and remaining open questions

#### Locked decisions

| Decision | Outcome |
|----------|---------|
| Multi-Admin model | **Multiple Admins per Org, all equal access**, except one holds `is_org_owner=True` for owner-only verbs. |
| Owner-only verbs | Delete Org · Transfer ownership · Change billing (v1.5) · Demote another Admin |
| Role count per (user, org) | **Multiple roles allowed.** Permissions = union of all active roles' modules. |
| Org switcher in SPA | **Yes.** Top-bar dropdown for users in 2+ Orgs. |
| Role toggle in SPA | **Yes.** Top-bar indicator for users with 2+ roles in same Org. UX hint only — does not gate permissions. |
| Sub-roles when inviter leaves | **Stay active.** `invited_by` is informational. |
| Media role in v1.0 | **Dropped.** Reintroduce in v1.5 if needed. |
| Co-org invite scope | Co-organizer can invite peer Co-organizers AND all sub-roles. |
| Game coord invite scope | Game coordinator can invite peer Game coordinators AND scorers/referees/team managers (all scoped to their assigned tournament). Sport-level narrowing deferred to sport module. |
| Per-user module overrides | **Schema AND full Admin UI both ship in v1.0 (locked).** Member Directory exposes a per-user module matrix with grant/revoke + reason ≥20 chars + audit logging. Bulk grant via multi-select supported. |
| First Admin = owner | First Admin of any Org is automatically `is_org_owner=True`. |
| Promotion to owner | Only via ownership transfer (no direct invite path to owner). |

#### Remaining open questions (non-blocking)

- **Concurrent ownership-transfer attempts** (two transfers in flight): should the second one auto-cancel the first, or queue, or reject? Recommend: reject the second with "transfer already pending" until first resolves or expires. Decision: defer to implementation phase.
- **Demoted owner**: when ownership transfers, does outgoing owner stay Admin (`is_org_owner=False`) or become Co-organizer? PRD §2.7 says "Outgoing user becomes Co-organizer (or chosen role)". Recommend: Admin presents a dropdown at transfer time — "After transfer, I will be: Admin (default) / Co-organizer / leave Org". Decision: confirm at implementation.
- **Minimum Admin count per Org**: should an Org always have ≥1 Admin? Currently enforced implicitly by orphan handling (last Admin leaving auto-promotes a Co-org). No additional constraint needed.

---

## 3. Co-organizer

### 3.1 Identity tier

- **Deputy of the Admin** within one Organization. Holds nearly all Admin module access by default, minus owner-only verbs and a few Org-configuration screens.
- **Multiple Co-organizers per Org allowed** — no cap. All Co-organizers have equal default access.
- A Co-organizer is **always invited** (Path C of §2.3 logic, but for `role=co_organizer`). There is no self-signup path for Co-organizer; they enter the platform via an invite from an Admin or another Co-organizer.
- A user can hold the Co-organizer role in **multiple Orgs simultaneously** (PRD §2.4 only restricts Admin).
- A user can be Co-organizer **and** Team manager / Scorer / Referee in the same Org (Q3 — multiple roles per (user, org)).

### 3.2 Purpose

In scope:
- Run tournaments end-to-end with Admin-equivalent operational authority: create tournaments, edit rules pre-freeze, generate brackets, schedule matches, manage rosters, oversee scoring, resolve disputes (per PRD §3.2 row entries marked ✅).
- Invite and manage sub-roles within the Org: peer Co-organizers, Game coordinators, Match scorers, Referees, Team managers.
- Amend rules post-freeze (with audit + reason + 24h grace per PRD §5.2). Marked ⚠️ in PRD §3.2 — allowed but flagged.
- Disqualify teams mid-tournament (⚠️, audit + reason).
- Stand in for Admin during operational windows when Admin is unavailable.

Out of scope:
- **Owner-only verbs** (delete Org, transfer ownership, change billing v1.5, demote another Admin) — reserved to `is_org_owner=True`.
- **Promoting users to Admin role** — only existing Admins (not Co-organizers) can invite/promote to Admin. A Co-organizer who needs Admin powers must be promoted *by an Admin*.
- **Org-level configuration that affects identity** — e.g., changing Org slug requires Admin (and post-publish, Super-admin); Co-organizer cannot.
- Anything outside their Org (multi-tenancy isolation per PRD §7.4).
- Super-admin verbs.

### 3.3 Creation

**Only one creation path: invite by Admin or another Co-organizer.**

- Invited via the canonical invite flow (§2.13).
- Inviter sets role = `co_organizer` on the invite form.
- Invitee accepts via in-app + email confirmation; on accept, `OrganizationMembership(role=co_organizer, status=active, is_org_owner=False)` is created.
- No self-signup. No public-facing signup form ever creates a Co-organizer.

### 3.4 Authentication

Same as Admin (§2.4):
- Email + password (PRD §2.9, §2.10).
- 2FA optional but recommended.
- Session cookie on `fixture.doxaed.com`.
- "Remember me" 30-day; sensitive verbs re-prompt password.
- Lockout policy unchanged.

### 3.5 Surface

Same SPA as Admin (`fixture.doxaed.com`). UI affordances differ by `effective_modules(user, org)`:
- No "Delete Organization" button in Org Settings.
- No "Transfer Ownership" entry point.
- No "Promote to Admin" option in the Member Directory's role-change dropdown.
- All other Admin-tier UI is identical.

Org switcher and role-context indicator behave identically to §2.5.

### 3.6 Capabilities

#### Default module access

Per Appendix A §A.3, the Co-organizer's default module set is **identical to Admin's defaults except**:
- `org.settings` → 👁 read-only (cannot edit Org-level identity fields like slug, owner contact).
- All other Org-, Tournament-, and Match-scoped modules → ✅ full.

**Specifically still allowed:**
- Edit Org branding (logo, color) — `org.branding` ✅.
- View and search Org audit log — `org.audit_log` ✅.
- All Tournament Editor / Bracket / Schedule / Roster / Lineup modules ✅.
- Match scoring/refereeing override (audit-tagged as elevated actor).

#### Owner-only verbs (denied)

Co-organizer cannot perform any verb in the §2.6 owner-only table.

#### Per-user module overrides

A Co-organizer **can be granted additional modules** by an Admin (e.g., `org.settings` write access), but **cannot grant overrides to other users themselves** — the override-grant verb is reserved to Admin in v1.0 even though the override-management UI itself ships in v1.0. (Granting power may be extended to Co-organizers in v1.5 if Org workflows demand it.)

### 3.7 Schema

No new tables. Same `OrganizationMembership` row as Admin, with:
- `role = 'co_organizer'`
- `is_org_owner = False` (and constraint prevents `True` for non-admin roles — see below)

Add a constraint to §2.7's schema:

```python
# In OrganizationMembership.Meta.constraints, append:
CheckConstraint(
    check=Q(is_org_owner=False) | Q(role='admin'),
    name='owner_flag_only_on_admin_role',
),
```

This enforces: a Co-organizer (or any non-Admin role) row can never have `is_org_owner=True`.

### 3.8 Delegation (the invite tree, recap)

Per Q1 (locked):

| Co-organizer can invite | Notes |
|-------------------------|-------|
| Co-organizer (peer) | Same role; new row defaults `is_org_owner=False` |
| Game coordinator | Tournament assignment required at invite time (one or more). Sport-level narrowing deferred to sport module. |
| Match scorer | Optional match assignment at invite time |
| Referee | Optional match assignment at invite time |
| Team manager | Optional team assignment at invite time |

| Co-organizer **cannot** invite | Why |
|-------------------------------|-----|
| Admin | Only existing Admins can promote/invite Admins (§2.9) |
| Media | Deferred to v1.5 |
| Super-admin | Out of scope; created via `manage.py createsuperuser` only |

Invite flow follows §2.13 verbatim.

### 3.9 Lifecycle

Status transitions identical to Admin (§2.10):

```
invited → pending_email_verification → active
                                 ↓
                             suspended / revoked / left
```

#### Suspension

- Any Admin can suspend any Co-organizer (audit-logged with reason).
- **Co-organizers cannot suspend peer Co-organizers** (locked decision). Suspension power flows downward in the role tree, never sideways. If a Co-organizer is misbehaving, an Admin (or Super-admin) must intervene.
- Super-admin can suspend any Co-organizer via `/sadmin/users/`.

#### Revocation / departure

- Admin or peer Co-organizer can revoke (with reason, audit).
- Co-organizer can voluntarily leave via Personal Profile → "Leave organization".
  - Blocked if they are the only remaining person who could be promoted to fill an orphaned-Admin slot — UI suggests promoting an alternative first.

#### Promotion to Admin

- An Admin invites the Co-organizer's user to the Admin role → new `OrganizationMembership(role=admin, is_org_owner=False)` is created **alongside** the Co-organizer row (Q3 — multiple roles per user per Org allowed).
- The user now holds both `co_organizer` and `admin` rows; effective modules = union.
- Optionally, the Admin can simultaneously revoke the `co_organizer` row to "clean up" — UX suggestion at promotion time, not enforced.

#### Effect of Admin suspension on Co-organizers

- Co-organizers stay active (Q5 — sub-roles survive their inviter leaving). They report to the Org, not to the inviter.

### 3.10 What Co-organizer does NOT have

- All four Admin owner-only verbs (Delete Org, Transfer ownership, Demote another Admin, Change billing).
- Edit Org settings beyond branding (slug, owner contact, top-level identity).
- Promote anyone to Admin role.
- Grant per-user module overrides (v1.0; reserved to Admin).
- Anything Super-admin-tier.
- Cross-Org visibility.

### 3.11 Onboarding

First login for a newly-active Co-organizer:

1. Email verification screen if not already verified (often pre-verified via invite token).
2. 2FA enrollment prompt (skippable).
3. **No welcome wizard** (Org is already configured by the Admin).
4. Land on Org dashboard (`/o/<org-slug>/`).
5. In-product tour highlights the modules they have access to (3-step overlay; dismissable; re-launchable from settings).

For users who already had another role in the same Org (e.g., promoted from Game coordinator → Co-organizer): no onboarding. Just land on dashboard with expanded affordances visible.

### 3.12 Decisions (locked) and remaining open questions

#### Locked decisions

| Decision | Outcome |
|----------|---------|
| Multiple Co-organizers per Org | Yes, no cap. All have equal default access. |
| Default module set | Admin defaults minus `org.settings` write access (read-only). |
| Owner-only verbs | All denied. |
| Self-signup as Co-organizer | Not supported. Invite-only. |
| Promotion path to Admin | Only Admins can invite/promote a Co-organizer to Admin. Co-organizers cannot self-promote nor promote peers. |
| Per-user module override grants | Co-organizer can RECEIVE overrides; cannot GRANT them in v1.0. |
| Sub-role survival | Sub-roles (GameCoord/Scorer/Referee/TM) invited by a Co-organizer stay active when that Co-organizer is revoked. |
| Multiple Co-org roles via multiple Orgs | Allowed (PRD §2.4 unchanged). |

#### Locked decisions (added)

| Decision | Outcome |
|----------|---------|
| Peer suspension among Co-organizers | **Admin-only.** Co-organizers cannot suspend peers. Suspension power flows downward in the role tree, never sideways. |

#### Remaining open questions (non-blocking)

- **"Voluntary leave" UX**: should there be a confirmation flow + 7-day undo window? Recommend: confirmation + immediate effect; no undo (cleanup later via re-invite if needed). Decision: defer to implementation.

---

## 4. Game coordinator

### 4.1 Identity tier

- **Operational deputy scoped to one or more specific Tournaments within an Org.** Not Org-wide. The Game coordinator is the day-to-day operator of the tournaments they are assigned to — drives bracket generation, scheduling, scorer/referee dispatch, and dispute escalation for their tournaments.
- **Multiple Game coordinators per Tournament allowed.** Multiple Tournaments per Game coordinator allowed. The mapping is many-to-many.
- **Sport-level narrowing is deferred** to the sport module (designed after user types). For now, the scope unit is **Tournament**. When sport plugs in, "Game coordinator for Tournament X" naturally inherits Tournament X's sport, and a future "multi-sport tournament" v2+ feature can re-narrow to (Tournament, Sport).
- A user can be Game coordinator in multiple Orgs and multiple Tournaments simultaneously (no cross-Org constraint beyond multi-tenancy isolation).
- A user can also hold Co-organizer / Team manager / Scorer / Referee roles in the same Org (Q3 — multiple roles per (user, org)).

### 4.2 Purpose

In scope:
- Run assigned tournaments end-to-end on the operational level: generate/lock bracket, generate/lock schedule, assign scorers and referees to matches, oversee live scoring, mediate first-line disputes.
- Invite peer Game coordinators (for the same tournament — load-sharing during a busy event).
- Invite Match scorers, Referees, Team managers — all auto-scoped to the Game coordinator's assigned tournament.
- Approve / reject team registrations within their tournament.
- **Disqualify teams within assigned Tournament(s) (locked).** ⚠️ audit + reason ≥20 chars + password re-prompt. Deviation from PRD §3.2 (which had this Admin/Co-org-only); v1.0 relaxes to GameCoord-within-scope because GameCoord is the day-to-day operational owner and is most likely to witness misconduct warranting DQ.
- Resolve disputes scoped to their assigned tournament (PRD §3.2 row "Resolve dispute" = sport-scoped → in v1.0 = tournament-scoped).
- Override scorer / referee in emergencies for their tournament's matches (audit-tagged).

Out of scope:
- Anything in a Tournament they are NOT assigned to (multi-Tournament narrowing is the whole point of this role).
- Org-level configuration: cannot edit Org settings, cannot edit Org branding, cannot manage the Org Member Directory's full membership (only sees members assigned to their tournaments).
- Inviting Co-organizers or Admins (only Admin/Co-organizer can invite at higher tiers).
- Owner-only verbs (Delete Org, Transfer ownership, etc.).
- Cross-Tournament data visibility — even within the same Org, a Game coordinator does not see tournaments they aren't assigned to.

### 4.3 Creation

**Only one creation path: invite by Admin, Co-organizer, or peer Game coordinator** (per Q1 locked decisions).

- Inviter selects role = `game_coordinator` AND **must specify ≥1 Tournament** to assign at invite time.
- Inviter must themselves have access to those Tournament(s):
  - Admin / Co-organizer can assign to any Tournament in the Org.
  - Peer Game coordinator can only co-assign within Tournament(s) they themselves are assigned to.
- Invitee accepts via §2.13 invite flow.
- On accept: `OrganizationMembership(role=game_coordinator, status=active)` + 1..N `TournamentMembership(user, tournament, role=game_coordinator)` rows.
- A Game coordinator can be re-assigned to additional Tournaments later by any Admin/Co-org/peer Game coord (creates new `TournamentMembership` rows; no new invite needed since user is already an Org member).

### 4.4 Authentication

Same as Admin (§2.4) and Co-organizer (§3.4):
- Email + password.
- 2FA optional, recommended.
- Session cookie on `fixture.doxaed.com`.
- "Remember me" 30-day; sensitive verbs (rule amend, disqualification, force-finalize) re-prompt password.

### 4.5 Surface

Same SPA. UI affordances filtered to assigned Tournament(s):
- Org dashboard shows ONLY the tournaments they're assigned to (not all Org tournaments).
- Member Directory is filtered: shows only members linked to their assigned Tournament(s) — Scorers/Referees/TMs they invited or who are assigned to their tournament's matches/teams.
- No "Org Settings" or "Org Branding" entry points.
- Tournament-scoped modules (Bracket Editor, Schedule Editor, etc.) appear ONLY for their assigned Tournaments.
- Match-scoped modules appear ONLY for matches within their assigned Tournaments.

When the user holds Game coordinator AND another role in the same Org, the SPA's role-toggle indicator (§2.5) lets them context-switch; modules union still applies.

### 4.6 Capabilities

#### Default module access (per Appendix A §A.3)

- `org.member_directory` → 👁 read-only, AND row-level filtered to members touching their assigned Tournaments.
- `org.audit_log` → 🔵 scoped to events within their assigned Tournaments only.
- `org.tournament_list` → 🔵 list filtered to assigned Tournaments only.
- `org.settings`, `org.branding` → no access.
- All `tournament.*` modules → 🔵 scoped to assigned Tournaments (full access within scope).
- All `match.*` modules → 🔵 scoped to matches within assigned Tournaments.
- Personal modules → ✅ full.

#### Verbs available to Game coordinator (within scope)

- Generate / lock bracket; auto + drag-drop edit.
- Generate / lock schedule; conflict warnings.
- Approve / reject team registration (within scope).
- Disqualify team mid-tournament (⚠️ audit + reason ≥20 chars + password re-prompt).
- Assign Match scorer / Referee to specific matches.
- Override scorer / referee actions in emergencies (audit-tagged as elevated actor).
- Force-finalize after `referee_approval_timeout_hours` (PRD §5.5).
- Resolve disputes raised in their tournament's matches (per PRD §3.2 row "Resolve dispute" = sport-scoped → tournament-scoped in v1.0).
- **Edit structured rules: DENIED (locked).** Per PRD §3.2 and confirmed at user-types phase, Game coordinator cannot edit structured tournament rules at any time. Rules are a Tournament-config concern owned by the Org tier (Admin / Co-organizer). Game coordinator can REQUEST a rule edit pre-freeze (informally, e.g., via a comment) and can REQUEST a rule amend post-freeze, but cannot enact either without Admin/Co-org action.

#### What Game coordinator cannot do (even within scope)

- Edit Org-level settings or branding.
- Invite Admin or Co-organizer.
- Promote a sub-role to Game coordinator's own role (only Admin/Co-org/peer GameCoord with shared tournament assignment can).
- Grant per-user module overrides (Admin-only, v1.0 schema-only).
- Resolve disputes outside their assigned Tournaments.
- Touch any tournament they aren't assigned to.

### 4.7 Schema

Two layered membership rows:

```python
# organizations/models.py — already covered in §2.7
OrganizationMembership(user, organization, role='game_coordinator', status, ...)


# tournaments/models.py — refining PRD §8 TournamentMembership
class TournamentMembership(models.Model):
    id = UUID v7 PK
    user = FK(User)
    tournament = FK(Tournament)
    role = enum('game_coordinator')                  # only role used at this scope in v1.0
    status = enum('active', 'suspended', 'revoked')
    assigned_by = FK(User, null=True, on_delete=SET_NULL)
    assigned_at = DateTimeField(auto_now_add=True)
    revoked_at = DateTimeField(null=True)
    # Note: sport_id intentionally omitted in v1.0 user-types phase.
    # Will be added (nullable) when the sport module is designed.

    class Meta:
        constraints = [
            UniqueConstraint(fields=['user', 'tournament', 'role'],
                             condition=Q(status='active'),
                             name='unique_active_tournament_role'),
        ]
```

**Authorization invariant:** to act as Game coordinator on Tournament T, a user must have BOTH:
1. `OrganizationMembership(user=U, organization=T.organization, role='game_coordinator', status='active')`, AND
2. `TournamentMembership(user=U, tournament=T, role='game_coordinator', status='active')`.

If only the Org-level row exists without a Tournament-level row, the user appears in the Member Directory as "Game coordinator (no assignments)" and has no operational access until assigned.

### 4.8 Delegation (recap)

| Game coordinator can invite | Scope of invite |
|----------------------------|-----------------|
| Game coordinator (peer) | Auto-assigned to inviter's currently-shared tournament(s); inviter can also assign to additional tournaments they themselves coordinate |
| Match scorer | Auto-assigned to inviter's tournament(s); optional match assignment |
| Referee | Auto-assigned to inviter's tournament(s); optional match assignment |
| Team manager | Auto-assigned to a team within inviter's tournament(s) |

| Game coordinator **cannot** invite | Why |
|-----------------------------------|-----|
| Admin / Co-organizer | Higher-tier; reserved to Admin (Co-org can also invite Co-orgs) |
| Game coordinator outside their tournaments | Scope leak prevention |
| Media | Deferred to v1.5 |

Invite flow follows §2.13.

### 4.9 Lifecycle

#### Status transitions

```
invited → active → suspended / revoked / left
```

Two layers can transition independently:
- **OrganizationMembership** suspended/revoked → user loses Org access entirely; all TournamentMembership rows effectively inert.
- **TournamentMembership** revoked (e.g., reassigned off a tournament) → user remains a Game coordinator in the Org, just no longer for that Tournament. Org-level Member Directory still shows them.

#### Reassignment / removal from a Tournament

- Any Admin / Co-organizer can revoke any `TournamentMembership` (audit-logged).
- Peer Game coordinators **cannot** revoke each other's Tournament assignments — that's an Admin/Co-org verb to prevent peer infighting from disrupting an active tournament.
- A Game coordinator with zero active TournamentMemberships is allowed (Org-level row stays); they show up as "unassigned" in Member Directory until assigned.

#### Suspension

- Admin / Co-organizer can suspend any Game coordinator at the Org-level row → cuts off all access immediately.
- Peer Game coordinators **cannot** suspend each other (Admin-only, same default as Co-organizer §3.9).
- Super-admin can suspend at the User level.

#### Promotion to Co-organizer

- Admin or Co-organizer invites the Game coordinator's user to Co-organizer role → new `OrganizationMembership(role=co_organizer)` row added alongside.
- Game coordinator row stays unless explicitly revoked (Q3 — multiple roles allowed).
- Effective modules = union; the user now sees full Org-wide capabilities.

### 4.10 What Game coordinator does NOT have

- Cross-Tournament visibility within their Org — limited strictly to assigned Tournaments.
- Org-level configuration (Settings, Branding, full Member Directory).
- Invite Admin / Co-organizer.
- Edit structured tournament rules (defaulted per PRD §3.2; flag if you want this changed).
- Grant per-user module overrides.
- Resolve disputes outside assigned Tournaments.
- Anything Super-admin-tier.
- Cross-Org access.

### 4.11 Onboarding

First login as a newly-active Game coordinator:

1. Email verification (often pre-verified via invite token).
2. 2FA enrollment prompt (skippable).
3. **No welcome wizard** (Org is already configured).
4. Land on a **scoped dashboard** showing assigned Tournament(s) — single-tournament dashboard if exactly one, list view if multiple.
5. In-product tour: 4-step overlay highlighting Bracket Editor, Schedule Editor, Match assignment, Dispute resolution (dismissable, re-launchable from settings).

### 4.12 Decisions (locked) and remaining open questions

#### Locked decisions

| Decision | Outcome |
|----------|---------|
| Scope unit | **Tournament** (sport-level narrowing deferred to sport module). |
| Multi-Tournament per Game coord | Allowed; many-to-many via `TournamentMembership`. |
| Multi-Game coord per Tournament | Allowed; no cap. Equal access among peers. |
| Two-layer membership | Org-level (`OrganizationMembership`) + Tournament-level (`TournamentMembership`). Both required for operational access. |
| Invite scope | Game coord can invite peer GameCoords + Scorers/Referees/Team managers — auto-scoped to their assigned Tournament(s). |
| Cannot invite | Admin, Co-organizer (higher tier); cannot reach into tournaments they aren't assigned to. |
| Peer revocation | Game coords cannot revoke peers' Tournament assignments — Admin/Co-org only. |
| Peer suspension | Game coords cannot suspend peers — Admin/Co-org only (consistent with §3.9 default). |
| Disqualify team | **Allowed within scope (locked).** ⚠️ audit + reason ≥20 chars + password re-prompt. Deviation from PRD §3.2 — v1.0 relaxes to GameCoord-within-scope because GameCoord is the operational owner closest to witnessed misconduct. |
| Resolve dispute | Allowed within scope (per PRD §3.2 sport-scoped → tournament-scoped in v1.0). |
| Edit structured rules | **Denied (locked).** Rule definitions are Org-tier (Admin / Co-org) only. GameCoord can request, not enact. |
| Sport-level narrowing | Deferred. `TournamentMembership.sport_id` not added in user-types phase. |

#### Remaining open questions (non-blocking)

- **Force-finalize after referee timeout**: PRD §3.2 has it as ⚠️ for GameCoord. Keeping ⚠️-allow.
- **Multiple co-assigned Game coords on a Tournament — who's "primary"?** No primary in v1.0 — all peers equal. v1.5 may add a "lead coordinator" flag if Org workflows demand it.

---

## 5. Match scorer

### 5.1 Identity tier

- **Match-level role.** Scope is one or more specific Matches within a Tournament — not the whole Tournament, not the whole Org.
- **Multiple Match scorers per Match allowed** (see §5.6 — concurrent scorer indicator). Multiple Matches per Scorer allowed (a single Scorer typically covers several matches across a tournament day).
- The Match scorer is the **operational entry point for live event data**. They produce the data that becomes the system of record (`MatchEvent` rows per PRD §7.3).
- A user can hold Match scorer plus other roles in the same Org (Q3). Common pairing: Match scorer + Team manager for a different team (no conflict-of-interest enforcement in v1.0; see §5.12 open question).
- Sport-specific scoring surfaces (event types, clock semantics, formation pickers) are deferred to the **sport module**. The user-model side is sport-agnostic: Match scorer = "user assigned to enter live event data on these matches."

### 5.2 Purpose

In scope:
- Enter live match events into the Scoring Console for assigned matches: clock control, event entry, lineup confirmation at kickoff.
- Submit final score for referee approval (per match state machine in PRD §5.5).
- Recover from network outages: idempotent retries, localStorage queue (PRD §5.6 invariant).
- Coordinate with co-scorers via the "another scorer present" indicator (PRD §5.6).
- View match-level data needed for scoring: lineups, suspensions, rule overrides for that match.
- View public Match Center for any match (read-only) — same as Viewer for unassigned matches.

Out of scope:
- Approving final score — that's Referee (§6).
- Editing any match data outside their assigned matches.
- Tournament-level operations: bracket, schedule, registration, dispute resolution.
- Org-level operations: settings, branding, member directory beyond their match's roster.
- Inviting other users (Match scorer cannot invite anyone in v1.0 — see §5.8).
- Voiding events post-final (only Referee + scoped Admin tiers can; PRD §3.2).

### 5.3 Creation

**Only one creation path: invite by Admin / Co-organizer / Game coordinator.**

- Inviter selects role = `match_scorer`.
- **Match assignment is OPTIONAL at invite time** (per §2.13). The Scorer can be invited first (added to the Org's pool of available scorers) and assigned to specific matches later via the Match assignment UI.
- If matches are assigned at invite time, they must be matches within the inviter's scope:
  - Admin / Co-organizer: any match in the Org.
  - Game coordinator: any match within their assigned Tournament(s).
- Invitee accepts via §2.13 invite flow.
- On accept: `OrganizationMembership(role=match_scorer, status=active)` + 0..N `MatchAssignment(user, match, role=match_scorer)` rows.

### 5.4 Authentication

Same baseline as other in-Org roles:
- Email + password.
- 2FA optional (Match scorers in real-world tournament settings often share devices; 2FA adds friction at the moment they're most rushed — flag if you want this re-evaluated).
- Session cookie on `fixture.doxaed.com`.
- "Remember me" 30-day.
- **No password re-prompt on event entry verbs** — would destroy the scoring flow. Re-prompt is reserved for destructive verbs which Match scorer doesn't have.

### 5.5 Surface

- React SPA, but the Scoring Console (`match.scoring_console`) is the dominant UI for this role. PRD §5.6 specifies it as **tap-friendly, phone/tablet-optimized**.
- Org dashboard for a Scorer shows ONLY a list of their assigned matches (today + upcoming + recent), not tournaments or org members.
- No Tournament Editor / Bracket / Schedule entry points.
- **Read-only Match Center** for any match they're not assigned to (same surface as Viewer).
- **Status pill** (Live ✓ / Reconnecting… / Offline N) per PRD §5.6.
- **Concurrent scorer indicator** when ≥2 scorers are active on the same match.

### 5.6 Capabilities

#### Default module access (per Appendix A §A.3)

- `org.tournament_list` → 🔵 list filtered to tournaments containing their assigned matches.
- `org.audit_log`, `org.settings`, `org.branding`, `org.member_directory` → no access.
- `tournament.lineup_manager` → 👁 read-only, scoped to their assigned matches' tournaments (so they can see the submitted lineup before kickoff).
- All other `tournament.*` modules → no access.
- `match.scoring_console` → 🔵 full access on assigned matches.
- `match.referee_console` → no access (this is Referee's surface).
- `match.center_admin_view` → 🔵 read on assigned matches.
- `match.lineup_submission` → no access (Team Manager / Admin override only).
- Personal modules → ✅ full.

#### Verbs available to Match scorer (within assigned match scope)

- Press kickoff, end-half, halftime, kickoff 2nd, full-time, extra-time, penalty shootout transitions (per PRD §5.5).
- Enter `MatchEvent` rows: goals, cards, substitutions, period events, etc. — sport-specific event taxonomy lives in the sport module; the user-model contract is "Scorer can write events on assigned matches."
- Confirm lineup at kickoff (cross-check submitted lineup vs. on-field; flag mismatch to Referee).
- Mark walkover (with reason) per PRD §5.6.
- Mark abandoned (with reason) per `abandonment_policy`.
- Designate outfield-GK substitute when GK is red-carded with no GK on bench (PRD §5.6) — sport-specific edge case but the verb is "scorer-can-edit-lineup-mid-match-with-flag."

#### What Match scorer cannot do

- Approve / reject final score (Referee only).
- Void events post-final (Referee + Admin tier only — `void_match_event` verb in PRD §3.2).
- Correct events that were already submitted: requires Referee approval (§6).
- Edit lineups except the GK-substitute edge case above and the kickoff lineup-confirmation flow.
- Resolve disputes.
- Touch any match they're not assigned to.

### 5.7 Schema

```python
# matches/models.py — refining PRD §8 MatchAssignment
class MatchAssignment(models.Model):
    id = UUID v7 PK
    match = FK(Match)
    user = FK(User)
    role = enum('match_scorer', 'referee')                 # both match-level roles use this table
    status = enum('assigned', 'declined', 'replaced',
                  'completed', 'revoked')                   # see §5.9 lifecycle
    assigned_by = FK(User, null=True, on_delete=SET_NULL)
    assigned_at = DateTimeField(auto_now_add=True)
    declined_at = DateTimeField(null=True)
    declined_reason = TextField(blank=True)
    replaced_by_assignment = FK('self', null=True, on_delete=SET_NULL)
    completed_at = DateTimeField(null=True)
    revoked_at = DateTimeField(null=True)

    class Meta:
        constraints = [
            # A user can hold only ONE active assignment per (match, role).
            UniqueConstraint(fields=['match', 'user', 'role'],
                             condition=Q(status='assigned'),
                             name='unique_active_match_assignment'),
        ]
```

**Authorization invariant:** to act as Match scorer on Match M, a user must have BOTH:
1. `OrganizationMembership(user=U, organization=M.tournament.organization, role='match_scorer', status='active')`, AND
2. `MatchAssignment(match=M, user=U, role='match_scorer', status='assigned')`.

A user with only the Org-level row appears in the Scorer pool — eligible to be assigned.

**Note:** This is the schema improvement flagged earlier (§1.x feedback) — `MatchAssignment` now has `status`, `declined_reason`, `replaced_by_assignment` so recusal/reassignment preserves audit trail rather than being a deletion.

### 5.8 Delegation

**Match scorer has zero invite power in v1.0.**

| Match scorer can invite | None |
|------------------------|------|

This is a deliberate constraint:
- Match scorer is an *operational endpoint*, not a *delegating* role.
- The role exists to do one job (score matches assigned to them); they should not be expanding the user pool.
- v1.5 may consider a "scorer recommends another scorer" flow if real-world workflows demand it.

### 5.9 Lifecycle

#### Assignment lifecycle (per match)

```
assigned → completed       (after match enters 'final')
      └─→ declined          (Scorer recuses; coordinator reassigns)
      └─→ replaced          (Coordinator swaps in another Scorer; old assignment archived)
      └─→ revoked           (Admin/Coord removes Scorer pre-match; e.g., conflict of interest)
```

**Recusal flow:**
1. Scorer opens assigned match → "Decline assignment" → reason ≥20 chars.
2. `MatchAssignment.status = 'declined'`, `declined_at`, `declined_reason` set.
3. Notification fires to Game coordinator and Admin.
4. Coordinator picks a replacement Scorer; new `MatchAssignment` row created; original's `replaced_by_assignment` field set to point at new row.
5. Audit-logged.

**Reassignment guardrails:**
- Cannot decline an assignment after the match has entered any `live_*` state (would strand the match mid-scoring). Decline only allowed in `scheduled`, `lineup_pending`, `lineup_submitted`.
- **Stranded match timeout (locked): 30 minutes.** If a match is in any `live_*` state AND no `MatchEvent` has been recorded for 30 consecutive minutes AND no assigned Scorer has an active SSE/WebSocket connection, the match enters a `stranded` sub-state. Admin / GameCoord receive `match_stranded` notification immediately upon entering `stranded`. **Auto-postpone fires 15 minutes later** (total 45 min) if no human intervention (replacement Scorer assigned OR Admin/GameCoord manually postpones). Aligns with `walkover_grace_minutes` analogue (PRD §5.13 default 30).

#### Org-level lifecycle

```
invited → active → suspended / revoked / left
```

- Suspension at the Org level blocks all `MatchAssignment` access immediately (even if the match is live — degraded state above applies).
- Revocation is permanent; preserves all historical `MatchAssignment` rows for audit.
- Voluntary leave: blocked if user has active `MatchAssignment` with `status='assigned'` on a non-final match. UI tells them: "You have N active match assignments. Decline or complete them before leaving."

#### Promotion path

- Match scorer → Game coordinator: standard invite-by-Admin/Co-org/peer-GameCoord. New role row added; existing Scorer row stays unless explicitly revoked (Q3 multi-role).
- Match scorer → Referee: standard invite. Same user can hold both `match_scorer` and `referee` Org-level memberships, but **cannot be both Scorer AND Referee on the same Match** (would defeat separation of duties — PRD §10 principle 7). Enforce at assignment time:

```python
# Constraint addition
CheckConstraint(
    check=~(
        Q(role='match_scorer') & Exists(
            MatchAssignment.objects.filter(
                match=OuterRef('match'), user=OuterRef('user'),
                role='referee', status='assigned'
            )
        )
    ) & ~(
        Q(role='referee') & Exists(... same idea ...)
    ),
    name='no_scorer_and_referee_on_same_match',
)
```

**Enforcement mechanism (locked):** Django CheckConstraint cannot express subquery-based checks. v1.0 enforces this constraint via a **pre-save signal** on `MatchAssignment` (`django.db.models.signals.pre_save`) that runs inside the same transaction as the assignment INSERT, raising `ValidationError` if the partner role exists. Service-layer guard (in the assignment-creation service function) is the FIRST line of defense; the signal is a safety net for direct ORM writes. **A Postgres EXCLUDE constraint via custom migration RawSQL is the v1.5 hardening target** (single-source-of-truth at the DB level).

### 5.10 What Match scorer does NOT have

- Approval / rejection of final score.
- Voiding `MatchEvent` rows post-final.
- Match assignment outside their assigned matches.
- Inviting any user.
- Tournament-level or Org-level configuration.
- Per-user module override grants.
- Cross-Match visibility within their tournaments (only sees the matches they're assigned to + public read of others).
- Any Super-admin tier verb.

### 5.11 Onboarding

First login as a newly-active Match scorer:

1. Email verification (often pre-verified via invite token).
2. 2FA enrollment prompt — **dismissable with longer reminder window (14 days vs. 7)** because Scorers operate under time pressure on tournament days and 2FA adds friction at the worst moment. Optional in v1.0.
3. **No welcome wizard** — Scorers don't configure anything.
4. Land on **assigned-matches dashboard**: today's matches highlighted, upcoming next, recent below.
5. **Brief in-product tour of the Scoring Console** — 3-step overlay covering: clock controls, event entry, sync status pill. Re-launchable from settings.
6. Pre-match warmup: ~15 min before any live match, the system pings the assigned Scorer with `match_starting_soon` notification (PRD §5.14) — same as today's PRD spec.

### 5.12 Decisions (locked) and remaining open questions

#### Locked decisions

| Decision | Outcome |
|----------|---------|
| Scope unit | **Match** (via `MatchAssignment`). |
| Multi-Scorer per Match | **Allowed.** Concurrent scorer indicator handles the UX (PRD §5.6). |
| Multi-Match per Scorer | **Allowed.** Many-to-many. |
| Two-layer membership | Org-level (`OrganizationMembership.role='match_scorer'`) + Match-level (`MatchAssignment.role='match_scorer'`). Both required. |
| Match assignment at invite time | **Optional.** Scorer can be added to Org pool first, assigned later. |
| Invite power | **None.** Scorer cannot invite any user. |
| Approve / reject final score | **Denied** (Referee verb). |
| Void events post-final | **Denied** (Referee + Admin tier verb). |
| Concurrent role: Scorer + Referee on SAME match | **Denied** (separation of duties — PRD §10 principle 7). DB / signal enforcement. |
| Concurrent role: Scorer in Org X + Team manager in Org X | **Allowed in v1.0** — soft-warning enforcement (see locked decision below). |
| Conflict-of-interest enforcement (v1.0) | **Soft warning + audit** at assignment time. Applies to BOTH Scorer and Referee assignments. If a user being assigned as Scorer or Referee on Match M holds a Team manager role for one of the playing teams, the assignment UI shows a banner: "⚠️ This user is Team manager of Team {X}, which is playing in this match. Continue?" Audit-logged either way. Hard block deferred to v1.5. |
| Recusal lifecycle | Captured via `MatchAssignment.status` enum + `replaced_by_assignment` link. |
| Decline-during-live-match | **Blocked** — declining only allowed in `scheduled` / `lineup_pending` / `lineup_submitted`. |
| Stranded match timeout | **30 minutes (locked).** No `MatchEvent` for 30 min during `live_*` + no Scorer connection → `stranded` sub-state + immediate notification to Admin/GameCoord. Auto-postpone at 45 min total if no intervention. |
| 2FA pressure | Optional; longer reminder window (14 days) than other roles. |
| Password re-prompt on scoring | **Never.** Re-prompt only on destructive verbs Scorer doesn't have. |

#### Remaining open questions (non-blocking)

- **"Scorer recommends another scorer" flow:** v1.5 consideration. Defer.
- **2FA exemption for Scorer role:** should we allow Org Admin to permanently waive 2FA for Scorers in their Org (acknowledging the tournament-day friction)? **Defaulting to NO** — 2FA is per-user, not per-role; if tournament-day friction is real, Admins can advise Scorers to skip the 14-day prompt.

---

## 6. Referee / verifier

### 6.1 Identity tier

- **Match-level role.** Scope is one or more specific Matches via `MatchAssignment` — same scope unit as Match scorer.
- **The separation-of-duties counterpart to Match scorer.** Scorer enters events; Referee approves the final score and may correct events. Per PRD §10 principle 7.
- **Multiple Referees per Match allowed** (e.g., a primary referee plus a fourth official as verifier). Multiple Matches per Referee allowed.
- The same user **cannot** be both Scorer and Referee on the same Match (constraint locked in §5.7). Same user CAN be Scorer on Match A and Referee on Match B simultaneously.
- A user can hold Referee plus other roles in the same Org (Q3). Common pairing: Referee + Game coordinator (the GameCoord referees a few matches themselves).
- Sport-specific verification surfaces are deferred to the **sport module**. The user-model side is sport-agnostic: Referee = "user assigned to verify and approve match-level data."

### 6.2 Purpose

In scope:
- Real-time review of Scorer's submitted events via the Referee Console (PRD §5.6).
- **Flag** scorer's draft entries pre-submission.
- **Correct** mistakenly-entered events pre-final — creates a `corrected` event linked to the original; original is retained (PRD §5.7).
- **Approve or reject the final score** at full time / end of penalty shootout. This is the verb that transitions the match `awaiting_referee_approval → final` (PRD §5.5).
- **Raise disputes** on assigned matches (PRD §3.2 — Referees can raise but not resolve disputes).
- **Void `MatchEvent` rows** (mark as voided; original retained per append-only audit). PRD §3.2 grants Referee ✅ on `void_match_event` for assigned matches.
- View Org / Tournament audit log entries scoped to their assigned matches (PRD §3.2 — Referee gets `own matches` access).
- Recuse from an assignment with reason; coordinator reassigns.

Out of scope:
- Entering live events (Scorer's job — but Referee can correct after the fact).
- Resolving disputes — that's Admin / Co-organizer / Game coordinator.
- Match assignment outside their assigned matches.
- Inviting any user (Referee has zero invite power in v1.0).
- Tournament- or Org-level configuration.

### 6.3 Creation

**Only one creation path: invite by Admin / Co-organizer / Game coordinator.**

- Inviter selects role = `referee`.
- **Match assignment is OPTIONAL at invite time** — same pool-based onboarding as Scorer. Referees often join the platform via "I'm a certified referee in District X" and get assigned to specific matches when tournaments need them.
- If matches are assigned at invite time, they must be matches within the inviter's scope (same scoping rules as §5.3).
- Invitee accepts via §2.13 invite flow.
- On accept: `OrganizationMembership(role=referee, status=active)` + 0..N `MatchAssignment(user, match, role=referee)` rows.

### 6.4 Authentication

- Email + password (PRD §2.9, §2.10).
- **2FA optional but more strongly encouraged than for Scorer** — Referee approval authority directly affects tournament outcomes. Recovery codes mandatory at enrollment.
- Session cookie on `fixture.doxaed.com`.
- "Remember me" 30-day; **password re-prompt on the approve/reject-final verb** because that single action determines tournament results. Other event-correction verbs do NOT re-prompt (would destroy real-time correction flow).
- Lockout policy unchanged.

### 6.5 Surface

- React SPA. Referee Console (`match.referee_console`) is the dominant UI for this role. PRD §5.6 specifies it as a real-time event review surface with flagging, correction, and approval forms.
- **Pre-match referee briefing screen** (PRD §5.6) — referee confirms roster + rule overrides + weather + special instructions. Mandatory before kickoff transition.
- Org dashboard for a Referee shows ONLY a list of their assigned matches.
- No Tournament Editor / Bracket / Schedule entry points.
- Read-only Match Center for unassigned matches.
- Real-time WebSocket connection to receive Scorer's events as they arrive.

### 6.6 Capabilities

#### Default module access (per Appendix A §A.3)

- `org.tournament_list` → 🔵 list filtered to tournaments containing their assigned matches.
- `org.audit_log` → 🔵 own matches (PRD §3.2).
- `org.settings`, `org.branding`, `org.member_directory` → no access.
- `tournament.lineup_manager` → 👁 read on assigned matches' tournaments (so they can see lineups during pre-match briefing).
- All other `tournament.*` modules → no access.
- `match.scoring_console` → no access (Scorer's surface; Referee corrects via Referee Console).
- `match.referee_console` → 🔵 full access on assigned matches.
- `match.center_admin_view` → 🔵 read on assigned matches.
- `match.lineup_submission` → no access.
- Personal modules → ✅ full.

#### Verbs available to Referee (within assigned match scope)

- **Approve final score** — transitions `awaiting_referee_approval → final` (PRD §5.5). Triggers advancement domain event. Multi-Referee semantics governed by per-match `requires_unanimous_referee_approval` flag — see §6.6 below and §6.7 schema.
- **Reject final score** with reason — returns to most recent `live_*` state. Audit-logged. Even under unanimous-approval mode, a single rejection from any assigned Referee is sufficient to reject (rejection is always EITHER).
- **Correct event pre-final** — creates `corrected` event; original retained (PRD §5.7).
- **Void event** — marks event `voided`; original retained. PRD §3.2 ✅.
- **Recuse from assignment** with reason — same recusal flow as Scorer (§5.9), but blocked once match enters `live_*` per §5.9 guardrails. Decision: keep blocked-during-live for Referee too. Confirm.
- **Raise dispute** post-match (PRD §3.2 — Referees can raise but not resolve).
- **Approve / decline late lineup edits** (PRD §5.4 — late edits within deadline window allowed only with referee approval).
- **Pre-match briefing confirmation** — confirm rule overrides + weather + special instructions before kickoff.

#### Multi-Referee approval (locked)

When multiple Referees are assigned to the same Match, approval semantics are controlled by a per-match flag:

- **`Match.requires_unanimous_referee_approval` (Bool, default `False`)** — set at assignment time. UI on the Match assignment screen: "All assigned referees must approve final score" toggle.
- **`False` (default — EITHER)**: any one assigned Referee can approve; the match transitions to `final` on the first approval. Other Referees see "match already approved" on next refresh.
- **`True` (BOTH/UNANIMOUS)**: every assigned Referee must independently approve before the match transitions to `final`. Each approval is recorded individually; the match enters `final` only when the last assigned Referee approves.
- **Rejection is always EITHER** — a single rejection from any Referee returns the match to a `live_*` state regardless of the flag.
- **Force-finalize override** (Admin / Co-org / GameCoord per PRD §5.5) bypasses both modes — `referee_approval_timeout_hours` applies to whichever Referee(s) haven't acted, then anyone with force-finalize authority can resolve.
- **The tournament-level `two_person_verification: bool` rule field (PRD §5.13) is a *separate, broader* concern.** When `two_person_verification=True` is enforced (v1.5), it requires two distinct *human* approvers regardless of the per-match flag. The per-match flag is the v1.0 mechanism; the rule field is the v1.5 tournament-wide policy.

#### What Referee cannot do

- Enter live events directly (only correct existing ones).
- Resolve disputes (Admin / Co-org / GameCoord-scoped only).
- Force-finalize after timeout (Admin / Co-org / GameCoord verb per PRD §5.5).
- Touch any match they're not assigned to.
- Invite any user.
- Edit lineups (only approve late edits).

### 6.7 Schema

Reuses `MatchAssignment` from §5.7 with `role='referee'`. Adds two fields — one on `Match`, one on `MatchAssignment` — for multi-Referee approval semantics.

```python
# matches/models.py — addition to the Match table (sport-agnostic part)
class Match(models.Model):
    # ... other fields defined in PRD §8 / sport module
    requires_unanimous_referee_approval = BooleanField(default=False)
    # When True, ALL assigned Referees must approve before match transitions to 'final'.
    # When False (default), the first assigned Referee to approve transitions the match.
    # Rejection is always EITHER regardless of this flag.


# matches/models.py — extending MatchAssignment from §5.7
class MatchAssignment(models.Model):
    # ... fields from §5.7 (status, declined_reason, replaced_by_assignment, etc.)
    referee_approval_status = enum('pending', 'approved', 'rejected')  # only meaningful for role='referee'
    referee_approved_at = DateTimeField(null=True)
    referee_rejection_reason = TextField(blank=True)


# Already defined in §5.7:
MatchAssignment(match, user, role='referee', status, ...)

# Authorization invariant:
# To act as Referee on Match M, a user must have BOTH:
#   1. OrganizationMembership(user=U, organization=M.tournament.organization,
#                              role='referee', status='active')
#   2. MatchAssignment(match=M, user=U, role='referee', status='assigned')

# Match transition guard (corrected — handles rejection-EITHER per §6.6 lock):
def can_finalize(match) -> tuple[bool, str]:
    """
    Returns (can_finalize, reason_if_not).
    Rejection is ALWAYS EITHER regardless of unanimous-mode flag.
    """
    referee_assignments = MatchAssignment.objects.filter(
        match=match, role='referee', status='assigned'
    )
    if not referee_assignments.exists():
        return (False, 'no_assigned_referee')

    # Any rejection blocks finalization regardless of mode.
    if any(a.referee_approval_status == 'rejected' for a in referee_assignments):
        return (False, 'referee_rejected')

    if match.requires_unanimous_referee_approval:
        if all(a.referee_approval_status == 'approved' for a in referee_assignments):
            return (True, '')
        return (False, 'awaiting_unanimous_approval')
    else:
        if any(a.referee_approval_status == 'approved' for a in referee_assignments):
            return (True, '')
        return (False, 'awaiting_any_approval')
```

**Concurrency note:** the `can_finalize()` check + the `Match.status` transition MUST run inside the same transaction with `SELECT ... FOR UPDATE` on the Match row to prevent race conditions where two referees approving simultaneously both observe "all approved" in unanimous mode. PRD's idempotent-`event_id` invariant (§7.6) covers individual approval writes; the finalization transition needs the row lock.

The "no Scorer + Referee on same Match" constraint (§5.7) covers the separation-of-duties guarantee bidirectionally.

### 6.8 Delegation

**Referee has zero invite power in v1.0** — same operational-endpoint principle as Scorer (§5.8).

| Referee can invite | None |
|--------------------|------|

v1.5 may consider a "referee recommends a verifier" flow for high-stakes matches.

### 6.9 Lifecycle

#### Assignment lifecycle (per match)

Same enum and transitions as Scorer (§5.9):

```
assigned → completed       (after match enters 'final')
      └─→ declined          (Referee recuses; coordinator reassigns)
      └─→ replaced          (Coordinator swaps)
      └─→ revoked           (Pre-match removal)
```

**Recusal:**
- Mid-`scheduled` / `lineup_pending` / `lineup_submitted`: standard decline flow with reason ≥20 chars.
- During `live_*`: **blocked** — Referee cannot abandon a live match. If genuinely needed (medical emergency), Admin / GameCoord must do an emergency reassignment (audit-logged).
- During `awaiting_referee_approval`: **blocked** — Referee must either approve, reject, or get force-finalized via `referee_approval_timeout_hours` (PRD §5.5).

#### Stranded-Referee timeout (PRD §5.5)

If assigned Referee never approves within `referee_approval_timeout_hours` (default 24h):
- Admin / Co-org / Game coordinator can **force-finalize** with reason (PRD §5.5).
- Audit-logged with elevated `actor_role`.
- Notification to Referee + Scorer.

#### Org-level lifecycle

```
invited → active → suspended / revoked / left
```

- Voluntary leave: same guardrails as Scorer (§5.9) — blocked if user has active `MatchAssignment` on a non-final match.
- Suspension at the Org level immediately invalidates active assignments; degraded state if mid-match (similar to stranded-Scorer).

#### Promotion path

- Referee → Game coordinator: standard invite-by-Admin/Co-org. New role row added; existing Referee row stays.
- Referee → Match scorer: standard invite. Same user can hold both Org-level memberships, BUT cannot be both on the same Match (§5.7 constraint).

### 6.10 What Referee does NOT have

- Live event entry (Scorer's job).
- Dispute resolution.
- Force-finalize override.
- Match assignment outside assigned matches.
- Invite any user.
- Tournament- or Org-level configuration.
- Per-user module override grants.
- Resolve own dispute (a Referee who raised a dispute cannot also resolve it — separation of duties).
- Anything Super-admin-tier.

### 6.11 Onboarding

First login as a newly-active Referee:

1. Email verification (often pre-verified via invite token).
2. **2FA enrollment recommended** with stronger nudging than Scorer — pop-up suggests it once, dismiss reminder is 7 days. Optional in v1.0.
3. **No welcome wizard.**
4. Land on **assigned-matches dashboard**.
5. **In-product tour of the Referee Console** — 4-step overlay covering: pre-match briefing, real-time event flagging, event correction, post-match approval form. Re-launchable from settings.
6. Pre-match: ~30 min before any assigned match, system pings Referee with `match_starting_soon` notification AND a reminder to complete the pre-match briefing.

### 6.12 Decisions (locked) and remaining open questions

#### Locked decisions

| Decision | Outcome |
|----------|---------|
| Scope unit | **Match** (via `MatchAssignment`). Same as Scorer. |
| Multi-Referee per Match | Allowed (primary + verifier pattern). |
| Multi-Match per Referee | Allowed. Many-to-many. |
| Two-layer membership | `OrganizationMembership(role='referee')` + `MatchAssignment(role='referee')`. Both required. |
| Match assignment at invite | Optional; pool-based onboarding supported. |
| Invite power | **None** in v1.0. |
| Approve/reject final score | **Allowed.** Single critical verb that determines tournament outcomes. Password re-prompt on this verb. |
| Multi-Referee approval semantics | **Per-match toggle (locked).** `Match.requires_unanimous_referee_approval` (Bool, default `False`). When `False`: EITHER assigned Referee approves transitions to `final`. When `True`: ALL assigned Referees must approve. Rejection is always EITHER. Tournament-level `two_person_verification` rule field (PRD §5.13) is a v1.5 broader policy that orthogonally requires two distinct human approvers. |
| Void / correct event | Allowed pre-final (correct), allowed post-final (void). |
| Resolve dispute | **Denied** (Admin / Co-org / GameCoord-scoped only). |
| Force-finalize | **Denied** (override role, not Referee). |
| Same user as Scorer + Referee on same Match | **Denied** (§5.7 constraint). |
| Mid-match recusal | **Blocked** for `live_*` and `awaiting_referee_approval` states. |
| Stranded-Referee mitigation | `referee_approval_timeout_hours` default 24h → Admin/GameCoord force-finalize. |
| 2FA encouragement | Stronger than Scorer; recovery codes mandatory at enrollment. |

#### Remaining open questions (non-blocking)

- **"Refused approval" timeout:** if Referee actively rejects (not just times out), how many rejection cycles before Admin must intervene? **Defaulting to unlimited** in v1.0 — Referee can reject as many times as needed; Admin force-finalize is the escape valve.

---

## 7. Team manager

### 7.1 Identity tier

- **Team-level role.** Scope is one or more specific Teams within a Tournament — narrower than Game coordinator (Tournament-scoped) and orthogonal to Match scorer/Referee (Match-scoped).
- **One Team manager per Team is the typical case**, but the schema allows multiple TMs per Team for co-management (e.g., head coach + manager). No cap.
- **Multiple Teams per TM allowed** — a single user can manage multiple teams across different tournaments (e.g., manages Team A in Tournament X and Team B in Tournament Y).
- A user can hold Team manager + other roles in the same Org (Q3). Real-world common case: TM of own school's team + Match scorer for unrelated matches in the same tournament.
- This is the **only role that can self-register** under specific Tournament conditions (open-registration with `team_registration_requires_approval=false`). All other in-Org roles are invite-only.

### 7.2 Purpose

In scope:
- Register their team for a tournament (if open-registration, OR if invited by Admin/Co-org/GameCoord for invite-only).
- Manage their team's roster: add/edit players (each maps to a `Person` per PRD §5.3), set jersey numbers, captain, GK flag.
- Submit lineups before each match (PRD §5.4).
- Withdraw their team from a tournament (with consequences per PRD §5.3 — pre-bracket-locked = clean removal; post-bracket-locked = walkover for opponent).
- View the public Match Center for any match (read-only, like a Viewer).
- View own team's matches with full detail (formations, lineups, events).
- View own team's standings, suspensions, eligibility status.
- Raise disputes on own team's matches (PRD §3.2 ✅ for `Raise dispute` for TM `(own team)`).
- View own player DOB (PII, gated to TM by PRD §3.2).

Out of scope:
- Managing other teams' rosters or lineups.
- Resolving disputes (Admin / Co-org / GameCoord).
- Live scoring, refereeing, approving final scores.
- Tournament-level operations (bracket, schedule, rules).
- Org-level operations.
- Inviting any user (TM has zero invite power in v1.0; v1.5 may consider co-TM invites).

### 7.3 Creation

**Two creation paths:**

#### Path A — Invite by Admin / Co-organizer / Game coordinator
- Inviter selects role = `team_manager`.
- Inviter must specify a **Team** at invite time (or "create new team" inline). The team belongs to a specific Tournament.
- Invitee accepts via §2.13 invite flow.
- On accept: `OrganizationMembership(role=team_manager, status=active)` + `TeamMembership(user, team, role=team_manager, status=active)`.

#### Path B — Self-registration (open-registration tournaments only)
- Tournament must have `team_registration_requires_approval = false` per PRD §5.3 (or `true` with approval flow).
- Visitor goes to a public Tournament page, clicks "Register team" (visible only when registration window is open).
- Form: email, password, name, team name, short name, crest, primary color, school, region, etc. (PRD §5.3 fields).
- On submit:
  - If `team_registration_requires_approval=true`: User created (`is_active=False` until email verified) + Team created (`status=pending_approval`) + TeamMembership (`status=pending_approval`). Admin/Co-org/GameCoord must approve.
  - If `team_registration_requires_approval=false`: User created + Team created (`status=registered`) + TeamMembership (`status=active`) directly.
- Email verification required before first login regardless.
- Anti-bot rate limit: 3/hour/IP (same baseline as Org self-signup).
- **Self-registered TM is NOT auto-promoted to any Org-level role beyond `team_manager`.**

### 7.4 Authentication

- Email + password (PRD §2.9, §2.10).
- 2FA optional, default-off. TMs are typically school staff / volunteers who may resist friction; encourage rather than enforce.
- Session cookie on `fixture.doxaed.com`.
- **Password re-prompt on team withdrawal** (consequential, can affect bracket integrity).
- "Remember me" 30-day.

### 7.5 Surface

- React SPA. **Team-scoped dashboard** — shows team-level data: registered tournaments, players, upcoming matches, standings (own team's rows highlighted), suspensions affecting own team.
- Org switcher works normally; if TM holds memberships in multiple Orgs, can switch.
- **Lineup submission is the most-used screen on match days** — drag-drop formation, starter/bench split, captain marker, GK marker.
- Read-only Match Center for any match (same as Viewer for unassigned matches).
- **No Bracket / Schedule editor entry points.** TM can VIEW the bracket and schedule for their tournament (since these are public artifacts) but cannot edit.

### 7.6 Capabilities

#### Default module access (per Appendix A §A.3)

- `org.tournament_list` → 🔵 list filtered to tournaments their team is registered in.
- `org.audit_log`, `org.settings`, `org.branding`, `org.member_directory` → no access.
- `tournament.editor`, `tournament.bracket_editor`, `tournament.schedule_editor`, `tournament.audit_log` → no access (read-only via public surface).
- `tournament.team_registration` → 🔵 own team (self-register only — submitting their team's registration form).
- `tournament.player_roster` → 🔵 own team (full roster CRUD on their team).
- `tournament.lineup_manager` → 🔵 own team (their team's lineups only).
- `match.scoring_console`, `match.referee_console` → no access.
- `match.center_admin_view` → 🔵 own team's matches.
- `match.lineup_submission` → 🔵 own team.
- Personal modules → ✅ full.

#### Verbs available to Team manager (within own team scope)

- Register team / withdraw team.
- Add / edit / remove players (within eligibility-freeze rules per PRD §5.3).
- Set captain, GK flag, jersey number.
- Submit lineup for each match (per PRD §5.4 deadline rules).
- Late lineup edit (post-deadline, pre-kickoff) — requires Referee approval (PRD §5.4).
- Edit player jersey number between matches (audit-logged).
- View own team's full match history, stats, standings.
- View own player DOB (PII; gated by PRD §3.2).
- Raise disputes on own team's matches.

#### What Team manager cannot do

- Manage any team other than their own.
- View other teams' player DOBs.
- Resolve disputes.
- Approve / reject team registrations (that's Admin / Co-org / GameCoord per PRD §3.2).
- Disqualify any team (including their own — withdrawal is the TM verb; disqualification is Admin's).
- Override player suspensions (Admin's verb with audit).
- Invite anyone.

### 7.7 Schema

```python
# teams/models.py — refining PRD §8 TeamMembership
class TeamMembership(models.Model):
    id = UUID v7 PK
    user = FK(User)
    team = FK(Team)
    role = enum('team_manager')                            # only role at this scope in v1.0
    status = enum('invited', 'pending_email_verification',
                  'pending_approval', 'active',
                  'suspended', 'revoked', 'left')          # superset of PRD §3.3
    invited_by = FK(User, null=True, on_delete=SET_NULL)
    invited_at = DateTimeField(null=True)
    accepted_at = DateTimeField(null=True)
    revoked_at = DateTimeField(null=True)
    created_at = DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            UniqueConstraint(fields=['user', 'team', 'role'],
                             condition=Q(status='active'),
                             name='unique_active_team_role'),
        ]
```

**Authorization invariant:** to act as Team manager on Team T, a user must have BOTH:
1. `OrganizationMembership(user=U, organization=T.organization, role='team_manager', status='active')`, AND
2. `TeamMembership(user=U, team=T, role='team_manager', status='active')`.

A user with only the Org-level row appears as "TM (no team yet)" — applies to self-registration before team approval, or invited TM before team is assigned.

### 7.8 Delegation

**Team manager has zero invite power in v1.0.**

| Team manager can invite | None |
|------------------------|------|

v1.5 may consider:
- Co-TM invite (assistant manager) — invited by primary TM, requires Admin approval.
- Player claim flow — TM invites a Person to claim their Player profile (also v1.5).

### 7.9 Lifecycle

#### Team-level transitions

```
TeamMembership: invited / pending_approval → active → suspended / revoked / left
```

#### Self-registration approval flow (open-registration, approval-required)

1. Visitor self-registers team → `User(is_active=False)` + `Team(status=pending_approval)` + `TeamMembership(status=pending_approval)`.
2. Email verification → `User.is_active=True`; team status unchanged.
3. Admin / Co-org / GameCoord reviews in Tournament's Team Registration module → approves or rejects.
4. **Approve**: `Team.status='registered'` + `TeamMembership.status='active'`. Welcome notification.
5. **Reject**: `Team.status='rejected'` + `TeamMembership.status='revoked'`. Email with reason. User account remains for potential future invitations.

#### Team withdrawal

- TM initiates from Team Settings → "Withdraw team" → password re-prompt + reason.
- **Pre-bracket-locked**: clean removal; team marked `withdrawn`; `TeamMembership.status='left'`.
- **Post-bracket-locked**: opponent's match becomes a walkover (PRD §5.3); advancement fires; downstream matches updated. Team marked `withdrawn`. `TeamMembership.status='left'`.
- Audit-logged with reason (≥20 chars).

#### Team disqualification (NOT a TM verb)

- Admin verb (⚠️ per PRD §3.2). TM is a recipient of the notification, not the actor.
- On disqualification: `TeamMembership.status` automatically set to `revoked` for all TMs of that team.

#### TM voluntary departure

- TM leaves their own team via Personal Profile → "Leave team".
- If they're the only active TM:
  - **Block** until another TM is assigned, OR until team is also withdrawn.
  - UI suggests: "Add a co-manager first, or withdraw the team."
- If multiple TMs active: clean exit; remaining TMs get notification.

#### Promotion / role change

- TM → Game coordinator: standard invite-by-Admin/Co-org. New Org-level row added; TM rows stay.
- TM → Co-organizer: standard invite-by-Admin. New row added; TM rows stay.
- A TM whose Org-level membership is promoted to Co-organizer/Admin retains TM access to their team — no automatic revocation. Q3 multi-role.

#### Conflict-of-interest considerations

- TM whose user is also assigned as Scorer/Referee on a match where their own team is playing — same soft-warning baseline as §5.12 / §6.12. v1.5 hard block.

### 7.10 What Team manager does NOT have

- Cross-team visibility (cannot see other teams' rosters, lineups pre-kickoff per PRD §3.2 row "View opposing lineup pre-kickoff" = ❌ for TM).
- DOB visibility for non-own-team players.
- Tournament-level configuration verbs (bracket, schedule, rules).
- Org-level configuration.
- Dispute resolution.
- Disqualification authority.
- Suspension override (only Admin can override).
- Invite any user (in v1.0).
- Cross-Org access.
- Anything Super-admin-tier.

### 7.11 Onboarding

#### Path A (invited TM)

1. Email verification (often pre-verified via invite token).
2. 2FA enrollment prompt (skippable; default-off).
3. **No welcome wizard** — Org and Tournament are already configured.
4. Land on **team dashboard** showing assigned team(s) + upcoming matches.
5. Brief in-product tour: 3-step overlay covering Roster, Lineup submission, Match calendar.

#### Path B (self-registered TM)

1. Submit team registration form → land on "Awaiting approval" page (if `requires_approval=true`) OR directly to team dashboard (if `requires_approval=false`).
2. Email verification.
3. 2FA enrollment prompt.
4. After approval (Path B with approval): notification + welcome email + redirect to team dashboard.
5. **Welcome wizard for self-registered TM** (different from Org Admin's wizard): 2 steps — confirm team details (crest, color, school) + complete first roster entries. Skippable.

### 7.12 Decisions (locked) and remaining open questions

#### Locked decisions

| Decision | Outcome |
|----------|---------|
| Scope unit | **Team** (via `TeamMembership`). |
| Multi-TM per Team | **Allowed** (head coach + manager pattern). No cap. |
| Multi-Team per TM | **Allowed.** A user can manage teams across multiple tournaments. |
| Two-layer membership | `OrganizationMembership(role='team_manager')` + `TeamMembership`. Both required for operational access. |
| Self-registration | **Allowed** when tournament is open-registration. Only role with self-registration path other than Org Admin. |
| Approval-required toggle | Per-tournament `team_registration_requires_approval` field (PRD §5.3). |
| Invite power | **None** in v1.0. |
| View opposing lineup pre-kickoff | **Denied** (PRD §3.2). |
| View own player DOB | **Allowed** (PRD §3.2). |
| Disqualify own team | **Cannot** — withdrawal is the TM verb. Disqualification is Admin. |
| Withdraw team | Allowed; password re-prompt + reason. Bracket-impact rules per PRD §5.3. |
| Leave team while sole TM | **Blocked** until co-TM added or team withdrawn. |
| Conflict-of-interest with Scorer/Referee role | **Soft warning + audit at assignment time (locked).** No hard block in v1.0. Hard block deferred to v1.5. |

#### Remaining open questions (non-blocking)

- **Co-TM invite (v1.5):** primary TM invites assistant manager. Approval required from Admin? Recommend yes.
- **Player claim flow (v1.5):** TM invites a Person to claim their Player profile, linking a User to the Person. PRD §5.3 marks v1.5.
- **Auto-team-deletion on TM departure:** if all TMs leave, does the team auto-withdraw or enter "orphaned team" status (Admin reassigns)? Recommend: enter `orphaned` status, surfaces in Admin's Team Registration module.

---

## 8. Player — DEFERRED TO SPORT MODULE

### 8.1 Status

**Player is sport-coupled and is deferred to the sport module.** The user-types phase intentionally does NOT define the Player schema, lifecycle, or capabilities in detail.

**Why Player is sport-coupled:**
- Position taxonomies are sport-specific (football: GK/CB/LB/RB/etc.; basketball: PG/SG/SF/PF/C; volleyball: setter/libero/outside hitter; etc.).
- Jersey number conventions differ by sport (football = 1–99 unique; basketball = different rules; cricket = no jersey requirement traditionally; etc.).
- Eligibility rules are sport-specific (age categories, gender categories, weight classes for some sports, professional/amateur status, etc.).
- GK / captain / starter / bench semantics are not universal across sports.
- Squad size constraints differ.
- Suspension calculation rules differ (cards in football; technical fouls in basketball; etc.).

Because every meaningful Player attribute is sport-specific, finalizing the Player schema in the user-types phase would force premature commitments. Player gets fully designed when the **sport module** is designed (next phase after user types).

### 8.2 What the user-types phase commits to (minimum viable scaffold)

The user-types phase locks in only the parts of the Player concept that are **independent of sport** and necessary for the user/account model to be coherent:

| Commitment | Detail |
|------------|--------|
| **Person ↔ Player split** | Stable platform-scoped human identity (`Person`) vs. per-tournament registration (`Player`). Locked invariant from PRD §10. |
| **Player has NO login in v1.0** | No Player ever signs in. Player is passive data. |
| **Permission matrix Player row** | Dead code in v1.0; retained for v1.5 forward-compatibility. |
| **Person ↔ User link approach** | When v1.5 claim flow lands, link via a single `Person.user` OneToOneField. No separate `PersonAccount` join table. |
| **Cross-tournament identity** | Person is the stable identity; cross-tournament career stats roll up via Person. |
| **Soft-delete** | Person and Player use `deleted_at`; references retained for audit/stats. |
| **Hard constraint** | A Person cannot be on two Teams in the same tournament (DB constraint). |
| **DOB privacy posture** | Sensitive; field-level encryption decision finalized in sport module. PRD §7.7 currently specifies Fernet on DOB. |
| **Claim flow** | Deferred to v1.5. No claim infrastructure in v1.0. |
| **Creation actor** | Team manager creates Player rows via the Roster Manager (whatever shape that takes per sport). |
| **No invite power for Player** | Even after v1.5 claim, Players cannot invite anyone. |

### 8.3 What is deferred to the sport module

These will be designed when the sport module is taken up:

- Full `Player` schema (positions, jersey number rules, GK / captain / starter / bench flags, eligibility status enum, sport-specific attributes).
- `Person` schema details beyond the bare identity (name, DOB encrypted, photo).
- Squad-size and GK-minimum constraints (sport-specific).
- Suspension calculation (cards / fouls / technical infractions vary by sport).
- Eligibility-freeze semantics by stage / round (sport-specific tournament structure).
- Player lifecycle states (`eligible` / `ineligible` / `pending` etc.) — definition depends on which sport's rules apply.
- Player claim flow UI (v1.5; sport-agnostic at the claim level but profile fields are sport-coupled).

### 8.4 Placeholder schema markers (for the planner, not for implementation)

The user-types phase does **not** define `Person.dob`, `Player.position`, `Player.jersey_no`, `Player.is_goalkeeper`, etc. The implementation plan should NOT scaffold the Player table from this document. The sport module is the authoritative source.

What the implementation plan CAN scaffold safely from user-types-phase commitments alone:

- The `OrganizationMembership` / `TournamentMembership` / `TeamMembership` / `MatchAssignment` schema (covered in §§2–7).
- The reservation that `Person.user` will be a OneToOneField (not a join table) when added.
- The reservation that `MatchEvent.actor_user` and similar audit hooks will reference `Person` (via the linked `User` if claimed) — actual `MatchEvent` schema is sport module territory.

### 8.5 Decisions (locked at user-types phase)

| Decision | Outcome |
|----------|---------|
| Player phase | **Deferred to sport module.** User-types phase commits only to the Person↔Player concept, not the schema. |
| Player login in v1.0 | **None.** |
| Permission matrix Player row | Dead code in v1.0. |
| Person ↔ User link | Single `Person.user` OneToOneField (when sport module adds Person). |
| Claim flow | v1.5 (post-sport-module). |
| Player invite power | Always None — even post-claim. |

---

## 9. Viewer (public)

### 9.1 Identity tier

- **Anonymous, unauthenticated.** Anyone on the internet with a URL.
- **No `User` row** in the database. No session in the Django sense (a Viewer may have anonymous CSRF + session cookies for SSE reconnection bookkeeping, but no `request.user.is_authenticated`).
- The Viewer is the **largest user population by far** — every public match URL, every share card click, every fan watching a final is a Viewer.
- Viewer is **not in the §3.2 permission matrix as an actor** in the same sense as logged-in roles; the matrix's "Viewer" column represents what *non-logged-in* requests can access.

### 9.2 Purpose

In scope:
- View public Tournament pages (when `visibility='public'`).
- View public Match Center for any match (PRD §5.10).
- Subscribe to Match SSE channel (`match:<uuid>`) for real-time event push (PRD §7.2).
- View public Standings, Top Scorers, Bracket diagrams.
- View Stadium / broadcast mode (`?mode=broadcast`) for projector-friendly UI.
- Submit anonymous feedback via the Feedback widget (`personal.feedback_widget` is accessible to Viewers; `Feedback.user_id` is nullable per §1.7).
- Share match URLs (OG cards, QR codes per PRD §4 in-scope list).

Out of scope:
- Anything that requires a session or identity.
- Viewing `private` tournaments without authentication.
- Viewing `unlisted` tournaments without a direct link (the link IS the access).
- Viewing dispute details (only outcome is public; disputes show `Result disputed` per PRD §5.10 edge cases).
- Voting, commenting, reacting on matches (out of scope for v1).

### 9.3 Creation

**N/A.** Viewers are not created. Anyone with a URL is implicitly a Viewer.

### 9.4 Authentication

**N/A.** No login.

A Viewer who creates an account becomes a **logged-in user** (some role, depending on path) — but until that moment, they are anonymous.

If a Viewer hits a `private` tournament URL: redirect to login with `?next=...`. If they're not in the Org, they get a 404 after login (multi-tenancy isolation).

### 9.5 Surface

- React SPA, public routes only:
  - `/o/<org-slug>/` — Org public page (lists public tournaments).
  - `/t/<tournament-slug>/` — Tournament page.
  - `/t/<tournament-slug>/m/<match-uuid>/` — Match Center.
  - `/t/<tournament-slug>/m/<match-uuid>/?mode=broadcast` — Stadium mode.
  - `/t/<tournament-slug>/standings/` — Standings page.
  - `/t/<tournament-slug>/bracket/` — Bracket diagram.
- **No session, no auth headers, no CSRF** for read-only public endpoints.
- **SSE channels** for real-time updates (PRD §7.2): `match:<uuid>` for events. No login required.
- **Feedback widget** as a floating button on every public page; opens a modal with subject + body fields.

### 9.6 Capabilities

#### What Viewers can access (per PRD §3.2 row)

- ✅ View public match data.
- ❌ Download CSV / PDF export.
- ❌ Anything else.

#### What endpoints are open

- All public Tournament + Match read endpoints (`GET /api/public/...`).
- SSE channels for `public/tournament` and `public/match`.
- Feedback widget POST (rate-limited per IP).

#### Rate limits (PRD §7.7)

- Public SSE: 100 conns/IP.
- Public API read: 60/min/IP.
- Feedback widget submit: 5/hour/IP.

### 9.7 Schema

**No User row.** No OrganizationMembership row.

**Anonymous artifacts** that may be tracked:
- `UsageEvent` rows (PRD-§1.7 schema for KPI dashboards) with `user_id=NULL`, `org_id=NULL` (or scoped to the org being viewed). Captures "anonymous viewer accessed Tournament X / Match Y" for analytics.
- `Feedback` rows with `user_id=NULL` (anonymous feedback).
- SSE connection tracking (Redis ephemeral; not in Postgres).

No persistent identity. A Viewer's IP is logged in nginx access logs only (90-day retention per PRD §6 NFR).

### 9.8 Delegation

**N/A.** Viewers have no role-acting authority.

### 9.9 Lifecycle

**N/A.** Anonymous; no lifecycle to track.

If a Viewer becomes a logged-in user, that's a separate signup flow (Org self-signup creates an Admin; invite creates a sub-role; etc.). Conversion is not a "Viewer lifecycle event."

### 9.10 What Viewer does NOT have

- Any session, identity, or attributable action.
- Access to private or restricted data (multi-tenancy isolation enforced regardless).
- Write endpoints (except feedback submission).
- DOB visibility for any Player (PRD §3.2).
- Lineup pre-kickoff visibility for any match (PRD §3.2 — only shows after kickoff per public rules).
- CSV / PDF export.
- Anything Super-admin-tier.

### 9.11 Onboarding

**None.** Viewers don't onboard. They land on a public page and consume content.

If they convert to a logged-in role (sign up as Org Admin, accept an invite, claim a Player profile), they go through that role's onboarding flow.

### 9.12 Decisions (locked) and remaining open questions

#### Locked decisions

| Decision | Outcome |
|----------|---------|
| Viewer is anonymous | No User row, no session identity. |
| SSE for live updates | Open to Viewers without auth. Rate-limited per IP. |
| Anonymous feedback | **Allowed.** `Feedback.user_id` nullable (already locked in §1.7). |
| Private tournaments | Hidden from Viewers; require login + Org membership. |
| Unlisted tournaments | Accessible only via direct link; not crawled / listed. |
| Stadium / broadcast mode | Public, no auth (PRD §5.10). |
| CSV / PDF export | **Denied** to Viewers (PRD §3.2). |
| Vote / comment / react | **Out of scope** for v1.0 / v1.5. v2+ may add. |

#### Remaining open questions (non-blocking)

- **Per-Org public-API rate limits**: PRD §7.7 has a global 60/min/IP. Should a viral match temporarily relax this for SSE specifically? **Defaulting to PRD limits** unchanged.
- **Anonymous viewer counters**: should the Match Center show "X viewers watching live" (Twitch-style)? Privacy-friendly (just a count, no identification). Recommend: **defer to v1.5** as an engagement feature.
- **OG card / QR code signing**: should public share URLs include a signed token to prevent enumeration? PRD already uses (slug, UUID) pairs which are long and hard to guess. Recommend: no extra signing; the UUIDs are sufficient.

---

## 10. Media / press — DROPPED FROM v1.0

### 10.1 Status

**This role is dropped from v1.0** per the Q6 decision in §2 design discussion. Reintroduced in v1.5 if real journalist workflows demand it.

### 10.2 Rationale

- PRD §3.1 originally lists Media as "Public read enhanced" — invited by Admin.
- The only Media-specific privilege in PRD §3.2 is "Download CSV / PDF export" ✅. Otherwise Media = Viewer.
- A single privilege does not justify a separate account type, schema row, invite flow, audit story, or UX surface.
- Dropping Media reduces v1.0 invitable roles from 6 to 5 (Co-organizer, Game coordinator, Match scorer, Referee, Team manager) and simplifies §2.13 invite flow logic.

### 10.3 What replaces Media in v1.0

- Journalists are treated as **Viewers** (anonymous public access).
- If an Org genuinely wants to grant CSV / PDF export to a specific external party, the Admin can add them as a **Co-organizer with per-user module overrides revoking everything except `org.tournament_list` and CSV export** — the override UI ships in v1.0, so this workaround is available from day 1.

### 10.4 v1.5 reintroduction criteria

Reintroduce Media as a distinct role only if:
- ≥3 real Orgs request press-room functionality.
- The privilege set has expanded beyond CSV export (e.g., advance lineup access, embargoed match data, press-only RSS feeds).
- An audit story exists for press-only views (separate from Org audit log).

Until then: no `media` value in the `OrganizationMembership.role` enum, no Media UI, no Media invite flow.

### 10.5 Schema impact

- `OrganizationMembership.role` enum **does NOT include `media`** in v1.0. Adding it would be a future migration when the role is reintroduced.
- `personal.feedback_widget` Module is accessible to Viewers (anonymous), so journalists can still submit feedback.

### 10.6 Decisions (locked)

| Decision | Outcome |
|----------|---------|
| Media role in v1.0 | **Dropped.** |
| Media role in v1.5 | **Conditionally reintroduced** based on §10.4 criteria. |
| Journalists in v1.0 | Treated as Viewers (anonymous). |
| Per-user export grants | Achievable via Admin + per-user module override (v1.5 UI). |

---

## Appendix A — Module catalog and permission model

> Referenced from every role section. Defines the unit of permission in v1.0 and the resolution algorithm.

### A.1 Concept

The platform's permissions are organized in **two layers**:

1. **Role defaults** — every role (Admin, Co-organizer, Game coordinator, Match scorer, Referee, Team manager) has a default set of modules it can access.
2. **Per-user module grants** — Admin can grant or revoke individual modules to specific users beyond the role's default set, on a per-user-per-Org basis.

A **module** is a coarse functional surface of the SPA (a screen or feature area) that a user either does or doesn't have access to. Modules are coarser than the row-level actions in PRD §3.2 — think "Bracket Editor" (a module) vs. "drag-drop a match" (a row-level action covered by §3.2). The §3.2 matrix continues to govern fine-grained actions *within* a module.

### A.2 Module catalog (v1.0 — sport-agnostic; 22 modules post-audit)

> Sports / games are designed as a separate module *after* user types. The module catalog below is the user-facing surface and is sport-agnostic. When the sport module lands, sport-specific surfaces (e.g., football scoring console, basketball scoring console) will plug in *under* `match.scoring_console` rather than replacing it.

22 modules total, grouped by scope. (3 added by Appendix B.16 post-audit: `tournament.report_export`, `tournament.organizer_checklist`, `tournament.day_pack_export`.)

#### Org-scoped (5)

| Slug | Display name | Description |
|------|--------------|-------------|
| `org.settings` | Org Settings | Org name, slug (locked post-publish), branding, timezone, public-page settings |
| `org.member_directory` | Member Directory | List of all users in the Org with roles, statuses, last-login; invite/revoke/role-change actions |
| `org.audit_log` | Org Audit Log | Org-scoped audit events; searchable, filterable, CSV export (per PRD §5.15) |
| `org.tournament_list` | Tournament List | List of all tournaments in the Org with status filter; entry point to per-Tournament modules |
| `org.branding` | Org Branding | Logo, primary brand color, public-facing description |

#### Tournament-scoped (7)

| Slug | Display name | Description |
|------|--------------|-------------|
| `tournament.editor` | Tournament Editor | Wizard + edit views for basics, format, structured rules, prose rulebook, dates, venues, registration window (PRD §5.1) |
| `tournament.bracket_editor` | Bracket Editor | Auto-generate + drag-drop bracket; lock/unlock |
| `tournament.schedule_editor` | Schedule Editor | Auto-generate + drag-drop schedule; conflict warnings |
| `tournament.team_registration` | Team Registration Manager | Approve/reject team registrations, withdraw, disqualify |
| `tournament.player_roster` | Player Roster Manager | Add/edit/remove players; eligibility freeze; suspension overrides |
| `tournament.lineup_manager` | Lineup Manager | View/override lineups for any match in the tournament |
| `tournament.audit_log` | Tournament Audit Log | Tournament-scoped audit events |

#### Match-scoped (4)

| Slug | Display name | Description |
|------|--------------|-------------|
| `match.scoring_console` | Scoring Console | Live scoring UI — clock, event entry, player picker (PRD §5.6) |
| `match.referee_console` | Referee Console | Real-time event review, correction, post-match approval (PRD §5.6) |
| `match.center_admin_view` | Match Center (admin view) | Match details with admin overlays — submitted lineups, raw event log, scorer/referee identities |
| `match.lineup_submission` | Lineup Submission | Submit lineup as TM or override-submit as Admin |

#### Personal / cross-cutting (3)

| Slug | Display name | Description |
|------|--------------|-------------|
| `personal.notification_prefs` | Notification Preferences | (event_type × channel) toggle matrix per PRD §5.14 |
| `personal.profile` | Personal Profile | Edit own name, photo, email, password, 2FA |
| `personal.feedback_widget` | Feedback Widget | Submit bug/feature/complaint feedback (lands in Super-admin's Feedback Inbox per §1.5) |

### A.3 Default role → module map (v1.0)

Legend: ✅ full access · 👁 read-only · 🔵 scoped (assigned tournament / own team / assigned matches) · — no access

| Module | Admin | Co-org | GameCoord | Scorer | Referee | TeamMgr |
|--------|:-----:|:------:|:---------:|:------:|:-------:|:-------:|
| `org.settings` | ✅ | 👁 | — | — | — | — |
| `org.member_directory` | ✅ | ✅ | 👁 | — | — | — |
| `org.audit_log` | ✅ | ✅ | 🔵 sport | — | 🔵 own matches | — |
| `org.tournament_list` | ✅ | ✅ | 🔵 assigned tournament | 🔵 assigned | 🔵 assigned | 🔵 own team |
| `org.branding` | ✅ | ✅ | — | — | — | — |
| `tournament.editor` | ✅ | ✅ | 👁 | — | — | — |
| `tournament.bracket_editor` | ✅ | ✅ | 🔵 assigned tournament | — | — | — |
| `tournament.schedule_editor` | ✅ | ✅ | 🔵 assigned tournament | — | — | — |
| `tournament.team_registration` | ✅ | ✅ | 🔵 assigned tournament | — | — | 🔵 own team (self-register) |
| `tournament.player_roster` | ✅ | ✅ | 🔵 assigned tournament | — | — | 🔵 own team |
| `tournament.lineup_manager` | ✅ | ✅ | 🔵 assigned tournament | 👁 assigned | 👁 assigned | 🔵 own team |
| `tournament.audit_log` | ✅ | ✅ | 🔵 sport | — | — | — |
| `match.scoring_console` | ✅ override | ✅ override | 🔵 assigned tournament | 🔵 assigned | — | — |
| `match.referee_console` | ✅ override | ✅ override | 🔵 assigned tournament | — | 🔵 assigned | — |
| `match.center_admin_view` | ✅ | ✅ | 🔵 assigned tournament | 🔵 assigned | 🔵 assigned | 🔵 own team |
| `match.lineup_submission` | ✅ override | ✅ override | 🔵 assigned tournament | — | — | 🔵 own team |
| `personal.notification_prefs` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `personal.profile` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `personal.feedback_widget` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Notes:**
- "override" for Admin / Co-organizer on match-scoped modules: they can act in the role but each action is audit-logged with elevated `actor_role` because they're not the assignee. Used for emergencies (assigned scorer drops out mid-match).
- Scope qualifiers (🔵) are enforced by **row-level filters** layered on top of module access. Module access = "you can see this screen"; scope = "what data this screen returns for you".

### A.4 Per-user module override model (schema in v1.0; UI in v1.5)

```python
class Module(models.Model):
    id = UUID v7 PK
    slug = CharField(unique=True)            # e.g. "tournament.bracket_editor"
    name = CharField()                       # display name
    description = TextField()
    scope = enum('org', 'tournament', 'match', 'personal')
    default_role_set = JSONField()           # which roles get this by default
    created_at = DateTimeField(auto_now_add=True)


class MembershipModuleGrant(models.Model):
    """
    AUDIT FIX (2026-05-02): keyed on (user, organization), NOT on
    OrganizationMembership. The original keying caused a multi-role
    resolver bug where a granted=False revoke was silently bypassed
    when the user had a SECOND active role granting the same module
    via Layer 1 union. Per-(user, org) keying ensures a single source
    of truth for module overrides regardless of how many roles the
    user holds in the Org.
    """
    id = UUID v7 PK
    user = FK(User, on_delete=CASCADE)
    organization = FK(Organization, on_delete=CASCADE)
    module = FK(Module, on_delete=CASCADE)
    granted = BooleanField()                 # True = add beyond default; False = revoke a default
    reason = TextField()                     # required ≥20 chars; PII-bearing — see §A.7 retention
    granted_by = FK(User, null=True, on_delete=SET_NULL)
    granted_at = DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            UniqueConstraint(fields=['user', 'organization', 'module'],
                             name='one_grant_per_user_org_module'),
        ]
        indexes = [
            models.Index(fields=['user', 'organization']),
        ]
```

**Resolution algorithm (corrected for multi-role users):**

```python
def effective_modules(user: User, org: Organization) -> set[Module]:
    # Layer 1: union of all role defaults across the user's active memberships.
    active_roles = OrganizationMembership.objects.filter(
        user=user, organization=org, status='active'
    ).values_list('role', flat=True)

    modules = set()
    for role in active_roles:
        modules |= role_default_modules(role)

    # Layer 2: per-user overrides keyed on (user, org), NOT on membership row.
    # This is the single source of truth for the user's module set in this Org —
    # independent of how many roles they hold.
    grants = MembershipModuleGrant.objects.filter(user=user, organization=org)
    for grant in grants:
        if grant.granted:
            modules.add(grant.module)
        else:
            modules.discard(grant.module)

    return modules
```

**Cache invalidation contract:**
- Cached at key `eff_modules:user:<uuid>:org:<uuid>` with a version suffix `v:<int>`.
- Version is bumped whenever ANY of these change for the (user, org) pair:
  - `OrganizationMembership.status` transition
  - `OrganizationMembership` row create / soft-revoke
  - `MembershipModuleGrant` row create / update / delete
- Bumping uses `transaction.on_commit` to push a `module_perm_invalidated` event onto Redis pub/sub `permcache:user:<uuid>:org:<uuid>`.
- All ASGI workers subscribe; on receipt, drop the cache key.
- For multi-tab SPA refresh: workers also push to `user:<uuid>:notifications` with a synthetic `permissions_changed` notification (always-on, not dismissable) so the SPA can re-fetch its module list.

**Audit:** every grant / revoke writes an `AuditEvent`.

### A.5 Why this matters

- **Role defaults give 90% of users the right access on day 1** without any per-user configuration.
- **Per-user overrides cover the 10% edge cases** without requiring custom roles. A trusted Game coordinator can be given Audit Log access without becoming a Co-organizer.
- **Both schema AND Admin UI ship in v1.0** so day-one Orgs have full module-override flexibility without escalating to support.
- **The module catalog is versioned in code** (Django fixture or migration data). New modules added in later versions get default role mappings declared at the same time.

---

## Appendix B — Implementation guardrails (added 2026-05-02 post-audit)

This appendix consolidates implementation guardrails surfaced by the multi-agent audit. Items here are **as load-bearing as the role sections above** — every developer reading this spec must read Appendix B before writing code.

### B.1 UUID v7 source (locked)

Every PK declared as `id = UUID v7 PK` MUST come from a deterministic v7 source, not `uuid.uuid4`:

- **Application source:** `uuid_utils` PyPI package (`uuid_utils.uuid7()`) — committed dependency. Python's stdlib does NOT provide v7 as of 3.13.
- **Database source (preferred for high-throughput tables):** `pg_uuidv7` Postgres extension installed in the migration that creates the schema; default values use `gen_uuid_v7()`.
- **Tables that MUST use DB-side default for time-ordered PKs:** `MatchEvent`, `AuditEvent`, `Notification`, `UsageEvent`. (Insert ordering matters for cursor-based pagination.)
- **Tables that may use application-side generation:** all role/membership tables.
- **CI check:** test that asserts no `uuid.uuid4` import in `apps/*/models.py` (use `uuid_utils.uuid7` exclusively).

### B.2 Row-level scope-filter pattern (locked)

Every 🔵-scoped module access in §A.3 (own team / assigned tournament / assigned matches / own matches) is enforced via a **two-layer pattern**:

```python
# 1. Per-app QuerySet manager class with explicit scope methods.
# Example: apps/tournaments/managers.py
class TournamentQuerySet(models.QuerySet):
    def visible_to(self, user, org):
        """Returns the set of Tournaments this user can READ in this Org."""
        modules = effective_modules(user, org)

        if 'tournament.editor' in modules:
            # Admin / Co-org — sees all org tournaments.
            return self.filter(organization=org, deleted_at__isnull=True)

        # Game coordinator scope: assigned tournaments only.
        gc_tournament_ids = TournamentMembership.objects.filter(
            user=user, status='active', tournament__organization=org
        ).values_list('tournament_id', flat=True)

        # Scorer/Referee scope: tournaments containing assigned matches.
        match_tournament_ids = MatchAssignment.objects.filter(
            user=user, status='assigned', match__tournament__organization=org
        ).values_list('match__tournament_id', flat=True)

        # Team manager scope: tournaments containing managed teams.
        tm_tournament_ids = TeamMembership.objects.filter(
            user=user, status='active', team__tournament__organization=org
        ).values_list('team__tournament_id', flat=True)

        return self.filter(
            organization=org,
            deleted_at__isnull=True,
            id__in=set(gc_tournament_ids) | set(match_tournament_ids) | set(tm_tournament_ids)
        )

# 2. DRF view base class that calls .visible_to() automatically.
class ScopedListView(generics.ListAPIView):
    def get_queryset(self):
        return self.queryset.visible_to(self.request.user, self.request.org_context)
```

**CI test contract:** for every scoped module, write a parametrized test asserting that:
- A user in Org X with role R sees only the rows their scope allows.
- A user in Org Y cannot see ANY Org X rows via the same endpoint (multi-tenancy isolation per PRD §7.4).
- Suspending the scope-membership row (e.g., `TournamentMembership.status='revoked'`) immediately removes the data from the queryset on the next request.

### B.3 DRF endpoint conventions (locked)

Endpoint shape follows **Google AIP-136 (custom methods, colon syntax)**:

| Pattern | When | Example |
|---------|------|---------|
| `GET /api/{collection}/` | List collection | `GET /api/orgs/` |
| `POST /api/{collection}/` | Create new | `POST /api/orgs/` |
| `GET /api/{collection}/{id}/` | Read | `GET /api/orgs/{uuid}/` |
| `PATCH /api/{collection}/{id}/` | Update | `PATCH /api/orgs/{uuid}/` |
| `DELETE /api/{collection}/{id}/` | Soft-delete | `DELETE /api/orgs/{uuid}/` |
| `POST /api/{collection}/{id}:{verb}/` | Custom action verb | `POST /api/orgs/{uuid}:suspend/` |
| `GET /api/{parent}/{id}/{nested}/` | Nested collection | `GET /api/orgs/{uuid}/members/` |

**All verb actions from §§1.6, 2.6, 3.6, 4.6, 5.6, 6.6, 7.6 use the `:verb` colon-suffix pattern.**

Examples:
- `POST /api/orgs/{uuid}:approve/`, `:reject/`, `:suspend/`, `:reassign-orphan/`
- `POST /api/users/{uuid}:force-logout-all/`, `:force-disable-2fa/`, `:impersonate/`
- `POST /api/orgs/{uuid}/members/{uuid}:demote/`, `:promote-admin/`, `:transfer-ownership-initiate/`
- `POST /api/matches/{uuid}/assignments/{uuid}:approve-final/`, `:reject-final/`, `:decline/`
- `POST /api/teams/{uuid}:disqualify/`, `:withdraw/`

**Why colon-syntax over RPC-style:** keeps resources noun-shaped, surfaces verbs explicitly in URL audit trails, plays well with `drf-spectacular` OpenAPI generation.

**OpenAPI commitment:** `drf-spectacular` is a v1.0 dependency. TypeScript types for the SPA are generated via `openapi-typescript-codegen` from the served schema. CI fails if a new endpoint lacks an `@extend_schema` annotation.

### B.4 AuditEvent integration pattern (locked)

**Service-layer call, NOT signals.** Every verb writes an `AuditEvent` from inside the service function, at the same call site that performs the state change. This keeps reason, payload, and elevated-actor tracking explicit at the place a developer is reading.

```python
# apps/audit/services.py
def emit_audit(
    actor_user: User,
    actor_role: str,                # see B.5 actor_role taxonomy
    event_type: str,                 # see B.6 event_type catalog
    target_type: str,
    target_id: UUID,
    payload_before: dict | None = None,
    payload_after: dict | None = None,
    reason: str = '',
    org: Organization | None = None,
    impersonating_user_id: UUID | None = None,
    request: HttpRequest | None = None,
):
    """Idempotent on (actor_user, event_type, target_id, idempotency_key)."""
    ...

# Example service-layer call site:
def suspend_organization(actor: User, org: Organization, reason: str):
    with transaction.atomic():
        before = {'status': org.status}
        org.status = 'suspended'
        org.suspended_at = timezone.now()
        org.save(update_fields=['status', 'suspended_at'])

        emit_audit(
            actor_user=actor,
            actor_role='super_admin',
            event_type='org_suspended',
            target_type='organization',
            target_id=org.id,
            payload_before=before,
            payload_after={'status': 'suspended'},
            reason=reason,
        )

        transaction.on_commit(lambda: notify_org_members(org, 'org_suspended'))
        transaction.on_commit(lambda: invalidate_org_sessions(org))
```

**No `post_save` signals for audit emission.** Signals couple emission to ORM mechanics; service-layer calls couple it to the actual user intent.

**Idempotency:** `AuditEvent` has an `idempotency_key` UUID field. The service function generates a deterministic key from `(verb, target_id, request.idempotency_key)`. Re-submission returns existing row (200, not 201) per PRD §7.6.

### B.5 actor_role taxonomy (locked)

`AuditEvent.actor_role` ∈ ONE OF:

| actor_role | When |
|------------|------|
| `super_admin` | Verb performed by `User.is_superuser=True` |
| `admin` | Verb performed by user holding active Admin role (`is_org_owner` either) |
| `co_organizer` | Verb performed by Co-org |
| `game_coordinator` | Verb performed by GameCoord |
| `match_scorer` | Verb performed by Scorer (assigned to the target match) |
| `referee` | Verb performed by Referee (assigned to the target match) |
| `team_manager` | Verb performed by TM (managing the target team) |
| `system` | Auto-transitions: stranded-match auto-postpone, advancement on team-disqualified, orphan auto-promote, expired-invite auto-archive, scheduled-notification cron, etc. `actor_user` IS NULL for system rows. |

**Elevated-actor convention** (when an Admin/Co-org acts on a match-scoped module they don't own as Scorer/Referee):
- `actor_role` = the user's HIGHEST tier role for the action (e.g., `admin`).
- `payload_after.elevated = true`.
- `payload_after.elevated_from_role = 'match_scorer'` (the role the verb normally requires).
- This way the audit log query "show me all override actions" is `WHERE payload->>'elevated' = 'true'`.

**Impersonation convention:**
- `actor_role` = `super_admin` (the actual actor).
- `actor_user` = Super-admin's User row.
- `payload_after.impersonating = <impersonated_user_id>`.
- A separate `AuditEvent(event_type='impersonation_action')` is also written so the impersonated user can query their own activity log and see Super-admin actions taken on their behalf.

### B.6 event_type catalog (canonical, ~70 strings)

```
# §1 Super-admin verbs
org_approved · org_rejected · org_suspended · org_unsuspended · orphan_org_reassigned
user_suspended · user_unsuspended · user_force_logged_out · user_2fa_force_disabled
user_impersonated · impersonation_action · feedback_responded · feedback_archived
super_admin_login · super_admin_login_failed · super_admin_2fa_reset

# §2 Org-level verbs
org_created · org_settings_changed · org_branding_changed · org_deleted
ownership_transfer_initiated · ownership_transfer_accepted · ownership_transfer_declined · ownership_transfer_expired
admin_promoted · admin_demoted · admin_added · org_owner_auto_promoted · org_orphaned

# §2.13 invite flow
member_invite_sent · member_invite_accepted · member_invite_declined · member_invite_revoked · member_invite_expired
member_role_added · member_role_revoked · member_suspended · member_unsuspended

# §3 Co-organizer (verbs reuse §2 events)
# §4 Game coordinator
tournament_created · tournament_published · tournament_state_changed
bracket_generated · bracket_locked · bracket_unlocked · bracket_edited
schedule_generated · schedule_locked · schedule_edited
team_registration_approved · team_registration_rejected · team_disqualified · team_withdrawn
dispute_resolved · match_force_finalized · player_suspension_overridden
rule_amend_proposed · rule_amend_effective

# §5 Match scorer
assignment_created · assignment_revoked · assignment_declined · assignment_replaced · assignment_completed
match_event_created · match_event_voided · match_event_corrected
match_clock_started · match_clock_paused · match_clock_resumed · match_period_ended
match_walkover_declared · match_abandoned · match_postponed
match_stranded · match_unstranded · match_auto_postponed
conflict_of_interest_warning_bypassed

# §6 Referee
referee_approve_final · referee_reject_final · referee_recused · referee_emergency_replaced
referee_pre_match_briefing_completed
multi_referee_partial_approval · match_finalized

# §7 Team manager
team_created · team_self_registered · team_settings_changed
player_added · player_edited · player_removed · jersey_number_changed · captain_changed
lineup_submitted · lineup_late_edit_approved · lineup_auto_walkover

# §A.4 module overrides
module_grant_added · module_grant_revoked · module_grant_changed
permissions_changed       # synthetic; for SSE invalidation only — not stored

# §A.10 anti-abuse
session_invalidated_org_suspension · session_fixation_cycled
```

**Every verb in §§1.6, 2.6, 3.6, 4.6, 5.6, 6.6, 7.6 maps to exactly one event_type from the above.**

### B.7 Notification recipient + default-state additions

New event types not in PRD §5.14 — fold these into PRD §5.14 with these defaults:

| event_type | Recipients | Default state | Always-on? |
|------------|-----------|---------------|------------|
| `org_admin_added` (Path C promotion) | All existing Admins (peer review) | enabled | **Yes** (security-relevant) |
| `module_grant_added` | Target user + audit-only fan-out to other Admins | enabled | **Yes** (security-relevant) |
| `module_grant_revoked` | Target user | enabled | **Yes** |
| `ownership_transfer_initiated` | Outgoing owner (sent), Recipient (sent), all other Admins (informational) | enabled | **Yes** |
| `ownership_transfer_accepted` | Outgoing owner, Recipient, all other Admins | enabled | **Yes** |
| `ownership_transfer_declined` | Outgoing owner | enabled | No |
| `ownership_transfer_expired` | Outgoing owner | enabled | No |
| `org_orphaned` | Super-admin queue + last remaining Admin (if any) | enabled | **Yes** |
| `org_owner_auto_promoted` | All Org members | enabled | **Yes** |
| `match_stranded` | Admin + GameCoord (with embedded "Postpone" / "Reassign Scorer" actions in payload) | enabled | **Yes** |
| `match_unstranded` | Admin + GameCoord | enabled | No |
| `match_auto_postponed` | All assigned roles + TMs of both teams | enabled | **Yes** |
| `multi_referee_partial_approval` | All co-Referees on the same match | enabled | No |
| `team_disqualified` | TMs of disqualified team + opposing TMs of affected matches + Admin/GameCoord | enabled | **Yes** (consequential) |
| `assignment_declined` | Assigner (Admin / GameCoord) | enabled | No |
| `permissions_changed` (synthetic) | Target user (drives SPA cache invalidation) | always | **Yes**, non-suppressible |
| `conflict_of_interest_warning_bypassed` | Audit only — no notification (intentional, prevents alert fatigue) | n/a | n/a |

### B.8 SSE channel scoping (cross-Org bleed fix)

PRD §7.2 originally publishes notifications on `user:<uuid>:notifications`. v1Users.md §2.5 introduces multi-Org users. **Locked refinement:**

- Channel structure: `user:<uuid>:notifications` (single channel per user, all Orgs).
- Every `Notification` row carries `org_id` (already in PRD schema).
- The SPA's bell component receives all events, **filters client-side by active Org context** (Org switcher state).
- An "All Orgs" view in the bell shows everything; Org-switcher views filter to that Org's rows.
- Notification-grouping rule (PRD §5.14 "≥5 same event_type within 1 minute → collapse") is **per-org**: 5 `match_scheduled` across 5 Orgs do NOT collapse.
- Self-suppression rule clarification: a notification suppresses if `actor_user_id == recipient_user_id`. For ownership transfer accept, the *accepter* is the actor → they don't get an `ownership_transfer_accepted` notification (the outgoing owner does).

### B.9 Suspension force-disconnect (locked)

When a user is suspended (Org-level or Super-admin), all open SSE/WebSocket sessions tied to their `User.id` MUST close immediately:

- Suspension service emits Redis pub/sub on channel `session:user:<uuid>:invalidate`.
- All ASGI workers subscribe; on receipt, look up open Channels groups + open SSE generators for that user and call `.close()`.
- Worker drops the connection with code `4401` (custom: "session invalidated"). Client SDK reconnects → 401 → redirects to login.
- Audit row: `session_invalidated_org_suspension` (event_type) with `actor_role='system'` and `payload.reason='org_suspended'` (or whichever cause).
- For force-logout-all-sessions (§1.6 verb): same mechanism, broader (all sessions of that user across the platform, including Super-admin's own session if self-applied).

### B.10 HTMX-CSRF wiring (Super-admin console, §1.5)

Locked pattern for the `sadmin/` Django templates:

```html
<!-- base.html <head> -->
<meta name="csrf-token" content="{{ csrf_token }}">

<script>
  document.body.addEventListener('htmx:configRequest', (event) => {
    event.detail.headers['X-CSRFToken'] =
      document.querySelector('meta[name="csrf-token"]').content;
  });
</script>
```

**No `@csrf_exempt` decorators on `apps/sadmin/views/`.** CI lint check fails if `@csrf_exempt` appears in that app.

For HTMX form submissions, the standard Django `{% csrf_token %}` template tag in the `<form>` is sufficient — the meta-tag-plus-headers approach above covers AJAX-style `hx-post` on non-form elements.

### B.11 Anti-abuse posture (consolidated)

Single source of truth for invite, signup, and feedback flows. Cross-references §2.13, §7.3, §1.7, §9.6.

| Surface | Rate limit | Honeypot | Time-to-submit | Identical response | Body redaction |
|---------|-----------|----------|----------------|--------------------|----------------|
| Org self-signup (Path B, §2.3) | 3/hr/IP, 1/day/email | ✅ | ≥800 ms | ✅ enumeration-safe | n/a |
| Team self-registration (§7.3 Path B) | 3/hr/IP | ✅ | ≥800 ms | ✅ | n/a |
| Member invite send (§2.13) | 30/hr/inviter | n/a | n/a | ✅ for "user exists vs not" probes | n/a |
| Feedback submit (§1.7, §9.6) | 5/hr/IP (anon), 30/hr/user | ✅ for anon | ≥800 ms | n/a | ✅ regex-scrub for emails, JWTs, UUIDs in querystring, base32/hex tokens, password=, otp= |
| SlugRedirect resolution (PRD §2.8) | 60/min/IP | n/a | n/a | identical 404 timing for unknown vs. suspended | n/a |
| Login (§2.4) | 5/min/IP, 20/min/email | n/a | n/a | ✅ (PRD §2.9) | n/a |

**Session-fixation defense on invite acceptance (§2.13):** every invite-accept handler MUST call `request.session.cycle_key()` before returning, regardless of whether the user was pre-authenticated. CI test enforces.

**Feedback body redaction (server-side at INSERT):**
```python
PII_PATTERNS = [
    re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'),  # emails
    re.compile(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b'),  # JWTs
    re.compile(r'\b[A-Za-z0-9]{32,}\b'),  # long opaque tokens
    re.compile(r'(?i)\b(password|otp|recovery[-_]?code)\s*[:=]\s*\S+'),
]
def redact_feedback_body(body: str) -> str:
    for p in PII_PATTERNS:
        body = p.sub('[REDACTED]', body)
    return body
```

### B.12 2FA mandatory for Org owners (locked refinement)

§2.4 originally said "optional but strongly recommended" for Admins. **Locked refinement:**
- Any user holding `is_org_owner=True` MUST enroll 2FA within 7 days of the flag taking effect (first login or transfer).
- Account is read-only (no destructive verbs, no member invites) until enrolled.
- Banner appears on every page until enrolled.
- After 7 days unenrolled: account is suspended pending 2FA enrollment; Super-admin notified.
- Recovery codes are MANDATORY at enrollment, hashed with argon2id at rest (consistent with §1.4).
- Non-owner Admins, Co-orgs, GameCoords, Scorers, Refs, TMs: 2FA remains optional.

### B.13 Stranded-match recovery transitions (locked refinement)

Extends §5.9 stranded-match logic with explicit transitions OUT of `stranded`:

```
live_*  →  stranded   (30 min no event + no Scorer connection)
stranded → live_*     (auto: first MatchEvent after entering stranded; cancels postpone timer)
stranded → live_*     (manual: GameCoord/Admin clicks "Resume" with reason; cancels timer)
stranded → live_*     (Scorer reconnects + posts an event within 15 min; cancels timer)
stranded → postponed  (auto: 15 min in stranded with no resolution; system actor)
stranded → postponed  (manual: GameCoord/Admin clicks "Postpone" with reason)
```

**Detector:** Celery beat task running every 60s scans `Match.status IN live_*` rows. For each, checks `last MatchEvent.server_ts`. If gap ≥ 30 min AND no active Scorer WS connection (Redis presence key `ws:match:<uuid>:scorer:*` empty) → enter `stranded`. If already `stranded` AND gap from `entered_stranded_at` ≥ 15 min → `match_auto_postponed`.

**Reset rule:** any human intervention (replacement Scorer assigned, `Match` `status` flipped, manual postpone) cancels the 15-min auto-postpone timer.

### B.14 Real-world fallback paths (locked v1.0 commitments)

These were flagged by the real-world audit and are committed for v1.0:

1. **WhatsApp/SMS magic link for invites.** v1.0 ships the email channel. Phone-number capture is OPTIONAL on the invite form (deferred to v1.5). For now: invite emails surface a "Forward this link" affordance so an organizer can manually relay via WhatsApp.

2. **Magic-link login** (deferred to v1.5). v1.0 keeps password + 2FA. v1.5 adds a 15-min-TTL signed-token email link for tournament-day reauth.

3. **Pre-tournament organizer checklist** (v1.0): a one-screen "Are you ready?" surface in the Tournament Editor that shows: Scorer pool size, Referee pool size, venues set, schedule generated, lineups submission status. Drives Orgs to onboard volunteers BEFORE tournament day, not during.

4. **Print-and-paper fallback** (v1.0):
   - GameCoord can export "Today's matches PDF" from the assigned-tournaments dashboard. Includes schedule, venues, team rosters, blank lineup sheets, blank match-card forms.
   - End-of-tournament report PDF: standings + top scorers + match results + bracket diagram. Generated by `tournament.report_export` (NEW module added to Appendix A as part of this audit; see B.16).

5. **Last-minute Scorer share-link** (v1.5). v1.0 keeps the standard invite flow + pool-based assignment.

6. **Offline-first scoring** (v1.5). v1.0 keeps the localStorage queue + status pill (PRD §5.6). Truly offline venues are out of scope for v1.0.

7. **Push notifications** (v1.5 PWA). v1.0: in-app SSE + email for critical events (`match_stranded`, `ownership_transfer_*`, `account_security_alert`). Email is the out-of-band channel.

8. **Path B Org self-signup approval SLA** (v1.0): commitment is **"Super-admin reviews within 24 hours."** If Super-admin is unreachable for >24h, an auto-approval-with-flag policy fires for low-risk signups (school email domain, no spam-pattern match) — flagged for Super-admin review post-fact. v1.5 adds explicit Super-admin SLA management.

9. **Conflict-of-interest "suppress for this tournament" toggle** (v1.0): the soft-warning banner has a "Don't warn me again for {Tournament X} matches" checkbox. Per-tournament, per-(user, team) preference, audit-logged on first dismiss.

10. **Lock-bracket workflow** (v1.0): Bracket Editor has a prominent "Lock bracket" button after generation. Locked brackets cannot be edited without explicit unlock + reason ≥20 chars. All bracket edits write a snapshot to `BracketSnapshot` table for one-click restore (deferred specifics to bracket module phase, but commitment stands).

### B.15 Test fixture commitment (locked)

- Factory library: **`factory_boy`** (committed). `model_bakery` ruled out (less control over relationships).
- Seed factory file: `apps/{app}/tests/factories.py` per app.
- Master seed runner: `manage.py seed_dev_data` — idempotent, generates: 1 Super-admin, 2 sample Orgs, 2 Admins per Org (one with `is_org_owner=True`), 2 Co-organizers per Org, 2 Game coordinators (with TournamentMembership), 4 Scorers + 4 Referees in the Org pool, 4 Team managers (each with a TeamMembership), 1 sample Tournament per Org (skeleton, sport-agnostic), Module catalog seeded, sample Feedback rows.
- Permission-matrix parametrized test: lives at `apps/permissions/tests/test_module_matrix.py`. Iterates Appendix A.3 cells and asserts `effective_modules()` returns the documented set for each (role, override-state) combination.

### B.16 Module catalog additions (post-audit)

Adding 3 modules surfaced by the real-world audit:

| Slug | Display name | Default access |
|------|--------------|----------------|
| `tournament.report_export` | Tournament Report Export | Admin ✅, Co-org ✅, GameCoord 🔵 assigned tournament. Generates end-of-tournament PDF (standings + top scorers + match results + bracket). |
| `tournament.organizer_checklist` | Pre-Tournament Checklist | Admin ✅, Co-org ✅, GameCoord 🔵 assigned tournament. Single-screen readiness summary. |
| `tournament.day_pack_export` | Today's Day-Pack Export | Admin ✅, Co-org ✅, GameCoord 🔵 assigned tournament. PDF for venue use (schedule + roster + blank lineup/match-card forms). |

Module total: 19 → **22**. Update §A.2 catalog as part of this audit.

### B.17 Sequencing dependency (locked)

**v1.0 ships in two phases:**

**Phase 1A — User types + chassis (this document):**
- `apps/accounts`, `apps/organizations`, `apps/audit`, `apps/permissions`, `apps/sadmin`.
- Models: `User`, `Organization`, `OrganizationMembership`, `AdminInvitation`, `SlugRedirect`, `AuditEvent`, `Module`, `MembershipModuleGrant`, `Feedback`, `UsageEvent`, `KPISnapshot`.
- Tournament/Team/Match memberships (`TournamentMembership`, `TeamMembership`, `MatchAssignment`) — schema and constraints — but the parent tables (`Tournament`, `Team`, `Match`) are stubs.
- Super-admin console.
- Org self-signup + approval flow.
- SPA shell + auth + Org switcher + Member Directory + invite flow + Module override matrix.
- All §1, §2, §3 surfaces. Partial §4 (Tournament-list scoping). §5/§6 schema only. §7 schema only.

**Phase 1B — Sport module (designed AFTER user types, separate spec):**
- `Tournament`, `Team`, `Match`, `Player`, `Person`, `MatchEvent`, `Lineup`, `PlayerSuspension`, `Dispute` schema in full.
- Sport-specific event taxonomy.
- Scoring Console + Referee Console.
- Bracket / Schedule generators.
- Public Match Center.
- Notification recipient lists for sport-specific events.

**Net effect on v1.0 timeline:** Phase 1A is independently shippable; an Org can be created, members invited, and the Super-admin console operates. Phase 1B is what makes the Org actually run a tournament. Both must ship before the v1.0 "first real tournament runs end-to-end" success criterion is met (PRD §11).

### B.18 Migration order (locked)

```
0001_accounts_user            # User + 2FA fields + deleted_at
0002_audit_event              # AuditEvent + Postgres role-deny migration
0003_organizations            # Organization + slug_redirect
0004_org_membership           # OrganizationMembership + 4 constraints
0005_admin_invitation         # AdminInvitation
0006_permissions_module       # Module catalog (data migration loads fixture)
0007_membership_module_grant  # MembershipModuleGrant
0008_sadmin_observability     # Feedback + UsageEvent + KPISnapshot
0009_tournament_skeleton      # Tournament stub (sport-agnostic fields only)
0010_tournament_membership    # TournamentMembership
0011_team_skeleton            # Team stub
0012_team_membership          # TeamMembership
0013_match_skeleton           # Match stub + requires_unanimous_referee_approval
0014_match_assignment         # MatchAssignment + status enum + referee approval fields
0015_match_assignment_signal  # pre_save signal for no-scorer-and-referee constraint

# Phase 1B (sport module — separate spec, not in this doc):
0016+_sport_football_*         # Player, Person, MatchEvent, etc.
```

**Migration-during-live-tournament guard** (PRD §5 mandate): `manage.py migrate` is wrapped by `manage.py safe_migrate`, which queries `Tournament.objects.filter(status='live').exists()` first and aborts with a tournament-list if any exists.

### B.19 Feature flag system (locked)

- Library: **`django-waffle`** (committed dependency).
- v1.0 flags ship to control:
  - `module_override_ui` (default ON)
  - `conflict_of_interest_soft_warning` (default ON)
  - `match_stranded_auto_postpone` (default ON)
  - `multi_referee_unanimous_mode` (default ON, controls whether the per-match toggle is exposed)
  - `org_owner_2fa_mandatory` (default ON)
  - `whatsapp_invite_relay` (default OFF — placeholder for v1.5)
- Flags can be flipped per-Org via `OrgFeatureFlag(org, flag, enabled)` table for Org-scoped overrides.
- Super-admin console exposes flag management at `/sadmin/flags/`.

### B.20 Frontend handoff (deferred to sibling doc)

A sibling document `v1Frontend.md` will cover:
- React SPA route table (per-role landing pages, deep-link semantics)
- Top-bar / sidebar component layout
- Org switcher UX (URL slug as source of truth, default = `User.last_active_org_id`)
- Role-context indicator (truncation rule for 4+ roles, dropdown vs. badge)
- Module-override matrix UI (3-state segmented control + bulk-column-header)
- Conflict-of-interest banner (tiered friction: single-click for tournament-day Scorer assignment, typed phrase for Admin override)
- Stranded-match notification card (embedded "Postpone now" + "Reassign Scorer" actions)
- Member Directory multi-role row display (chips with primary-role-bold, overflow "+N more")
- Mobile breakpoints for Admin/Co-org/GameCoord/TM SPA (Lineup Manager is mobile-first; Bracket/Schedule editors desktop-first)
- Empty/error/loading state catalog per role (PRD §5.12 enumerated)

`v1Frontend.md` is a v1.0 blocker for SPA work but NOT a blocker for backend Phase 1A.

### B.21 Open questions deferred to implementation phase (don't block)

These are intentionally not locked at spec time:

- Concurrent ownership-transfer attempts (recommend: reject second until first resolves; SELECT FOR UPDATE on Org row at initiate)
- Demoted owner's post-transfer role (dropdown at transfer time: Admin / Co-organizer / leave Org)
- KPISnapshot caching cadence (start on-demand; revisit after first dashboard performance issue)
- "Lead coordinator" flag for multi-GameCoord tournaments (v1.5)
- "Scorer recommends another scorer" flow (v1.5)
- Anonymous viewer counter (v1.5)
- Person merge tool (v1.5)
- Photo encryption beyond DOB (security review pre-v1.0 ship)

### B.22 Audit summary (transparency)

8 audit lenses applied to v1Users.md on 2026-05-02:

| Lens | Findings | Severity |
|------|----------|----------|
| Schema & DB constraints | 25 | 5 critical, 6 schema gaps, 5 inconsistencies, 9 hazards |
| Authorization & permissions | 20 | 4 critical (incl. multi-role resolver bug), 4 multi-tenancy risks, 5 inconsistencies, 7 missing specs |
| State machine & lifecycle | 19 | 6 missing transitions, 5 race conditions, 5 timing ambiguities, 3 missing recovery paths |
| Real-world tournament ops | 16 | 8 workflow gaps, 5 friction points, 5 offline gaps, 6 missing fallbacks |
| Security & PII | 18 | 5 critical, 5 PII gaps, 4 anti-enumeration, 4 ops-security |
| UX / onboarding | 16 | 11 UX gaps, 5 confusion risks, 6 empty states, 6 mobile gaps |
| PRD consistency | 28 | 9 matrix overrides, 7 stale sections, 15 schema additions, 20 decisions to log |
| Notification & audit plumbing | 17 | 12 notification gaps, 8 audit-emission gaps, 11 event-bus gaps, 7 cross-Org bleed risks |
| Dev-readiness | 18 | 8 Day-1 blockers, 5 Day-7 blockers, 5 v1.0 blockers, 7 recommended additions, 10 known-unknowns |

**Resolution summary:** Appendix B (B.1–B.22) addresses 90+ findings inline; Appendix A.2/A.3 module catalog updated; constraint code blocks corrected; resolver algorithm corrected for multi-role; PRD §3.2/§5.14/§7.5/§8/§11/§14 fold-in items listed for separate PRD revision; remaining items deferred per B.21.

---

*End of v1Users.md draft v4 (post-audit). All ten sections drafted, Appendix A (Module catalog) + Appendix B (Implementation guardrails). Next phase:*

1. *Sibling doc `v1Frontend.md` (SPA shell + UX patterns; v1.0 blocker for SPA work, not backend)*
2. *PRD revision absorbing locked decisions (PRD §3.2 cells, §3.1 row count, §7.5 RBAC layering, §8 schema additions, §11 v1.0 column updates, §14 entries #71–#90)*
3. *Sport module spec (`v1Sport.md`) — Player/Team/Match/Tournament full schema*
4. *`superpowers:writing-plans` translation to ordered milestones*

| § | Role | Status |
|---|------|--------|
| 1 | Super-admin | ✅ Complete |
| 2 | Admin (Org owner) | ✅ Complete |
| 3 | Co-organizer | ✅ Complete |
| 4 | Game coordinator | ✅ Complete (sport-agnostic; sport-narrowing deferred to sport module) |
| 5 | Match scorer | ✅ Complete |
| 6 | Referee / verifier | ✅ Complete |
| 7 | Team manager | ✅ Complete |
| 8 | Player | ⏸ Deferred to sport module (Person↔Player concept committed; full schema lands with sports) |

*Plus Appendix A — Module catalog (22 modules post-audit) and Appendix B — Implementation guardrails (B.1–B.22 — UUID v7 source, scope-filter pattern, DRF conventions, audit taxonomy, anti-abuse posture, sequencing, migration order, etc.).*
| 9 | Viewer (public) | ✅ Complete |
| 10 | Media / press | ⏸ Dropped from v1.0; v1.5 conditional |

*Plus Appendix A — Module catalog and permission model (sport-agnostic).*

*Next phase: review across sections for consistency, then translate to implementation plan via the `superpowers:writing-plans` skill.*
