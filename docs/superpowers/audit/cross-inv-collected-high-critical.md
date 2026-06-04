# Cross-Invariant Audit — Collected CRITICAL + HIGH findings

**Source:** the 15 `cross-inv-*.md` architectural-invariant analyses in `docs/superpowers/audit/`.
**Date collected:** 2026-06-04
**Filter:** severity `critical` or `high` only (medium/low/info findings and Phase-1B prep
gaps are intentionally excluded — see the individual `cross-inv-N.md` files for those).

**Headline:** No `critical` findings exist across the 15 invariant analyses. There are
**16 HIGH findings**. They cluster into four themes:

1. **Idempotency contract holes (inv-3, inv-12-F3 dup):** two shipping mutation endpoints
   (`bulk_set_grants`, `transfer_ownership`) accept `event_id` but silently drop it, so they
   are not idempotent — directly violating invariant 3 ("applies to *all* writes").
2. **Append-only audit not enforced at the role layer (inv-5):** the literal REVOKE the
   invariant mandates is absent; the app connects as the Postgres superuser; the trigger
   that does exist is bypassable. Three HIGH findings.
3. **Multi-tenancy mechanism/test gaps (inv-2):** two divergent scope modules (one dead),
   and per-endpoint cross-org isolation tests exist for only one endpoint.
4. **i18n/a11y + CSRF + side-effect ordering (inv-13, inv-15, inv-4, inv-8, inv-11):**
   no backend translation infra, untranslatable `t()` template-literals, two `@csrf_exempt`
   super-admin mutations, an email sent inside `transaction.atomic()`, an unresolved
   PRD↔v1Users spec conflict (PersonAccount vs Person.user), and the InMemoryChannelLayer
   that will break multi-worker fan-out in Phase 1B.

---

## HIGH findings

| # | Inv | ID | Title | File:line |
|---|-----|----|-------|-----------|
| 1 | 2 | F1 | Two divergent, duplicated scope implementations; one is dead code | `backend/apps/organizations/scope.py:21` |
| 2 | 2 | F6 | Cross-org isolation tests exist for only one endpoint | `backend/apps/audit/tests/test_audit_list_view.py:120` |
| 3 | 3 | F1 | `bulk_set_grants` silently drops `event_id`; endpoint is NOT idempotent | `backend/apps/permissions/views.py:210` |
| 4 | 3 | F2 | `transfer_ownership` drops `event_id`; ownership swap NOT idempotent | `backend/apps/organizations/views.py:331` |
| 5 | 4 | F1 | `send_mail` fires INSIDE `transaction.atomic()` in invitation verb | `backend/apps/organizations/services/invitation.py:188` |
| 6 | 5 | F1 | Literal role-level REVOKE absent; only a trigger enforces append-only | `backend/apps/audit/migrations/0002_audit_append_only.py:17` |
| 7 | 5 | F2 | Promised "deploy provisioning" REVOKE has no script/target/CI check | (absence — no `deploy/`, no hardening SQL) |
| 8 | 5 | F3 | App connects as Postgres superuser; no separate app role → REVOKE is a no-op | `backend/.env.example:3` |
| 9 | 8 | F2 | Spec conflict: PRD §8 `PersonAccount` join table vs locked `Person.user` OneToOne | `docs/superpowers/specs/2026-04-30-fixture-platform-prd.md:887` |
| 10 | 11 | F2 | `InMemoryChannelLayer` cannot fan out across workers (breaks #11/#4) | `backend/fixture/settings/base.py:185` |
| 11 | 13 | F1 | Backend: no `LocaleMiddleware`/`LOCALE_PATHS`/catalogs (gettext inert) | `backend/fixture/settings/base.py:59` |
| 12 | 13 | F2 | Backend: serializer & service error strings hardcoded English, unmarked | `backend/apps/organizations/serializers.py:64` |
| 13 | 13 | F4 | Frontend `t()` shim has no interpolation → 12 untranslatable call sites | `frontend/src/lib/t.ts:7` |
| 14 | 15 | F-01 | `@csrf_exempt` on super-admin `bulk_email_api` (CSRF removed on cookie-auth mutation) | `backend/apps/sadmin/views/superadmin.py:45` |
| 15 | 15 | F-02 | `@csrf_exempt` on super-admin `archive_feedback_api` (same CSRF regression) | `backend/apps/sadmin/views/superadmin.py:95` |
| 16 | 12 | F3 | Grant-write `event_id` accepted but ignored (inv-3 dup, RBAC path) | `backend/apps/permissions/views.py:221` |

(Item 16 is the same defect as item 3 viewed from the RBAC invariant; both retained because
each analysis filed it independently.)

---

## CRITICAL findings

None. Every analysis explicitly notes that the heaviest invariants (#4 Redis publish, #7
rule freeze, #8 Person/Player, #9 typed match deps, #10 GenerationRun, #11 SSE/WS) are
Phase 1B and unbuilt, so they cannot be violated yet — and that Phase 1A does not block any
of them. The present HIGH findings are real Phase-1A defects plus copy-paste-able anti-patterns
that should be fixed before Phase 1B inherits them.
