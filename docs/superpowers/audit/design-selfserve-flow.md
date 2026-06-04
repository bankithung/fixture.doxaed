# Design — Self-Serve "Org-as-Hidden-Workspace" Flow (LOCKED)

Status: implementation-ready design. Confidence: HIGH on existing-code citations
(all read directly); MEDIUM on Phase-1B `Tournament` field set (only the chassis
needed for self-serve is specified here; the full sport-coupled model is
`v1Fixtures.md`'s job).

Author run: continues the prior audit. Primary source of the 3 blockers:
`docs/superpowers/audit/cross-e2e-flow.md` §1.1–§1.10, §2.

---

## 0. The locked flow, restated as an end-to-end happy path

1. Anyone signs up (`POST /api/accounts/auth/signup/`) → User created `is_active=False`,
   verification email sent. **No org is created at signup anymore.**
2. They click the verification link → `POST .../verify_email/` flips `is_active=True`.
   **Still no org.** They land on an empty "Start your first tournament" screen.
3. They click "Create tournament", fill name + sport → `POST /api/tournaments/`.
   This single call **auto-provisions** their hidden personal workspace `Organization`
   (status `active`), an **active** `OrganizationMembership(role=admin, is_org_owner=True)`,
   the `Tournament` row, and an active `TournamentMembership(role=admin)` — all atomic,
   **no super-admin approval**.
4. They invite anyone by email (`POST /api/tournaments/{id}/invitations/`), choosing a
   tournament-scoped role. The invitee need not have an account.
5. Invitee opens the link. If logged out / no account, a single
   `POST /api/invitations:accept/` (now **AllowAny**) accepts the invite AND, when the
   email has no User, creates the account inline (or routes to a signup-with-token page),
   then creates an **active** `TournamentMembership` + a thin `OrganizationMembership`
   (role from the invite, **never `admin`**) so the workspace's RBAC resolver can see them.
6. The inviter assigns/adjusts modules via the existing per-user `MembershipModuleGrant`
   matrix. No new RBAC machinery.

The three audit blockers map to fixes here:
- **Blocker 1** (signup mints pending org + inactive membership; verify never activates):
  §2 — stop creating the org at signup; org is created at first-tournament-create, active.
- **Blocker 2** (`single_org_per_admin_user` caps a user at one workspace, 500s 2nd admin
  accept): §4 — drop that constraint; move "tournament admin" identity onto
  `TournamentMembership`; keep org-owner uniqueness.
- **Blocker 3** (no create-tournament entrypoint; invite-accept needs a pre-existing
  account): §3 + §5 — add `POST /api/tournaments/` self-serve create; make invite-accept
  `AllowAny` with inline account creation.

---

## 1. What we reuse (chassis is solid — do not rebuild)

| Concern | Reused as-is | File |
|---|---|---|
| User, 2FA, email verify, login, session cycle | unchanged | `backend/apps/accounts/` |
| `Organization` model (status enum, soft-delete, slug, TZ) | reused; `OrgStatus.ACTIVE` becomes the self-serve default | `backend/apps/organizations/models.py:111-161` |
| `OrganizationMembership` (multi-role, owner flag, `one_owner_per_org`) | reused; **one constraint dropped** (§4) | `backend/apps/organizations/models.py:169-243` |
| `AdminInvitation` model + create/accept/revoke service | generalized to carry a `tournament` FK (§5) | `backend/apps/organizations/models.py:256-332`, `services/invitation.py` |
| Slug derivation/uniqueness (`_pick_unique_slug`, `RESERVED_SLUGS`) | moved into a shared workspace-provision service | `backend/apps/accounts/services/signup.py:96-165`, `constants.py` |
| Module RBAC resolver + grant overrides (keys off **active** memberships) | reused unchanged — this is why the invitee needs a thin active OrgMembership | `backend/apps/permissions/services/resolver.py:53-132` |
| Audit emit (idempotent on `event_id`) | reused for every new write | `backend/apps/audit/services.py` |
| `transfer_ownership`, `detect_orphaned`, lifecycle suspend/archive | unchanged | `backend/apps/organizations/services/{ownership,lifecycle}.py` |
| SPA chassis: `ProtectedRoute`, `AppShell`, `OrgChooserPage`, auth store, routes, `InviteAcceptPage`, `InviteCreateModal` | reused; extended (§7) | `frontend/src/...` |

New Django app: `apps.tournaments` (the only structural addition for self-serve).
Add `"apps.tournaments"` to `LOCAL_APPS` (`backend/fixture/settings/base.py:48-55`).

---

## 2. Blocker 1 — Signup no longer mints a pending org; verify activates nothing extra

### 2.1 Root cause (cited)
`perform_signup` creates, in one transaction, `User(is_active=False)`,
`Organization(status=PENDING_REVIEW)`, `OrganizationMembership(role=admin,
is_org_owner=True, is_active=False)` (the inactive flag at
`backend/apps/accounts/services/signup.py:287`), an `EmailVerificationToken`, and audit
(`signup.py:254-318`). `verify_email` only flips `user.is_active` + `email_verified_at`
(`backend/apps/accounts/views.py:172-176`) — it never activates the membership or org.
Net: a verified founder has `memberships=[]` and is bounced to an empty `/orgs`
(`cross-e2e-flow.md` §1.3). The only activation is super-admin `approve_org`
(`backend/apps/organizations/services/lifecycle.py:84-109`), which is the removed gate.

### 2.2 Change — make signup account-only
Rewrite `perform_signup` to create **only** the User + verification token + audit. Drop
org/membership/slug creation from this path entirely.

`perform_signup(...) -> SignupResult` new shape:
```python
@dataclass
class SignupResult:
    user: User
    verification_token_plaintext: str | None
    created: bool
    duplicate_email: bool
    # organization / membership fields REMOVED
```
- Keep the duplicate-email enumeration-safe branch (`signup.py:242-250`) and the
  `event_id` idempotency replay (`signup.py:168-205`) — but the replay's audit payload no
  longer carries `organization_id`/`membership_id`; it just points at the User.
- Audit `event_type` stays `"user_signup"`; `payload_after` drops the org keys, keeps
  `{"path": "B"}` for compatibility with existing audit assertions
  (`backend/apps/accounts/tests/test_audit_emission.py` — adjust expected payload).
- `org_name` stays an accepted (optional) field on `SignupSerializer`
  (`backend/apps/accounts/serializers.py:30`) but is now **stashed**, not consumed:
  carry it into the first-tournament-create flow only if the SPA passes it along. Simpler
  v1: drop `org_name` from signup, collect the tournament/workspace name at create time.
  (Recommended: drop it — the SPA signup form never sent it anyway, `SignupPage.tsx:71-75`.)

The slug helpers (`_slugify_for_org`, `_pick_unique_slug`, `_derive_slug`,
`signup.py:96-165`) **move** to a new shared module
`backend/apps/organizations/services/workspace.py` so the tournament-create flow reuses
them. Leave thin re-export shims in `signup.py` only if a test imports them directly.

### 2.3 `verify_email` — unchanged behavior, correct by construction
After §2.2 there is no inactive membership to repair, so `verify_email`
(`backend/apps/accounts/views.py:155-186`) stays exactly as-is (flip `is_active` +
`email_verified_at`, mark token used, audit). The "verify doesn't activate workspace" bug
disappears because there is no workspace yet. The post-verify landing becomes the
"create your first tournament" empty state (§7).

### 2.4 Tests to update/add (accounts)
- Rewrite `backend/apps/accounts/tests/test_signup_path_b.py`: assert signup creates **no**
  Organization and **no** OrganizationMembership; assert User `is_active=False`; assert a
  verification token exists; assert audit row has no `organization_id`.
- Keep idempotency test (same `event_id` → 200, single User).
- Keep duplicate-email enumeration-safe test (identical 201, no second User, no email).
- Update `test_audit_emission.py` expected `payload_after`.

---

## 3. Blocker 3a — `POST /api/tournaments/` self-serve create (auto-provision workspace)

This is the heart of the locked flow. One endpoint, one atomic transaction, no SA gate.

### 3.1 New app `apps.tournaments` — models

```python
# backend/apps/tournaments/models.py
from apps.accounts.models import uuid7

class TournamentStatus(models.TextChoices):          # PRD §5.2 is canonical; v1 subset
    DRAFT = "draft", _("Draft")
    PUBLISHED = "published", _("Published")
    REGISTRATION_OPEN = "registration_open", _("Registration open")
    SCHEDULED = "scheduled", _("Scheduled")
    LIVE = "live", _("Live")
    COMPLETED = "completed", _("Completed")
    ARCHIVED = "archived", _("Archived")

class TournamentMembershipRole(models.TextChoices):  # superset of v1Users §4.7 (which only listed game_coordinator)
    ADMIN = "admin", _("Admin")                      # the creator / co-admin of THIS tournament
    CO_ORGANIZER = "co_organizer", _("Co-organizer")
    GAME_COORDINATOR = "game_coordinator", _("Game coordinator")
    MATCH_SCORER = "match_scorer", _("Match scorer")
    REFEREE = "referee", _("Referee")
    TEAM_MANAGER = "team_manager", _("Team manager")

class TournamentMembershipStatus(models.TextChoices):
    ACTIVE = "active", _("Active")
    SUSPENDED = "suspended", _("Suspended")
    REVOKED = "revoked", _("Revoked")

class Tournament(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)   # invariant 1
    organization = models.ForeignKey(                                        # invariant 2
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="tournaments",
    )
    sport = models.ForeignKey(                                               # apps.sports catalog
        "sports.Sport", null=True, blank=True, on_delete=models.PROTECT,
        related_name="tournaments",
    )
    slug = models.CharField(max_length=63)                                   # unique per-org, see Meta
    name = models.CharField(max_length=200)
    status = models.CharField(
        max_length=24, choices=TournamentStatus.choices,
        default=TournamentStatus.DRAFT, db_index=True,                       # invariant 6 (state machine)
    )
    time_zone = models.CharField(max_length=64, default="Asia/Kolkata")      # invariant 14; defaults to org TZ
    # invariant 10 (conflict warnings) — present from day 1 so generators can fill them.
    inputs_hash = models.CharField(max_length=64, blank=True)
    last_manual_edit_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="tournaments_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)  # soft-delete parity

    class Meta:
        db_table = "tournaments_tournament"
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "slug"],
                condition=Q(deleted_at__isnull=True),
                name="unique_tournament_slug_per_org",
            ),
        ]
        indexes = [
            models.Index(fields=["organization", "status"], name="trn_org_status_idx"),
        ]

class TournamentMembership(models.Model):           # refines v1Users.md §4.7
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                             related_name="tournament_memberships")
    tournament = models.ForeignKey(Tournament, on_delete=models.CASCADE,
                                   related_name="memberships")
    role = models.CharField(max_length=24, choices=TournamentMembershipRole.choices)
    status = models.CharField(max_length=16, choices=TournamentMembershipStatus.choices,
                              default=TournamentMembershipStatus.ACTIVE)
    assigned_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
                                    on_delete=models.SET_NULL, related_name="tournament_assignments_made")
    assigned_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "tournaments_membership"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "tournament", "role"],
                condition=Q(status="active"),
                name="unique_active_tournament_role",     # matches v1Users §4.7
            ),
        ]
        indexes = [
            models.Index(fields=["tournament", "role", "status"], name="trnmem_t_role_status_idx"),
            models.Index(fields=["user", "status"], name="trnmem_user_status_idx"),
        ]
```

Note vs spec: v1Users §4.7 declared `role` as `enum('game_coordinator')` only. We widen
to the 6-role set because the self-serve creator must be the tournament `admin`, and
tournament-scoped invites span all sub-roles. This is an additive spec refinement —
**log it as decision #91 in v1Users.md / PRD §14** before merging code (per CLAUDE.md
"PRD edit first, code second" for anything touching the user model).

### 3.2 Workspace-provision service (shared)

```python
# backend/apps/organizations/services/workspace.py
def provision_personal_workspace(*, user, name, time_zone=None, request=None) -> Organization:
    """Create an ACTIVE org + ACTIVE admin/owner membership for `user`.
    No super-admin approval. Idempotency is the caller's concern (event_id on the
    tournament-create audit). Slug derived from `name`, deduped, reserved-checked."""
    slug = _pick_unique_slug(_slugify_for_org(name) or "workspace")
    with transaction.atomic():
        org = Organization.objects.create(
            slug=slug, name=name[:200],
            status=OrgStatus.ACTIVE,                       # <-- key change vs pending_review
            time_zone=time_zone or settings.DEFAULT_ORG_TIMEZONE,
            created_by=user,
        )
        OrganizationMembership.objects.create(
            user=user, organization=org,
            role=MembershipRole.ADMIN, is_org_owner=True,
            is_active=True,                                # <-- ACTIVE, not pending
            created_by=user,
        )
        emit_audit(actor_user=user, actor_role=ActorRole.ADMIN,
                   event_type="workspace_provisioned", target_type="organization",
                   target_id=org.id, organization_id=org.id,
                   payload_after={"slug": org.slug, "status": org.status}, request=request)
    return org
```

### 3.3 Tournament-create service + view

```python
# backend/apps/tournaments/services/create.py
def create_tournament(*, user, name, sport_code=None, workspace_org=None,
                      event_id=None, request=None) -> Tournament:
    # 1. Idempotency replay on event_id via audit (invariant 3) — return prior Tournament.
    # 2. Resolve workspace:
    #      - If user has an existing ACTIVE admin/owner OrganizationMembership and the SPA
    #        chose "create in <existing workspace>", reuse it.
    #      - Else provision a fresh personal workspace (§3.2). NOW POSSIBLE because
    #        single_org_per_admin_user is dropped (§4).
    # 3. Resolve sport from apps.sports catalog (PROTECT). Nullable in v1.
    # 4. transaction.atomic():
    #      tournament = Tournament.objects.create(organization=org, sport=sport,
    #          slug=_pick_unique_slug_per_org(org, name), name=name,
    #          status=DRAFT, time_zone=org.time_zone, created_by=user)
    #      TournamentMembership.objects.create(user=user, tournament=tournament,
    #          role=TournamentMembershipRole.ADMIN,
    #          status=ACTIVE, assigned_by=user)
    #      emit_audit(event_type="tournament_created", target_type="tournament",
    #          target_id=tournament.id, organization_id=org.id,
    #          idempotency_key=event_id, request=request)
    #      transaction.on_commit(lambda: publish_redis(...))   # invariant 4 (Phase 1B hook)
    return tournament
```

```python
# backend/apps/tournaments/views.py  — POST /api/tournaments/
class TournamentListCreateView(GenericAPIView):
    permission_classes = [IsAuthenticated]   # any verified user; NO IsSuperUser
    def post(self, request):
        # require request.user.is_active (email-verified) — return 403 "verify_email_first" otherwise
        ser = TournamentCreateSerializer(data=request.data); ser.is_valid(raise_exception=True)
        t = create_tournament(user=request.user,
                              name=ser.validated_data["name"],
                              sport_code=ser.validated_data.get("sport_code"),
                              workspace_org=ser.validated_data.get("organization_id"),
                              event_id=ser.validated_data.get("event_id"),
                              request=request)
        return Response(TournamentSerializer(t).data, status=201)
    def get(self, request):
        # list tournaments where user has an active TournamentMembership OR is org admin/owner
        ...
```

`TournamentCreateSerializer`: `name` (required, 1–200), `sport_code` (optional, validated
against catalog), `organization_id` (optional — create-in-existing-workspace),
`event_id` (optional UUID, idempotency invariant 3).

URLs: new `backend/apps/tournaments/urls.py` mounted at `/api/tournaments/` from
`fixture/urls.py`:
- `POST/GET /api/tournaments/` → `TournamentListCreateView`
- `GET/PATCH /api/tournaments/{id}/` → detail
- `GET/POST /api/tournaments/{id}/invitations/` → tournament invitations (§5)
- `GET/DELETE /api/tournaments/{id}/members/...` → tournament membership mgmt

### 3.4 RBAC for tournament verbs
A workspace owner is `OrganizationMembership(admin, owner, active)`, so the existing
`effective_modules` resolver already grants them every admin module
(`resolver.py:53-132`). Tournament-scoped sub-roles additionally require an active
`TournamentMembership` (the v1Users §4.7 two-layer invariant). Add a permission helper
`HasTournamentRole(...)` in `apps.tournaments.permissions` that checks both layers; reuse
`apps.permissions.permissions.HasModule` for org-surface gating.

---

## 4. Blocker 2 — drop `single_org_per_admin_user`; keep owner uniqueness

### 4.1 Root cause (cited verbatim)
`backend/apps/organizations/models.py:229-233`:
```python
# 3. A user can hold an active admin membership in only one
# Organization globally (PRD §2.4 widened).
UniqueConstraint(
    fields=["user"],
    condition=Q(role="admin", is_active=True),
    name="single_org_per_admin_user",
),
```
Under org-as-hidden-workspace, a user who starts two tournaments needs two workspace orgs
and would be admin/owner of both — impossible under this constraint
(`cross-e2e-flow.md` §2 blocker 2, §"single_org_per_admin_user implication"). It also 500s
on a second admin-role invite-accept because `accept_invitation` creates the membership
without catching `IntegrityError` (`backend/apps/organizations/services/invitation.py:287-293`).

### 4.2 Change — remove the constraint
Delete the `single_org_per_admin_user` `UniqueConstraint` from the model
(`models.py:227-233`). Keep:
- `one_owner_per_org` (`models.py:222-226`) — still exactly one owner per org. ✅
- `unique_active_role_per_user_per_org` (`models.py:211-215`) — still no duplicate active
  (user, org, role). ✅
- `owner_flag_only_on_admin_role` CheckConstraint (`models.py:235-238`). ✅

The "tournament admin" identity now lives on `TournamentMembership(role=admin)` (§3.1).
A user can be org-admin/owner of N personal workspaces (one per tournament they started),
and a non-admin OrgMember (e.g. `co_organizer`) in other people's workspaces.

### 4.3 Migration
`backend/apps/organizations/migrations/0002_drop_single_org_per_admin.py`
(next number after `0001_initial.py` — confirmed only `0001` exists):
```python
operations = [
    migrations.RemoveConstraint(
        model_name="organizationmembership",
        name="single_org_per_admin_user",
    ),
]
```
Update the model docstring (`models.py:8`) which still claims the constraint exists.

### 4.4 Defensive fix in accept (belt-and-suspenders)
Even with the constraint gone, wrap the membership create in `accept_invitation`
(`invitation.py:287-293`) in a try/except `IntegrityError` → re-raise as a clean
`ValidationError("membership_conflict")` so any *future* unique collision (e.g. duplicate
active role) returns 400, never 500. This addresses the latent break in
`cross-e2e-flow.md` §1.10.

---

## 5. Blocker 3b — invite ANY email; accept creates account if needed; tournament-scoped role

### 5.1 Root causes (cited)
- `InvitationAcceptView.permission_classes = [IsAuthenticated]`
  (`backend/apps/organizations/views.py:468`) — a brand-new invitee must already have a
  session, so they self-signup (minting a junk pending org) then accept
  (`cross-e2e-flow.md` §1.2, §1.8, §2 blocker 7).
- `AdminInvitation` is org-scoped only (`models.py:256-312`); the locked flow wants invites
  scoped to a tournament (`cross-e2e-flow.md` §2 blocker 6).

### 5.2 Model change — add `tournament` FK to `AdminInvitation`
Add a nullable `tournament` FK so the same table serves both org-level and
tournament-scoped invites (least-churn vs a parallel model):
```python
# backend/apps/organizations/models.py  (AdminInvitation)
tournament = models.ForeignKey(
    "tournaments.Tournament", null=True, blank=True,
    on_delete=models.CASCADE, related_name="invitations",
)
```
Adjust the partial-unique constraint to include tournament so the same email can hold one
pending invite per (org, tournament, email):
```python
constraints = [
    UniqueConstraint(
        fields=["organization", "tournament", "email"],
        condition=Q(status="pending"),
        name="unique_pending_invite_per_email_per_org_tournament",
    ),
]
```
Migration: `organizations/0003_admininvitation_tournament.py` (depends on
`tournaments.0001_initial`; declare cross-app dependency). Because of the FK direction,
the `tournaments` app's initial migration must land first — see build order §8.

### 5.3 Invitation service — tournament-aware
`create_invitation` (`invitation.py:107-227`) gains an optional `tournament=None` kwarg;
the tournament-create flow's invite view always passes it. Persist on the row; keep token
hashing, email, `event_id` idempotency, role-array → highest-tier collapse
(`invitation.py:136-146`). Guard: tournament must belong to `org` and not be archived.

`accept_invitation` (`invitation.py:230-322`) — rewrite the membership side:
1. Hash lookup + status/expiry checks: **unchanged** (`invitation.py:243-272`).
2. After matching the invite, ensure a thin **active** `OrganizationMembership` exists for
   (accepting_user, org). Role = the invite's role **unless it is `admin`** — invitees of
   *someone else's* tournament are never org-admin; clamp to `co_organizer` at org level
   (or a dedicated low-privilege `team_manager` for team roles). This keeps the
   `effective_modules` resolver (which keys off **active** OrgMemberships,
   `resolver.py:53-64`) able to surface modules for the invitee.
3. If the invite has `tournament_id`, create an **active** `TournamentMembership`
   (role = invite role, full 6-role set; admin allowed here since it is tournament-scoped),
   idempotent on (user, tournament, role) via `unique_active_tournament_role`.
4. Mark invite accepted, session cycle (`_cycle_session`, `invitation.py:319-320`), audit.
5. Wrap creates in try/except `IntegrityError` (§4.4).

### 5.4 Accept endpoint — `AllowAny` + inline account creation
Change `InvitationAcceptView` (`views.py:461-485`) to `permission_classes = [AllowAny]`.
New `AcceptInvitationSerializer` fields:
`token` (required), and for logged-out new accounts: `password` (optional, min 12),
`name` (optional). Logic:
```python
def post(self, request):
    ser.is_valid(raise_exception=True)
    invite = lookup_pending_invite(token)        # 400 invalid/expired/revoked
    user = request.user if request.user.is_authenticated else None
    if user is None:
        existing = User.objects.filter(email=invite.email).first()
        if existing and existing.is_active:
            # account exists, not logged in → ask them to sign in (401 + next hint)
            return Response({"detail": "login_required", "email": invite.email}, status=401)
        if existing and not existing.is_active:
            # unverified account on that email → activate via invite (email is proven by
            # possession of the invite token) and set password if provided
            user = existing
        else:
            if not ser.validated_data.get("password"):
                return Response({"detail": "password_required"}, status=400)
            user = User.objects.create_user(
                email=invite.email, password=ser.validated_data["password"],
                name=ser.validated_data.get("name", ""), is_active=True,
            )
            user.email_verified_at = timezone.now()    # invite-token possession proves email
            user.save(update_fields=["email_verified_at"])
        login(request, user)                            # establish session
    membership = accept_invitation(token_plaintext=token, accepting_user=user, request=request)
    return Response({"org_slug": membership.organization.slug,
                     "tournament_id": str(invite.tournament_id) if invite.tournament_id else None,
                     "membership": OrganizationMembershipSerializer(membership).data}, status=200)
```
Security notes:
- The invite token (256-bit, sha256-stored, `invitation.py:88-94`) is the bearer proof of
  email ownership, so inline account creation for that email is safe and lets us mark
  `email_verified_at` without a second round-trip.
- Throttle this endpoint (reuse/clone `SignupRateThrottle`,
  `backend/apps/accounts/throttling.py`) since it can create accounts.
- Email is taken from the invite, never from the request body — prevents account-takeover
  via mismatched email.

### 5.5 Keep the existing alias routes
`/api/invitations:accept/` (`fixture/urls.py`) and `/api/orgs/invitations/accept/`
(`organizations/urls.py:93-97`, `InvitationAcceptByPathView`) both keep working; they now
inherit `AllowAny`. Add `/api/tournaments/{id}/invitations/` for create only; accept stays
on the shared route since the token already identifies the tournament.

---

## 6. API surface summary (new + changed)

| Method + path | Auth | Status | Notes |
|---|---|---|---|
| `POST /api/accounts/auth/signup/` | AllowAny | **changed** | account-only; no org created (§2) |
| `POST /api/accounts/auth/verify_email/` | AllowAny | unchanged | flips `is_active` only (§2.3) |
| `POST /api/tournaments/` | IsAuthenticated (verified) | **new** | auto-provisions workspace + admin membership + tournament (§3) |
| `GET /api/tournaments/` | IsAuthenticated | **new** | list user's tournaments |
| `GET/PATCH /api/tournaments/{id}/` | IsAuthenticated + tournament role | **new** | detail/edit |
| `POST /api/tournaments/{id}/invitations/` | tournament admin/co-org/game-coord-in-scope | **new** | tournament-scoped invite by email (§5) |
| `POST /api/invitations:accept/` | **AllowAny** | **changed** | inline account creation + tournament membership (§5.4) |
| `GET/DELETE /api/tournaments/{id}/members/{id}/` | tournament admin/co-org | **new** | revoke `TournamentMembership` |
| `POST /api/orgs/` | IsSuperUser | unchanged | SA-only org create stays for back-office |

All new mutation endpoints accept `event_id` and are idempotent (invariant 3). All
tournament queries are org-scoped (invariant 2) and must get a cross-org isolation test.

---

## 7. SPA routes / pages (new + changed)

Reuse the chassis: `ProtectedRoute`, `AppShell`, auth store, `routes` helper, toast,
`InviteCreateModal`, `InvitationsListPanel`.

### 7.1 New routes (`frontend/src/App.tsx`, `frontend/src/lib/routes.ts`)
- `/tournaments/new` → **`CreateTournamentPage`** (protected). Form: tournament name +
  sport picker (from `apps.sports` catalog) + optional "create in existing workspace"
  selector. Submits `POST /api/tournaments/` with a client `event_id`; on 201 navigates to
  `/o/{org_slug}/tournaments/{id}` (or the Phase-1B tournament dashboard). Replaces the
  dead-end: today the only tournament surface is `ComingSoonPage` (`App.tsx:171-174`).
- `/o/:orgSlug/tournaments/:tournamentId` → tournament dashboard (thin in 1A; Phase 1B
  fills it). Add `routes.tournamentNew()`, `routes.tournament(slug, id)`.
- `/signup-invite?token=...` (optional) → signup-with-invite variant of `SignupPage` that
  posts to the accept endpoint with a password. The simpler path is to keep one `/accept`
  page (§7.2) and show inline email+password fields when logged out.

### 7.2 Changed pages
- **`OrgChooserPage`** (`frontend/src/features/layout/OrgChooserPage.tsx`): the empty state
  ("you have no orgs") becomes a "Start your first tournament" CTA → `/tournaments/new`.
  This is the post-verify landing for self-serve founders.
- **`InviteAcceptPage`** (`frontend/src/features/orgs/InviteAcceptPage.tsx:73-104`): when
  `user` is null, instead of only offering "Sign in", render an inline
  email(read-only, from invite)/name/password mini-form that calls
  `orgsApi.acceptInvitation(token, { password, name })`. On success, `refreshMe()` then
  navigate to the tournament (response now returns `tournament_id`). Keep the "already have
  an account → sign in" path (the 401 `login_required` branch from §5.4).
- **`SignupPage`** (`frontend/src/features/auth/SignupPage.tsx`): success copy changes from
  "activate your account" to "verify your email, then create your first tournament." No org
  name field (matches §2.2).
- **`orgsApi.acceptInvitation`** (`frontend/src/api/orgs.ts:82-86`): widen the payload to
  `{ token, password?, name? }` and the response to include `tournament_id`.
- New `frontend/src/api/tournaments.ts`: `create`, `list`, `get`, `invite`.

### 7.3 a11y / i18n (invariant 13)
All new strings via `t()`; CreateTournamentPage form is WCAG 2.1 AA (labels, `aria-invalid`,
error `role="alert"`) consistent with `SignupPage`.

---

## 8. Migration / build order (strict)

1. **PRD/spec edit first** (CLAUDE.md rule): log decision #91 "TournamentMembership widened
   to 6 roles; org-as-hidden-workspace self-serve; `single_org_per_admin_user` dropped" in
   `v1Users.md` and fold into PRD §14.
2. Create `apps.tournaments` app; add to `LOCAL_APPS` (`settings/base.py:48-55`).
3. `apps/tournaments/migrations/0001_initial.py` — `Tournament` + `TournamentMembership`.
   (No FK from organizations yet, so this is self-contained besides `organizations` +
   `sports` + `accounts` FKs which already exist.)
4. `apps/organizations/migrations/0002_drop_single_org_per_admin.py` — `RemoveConstraint`
   (§4.3).
5. `apps/organizations/migrations/0003_admininvitation_tournament.py` — add nullable
   `tournament` FK + swap the partial-unique constraint (§5.2). `dependencies` include
   `("tournaments", "0001_initial")`.
6. Backend services: `organizations/services/workspace.py` (§3.2); rewrite
   `accounts/services/signup.py` (§2.2); extend `organizations/services/invitation.py`
   (§5.3); new `tournaments/services/create.py` (§3.3).
7. Views/urls/serializers: tournaments app (§3.3); accept endpoint `AllowAny` + inline
   create (§5.4); mount `/api/tournaments/` in `fixture/urls.py`.
8. Frontend: `api/tournaments.ts`, `CreateTournamentPage`, route wiring, `InviteAcceptPage`
   + `OrgChooserPage` + `SignupPage` edits, `orgsApi.acceptInvitation` widening (§7).
9. Regenerate OpenAPI types (`frontend/src/types/api.generated.ts`) after backend lands.

Deploy guard reminder (CLAUDE.md / PRD §5): migrations are blocked while any tournament is
`live`. These migrations are pre-1B so nothing is live, but wire the pre-flight check
before the tournament state machine ships.

---

## 9. Tests to write (must-have)

Backend (pytest):
- `accounts/tests/test_signup_path_b.py` — rewritten: signup creates User only, no org/membership (§2.4).
- `accounts/tests/test_verify_email.py` — verify flips `is_active`; no membership side effects.
- `tournaments/tests/test_create_tournament.py` —
  - verified user creates a tournament → ACTIVE org + ACTIVE admin/owner OrgMembership +
    Tournament(DRAFT) + ACTIVE TournamentMembership(admin); no SA step.
  - **same user creates a SECOND tournament → SECOND workspace org, no IntegrityError**
    (regression for dropped `single_org_per_admin_user`, blocker 2).
  - unverified (`is_active=False`) user → 403 `verify_email_first`.
  - `event_id` idempotency replay returns the same Tournament (invariant 3).
- `tournaments/tests/test_isolation.py` — user A in workspace X cannot read/patch B's
  tournament or invite into it (invariant 2; required by CLAUDE.md).
- `organizations/tests/test_invitation_flow.py` — extend:
  - invite by email to a tournament → invitee with NO account accepts via `AllowAny` with
    password → User created (active, email_verified), active TournamentMembership + thin
    active OrgMembership (role clamped, not admin) (blocker 3).
  - invitee whose email already maps to an active user → 401 `login_required`.
  - invitee accepts `admin`-role tournament invite while already owning another workspace →
    succeeds (no 500); regression for blocker 2 §4.4.
  - email in body ignored / always taken from invite (account-takeover guard).
- `organizations/tests/test_org_constraints.py` — assert `single_org_per_admin_user` is
  GONE; assert `one_owner_per_org` + `unique_active_role_per_user_per_org` still enforced;
  assert a user can hold two active admin memberships in two orgs.
- `permissions/tests` — invitee's thin active OrgMembership yields the expected
  `effective_modules` for the clamped role (resolver keys off active memberships,
  `resolver.py:53-64`).

Frontend (vitest):
- `CreateTournamentPage.test.tsx` — submit → posts with `event_id`, navigates on 201.
- `InviteAcceptPage.test.tsx` — logged-out new-email path shows password field, posts, then
  navigates to tournament.
- `OrgChooserPage.test.tsx` — empty state renders "Start your first tournament" CTA.

---

## 10. Open items to confirm before coding (low-risk, flagged)
- **Org-level role clamp for invitees** (§5.3 step 2): clamp non-`admin` tournament roles to
  `co_organizer` at org level, or introduce a minimal `viewer`/`member` org role? v1Users §2.7
  lists no pure-viewer org role, so reuse `co_organizer` (lowest org-management role) or
  `team_manager`. Recommend `co_organizer` for staff-type roles, `team_manager` for team roles.
  Confidence MEDIUM — pick during plan write-up.
- **`org_name` at signup**: recommend dropping the field entirely (§2.2); workspace name is
  collected at tournament create. The SPA never sent it (`SignupPage.tsx:71-75`).
- Tournament `slug` uniqueness is per-org (§3.1 Meta); public URL is
  `(org_slug, tournament_slug)` consistent with invariant 1's `(slug, UUID)` pairing.
