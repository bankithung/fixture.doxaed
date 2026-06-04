"""Service layer for the organizations app.

Every state-changing verb lives here (NOT in views, NOT in signals).
Services compose audit emission inline (apps.audit.services.emit_audit)
and atomic transactions explicitly.
"""
