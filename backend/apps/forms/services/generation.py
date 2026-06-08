"""Auto-generate a team-registration form TEMPLATE from the org-registration
form's category options (spec: "based on their selected option the team form can
be automatically generated"). The admin reviews/edits/uses it.

Shape: a "Your institution" section (institution dropdown snapshotted from the
registered institutions + a "categories" multi-choice) followed by ONE conditional
section per category — visible only when that category is selected, so a school
that picked U14+U15 only sees those team-entry sections. The submission mapping
(`mapping.py::_map_team_registration`, category_groups mode) turns each category
group's rows into teams (pool = category) under the chosen institution.
"""
from __future__ import annotations

import re

from apps.forms.constants import CHOICE_TYPES, FormPurpose
from apps.forms.models import Form
from apps.forms.services.forms import create_form

_SLUG = re.compile(r"[^a-z0-9]+")


def _slug(s: str, fallback: str) -> str:
    out = _SLUG.sub("_", (s or "").strip().lower()).strip("_")
    return out[:30] or fallback


def _opt_value(o):
    return (o.get("value", o.get("label", "")) if isinstance(o, dict) else o)


def _opt_label(o):
    return (o.get("label", o.get("value", "")) if isinstance(o, dict) else o)


def _find_categories_field(schema: dict) -> dict | None:
    """The org-reg choice field whose options become the per-category sections.
    Prefers a field tagged via settings, else the first multi_choice, else any
    choice field with options."""
    choice = []
    for sec in (schema or {}).get("sections", []):
        for f in sec.get("fields", []):
            if f.get("type") in CHOICE_TYPES and f.get("options"):
                choice.append(f)
    for f in choice:
        if f.get("type") == "multi_choice":
            return f
    return choice[0] if choice else None


def build_team_form_schema(org_form: Form | None) -> tuple[dict, dict]:
    """Return (schema, bindings) for the generated team-registration form."""
    cat_field = _find_categories_field(org_form.schema) if org_form else None
    cat_opts = [
        (str(_opt_value(o)), str(_opt_label(o)))
        for o in ((cat_field or {}).get("options", []) or [])
    ]

    sections: list[dict] = [
        {
            "key": "institution",
            "title": "Your institution",
            "fields": [
                {
                    "key": "institution_id",
                    "type": "dropdown",
                    "label": "Select your institution",
                    "required": True,
                    "options": [],
                    # Live-bound: the public form fills these from the current
                    # registered institutions at fetch time (always up to date).
                    "data_source": {"type": "institution_list"},
                },
                # The categories selector only exists when the org-reg form
                # offered categories (otherwise an empty choice field is invalid).
                *(
                    [
                        {
                            "key": "categories",
                            "type": "multi_choice",
                            "label": "Which categories are you entering?",
                            "required": True,
                            "options": [{"value": v, "label": lbl} for v, lbl in cat_opts],
                        }
                    ]
                    if cat_opts
                    else []
                ),
            ],
        }
    ]

    category_groups: list[dict] = []
    used: set[str] = set()
    for v, lbl in cat_opts:
        slug = _slug(v, f"cat{len(category_groups)}")
        while slug in used:
            slug += "_x"
        used.add(slug)
        gkey, tkey = f"teams_{slug}", f"team_name_{slug}"
        sections.append(
            {
                "key": f"cat_{slug}",
                "title": f"Teams — {lbl}",
                "visibility": {"field": "categories", "op": "includes", "value": v},
                "fields": [
                    {
                        "key": gkey,
                        "type": "group",
                        "label": f"Team(s) for {lbl}",
                        "repeatable": True,
                        "fields": [
                            {"key": tkey, "type": "short_text", "label": "Team name",
                             "required": True},
                        ],
                    }
                ],
            }
        )
        category_groups.append({"category": v, "group": gkey, "team_name": tkey})

    # No categories detected → a single generic team-entry group so the form is
    # still usable; the admin can restructure it in the builder.
    if not category_groups:
        sections.append(
            {
                "key": "teams",
                "title": "Teams",
                "fields": [
                    {
                        "key": "teams_all",
                        "type": "group",
                        "label": "Team(s)",
                        "repeatable": True,
                        "fields": [
                            {"key": "team_name_all", "type": "short_text",
                             "label": "Team name", "required": True},
                        ],
                    }
                ],
            }
        )
        category_groups.append({"category": "", "group": "teams_all", "team_name": "team_name_all"})

    schema = {"version": 1, "sections": sections}
    bindings = {"institution_id": "institution_id", "category_groups": category_groups}
    return schema, bindings


def generate_team_form_template(*, tournament, created_by=None, request=None) -> Form:
    """Create a draft team-registration form from the tournament's org-reg form.
    Idempotent-ish: always creates a fresh draft the admin reviews (templates are
    cheap; the admin keeps or discards). The "select your institution" field is
    live-bound, so it reflects whoever is registered when each respondent opens it."""
    org_form = (
        Form.objects.filter(
            tournament=tournament, stage="org_registration", deleted_at__isnull=True
        ).order_by("created_at").first()
        or Form.objects.filter(
            tournament=tournament,
            purpose=FormPurpose.ORGANIZATION_REGISTRATION,
            deleted_at__isnull=True,
        ).order_by("created_at").first()
    )
    schema, bindings = build_team_form_schema(org_form)
    form = create_form(
        tournament=tournament,
        title="Team registration",
        purpose=FormPurpose.TEAM_REGISTRATION,
        stage="team_registration",
        schema=schema,
        created_by=created_by,
        request=request,
    )
    form.settings = {
        **(form.settings or {}),
        "bindings": bindings,
        "generated_from": str(org_form.id) if org_form else None,
    }
    form.save(update_fields=["settings"])
    return form
