"""Fill the new crest columns from the submissions that already carry a logo.

Every school that has already registered its teams uploaded its badge into the
form response; the columns added in 0014 would otherwise start empty and only
fill on a resubmission nobody is going to make mid-tournament. So the crest is
read back out of the stored answers here, with the same bindings the mapper
uses — top-level key first (the crest is the school's since 2026-08-17), then
the per-team-row key that older generated forms asked for.

Deliberately forgiving: a response whose bindings are missing, whose answers are
shaped oddly, or whose ref is not a UUID is skipped. A crest is decoration, and
no draw may fail to migrate over one.
"""
from __future__ import annotations

import uuid as _uuid

from django.db import migrations


def _one_ref(value):
    ref = value[0] if isinstance(value, list) and value else value
    if not isinstance(ref, str):
        return None
    try:
        return _uuid.UUID(ref)
    except (ValueError, AttributeError):
        return None


def backfill(apps, schema_editor):
    Form = apps.get_model("forms", "Form")
    FormResponse = apps.get_model("forms", "FormResponse")
    Institution = apps.get_model("teams", "Institution")
    Team = apps.get_model("teams", "Team")

    inst_logos: dict = {}
    team_logos: dict = {}

    for form in Form.objects.filter(purpose="team_registration"):
        b = (form.settings or {}).get("bindings") or {}
        groups = b.get("category_groups") or []
        if not groups:
            continue
        iid_key = b.get("institution_id", "institution_id")
        # Oldest first, so a school's most recent submission wins.
        for resp in FormResponse.objects.filter(
            form_id=form.id, deleted_at__isnull=True
        ).order_by("created_at"):
            a = resp.answers or {}
            iid = a.get(iid_key)
            for cg in groups:
                logo_key = cg.get("team_logo")
                if not logo_key:
                    continue
                top = _one_ref(a.get(logo_key))
                if top and iid:
                    inst_logos[str(iid)] = top
                tname_key = cg.get("team_name")
                rows = a.get(cg.get("group")) or []
                if not isinstance(rows, list):
                    continue
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    ref = _one_ref(row.get(logo_key))
                    name = str(row.get(tname_key) or "").strip()
                    if ref and name:
                        key = (
                            str(resp.tournament_id),
                            cg.get("leaf_key") or cg.get("category") or "",
                            name,
                        )
                        team_logos[key] = ref

    for iid, ref in inst_logos.items():
        Institution.objects.filter(id=iid).update(logo_ref=ref)

    if team_logos:
        for tm in Team.objects.filter(deleted_at__isnull=True).only(
            "id", "tournament_id", "leaf_key", "name"
        ):
            ref = team_logos.get(
                (str(tm.tournament_id), tm.leaf_key or "", tm.name)
            )
            if ref:
                Team.objects.filter(id=tm.id).update(logo_ref=ref)


def unbackfill(apps, schema_editor):
    """Reversible: the columns go back to empty, and the crests still live in
    the submissions this read them from."""
    apps.get_model("teams", "Institution").objects.update(logo_ref=None)
    apps.get_model("teams", "Team").objects.update(logo_ref=None)


class Migration(migrations.Migration):

    dependencies = [("teams", "0014_institution_logo_ref_team_logo_ref")]

    operations = [migrations.RunPython(backfill, unbackfill)]
