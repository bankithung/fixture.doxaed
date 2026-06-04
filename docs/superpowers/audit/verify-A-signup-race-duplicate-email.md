# Adversarial Verify A — signup duplicate-email race condition

## Finding under test
- severity: high
- area: signup
- file: backend/apps/accounts/services/signup.py
- line: 242
- title: Race condition: duplicate-email guard and user creation are not in the same atomic block

## Verdict: REAL (the structural defect exists) — but severity overstated. Corrected severity: LOW.

## What the real code shows

`backend/apps/accounts/services/signup.py`:

- Line 242 (duplicate-email guard, OUTSIDE any transaction):
  ```python
  if User.objects.filter(email=email).exists():
      return SignupResult(... duplicate_email=True ...)
  ```
- Line 254 (atomic block starts):
  ```python
  with transaction.atomic():
  ```
- Line 256 (user creation, INSIDE the atomic block):
  ```python
  user = User.objects.create_user(email=email, password=password, name=name, is_active=False)
  ```

So the finding's literal claim is accurate: the `exists()` check (242) and the `create_user` (256) are not in the same atomic/locked region. It is a textbook check-then-act (TOCTOU) pattern. Two concurrent signups for the same brand-new email can both pass line 242 (neither has committed yet), then both enter the transaction and both attempt creation.

## Why severity is LOW, not HIGH

1. The DB has the real guard. `backend/apps/accounts/models.py:71`:
   ```python
   email = models.EmailField(_("email address"), unique=True)
   ```
   The unique constraint is the authoritative protection. In the racing case, the second `create_user` raises `IntegrityError` and the surrounding `transaction.atomic()` (line 254) rolls back the entire chain. There is NO possibility of two User rows with the same email, NO partial/orphaned Org or membership, and NO cross-org data integrity violation. The "duplicate-email guard" at 242 is an optimization / enumeration-safe fast-path, not the integrity boundary — invariant 2 (org isolation) and uniqueness are not at risk.

2. The only observable harm is cosmetic: in the narrow race window, the losing request gets an unhandled `IntegrityError` -> HTTP 500 instead of the enumeration-safe 201. `backend/apps/accounts/views.py:108-126` calls `perform_signup` with no `IntegrityError`/`except` wrapper, so the exception propagates. The serializer (`backend/apps/accounts/serializers.py:14-29`) has only `email = serializers.EmailField()` with no `UniqueValidator`, confirming line 242 is the sole app-level check.

3. Exploit surface is tiny. `SignupRateThrottle` is 3/hr/IP (per the view docstring, line 103). The race requires two requests for the SAME never-before-seen email to land within milliseconds of each other before either commits. This is effectively only reachable by the legitimate same-user double-click / double-submit, which is far better mitigated by the existing `event_id` idempotency replay (lines 236-239) — a real client passing `event_id` never hits the race at all. There is no attacker-controlled benefit: you cannot hijack, overwrite, or enumerate via this path; worst case is a 500 the user retries.

4. Note the same `IntegrityError`->500 also applies to the org `slug` create (lines 270-279) and is wrapped there, but email is not. The asymmetry is real but low-impact for the reasons above.

## Confidence
0.9 that the structural defect is real (directly read both lines + the model constraint + the view + the serializer). High confidence the correct severity is LOW (no data-integrity or security impact; only a rare unhandled-500 cosmetic issue, already largely covered by event_id idempotency and the DB unique constraint). A defensible alternative is to keep it open as a small robustness fix: wrap the create in `try/except IntegrityError` and convert to the `duplicate_email=True` result.
