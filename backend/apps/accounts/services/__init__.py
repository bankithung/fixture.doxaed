"""Service layer for the accounts app.

Each module groups one cohesive verb-set; see v1Users.md §2.4, §A.5.
All state-changing services emit AuditEvent rows via
``apps.audit.services.emit_audit`` (B.4 lock).
"""
