# VERIFY B — invitation.py: send_mail fires inside transaction.atomic()

**Finding:** send_mail (invite token email) fires INSIDE `transaction.atomic()` in
`create_invitation` — side-effect before commit (Invariant 4 violation).
**File:** `backend/apps/organizations/services/invitation.py:188`
**Claimed severity:** high
**Verdict: REAL. Severity corrected to MEDIUM.**

## What the real code shows (cited)

`backend/apps/organizations/services/invitation.py`:
- `:188` `    with transaction.atomic():`
- `:189-195` `inv = AdminInvitation.objects.create(...)` — the invite row.
- `:196-210` `emit_audit(...)` — audit row, inline (shares atomicity).
- `:212-223` `send_mail(subject=..., message=("...Use this token to accept: " + plaintext...), recipient_list=[email], fail_silently=True)` — **STILL inside the atomic block.** The block does not close until the `return` at `:227`, which is outside.
- `:224-225` `except Exception: pass` — email failure swallowed.

The email message at `:215-219` literally embeds the one-time plaintext acceptance token (`plaintext = _generate_token()` at `:185`). So the side-effect carries a credential.

## The aggravating factor the finding nailed: ATOMIC_REQUESTS

`backend/fixture/settings/base.py:102` `DATABASES["default"]["ATOMIC_REQUESTS"] = True`.

Consequence: the DRF view already runs inside a request-level transaction. The
inner `with transaction.atomic()` at `:188` is therefore a **savepoint**, not a
top-level transaction. Its exit at `:227` releases the savepoint but does **not**
COMMIT. The real COMMIT happens only after the view returns successfully
(`OrgInvitationsView.post` `views.py:419-435`; `views.py:569-587`). So `send_mail`
fires well before the outer transaction commits — anything that raises during
response serialization or request teardown rolls the whole transaction back
(invite row + audit row gone) while the token email is already out the door.
This is precisely the failure mode Invariant 4 forbids ("publish ... *after* the
DB transaction commits / `transaction.on_commit`").

## The remediation the codebase already had

`backend/apps/audit/services.py:80-87` ships `emit_audit_on_commit(**kwargs)` =
`transaction.on_commit(lambda: emit_audit(**kwargs))`. The same `on_commit`
pattern should wrap `send_mail` here. The verb author used inline `emit_audit`
(correct for the audit row, which must share atomicity) but left the **email**
side-effect inside the block instead of deferring it with `transaction.on_commit`.
The finding's claim that "the codebase already ships emit_audit_on_commit but
this verb didn't use it" is accurate (though the fix is on_commit for the email,
not literally emit_audit_on_commit, which is for audit rows).

## Why severity → MEDIUM (not high)

The Invariant-4 violation is real and confirmed, but the blast radius is bounded:
- A dangling token (sent for a row that rolled back) is **unusable**:
  `accept_invitation` does a hash lookup at `:249`
  (`AdminInvitation.objects.filter(token_hash=token_hash).first()`) and raises
  "Invalid invitation token." when no row exists. No privilege escalation, no
  cross-org leak, no usable credential exposure.
- `fail_silently=True` + `try/except` means email problems never corrupt state.
- Real harm is operational/correctness: an invitee can receive a dead invite
  email after a late rollback, plus an unguaranteed-ordering / partial-state
  smell that violates a stated architectural invariant. Worth fixing (move
  `send_mail` into a `transaction.on_commit(...)` callback), but not a
  high-severity security/data-integrity defect.

## Confidence
High that the code matches the finding (every cited line verified, plus the
ATOMIC_REQUESTS amplifier). Medium-high on the downgraded severity rating.
