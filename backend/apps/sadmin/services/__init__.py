"""Service layer for the Super-admin console.

Every state-changing verb composes audit emission inline via
``apps.audit.services.emit_audit`` (NOT signals — v1Users.md B.4 lock).

Public surfaces:

* ``feedback`` — submit, triage, archive feedback rows + PII redaction.
* ``usage`` — fire-and-forget telemetry writer (``emit_usage``).
* ``kpi`` — daily rollup ``compute_kpi_snapshot`` (idempotent upsert).
* ``superadmin_verbs`` — the 13 verbs from §1.6 (approve_org, suspend_user,
  force_logout_all, impersonate_*, etc.).
"""
