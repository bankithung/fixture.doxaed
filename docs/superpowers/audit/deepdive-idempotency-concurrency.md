# Deep-Dive: Idempotency + Concurrency (Invariant #3)

**Pass:** 2 (deeper). **Scope:** every mutation endpoint in the Phase 1A backend.
**Question per invariant #3:** does each mutation accept `event_id` with a unique
constraint and return the existing row on replay? Where are the TOCTOU races,
non-atomic multi-writes, missing `on_commit`, and double-submit corruptions?

**Method:** traced full call paths view -> serializer -> service -> model/migration.
Confidence is marked per finding. Evidence is quoted with `file:line`.

---

## 0. How idempotency is actually implemented (the shared substrate)

There is **no dedicated idempotency table**. The entire idempotency story is bolted
onto `AuditEvent.idempotency_key`:

- `apps/audit/models.py:48` — `idempotency_key = models.UUIDField(unique=True, null=True, blank=True)`.
  The DB-level UNIQUE constraint is real (confirmed in
  `apps/audit/migrations/0001_initial.py:31-32`).
- `apps/audit/services.py:45-48` — the *only* idempotency gate:
  ```python
  if idempotency_key:
      existing = AuditEvent.objects.filter(idempotency_key=idempotency_key).first()
      if existing:
          return existing
  ```
- Replay reconstruction is done **per-service** by re-reading the audit row and
  rebuilding the prior return value from `target_id` / `payload_after`
  (signup `apps/accounts/services/signup.py:168-205`; invitation
  `apps/organizations/services/invitation.py:160-167`; feedback
  `apps/sadmin/services/feedback.py:74-81`).

This design has three structural consequences that drive most findings below:

1. **The idempotency check is check-then-create in Python, not an atomic upsert.**
   The DB UNIQUE constraint is the only true guard; the app-level `.first()` check
   is a TOCTOU window.
2. **Only 3 of ~25 mutation verbs actually thread an `event_id` through.** signup,
   `create_invitation`, and `submit_feedback`. Everything else (org lifecycle,
   ownership transfer, grants, slug change, member remove, 2FA, password reset,
   triage, all 13 super-admin verbs) silently ignores invariant #3 — there is no
   `event_id` parameter at all, so a double-submit creates duplicate state +
   duplicate audit rows.
3. **`transaction.on_commit` / Redis publish is essentially absent.** Only
   `emit_audit_on_commit` exists (`apps/audit/services.py:80-87`) and **it is never
   called anywhere** (grep: zero call sites). Invariant #4 ("publish to Redis in
   `transaction.on_commit`") has no implementation in Phase 1A — every "TODO Redis
   pub/sub" is a comment (`apps/permissions/services/grants.py:110`,
   `apps/permissions/services/resolver.py:45`). Not exploitable yet (no SSE/WS
   consumers in 1A) but it means the cache-invalidation in `set_grant` is
   **inside** the transaction and fires before commit (see Finding 6).

---

## TOP FINDINGS

### Finding 1 — TOCTOU in `emit_audit` idempotency gate: replay can 500 instead of returning the existing row (HIGH confidence)

`apps/audit/services.py:45-77`:

```python
if idempotency_key:
    existing = AuditEvent.objects.filter(idempotency_key=idempotency_key).first()  # (T1 read)
    if existing:
        return existing
...
return AuditEvent.objects.create(idempotency_key=idempotency_key, ...)            # (T2 write)
```

**The race:** two concurrent requests carry the same `event_id` (the *exact*
double-submit scenario invariant #3 exists to defend — user double-clicks, SPA
retries on a flaky network, mobile resends). Both execute the `.first()` read,
both see `None`, both proceed to `INSERT`. The DB UNIQUE constraint on
`idempotency_key` (`audit_event.idempotency_key`) lets the first commit win and
makes the second raise `IntegrityError`.

**Why it is exploitable / harmful, not benign:**
- `emit_audit` does **not** catch `IntegrityError` and re-fetch. The exception
  propagates up through the service into the DRF view, which has no handler for it
  (e.g. `signup` view `apps/accounts/views.py:108-115` only catches nothing;
  `create_invitation` view catches only `DjangoValidationError`). Result: the
  replay request returns **HTTP 500**, the opposite of the invariant's contract
  ("re-submitting returns the existing record, 200 not 201").
- Worse, in `perform_signup` the `emit_audit` call is the **last** statement inside
  the `transaction.atomic()` block (`signup.py:303-318`). When the second
  request's `emit_audit` raises `IntegrityError`, the **entire signup transaction
  rolls back** — User, Organization, Membership, EmailVerificationToken all
  unwind. So a double-submitted signup where the first is still in-flight can cause
  the second to 500 AND poison the connection's transaction state. The
  "idempotent replay -> 200" path (`signup.py:236-239`,
  `views.py:117-119`) only works when the first request has **already committed**;
  it provides zero protection during the in-flight overlap window.

**Correct fix:** wrap the create in `try/except IntegrityError:` and re-fetch by
`idempotency_key`, returning the now-existing row — i.e. make `emit_audit` a true
get-or-create. Optionally `select_for_update` won't help (no row exists yet); the
catch-and-refetch pattern is the right one.

---

### Finding 2 — Ownership transfer relies on a DEFERRABLE constraint that does NOT exist; the swap is only safe by accident, and the in-code claim is false (HIGH confidence)

`apps/organizations/services/ownership.py:91-97`:

```python
# Atomic swap. Thanks to DEFERRABLE INITIALLY DEFERRED, the
# constraint is checked at COMMIT, not after each UPDATE.
current.is_org_owner = False
current.save(update_fields=["is_org_owner"])
incoming.is_org_owner = True
incoming.save(update_fields=["is_org_owner"])
```

The comment asserts the `one_owner_per_org` unique constraint is
`DEFERRABLE INITIALLY DEFERRED`. **It is not.** The model
(`apps/organizations/models.py:216-226`) declares it as a *partial* UniqueConstraint
(`condition=Q(is_org_owner=True, is_active=True)`) and the model docstring itself
admits Django "prohibits combining `condition` with `deferrable`" so the deferrable
"is therefore added by a follow-up RunSQL migration owned by the organizations
agent." **That follow-up migration does not exist** — `organizations/migrations/`
contains only `0001_initial.py` (verified), and `0001_initial.py:294-301` adds the
constraint with **no `deferrable=` argument** -> it is IMMEDIATE.

**Consequences:**
1. The constraint fires *after each UPDATE*, not at commit. The code happens to
   survive only because it clears the outgoing owner **first** (zero matching rows),
   then sets the incoming owner. If anyone "optimizes" the ordering, or adds a
   pre-set of the incoming flag, it will throw `IntegrityError` mid-transaction.
   The safety is undocumented-accidental, and the inline comment actively lies about
   *why* it works, so a future maintainer will trust the wrong invariant.
2. **No `event_id` / idempotency on transfer at all.** `transfer_ownership` takes no
   `event_id`; the view (`OrgTransferOwnershipView.post`,
   `apps/organizations/views.py:324-341`) passes none. A double-submit of the
   transfer is *idempotent-ish by luck* (second run finds `current` no longer has
   `is_org_owner=True` and raises "Current owner does not hold an active owning
   admin membership" — `ownership.py:62-72`), i.e. it returns a **400 error on
   replay** instead of a 200 with the post-transfer state. That violates invariant
   #3's "re-submit returns existing record."
3. The `select_for_update()` on both rows (`ownership.py:62,75`) does lock correctly,
   so two *different* transfers can't interleave — that part is sound.

**Net:** correctness is fragile (depends on statement order + a nonexistent
constraint property) and replay-safety is wrong (replay -> 400).

---

### Finding 3 — Recovery-code consumption is a double-spend race (no row lock); a code can be accepted twice concurrently (HIGH confidence)

`apps/accounts/services/twofa.py:197-214` (`_verify_recovery`):

```python
qs = RecoveryCode.objects.filter(user=user, used_at__isnull=True)   # (read, NO select_for_update)
for row in qs:
    try:
        _HASHER.verify(row.code_hash, candidate)
    except VerifyMismatchError:
        continue
    ...
    row.used_at = timezone.now()
    row.save(update_fields=["used_at"])    # (write — last-writer-wins, no lock)
    return True
```

This is invoked from `verify_totp_or_recovery` (`twofa.py:217-247`), which is
called by the **login** path (`apps/accounts/views.py:231`) — i.e. an unauthenticated,
attacker-reachable surface.

**The race:** two concurrent login attempts submit the same single-use recovery
code. Neither uses `select_for_update`; both read the row while `used_at IS NULL`,
both argon2-verify successfully, both set `used_at` (the second overwrites the
first), both return `True`. A one-time recovery code is honored **twice**. There is
no unique/`used_at IS NULL` guard at the DB level either. For a 2FA bypass primitive,
a single leaked recovery code surviving "one" use defeats the "consume on use"
guarantee in `twofa.py:13` ("consumes a recovery code on use") and B.14.

Severity is elevated because this is on the auth boundary, and because `confirm_totp`
correctly uses `select_for_update` on the device (`twofa.py:126`) — so the
*omission* here is clearly an oversight, not a deliberate choice.

**Fix:** `RecoveryCode.objects.select_for_update().filter(user=user, used_at__isnull=True)`
inside a `transaction.atomic()`, and/or make the consuming write a conditional
`UPDATE ... WHERE used_at IS NULL` and check `rowcount == 1`.

---

## ADDITIONAL FINDINGS

### Finding 4 — Signup duplicate-email check is TOCTOU; concurrent signups collide on the `User.email` UNIQUE and 500 (MEDIUM-HIGH)

`apps/accounts/services/signup.py:242-261`:

```python
if User.objects.filter(email=email).exists():   # (read)
    return SignupResult(..., duplicate_email=True)
...
with transaction.atomic():
    user = User.objects.create_user(email=email, ...)   # (write — email is UNIQUE)
```

`User.email` is `unique=True` (`apps/accounts/models.py:71`). Two concurrent
signups for the same fresh email both pass the `.exists()` check, then one
`create_user` wins and the other raises `IntegrityError`, which is **uncaught** in
both the service and the view (`apps/accounts/views.py:108-115`) -> HTTP 500 instead
of the "enumeration-safe identical 201" the B.11 design promises
(`signup.py:228-229`). Same class of bug as Finding 1 but on the `User` table.
Note `event_id` does NOT protect this path: the duplicate-email branch is checked
*before* the idempotency replay would help on a *different* event_id, and two
double-submits with the *same* event_id hit Finding 1 first.

### Finding 5 — Replay reconstruction is non-atomic with the writes it reconstructs (MEDIUM)

`signup.py:168-205`, `invitation.py:160-167`, `feedback.py:74-81` all do:
"find audit row by `idempotency_key` -> look up the target row by
`audit_row.target_id` -> return it." But the audit row and the target row are read
in **separate queries with no lock and no snapshot guarantee**. If a replay arrives
in the narrow window after the first request's audit row commits but a related row
was subsequently hard-deleted, the reconstruction returns a partially-null result:
- signup `signup.py:182-186`: if the User was hard-deleted, it returns `None` and
  *silently falls through to a fresh signup attempt* — meaning the "same event_id"
  no longer short-circuits, breaking idempotency.
- signup `signup.py:188-196`: org/membership looked up independently; either can be
  `None` while `created=False`, yielding a `SignupResult` with `organization=None`
  that the view treats as a successful replay (`views.py:118-119`). Low real-world
  likelihood but it is a silent-corruption path, not a hard failure.

### Finding 6 — `set_grant` / `bulk_set_grants` invalidate cache INSIDE the transaction, before commit (MEDIUM, latent)

`apps/permissions/services/grants.py:109-111` and `:211`:

```python
invalidate_cache(user.id, organization.id)   # called inside `with transaction.atomic():`
emit_audit(...)                               # still inside the txn
```

`invalidate_cache` runs before the transaction commits. Under concurrency, a
*reader* on another worker can (a) observe the invalidation, (b) re-populate the
cache by reading the **pre-commit** grant state (old value, since the writer's
transaction hasn't committed), and (c) leave a stale-but-"fresh" cache entry after
the writer commits. This is the textbook reason invariant #4 mandates
`transaction.on_commit`. The fix is to wrap the invalidation in
`transaction.on_commit(lambda: invalidate_cache(...))`. The code's own TODO at
`grants.py:110` acknowledges the missing Redis cross-worker publish but not the
ordering bug. Latent in 1A (locmem cache, single worker) but real in prod (Redis,
multiple ASGI workers).

### Finding 7 — Grants matrix PUT advertises `event_id` idempotency but silently ignores it -> double-submit duplicates audit rows (MEDIUM)

`apps/permissions/serializers.py:103-110` accepts `event_id` and the view docstring
(`apps/permissions/views.py:204-208`) tells clients the matrix PUT supports it. But
`apps/permissions/views.py:238-246` calls `bulk_set_grants(...)` **without** passing
`event_id`, and `bulk_set_grants` (`grants.py:135-213`) has no `event_id` parameter.
The serializer comment is honest about it (`serializers.py:108-109`: "currently
ignored at the service layer"), but the **public API contract lies** to clients,
who will reasonably assume retries are safe. A double-submit of the matrix PUT
(network retry on a slow request) runs the whole upsert twice: the second pass is
mostly a no-op for unchanged cells (`grants.py:169-173` skips equal states) BUT any
cell whose value the user changed between the two clicks, or any concurrent edit,
produces a second `module_grant_changed` audit row and re-fires `invalidate_cache`.
Not corrupting, but it violates invariant #3 for an endpoint that claims to honor it.

### Finding 8 — `accept_invitation` flips status OUTSIDE the atomic block; partial-failure leaves invite in `expired` with no membership (LOW-MEDIUM)

`apps/organizations/services/invitation.py:249-256`:

```python
pre_inv = AdminInvitation.objects.filter(token_hash=token_hash).first()
...
if pre_inv.status == InviteStatus.PENDING and pre_inv.is_expired():
    AdminInvitation.objects.filter(pk=pre_inv.pk, status=InviteStatus.PENDING).update(
        status=InviteStatus.EXPIRED)     # write OUTSIDE the later transaction.atomic()
    raise ValidationError("Invitation has expired.")
```

The expiry flip is deliberately done outside the atomic block (the comment at
`:247-248` says so, "so the status flip survives a subsequent ValidationError
rollback"). The conditional `.update(... status=PENDING)` is itself atomic at the
statement level (good — concurrent accepts can't both flip), but the broader concern
is that `accept_invitation` performs four writes inside the real atomic block
(`:258-317`: membership create/reactivate, invite -> accepted, audit) with **no
`event_id`**. A double-submit of accept (two tabs, retry) is *partially* guarded by
the `select_for_update` on the invite (`:260`) and the `status == ACCEPTED` early
raise (`:266-267`) — so the second attempt returns a **400 "already accepted"**
rather than the membership row (invariant #3 says replay should return the existing
record/200). Also note `_cycle_session` runs **after** the transaction
(`:319-320`), which is correct ordering, but it is the only place in the codebase
that does post-commit work and it does so by *position*, not `transaction.on_commit`
— if a later refactor moves it into the block it will cycle a session that may roll
back.

### Finding 9 — Org lifecycle verbs (suspend/unsuspend/archive/approve/reject/orphan), slug change, member-remove, feedback triage/archive, 2FA enroll/confirm/disable, all 13 super-admin verbs: zero `event_id`, zero idempotency (MEDIUM, breadth)

None of these accept an `event_id`:
- `apps/organizations/services/lifecycle.py` (every verb).
- `apps/organizations/services/slug.py:change_slug`.
- `apps/organizations/views.py:OrgMemberRemoveView.delete` (`:372-399`) — writes
  membership + audit with no idempotency; a double DELETE re-emits
  `member_role_revoked` (the membership flip is idempotent because it checks
  `if membership.is_active` at `:385`, but the audit duplicates).
- `apps/sadmin/services/feedback.py:triage_feedback / archive_feedback`.
- `apps/accounts/services/twofa.py` enroll/confirm/disable/regenerate.
- `apps/sadmin/services/superadmin_verbs.py` (all verbs;
  force-logout/suspend-user/etc.).

Most are *naturally* idempotent on the primary state column (e.g. `suspend_org`
early-returns if already suspended, `lifecycle.py:159-160`) so the user-visible
state doesn't corrupt, but **every one emits a duplicate AuditEvent on replay**,
polluting the append-only log that is the system of record (invariant #4/#5). Since
audit rows are physically immutable (invariant #5, `0002_audit_append_only.py`),
these duplicates can never be cleaned up. This is the broadest violation of #3:
the invariant says it "applies to *all* writes," and ~22 of ~25 verbs don't.

### Finding 10 — `KPISnapshot` upsert race (LOW)

`apps/sadmin/services/kpi.py:45` uses `KPISnapshot.objects.update_or_create(snapshot_date=...)`.
Django's `update_or_create` is itself a check-then-act (filter then save) and is not
atomic without a row lock; two concurrent snapshot runs for the same date can both
miss and one will hit the `unique` on `snapshot_date`
(`apps/sadmin/tests/factories.py:64` implies `snapshot_date` is the natural key).
Cron-only, single-runner in 1A, so low risk — but it is the same `update_or_create`
TOCTOU class as the grants writes.

---

## Cross-cutting conclusions

1. **Invariant #3 is ~12% implemented.** 3 verbs thread `event_id`; the unique
   constraint exists only on `AuditEvent.idempotency_key`; there is no global
   idempotency table; and even the 3 implemented verbs are TOCTOU-racy (Finding 1)
   and reconstruct replays non-atomically (Finding 5).
2. **Invariant #4 is effectively 0% implemented in 1A.** `emit_audit_on_commit`
   exists but is never called; no Redis publish anywhere; the one piece of
   post-write cache work (`invalidate_cache`) runs *inside* the transaction
   (Finding 6).
3. **The one concurrency-sensitive auth path that must be a single-spend
   (recovery codes) lacks a row lock** (Finding 3) while a less-sensitive one
   (`confirm_totp` device) has it — an inconsistency that signals the locking was
   applied ad hoc, not from a concurrency model.
4. **Two services lie in comments/contracts about the guarantee they provide**
   (ownership "DEFERRABLE" comment, Finding 2; grants matrix `event_id` contract,
   Finding 7), which is more dangerous than an honest gap because maintainers will
   trust the false claim.

## Recommended remediations (priority order)

1. Make `emit_audit` a true atomic get-or-create: `try INSERT / except IntegrityError -> SELECT`
   (fixes Finding 1, and de-risks Findings 4-style collisions when those add `event_id`).
2. Add `select_for_update` + conditional `UPDATE ... WHERE used_at IS NULL` to
   recovery-code consumption (Finding 3).
3. Either ship the deferrable RunSQL migration for `one_owner_per_org` and fix the
   comment, or delete the false comment and document the clear-then-set ordering as
   the load-bearing invariant (Finding 2).
4. Move all post-write cache invalidation / future Redis publishes into
   `transaction.on_commit` (Finding 6; satisfies invariant #4).
5. Introduce a real cross-cutting idempotency mechanism (a dedicated
   `IdempotencyKey` table or a decorator) so every mutation verb — not 3 of them —
   honors invariant #3, and replays return the prior row as 200 (Findings 7, 8, 9).
6. Catch `IntegrityError` -> re-fetch in the signup duplicate-email path (Finding 4).
