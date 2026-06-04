# Adversarial Verify A — `last_active_org_id` writable via PATCH /me/

**Finding under test:** high — "last_active_org_id writable via PATCH /me/ without membership
validation — IDOR / cross-org probe" — `backend/apps/accounts/serializers.py:117`.

**Verdict: REAL (the mass-assignment fact is confirmed), but severity is OVERSTATED.
Corrected severity: low.** Confidence 0.85.

## What the code actually shows

### 1. The field IS writable (mass assignment confirmed)
`backend/apps/accounts/serializers.py:107-132` — `MeSerializer.Meta`:
- `fields` (lines 109-121) includes `"last_active_org_id"` (line 117).
- `read_only_fields` (lines 122-132) lists `id, email, is_superuser, has_2fa_enrolled,
  twofa_enrolled_at, email_verified_at, memberships, last_active_org_slug, deleted_at`
  — it does **NOT** include `last_active_org_id`.
- Therefore `last_active_org_id` is a writable model field on PATCH.

There is **no** `validate_last_active_org_id` method and **no** custom `validate()` in the
serializer (whole file read, lines 1-185).

### 2. The view persists it with NO membership check
`backend/apps/accounts/views.py:416-441` (`me_view`):
- Line 423: `serializer = MeSerializer(user, data=request.data, partial=True)`
- Line 424: `serializer.is_valid(raise_exception=True)`
- Line 426: `serializer.save()` — writes `last_active_org_id` straight from `request.data`.
- No `OrganizationMembership` lookup, no org-membership guard anywhere in the handler
  (grep for `membership`/`OrganizationMembership` in views.py returns only the docstring at
  line 94). Audit emit (lines 431-440) records the change but does not validate it.

So a user CAN PATCH their own `last_active_org_id` to an arbitrary org UUID they are not a
member of. The mass-assignment / missing-validation fact in the finding is TRUE.

### 3. Why this is NOT a real IDOR / access-control breach (severity downgrade)
`last_active_org_id` is a **per-user UI routing hint** ("Org switcher" — model comment
`models.py:85-86` "Last-active org for the SPA Org switcher (v1Users.md B.20)"), stored on
the *attacker's own* row. It is never used as an authorization trust boundary:

- **Server read of it** — `serializers.py:177-184` `get_last_active_org_slug`: resolves the
  slug via `Organization.objects.filter(id=user.last_active_org_id)` and returns it. This
  leaks at most the *slug* of an org the user named — and **slugs are already public** by
  invariant 1 ("Public URLs use `(slug, UUID)` pairs"). It does NOT return org name, members,
  or any tenant-scoped data. The org's own UUID is the value the attacker supplied, so no
  new identifier is disclosed.
- **Frontend consumption** — `frontend/src/features/roles/redirectByRole.ts:32-36`:
  `last_active_org_slug` is used only to **find a matching entry inside the user's own
  `memberships[]`**. If the forged slug is not in `memberships[]`, it falls back to
  `memberships[0]` (line 36). A forged value for a non-member org is silently ignored and
  grants no route/access. `AppShell.tsx:81` and `ComingSoonPage.tsx:37` use it the same way
  (display/route hint only).
- **No tenant-scoped query keys off `last_active_org_id`.** Org-data endpoints scope by
  `OrganizationMembership` / accessible-org managers (invariant 2), not by this field.
  Setting it to org Y does not make org Y's data reachable.

### 4. "Cross-org probe" claim
The only probe value is: PATCH a guessed org UUID, then GET /me/ and observe whether
`last_active_org_slug` comes back non-null to confirm the UUID is a real org. That is a weak
existence-oracle over already-public slugs (slugs are public per invariant 1), with no PII or
tenant data exposed. Low impact.

## Conclusion
- **is_real: true** — the field is genuinely writable without validation (real
  mass-assignment / input-hygiene defect; it *should* validate membership).
- **Severity: high → low.** It is not Broken Access Control: the value lives on the user's
  own row, is never an authz trust boundary, and exposes only already-public slug existence.
  Worth fixing (add `validate_last_active_org_id` to assert active membership, or move the
  field to a dedicated `/me/active-org` action) but not a high-severity IDOR.

## Evidence files
- `backend/apps/accounts/serializers.py:107-132, 177-184`
- `backend/apps/accounts/views.py:416-441`
- `backend/apps/accounts/models.py:85-86`
- `frontend/src/features/roles/redirectByRole.ts:27-56`
