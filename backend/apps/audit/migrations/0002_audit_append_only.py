"""Append-only enforcement for audit_event at the DB layer.

CLAUDE.md invariant 5 / v1Users.md: UPDATE and DELETE on audit_event are
denied at the database level — not just in application code. A migration
that tries to mutate audit rows must fail.

Implementation: a BEFORE UPDATE OR DELETE trigger that raises
insufficient_privilege. Triggers fire regardless of role (including
superuser), so this is robust even in dev where the app connects as
the Postgres `postgres` superuser. Production deployments should
ADDITIONALLY REVOKE UPDATE/DELETE on audit_event from the application
role for defense in depth — handled in deploy provisioning, not here.
"""
from django.db import migrations


FORWARD_SQL = """
CREATE OR REPLACE FUNCTION audit_event_append_only()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'audit_event is append-only (v1Users.md invariant 5). UPDATE/DELETE denied at DB level.'
        USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_event_no_update ON audit_event;
CREATE TRIGGER audit_event_no_update
    BEFORE UPDATE ON audit_event
    FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();

DROP TRIGGER IF EXISTS audit_event_no_delete ON audit_event;
CREATE TRIGGER audit_event_no_delete
    BEFORE DELETE ON audit_event
    FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
"""


REVERSE_SQL = """
DROP TRIGGER IF EXISTS audit_event_no_delete ON audit_event;
DROP TRIGGER IF EXISTS audit_event_no_update ON audit_event;
DROP FUNCTION IF EXISTS audit_event_append_only();
"""


class Migration(migrations.Migration):

    dependencies = [
        ("audit", "0001_initial"),
    ]

    operations = [
        migrations.RunSQL(sql=FORWARD_SQL, reverse_sql=REVERSE_SQL),
    ]
