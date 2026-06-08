# Security & Multi-Tenancy Audit — Fixture Platform

Scope: cross-org isolation on every tenant-scoped endpoint, auth (session/CSRF, 2FA,
axes), the append-only audit guarantee, secret handling, public `AllowAny` endpoints +
throttling, and SADMIN gating. Every claim is cited to `file:symbol` + line range and
was verified against source (not the breadth-pass notes). No source was modified.

Date: 2026-06-08. Verified against `backend/` at repo root `/home/ubuntu/Fixture`.

---

## 1. Executive summary

The tenant-isolation model is **solid and consistent** for the authenticated REST
surface. Two helpers — `apps/tournaments/scope.py::accessible_tournaments` (lines 19-32)
and `apps/tournaments/permissions.py::can_manage_tournament` (lines 17-36) — are applied
uniformly across tournaments, matches, fixtures, disputes, forms, and teams views in a
strict **404-before-403** order (existence is never leaked to outsiders; insiders lacking
the verb get 403). Org-level surfaces use `apps/organizations/permissions.py` role classes
+ `apps/permissions/permissions.py::HasModule` module gates. The append-only audit
guarantee is implemented at the **DB-trigger** level (fires for superuser too), which is
stronger than a REVOKE-only design. Auth is session-only (no JWT), CSRF-enforced via DRF
`SessionAuthentication`, with argon2id hashing, axes lockout, TOTP+recovery 2FA, and
session cycling on auth-state changes.

The notable gaps are all on the **public / non-REST edges**: the WebSocket consumer
accepts any connection with no auth or scope (`apps/live/consumers.py`); the public live
snapshot and public form GET expose data without gating on parent tournament/org **state**
(draft / suspended / archived); the prod-only `REVOKE` half of the audit defense is a
manual runbook step, not code; and two `@csrf_exempt` superadmin JSON verbs depend solely
on SameSite=Lax + IP-allowlist for CSRF protection.

| # | Finding | Severity | Location | Detail | Restructuring implication |
|---|---------|----------|----------|--------|---------------------------|
| 1 | WebSocket match room has **no authentication and no scope check** | Medium | `apps/live/consumers.py::MatchConsumer.connect` L12-16; `apps/live/routing.py` L8; `fixture/asgi.py` L21-28; test proves open access `apps/live/tests/test_live.py::test_ws_match_room_receives_broadcast` L51-68 | `connect()` calls `await self.accept()` unconditionally for `match_<id>`; `scope["user"]` (populated by `AuthMiddlewareStack`) is never read, and the match's tournament/org is never checked. Any anonymous, same-origin client can subscribe to **any** match UUID — even one that does not exist — and receive the live event broadcast. Contradicts CLAUDE.md invariant 11 / "WebSockets only for the scorer/referee rooms." Data carried is the same public scoring stream as the snapshot, so disclosure impact is bounded, but it is also an unbounded-connection / room-enumeration DoS vector with no per-IP cap. | In the restructure, gate the consumer: resolve the match, require an authenticated scorer/manager for the *write/echo* path, and either (a) keep a separate read-only public room or (b) move public viewing entirely to SSE (the invariant's intent). Add an isolation/auth test for the WS leg (currently the only WS test asserts open access). |
| 2 | Public live snapshot exposes matches regardless of **tournament/org state** | Medium | `apps/live/views.py::LiveMatchSnapshotView.get` L50-103 (only gate is `m.status in _ROSTER_VISIBLE` for rosters, L13/L59) | The view fetches any `Match` by UUID where `deleted_at IS NULL` and returns score, team names, short names, current period, and recent (non-voided) events — and the full roster once the match is LIVE/HALF_TIME/COMPLETED. It never checks `match.tournament.status` (a `draft`/unpublished tournament still leaks) nor whether the owning org is `suspended`/`archived`. PII surfaced is limited to `Person.display_name or full_name` (`_name` L16-20). | Add a "public visibility" gate keyed on tournament state (e.g. only `published`+ / not-soft-deleted org) before any public read. Consider a single `public_match_visible(match)` predicate shared by the snapshot and any future SSE/WS public room. |
| 3 | Prod `REVOKE UPDATE/DELETE on audit_event` is a **manual runbook step**, not code | Medium | `apps/audit/migrations/0002_audit_append_only.py` L9-13 (comment: "handled in deploy provisioning, not here"); documented only in `deploy/README.md` L42-44 and `deploy/CREDENTIALS-PROD.md` L18; `fixture/settings/prod.py` L6-8 docstring | The append-only DB trigger (L17-35) is robust and fires even for superusers (proven by `apps/audit/tests/test_append_only.py` L36-73, which runs as a Postgres superuser). The *defense-in-depth* role REVOKE has no migration/automation; if an operator skips the manual `GRANT`/`REVOKE` provisioning, the app role keeps UPDATE/DELETE privileges and only the trigger stands between a buggy/compromised app and audit tampering. There is also no deploy-time assertion that the runtime DB role is non-owner/non-superuser. | Encode the role provisioning (or at least a startup self-check that the connected role lacks UPDATE/DELETE on `audit_event`) so the guarantee is enforced by code, not a checklist. Keep the trigger as the primary control. |
| 4 | `@csrf_exempt` on session-authenticated superadmin JSON verbs | Low | `apps/sadmin/views/superadmin.py::bulk_email_api` L45-47 and `archive_feedback_api` L95-97 (both `@superadmin_required` + `@require_POST` + `@csrf_exempt`) | These are state-changing POSTs authenticated by the superuser session cookie, with CSRF protection explicitly removed. Mitigations: `SESSION_COOKIE_SAMESITE = "Lax"` (`fixture/settings/base.py` L154) blocks cross-site POSTs from sending the cookie, and `SADMIN_IP_ALLOWLIST` (`apps/sadmin/middleware.py`) can hide the surface. The HTML sadmin verbs (`user_verb`/`org_verb`) are **not** exempt and use the Django CSRF token. Residual risk is small but the exemption is unnecessary if the SPA sends `X-CSRFToken`. | Drop `@csrf_exempt`; require the CSRF token like every other mutation. If a non-cookie auth is ever added for these, re-evaluate. |
| 5 | TOTP-secret encryption key derived from `SECRET_KEY`; silent plaintext fallback | Low | `apps/accounts/services/_crypto.py::_fernet` L32-38, `encrypt_secret` L41-49 (`if f is None: return plaintext`); imported by `apps/accounts/services/twofa.py` L36,90; noted `apps/accounts/models.py` L129 | The Fernet key is `sha256(SECRET_KEY)` — anyone with `SECRET_KEY` can decrypt all stored TOTP secrets, and rotating `SECRET_KEY` invalidates every 2FA enrollment. If `cryptography` fails to import, `encrypt_secret` silently **stores the TOTP shared secret in plaintext** (L46-47) with no alarm. Recovery codes are argon2id-hashed (separate, fine). | Move to a dedicated, rotatable key (KMS-backed per the B.21 TODO) separate from `SECRET_KEY`; make the missing-crypto path fail-closed (refuse enrollment) rather than store plaintext. |
| 6 | Production credentials file with live secrets in the working tree | Low | `deploy/CREDENTIALS-PROD.md` L1-2,12-22 (super-admin password, both Postgres role passwords, Django `SECRET_KEY` in plaintext) | The file is correctly **gitignored** and not tracked (verified: `git ls-files` shows only `.env.example`; no history for the file), so it is not in the repo. But it sits unencrypted in the working directory of a shared/analysis host; anyone with filesystem/backup access to this box reads prod secrets. The file itself says "Rotate after handover." | Out-of-band: rotate the listed secrets (the analysis env has read them), and keep prod secrets in a secret manager rather than a repo-adjacent file. Not a code change. |
| 7 | Published demo-account passwords seeded; super-admin not 2FA-enrolled in prod | Low | `deploy/CREDENTIALS-PROD.md` L25+ ("Demo accounts (PUBLISHED passwords)"); `deploy/README.md` L103-113 hardening TODO (items 3 "Remove demo data", 5 "2FA for the super-admin currently not enrolled") | Known, documented launch-blockers. Demo orgs `*.doxaed.test` with public passwords + a super-admin lacking 2FA are real foot-guns if the host is ever exposed before the TODO is done. | Block public launch on the documented hardening list; add a deploy pre-flight that fails if demo accounts exist or the SA lacks 2FA. |
| 8 | Public live snapshot has **no endpoint-specific throttle** | Low | `apps/live/views.py::LiveMatchSnapshotView` L47-48 (no `throttle_classes`) | Falls back to the global `AnonRateThrottle` 60/min (`fixture/settings/base.py` L168-172). That is far looser than the dedicated public throttles used elsewhere (`PublicFormThrottle` 30/h, `RegistrationRateThrottle` 30/h, `SignupRateThrottle` 3/h). 60/min per IP allows cheap match-UUID enumeration + scraping. | Add a dedicated per-IP throttle for public read endpoints, consistent with the forms/teams pattern. |
| 9 | `_OrgMembershipPermission` **fails open** when org can't be resolved | Low | `apps/organizations/permissions.py::_OrgMembershipPermission.has_permission` L85-90 (`if org is None: return True`) | If the org kwarg is absent/unresolvable, the permission class returns `True` ("resource-level views pass through; object filter happens at the queryset layer"). Today every consumer (`OrgChangeSlugView`, `OrgInvitations*`, etc.) also calls `_resolve_org(...)`/`get_object_or_404` in the handler, so the gap is not currently reachable — but it is a fail-open default that a future view could rely on by mistake. | Invert to fail-closed (`return False` when org is unresolved) and require views to pass the org explicitly via `get_organization()`, mirroring `HasModule` which fails closed (`apps/permissions/permissions.py` L48-49). |
| 10 | Any open form is publicly readable/submittable by raw form ID (no "is-public" flag) | Info | `apps/forms/views.py::PublicFormView._resolve` L190-201, `get`/`post` L203-232; gate is only `is_open(form)` | Resolving by `form_id` (not just a share token) exposes the form schema + `tournament_name` and accepts submissions for **any** form whose status is open and within window — there is no separate flag distinguishing "link-only" forms from "publicly listed" forms. This is by design for self-registration, and there is no cross-org read of *responses* (those are manager-gated via `_get_manageable_form`), but it means an organizer cannot make an internal-only open form. PII (`respondent_email/phone/name`) is collected via `AllowAny` (expected for registration). Uploads are correctly scoped on claim (`submit_response` L69-74: `form=form, response__isnull=True`). | If "internal" open forms are needed, add an explicit public-listing flag and require a share token for non-listed forms. Otherwise document that open == public. |

---

## 2. Cross-org isolation — endpoint-by-endpoint verification

The canonical pattern (verified across every tenant-scoped read/write) is the
404-before-403 ordering documented at `apps/tournaments/views.py::_get_tournament_or_404`
(L62-71): fetch the row, then `accessible_tournaments(user).filter(id=...).exists()` →
`NotFound` if not accessible (no existence leak); only then check the verb predicate →
`PermissionDenied`.

### Tournaments (`apps/tournaments/views.py`)
- `TournamentListCreateView.get` L43-45 → `accessible_tournaments(request.user)` only. Create (L47-59) gates on `email_verified_at`.
- `_get_tournament_or_404` L62-71 used by invitations (L83), settings GET/PATCH (L129,L133), members GET (L188), member PATCH (L211), audit (L298). Mutations add `can_manage_tournament` (L84, L135, L212, L299). `TournamentAuditView` is manager-only and filters `AuditEvent.objects.filter(tournament_id=tournament.id)` (L312). Last-admin guard at L227-249.

### Matches (`apps/matches/views.py`)
- `_accessible_tournament_or_404` L52-55 and `_match_or_404` L58-68 enforce scope; `_can_score` L71-83 (manager OR per-match scorer OR active `MATCH_SCORER`). All write verbs (score L143, events L171, transition L232, lineup set L325, confirm L363, incident file L398) check `_can_score`; assign-scorer requires `can_manage_tournament` (L125). **Player cross-tenant guard**: `record_match_event` (L186-208) and `file_incident` (L407-411) re-fetch players with `tournament=match.tournament` and reject players not on the match's teams — prevents referencing another tournament's player by UUID. Read-only GETs (lineups L313, incidents L391, CSV export L255) are any-match-viewer (access-scoped). CSV uses `_csv_safe` (L44-49) to neutralize formula injection.
- `assign_scorer` service validates target is a tournament member (`apps/matches/services/scoring.py` `assign_scorer` — `_is_tournament_member` check), so the global `User.objects.filter(id=...)` lookup in `AssignScorerView` (L127) cannot escalate a non-member.

### Fixtures (`apps/fixtures/views.py`)
- `GenerateFixturesView.post` L23-46: `accessible_tournaments(...).exists()` 404 then `can_manage_tournament` 403. Teams are pulled `Team.objects.filter(tournament=t, ...)` (L33-35) — scoped.

### Disputes (`apps/disputes/views.py`)
- `_accessible_tournament_or_404` L23-26, `_dispute_or_404` L29-37. List narrows to `raised_by=request.user` for non-managers (L49-50). Resolve/Reject are manager-only (`_ManagerTransitionView` L79); Withdraw is raiser-only (`d.raised_by_id != request.user.id` L109). Dispute's match is re-scoped `Match.objects.filter(id=..., tournament=t)` (L60).

### Forms (`apps/forms/views.py`)
- `_get_manageable_tournament` L49-55 / `_get_manageable_form` L58-65 enforce `accessible_tournaments` + `can_manage_tournament`. List (L73-79) is access-scoped read. Responses list/CSV (L283-308), response review (L316-327), stage-2 (L342-365) all go through `_get_manageable_form` and re-scope the target form `tournament=form.tournament` (L347). Public surfaces resolve org via the form/share-link, never the request body.

### Teams (`apps/teams/views.py`)
- `RegistrationLinkCreateView` L30-49 (scope+manage). `TournamentTeamsListView` L100-125 (access-scoped). Public registration (L52-92) derives the tournament/org from the resolved link (`register_school(tournament=link.tournament, ...)`), not from request input.

### Organizations (`apps/organizations/views.py`)
- Org GET requires membership-or-superuser (L192-198); PATCH requires active ADMIN (L209-216). AIP-136 verbs use role classes: suspend/unsuspend `IsSuperUser` (L257,277), archive owner-or-SA (L300-309), transfer-ownership `IsOrgOwner` (L327). Member remove / invitation revoke scope the sub-resource with `get_object_or_404(..., organization=org)` (L380-382, L450-452). **Ownership transfer** (`services/ownership.py::transfer_ownership` L74-84) requires the new owner to already hold an active admin membership *in that org* — the global `get_object_or_404(User, ...)` in the view cannot transfer to an outsider.

### Permissions (`apps/permissions/views.py`)
- `UserGrantsView` GET/PUT gated by `IsOrgAdminOrOwner` (L150), data keyed on the resolved org + target user (L182-198, L255-269) — no cross-org leak even though `get_target_user` is a global lookup. `MatrixView` admin-only (L354). `MyEffectiveModulesView` (L91-136) returns only the *requester's own* modules for an org-by-UUID (non-members get `[]`), so no leak. `ScopedQuerySet.scoped_for_user` / `module_gated` (`apps/permissions/scope.py` L64-111) are the generic isolation primitives (anon → `.none()`, superuser bypass).

### Audit (`apps/audit/views.py`)
- `OrgAuditListView` gated by `HasModule("org.audit_log")` (L103), filtered `organization_id=org.id` (L129). Cursor pagination is opaque base64 (no IDOR). Tournament-scoped audit is the separate manager-only `TournamentAuditView`.

### Notifications (`apps/notifications/views.py`)
- All three views are `IsAuthenticated` and filter `user=request.user` (L19,21,35,45) — strict per-user isolation, no org kwarg needed.

---

## 3. Auth: session, CSRF, 2FA, axes

- **Session-only auth (no JWT)**: `REST_FRAMEWORK['DEFAULT_AUTHENTICATION_CLASSES'] = ['rest_framework.authentication.SessionAuthentication']` (`fixture/settings/base.py` L160-163). DRF `SessionAuthentication` enforces CSRF on unsafe methods, so every mutating REST endpoint requires the `X-CSRFToken` header matching the `csrftoken` cookie. `DEFAULT_PERMISSION_CLASSES = [IsAuthenticated]` (L164-166) means endpoints are deny-by-default unless they opt into `AllowAny`.
- **Cookie hardening**: `SESSION_COOKIE_HTTPONLY=True`, `SESSION_COOKIE_SAMESITE="Lax"`, `*_COOKIE_SECURE = not DEBUG` (base L152-157); prod forces `SECURE=True` + HSTS/SSL-redirect/nosniff/XFO=DENY (`prod.py` L29-40). `CSRF_COOKIE_HTTPONLY=False` is intentional (SPA reads the token).
- **Password hashing**: argon2id primary (`PASSWORD_HASHERS` base L116-121); min length 12 (L124-128).
- **axes lockout**: `AXES_FAILURE_LIMIT=10`, `COOLOFF=0.25h`, params `[ip_address, username]`, `RESET_ON_SUCCESS=True` (base L189-193); `AxesStandaloneBackend` in `AUTHENTICATION_BACKENDS` (L130-134). Login (`apps/accounts/views.py::login_view`) runs through `authenticate(request, ...)` so axes can short-circuit.
- **2FA**: TOTP (valid_window=1) + single-use argon2id recovery codes; the 2FA lockout counter is a **separate** cache counter from axes (`apps/accounts/services/twofa.py` L204-224) so a correct password does not reset the attacker's second-factor budget. Enroll/confirm/disable/regenerate are `IsAuthenticated` (`views.py` L408-468) and cycle the session on confirm/disable (L437,453).
- **Session cycling on auth-state change** (fixation defense): `login_view`, `twofa_confirm_view`, `twofa_disable_view`, and `InvitationAcceptView` all call `cycle_session_on_role_change` after `login()`. Password reset wipes all sessions for the user (`complete_password_reset`).
- **Enumeration safety**: signup duplicate-email returns identical 201; password-reset-request always 200; resend-verification always 202.

---

## 4. Append-only audit guarantee

- **DB trigger (primary control, superuser-proof)**: `apps/audit/migrations/0002_audit_append_only.py` L17-35 installs `BEFORE UPDATE OR DELETE` triggers that `RAISE EXCEPTION ... ERRCODE '42501'`. Postgres row triggers fire **regardless of role, including superuser** — this is the key strength over a REVOKE-only scheme. Proven by `apps/audit/tests/test_append_only.py` (L36-73) which runs as a PG superuser and asserts ORM + raw SQL UPDATE/DELETE both fail, while INSERT still works (L76-87).
- **Single write path**: `apps/audit/services.py::emit_audit` (L24-77) is the only sanctioned writer; idempotent on `idempotency_key` (L45-48); shares the verb's transaction (`ATOMIC_REQUESTS=True`, base L110) so audit + state change commit atomically. `emit_audit_on_commit` (L80-87) for deferred cases.
- **Role REVOKE (defense-in-depth, NOT in code)**: see Finding #3 — documented in `deploy/README.md` L42-44 only.

---

## 5. Public `AllowAny` endpoints + throttling

| Endpoint | View | Throttle | Notes |
|----------|------|----------|-------|
| `POST /api/accounts/auth/signup/` | `accounts/views.py::signup` L89-91 | `SignupRateThrottle` 3/h/IP (`accounts/throttling.py`) — **replaces** defaults | Path B org self-signup. Enumeration-safe. |
| `POST .../login/`, `verify_email/`, `resend_verification/`, `password_reset_request/`, `password_reset_complete/` | `accounts/views.py` L143-383 | Global `AnonRateThrottle` 60/min (no override) + axes (login) + per-email/IP cache limiter (password reset, `PASSWORD_RESET_RATE_PER_*`) | Adequate; login double-protected by axes. |
| `POST /api/invitations:accept/` (+ path alias) | `organizations/views.py::InvitationAcceptView` L467-547 | global defaults | Email taken from signed invite, never the body (account-takeover guard L490-527); active-account → 401 `login_required`; pre-existing unverified account is activated but **password is never reset** (L497-508). |
| `GET/POST /api/forms/{id}/public/`, `/api/forms/r/{token}/` | `forms/views.py::PublicFormView` L179-232 | `PublicFormThrottle` 30/h/IP | See Finding #10. |
| `POST /api/forms/{id}/uploads/` | `forms/views.py::PublicUploadView` L235-269 | `PublicFormThrottle` 30/h/IP | Size cap 10 MB, content-type allowlist `{pdf,png,jpeg}` (L246-259). Uploads claimed only when `form=form, response__isnull=True`. |
| `GET/POST /api/register/{token}/` | `teams/views.py::PublicRegistrationView` L52-92 | `RegistrationRateThrottle` 30/h/IP (POST only, GET exempt) | Org derived from link, not request. No `is_open`/window check (functional, not security). |
| `GET /api/sports/`, `/api/sports/{code}/` | `sports/views.py` L33-63 | global `AnonRateThrottle` | Platform metadata only; no tenant data. |
| `GET /api/live/match/{id}/` | `live/views.py::LiveMatchSnapshotView` L47-103 | **none (global 60/min)** | Findings #2 and #8. |
| `ws /ws/match/{id}/` | `live/consumers.py::MatchConsumer` | **none** | Finding #1. |

`/api/feedback/submit/` (`sadmin/views/feedback.py::FeedbackSubmitView` L119-202) is **`IsAuthenticated`** (not AllowAny), throttled 10/h/user. The default throttle rates live in `fixture/settings/base.py` L172-179 (`anon 60/min`, `user 240/min`, `signup 3/h`, `school_registration 30/h`).

> Throttle backing: dev uses `LocMemCache` (per-process, ineffective across workers) — fine for dev; prod uses Redis (`prod.py` L43-49) so the limiters are shared. Cache flush/restart resets all counters (documented limiter weakness).

---

## 6. SADMIN gating

- **Decorator gate**: `apps/sadmin/decorators.py::superadmin_required` (L18-42) — anonymous → 302 to `/sadmin/login/`; authenticated-but-not-superuser (or inactive/soft-deleted) → **404** (no surface-existence leak), per v1Users §1.5. Verified the decorator is on **every** view: audit (1/1), dashboard (2/2), feedback HTML (2/2), orgs (3/3), users (4/4), superadmin JSON (3/3); only `sadmin_login`/`sadmin_logout` are intentionally ungated (login bootstrap). `org_verb`/`user_verb`/`impersonate_stop` (`views/users.py` L70-123, `views/orgs.py`) are `@require_POST` and CSRF-protected (HTMX token); only the two JSON verbs are `@csrf_exempt` (Finding #4).
- **Network gate**: `apps/sadmin/middleware.py::SadminIPAllowlistMiddleware` (L51-67) → 404 for non-allowlisted IPs on `/sadmin/*`; no-op when `SADMIN_IP_ALLOWLIST` empty (dev default; `fixture/settings/base.py` L84-86).
- **Django admin disabled** in v1.0 (`fixture/urls.py` L12-13 — no `/admin/` route; the SA uses the custom console).
- **Impersonation** (`sadmin/services/superadmin_verbs.py::impersonate_start`) is a session-marker + audit row only — it does **not** `login()` as the target, so it cannot be used to act as the target through the SPA; audited via `emit_audit(... impersonating_user_id=target.id)`.

---

## 7. Where isolation tests exist

Cross-org / outsider-404 coverage is present for most tenant-scoped surfaces:

- **Tournaments**: `apps/tournaments/tests/test_create_api.py::test_get_tournaments_lists_only_accessible_ones` (L48-49, "user A must not see user B's tournament"); `test_members_api.py`, `test_settings_api.py`, `test_invite_api.py`.
- **Matches**: `apps/matches/tests/test_match_api.py::test_outsider_cannot_list_matches` (L75-82, asserts 404) and `test_outsider_cannot_generate_fixtures` (L85-93, asserts 404 — this also covers `GenerateFixturesView`); plus `test_incidents.py`, `test_lineups.py`, `test_scorer_flow.py`.
- **Disputes**: `apps/disputes/tests/test_disputes.py::test_outsider_cannot_raise` (L91-95, 404), `test_manager_sees_all_member_sees_own` (L80).
- **Forms**: `apps/forms/tests/test_isolation.py::test_outsider_cannot_read_form_404` / `test_outsider_cannot_act_on_form_404` (L23-44); also `test_public_api.py`, `test_responses_api.py`, `test_builder_api.py`.
- **Permissions scope**: `apps/permissions/tests/test_scope_queryset.py`, `test_module_gated_queryset.py`, `test_matrix.py` (admin-only matrix).
- **Audit**: `apps/audit/tests/test_audit_list_view.py` (org-scoped feed), `test_append_only.py` (the DB-trigger guarantee).
- **Notifications**: `apps/notifications/tests/test_notifications.py` (per-user isolation).
- **Teams**: `apps/teams/tests/test_registration_link.py`, `test_registration_link_limits.py`.
- **SADMIN**: `apps/sadmin/tests/test_access_control.py`, `test_ip_allowlist.py`, `test_pii_redaction.py`, `test_superadmin_api_verbs.py`, `test_force_logout_rate_limit.py`.

**Coverage gaps to add in the restructure:**
1. **WebSocket auth/isolation** — the only WS test (`apps/live/tests/test_live.py::test_ws_match_room_receives_broadcast` L51-68) *asserts* open, unauthenticated access; there is no test that an outsider is rejected (because the consumer rejects no one — Finding #1).
2. **Public live snapshot state gating** — `test_live_snapshot_is_public_and_shows_score` (L30-47) confirms it is public but no test asserts a draft-tournament / suspended-org match is hidden (Finding #2).
3. **Fixtures app** has no dedicated outsider test in `apps/fixtures/tests/` (only `test_generate.py`/`test_advance.py`); the generate endpoint is covered indirectly by the matches test above.

---

## 8. Restructuring implications (consolidated)

1. **Unify the public-read edge.** Today three mechanisms exist (public snapshot REST, public WS room, public form/registration). Define one `public_visible(entity)` predicate (tournament published + org not suspended/soft-deleted) and apply it to every AllowAny/WS read. Move public viewing to SSE per invariant 11 and reserve WS for authenticated scorer/referee rooms with a real `connect()` auth check.
2. **Make the audit role-revoke a code-level guarantee** (startup self-check or managed migration) so the append-only promise does not depend on a runbook. Keep the superuser-proof trigger as primary.
3. **Fail-closed defaults everywhere.** Flip `_OrgMembershipPermission` to deny on unresolved org; make the 2FA crypto path refuse enrollment rather than store plaintext.
4. **Centralize throttling + the public-endpoint catalog.** A single policy module (per-IP read throttle for public reads, the existing per-action limiters) makes the anti-abuse budgets auditable in one place, and closes the live-snapshot gap.
5. **Decouple secret derivation.** Give 2FA-at-rest a rotatable, KMS-backed key independent of `SECRET_KEY`.
6. **Add the missing isolation/auth tests** (WS reject-outsider, public-snapshot state gating, fixtures outsider-404) so the restructure carries them forward as non-optional, per CLAUDE.md invariant 2.
