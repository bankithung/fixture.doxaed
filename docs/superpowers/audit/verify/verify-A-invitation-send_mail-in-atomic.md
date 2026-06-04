# Adversarial Verify A — send_mail inside transaction.atomic() in create_invitation

**Finding under test:** high / Invariant 4 (DB-first; side-effect after commit)
**File:** `backend/apps/organizations/services/invitation.py:188` (send_mail at :213)

## Verdict
- **is_real: TRUE**
- **corrected_severity: medium** (finding claimed high)
- **confidence: 0.9**

## What the real code shows (evidence)

`invitation.py` `create_invitation`:
- `188`  `with transaction.atomic():`
- `189`  `inv = AdminInvitation.objects.create(...)`  (creates the invitation row + token_hash)
- `196`  `emit_audit(...)`  (audit row, still inside the block)
- `213`  `send_mail(subject=..., message=f"...Use this token to accept: {plaintext}...", recipient_list=[email], fail_silently=True)` — STILL inside the atomic block. The plaintext one-time token is in the message body (`185 plaintext = _generate_token()`).
- `224`  `except Exception: pass` — email exceptions swallowed.

`settings/base.py:102`  `DATABASES["default"]["ATOMIC_REQUESTS"] = True` — every request runs in an OUTER transaction. The inner `with transaction.atomic()` at :188 is therefore a SAVEPOINT, not a top-level transaction.

`views.py:419-435` `OrgInvitationsView.post` calls `create_invitation(...)` then builds a Response — all inside the ATOMIC_REQUESTS outer transaction. Any error after `send_mail` (response render, middleware, signal, later view code) rolls the OUTER transaction back AFTER the email already transmitted.

`audit/services.py:80-87` `emit_audit_on_commit(**kwargs)` -> `transaction.on_commit(lambda: emit_audit(**kwargs))` — confirms the codebase already ships a commit-deferral pattern.

`settings/dev.py:24` console backend (dev); no prod override found => prod uses a real transmitting SMTP backend, so the email genuinely goes out in production.

## Why REAL
`send_mail` is synchronous and transmits at the call site (no celery/deferred backend configured). It is a non-transactional external side effect carrying a one-time acceptance token, executed before commit. With ATOMIC_REQUESTS, a post-send rollback leaves the recipient holding a token for an AdminInvitation row that no longer exists. This is exactly the "side effect before commit" class Invariant 4 forbids for Redis publishes; the correct shape is `transaction.on_commit(lambda: send_mail(...))`.

## Why downgraded to medium (adversarial nuance)
1. **No exploitable security path.** `accept_invitation` (`:230-264`) looks up by `token_hash`; if the row was rolled back, the lookup returns None -> `ValidationError("Invalid invitation token.")`. The leaked token is useless. So the impact is confusing/degraded UX + hygiene, not privilege escalation or unauthorized access.
2. **Compound failure required.** Exposure needs a SECOND failure in the request path after `send_mail` returns; the inner block has nothing after send_mail, and the send is try/except-wrapped.
3. **Finding's fix reference is slightly imprecise.** It cites `emit_audit_on_commit`. The audit row is CORRECTLY kept inside the transaction (must roll back with the data; see audit/services.py:83-86 docstring). The real fix targets `send_mail`, not the audit emit. This imprecision does not invalidate the core issue.

Real correctness/invariant-consistency defect worth fixing; bounded blast radius => medium, not high.
