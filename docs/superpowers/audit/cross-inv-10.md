# Cross-Cutting Audit — Invariant #10: `inputs_hash` + `last_manual_edit_at` on generated artifacts

**Invariant (canonical text):** "Auto-generate everything; manual edit allowed; conflict warnings.
Every auto-generated artifact (bracket, schedule, prose rulebook, suspensions, etc.) stores
`inputs_hash` + `last_manual_edit_at`. UI shows a 'regenerate / keep manual / view diff' banner
if inputs change after a manual edit." (root `CLAUDE.md:37`)

**PRD support:**
- §5.16 Conflict-warning system (`docs/superpowers/specs/2026-04-30-fixture-platform-prd.md:740-747`).
  Applies to: **prose rulebook, bracket, schedule, group composition, match clock state,
  suspensions, slugs**. Read-only computed (leaderboards, standings) → **no banner**.
- §8 data model — the carrier model:
  `GenerationRun (target_type, target_id, inputs_hash, generated_at, last_manual_edit_at, report JSONB)`
  (`...prd.md:962`).

**Scope reality:** All §5.16 artifacts except **slugs** are Phase 1B (tournaments / fixtures /
matches / disputes). None of those apps exist yet. Slugs are the only §5.16 artifact that ships
in Phase 1A (organizations) — so it is the only place where this invariant could already be
honored or violated today.

**Verdict:** Phase 1A does NOT block invariant #10. The carrier model (`GenerationRun`) and the
conflict-warning banner are simply not yet built (correct — Phase 1B). One genuine, low-severity
prep gap exists for slugs, plus the cross-cutting infrastructure gaps recorded below.

---

## Findings

### F1 — `GenerationRun` model does not exist anywhere in code (info — expected for Phase 1B)

**Severity:** info
**Files:** entire `backend/` tree.
**Evidence:** A repo-wide search for the carrier model and its fields returns ONLY the PRD:
```
docs\superpowers\specs\2026-04-30-fixture-platform-prd.md:962:
  | GenerationRun | (target_type, target_id, inputs_hash, generated_at, last_manual_edit_at, report JSONB) |
```
No `class GenerationRun`, no `inputs_hash` field, no `last_manual_edit_at` field exists in any
`models.py` or migration. The six `backend/apps/*/models.py` files (accounts, audit, organizations,
permissions, sadmin, sports) contain none of these.

**Why it matters:** Invariant #10's entire mechanism (the `GenerationRun` audit row + the
view-time conflict banner) is unbuilt. This is correct for current phase — every artifact that
needs it (bracket, schedule, rulebook, suspensions, group composition, match clock) lives in
unbuilt Phase 1B apps. Recording it so the gap is tracked, not lost.

**Recommendation:** Build `GenerationRun` (or per-artifact embedded `inputs_hash` +
`last_manual_edit_at` columns) as the FIRST item in the fixtures/bracket-generator milestone,
before any generator writes its first artifact. Decide deliberately between (a) one central
`GenerationRun` table keyed by `(target_type, target_id)` as the PRD schema implies, vs.
(b) embedded columns on each artifact model. The PRD §8 row implies a central table; §5.16's
per-artifact banner logic works with either. Lock this in `v1Sport.md` before coding.

---

### F2 — Slug auto-generation has no `inputs_hash` / `last_manual_edit_at` (low — slugs are a §5.16 artifact)

**Severity:** low
**Files:**
- `backend/apps/accounts/services/signup.py:157` (`_derive_slug`), `:119` (`_pick_unique_slug`),
  `:96` (`_slugify_for_org`)
- `backend/apps/organizations/services/slug.py:64` (`change_slug`)
- `backend/apps/organizations/models.py:114` (`Organization.slug = models.CharField(...)`)

**Evidence:** §5.16 explicitly lists **slugs** among the conflict-warning artifacts ("Applied to:
prose rulebook, bracket, schedule, group composition, match clock state, suspensions, slugs" —
`...prd.md:747`). The Org slug IS auto-derived:
```python
# signup.py:157
def _derive_slug(*, org_name: str | None, email: str) -> str:
    """Pick the slug seed — ``org_name`` if given, else email local-part."""
    if org_name and org_name.strip():
        seed = _slugify_for_org(org_name)
        ...
```
and mutated:
```python
# slug.py:88-89
org.slug = new_slug
org.save(update_fields=["slug"])
```
Neither the `Organization` model (`organizations/models.py:114`) nor `change_slug` records an
`inputs_hash` (e.g. a hash of `org_name`) or a `last_manual_edit_at`. So if `org_name` later
changes, the system cannot tell whether the current slug is still the auto-derived one or was
manually overridden — exactly the state §10's banner is designed to surface.

**Why it matters / confidence:** Confidence MEDIUM that this is a real-but-minor gap. In practice
the slug→org-name coupling is one-shot at signup and slug changes are explicit admin actions, so
the "inputs changed after manual edit" banner has little real signal for slugs (unlike brackets,
where inputs genuinely change underneath a manual edit). The PRD lists slugs in §5.16 but a
`SlugRedirect` history table (`organizations/models.py:340`) already covers the practical concern
(old links resolve). Treating this as a hard violation would be over-reading the spec.

**Recommendation:** Decide-and-document, do not necessarily build. Either (a) when `GenerationRun`
lands in Phase 1B, register the Org slug as a tracked target so §5.16 is uniformly satisfied; or
(b) record an explicit PRD §13→§14 decision that slugs are EXEMPT from the `GenerationRun` banner
(justification: user-authored from day 1 + `SlugRedirect` already preserves link integrity).
Without one of these, §5.16's own artifact list and the implemented slug code disagree.

---

### F3 — No frontend "regenerate / keep manual / view diff" banner; existing banner is unrelated (info)

**Severity:** info
**Files:** `frontend/src/features/permissions/ConflictOfInterestBanner.tsx:1-54`
**Evidence:** The only banner that pattern-matches "conflict" in the frontend is the RBAC
conflict-of-interest banner, explicitly scoped to a different spec section:
```tsx
// ConflictOfInterestBanner.tsx:11-16
/**
 * v1Users.md Appendix B.22 — soft-warning banner pattern. The platform
 * does NOT block conflicted actions; it requires the actor to tick an
 * acknowledgement which the backend logs to AuditEvent...
 */
```
A frontend search for `regenerate|keep manual|view diff|inputsHash|lastManualEdit` returns only
the 2FA recovery-codes regenerate endpoint and a codegen comment — nothing related to §5.16.

**Why it matters:** The §10 view-time banner ("⚠️ Edited manually but inputs changed.
[Re-generate] [Keep manual] [View diff]") is unbuilt. Correct for Phase 1A (no artifacts to show
it on). Recording so it is tracked alongside the backend model.

**Recommendation:** Build a reusable `<RegenerateConflictBanner />` (shadcn `Alert` + three
actions) when the first generator UI (bracket/schedule editor) lands. Do NOT reuse
`ConflictOfInterestBanner` — different semantics (acknowledgement checkbox vs. three-way action).

---

### F4 — KPISnapshot correctly omits the fields (info — confirms read-only-computed carve-out is honored)

**Severity:** info
**Files:** `backend/apps/sadmin/models.py:142-155`, `backend/apps/sadmin/services/kpi.py:33-49`
**Evidence:** `KPISnapshot` is a daily rolled-up metrics row, recomputed idempotently per date:
```python
# sadmin/models.py:142-148
class KPISnapshot(models.Model):
    """Daily rolled-up KPI metrics. Idempotent per snapshot_date."""
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    snapshot_date = models.DateField(unique=True)
    metrics = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
```
```python
# sadmin/services/kpi.py:45-49 — pure upsert, never manually edited
snapshot, _created = KPISnapshot.objects.update_or_create(
    snapshot_date=snap_date, defaults={"metrics": metrics},
)
```
**Why it matters:** §5.16 explicitly carves out "Read-only computed (leaderboards, standings) →
no banner." KPISnapshot is exactly that class (read-only computed rollup, never hand-edited), so
its lack of `inputs_hash`/`last_manual_edit_at` is CORRECT, not a violation. This is a positive
confirmation that the one computed artifact in Phase 1A respects the invariant's boundary.

**Recommendation:** None. Keep KPISnapshot out of the `GenerationRun` mechanism. Apply the same
"read-only computed → no banner" reasoning to future leaderboards/standings in Phase 1B.

---

## Gaps (prep work for Phase 1B; none block 1A)

| # | Gap | Missing | Needed for | Effort | Blocking 1A? |
|---|-----|---------|-----------|--------|--------------|
| G1 | `GenerationRun` carrier model unbuilt | `inputs_hash`, `generated_at`, `last_manual_edit_at`, `report` JSONB; central vs. embedded-columns decision | bracket / schedule / rulebook / suspension / group-composition / match-clock generators | M | No |
| G2 | Slug §5.16 status undecided | Either register Org slug as a `GenerationRun` target OR a PRD §14 decision exempting slugs (justify via existing `SlugRedirect`) | spec/code consistency | S | No |
| G3 | Conflict-warning UI primitive unbuilt | `<RegenerateConflictBanner />` (regenerate / keep manual / view diff) + a TanStack Query hook to read `GenerationRun` state | every generator-editor screen | M | No |
| G4 | "view diff" mechanism unspecified | How a manual edit's diff vs. a fresh regenerate is computed and rendered (per artifact type) | the [View diff] action in the banner | M | No |
| G5 | Generator idempotency contract | Generators must compute `inputs_hash` deterministically and gate regeneration on it (ties into invariant #3 idempotent writes + #4 DB-first) | safe regenerate without clobbering manual edits | S | No |

**Bottom line:** Phase 1A is clean for invariant #10. The only artifact in 1A that §5.16 names
(slugs) is auto-generated but untracked (F2, low) and needs a deliberate exempt-or-track decision.
Everything else (GenerationRun model, conflict banner, view-diff) is legitimately deferred to
Phase 1B and nothing in 1A blocks building it. KPISnapshot positively confirms the
read-only-computed carve-out is being respected.
