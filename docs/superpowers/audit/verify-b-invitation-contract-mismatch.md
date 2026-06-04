# Adversarial Verify B — Invitation list/create contract mismatch (FE expects roles[]+token; BE returns role + invited_by + no token)

**Verdict: REAL. Severity: high (confirmed).** Confidence: 0.97

## Finding under review
`backend/apps/organizations/serializers.py:160` — `AdminInvitationSerializer` returns `role`
(singular), `invited_by` (UUID), and no `token`; the FE renders `invitation.roles[]` and builds a
share link from `invitation.token`, so role badges are empty and no invite link is shown.

## Evidence from real code

### Backend returns the wrong shape
`backend/apps/organizations/serializers.py:169-184` — `AdminInvitationSerializer.Meta.fields`:
```
fields = ["id","organization","email","role","status","effective_status",
          "expires_at","accepted_at","revoked_at","created_at","invited_by"]
read_only_fields = fields
```
- Field is `role` (singular), NOT `roles`.
- Field is `invited_by` (a User FK → serializes to UUID; model `models.py:263` `invited_by = ForeignKey(AUTH_USER_MODEL, ...)`), NOT `invited_by_email`.
- No `token` / `roles` field at all. No custom `to_representation`.
- `role` model field is a single CharField (`models.py:270-274`).

### Both POST views discard the plaintext token
- `views.py:574` (slug route) and `views.py:424` (uuid route):
  `inv, _plaintext = invitation_svc.create_invitation(...)` — plaintext token captured into
  `_plaintext` and thrown away.
- `views.py:585-587` returns `AdminInvitationSerializer(inv).data` (status 201). The create
  response therefore carries no `token` and uses singular `role`.
- The service genuinely returns the token: `services/invitation.py:227` `return inv, plaintext`
  (plaintext emailed only — `invitation.py:217`). So it exists but is never surfaced via the API.

### Backend test confirms singular `role` in response (not roles/token)
`tests/test_slug_routes.py:142-145`:
```
assert resp.status_code == 201
body = resp.json()
assert body["role"] == MembershipRole.ADMIN
```
No test asserts `roles` or `token` in any create/list response. The views accept `roles` on input
(`views.py:578`, test line 137) but never echo it back.

### Frontend expects roles[] + token + invited_by_email
- `frontend/src/api/orgs.ts:44-53` `InvitationListItem`: `roles: string[]`, `token?: string`,
  `invited_by_email: string`.
- `frontend/src/types/user.ts:136-145` `OrgInvitation`: `roles: Role[]`, `token?: string`,
  `invited_by_email: string`.
- `frontend/src/features/orgs/InvitationsListPanel.tsx:137`:
  `(invitation.roles ?? []).map((r) => <RoleBadge ... />)` → `roles` undefined → empty badges.
- `InvitationsListPanel.tsx:114`: `const link = invitation.token ? shareLinkFor(invitation.token) : ""`
  → token absent → copy-link button not rendered (line 146 `{link ? <Button.../> : null}`).
- `InviteCreateModal.tsx:247-248`: `const token = invitation.token ?? ""; const link = token ? shareLinkFor(token) : ""`
  → post-create "Sent" modal shows an empty token field and empty share link.

## User-visible impact (confirmed)
1. Invitation list rows render with NO role badges (FE reads `roles`, BE sends `role`).
2. The invitation list never offers a "Copy link" button (FE reads `token`, BE sends none).
3. The post-create confirmation ("SentView") shows an empty token and empty share link — the
   entire point of the self-serve, share-a-link invite flow is broken.
4. (Minor) `invited_by_email` is undefined on the FE (BE sends `invited_by` UUID), so any
   "invited by" attribution would be blank.

## Severity judgment
`high` is correct. This breaks a core user workflow (sharing an invite link is the locked
self-serve onboarding path) and silently shows empty UI, but it is not a security/isolation issue
(no cross-org leak, no auth bypass, token is not over-exposed — if anything it is under-exposed).
Not `critical` (no data loss/security), clearly above `medium` (it renders the primary invite
sharing affordance non-functional and the role display blank).

## Caveats / precision notes
- The finding's line cite (serializers.py:160) is the class def line; the offending field list is
  169-184 — same serializer, accurate enough.
- The finding correctly extends the defect to the create modal (InviteCreateModal.tsx:247), not
  just the list panel; both are confirmed.
