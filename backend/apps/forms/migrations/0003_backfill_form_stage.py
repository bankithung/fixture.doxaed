"""Backfill Form.stage from Form.purpose for registration forms created before
stage-binding existed (forms built via the "New form" dialog stored a purpose
but a blank stage, so the stage auto-close/reopen never touched them). Driven by
the canonical purpose->stage map (kept inline so the migration is frozen).
"""
from django.db import migrations

_PURPOSE_TO_STAGE = {
    "organization_registration": "org_registration",
    "team_registration": "team_registration",
}


def backfill_stage_from_purpose(apps, schema_editor):
    Form = apps.get_model("forms", "Form")
    for purpose, stage in _PURPOSE_TO_STAGE.items():
        Form.objects.filter(stage="", purpose=purpose).update(stage=stage)


class Migration(migrations.Migration):

    dependencies = [
        ("forms", "0002_form_stage"),
    ]

    operations = [
        migrations.RunPython(backfill_stage_from_purpose, migrations.RunPython.noop),
    ]
