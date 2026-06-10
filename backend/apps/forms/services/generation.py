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
                # Contact carried over from Stage 1 (prefilled, editable) so a
                # school confirms rather than re-enters it. Optional: a per-
                # institution link prefills these; the public link leaves blank.
                {"key": "contact_name", "type": "short_text",
                 "label": "Contact person", "required": False},
                {"key": "contact_email", "type": "email",
                 "label": "Contact email", "required": False},
                {"key": "contact_phone", "type": "phone",
                 "label": "Contact phone", "required": False},
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
                        "label": "Team",
                        "repeatable": True,
                        "fields": [
                            {"key": tkey, "type": "short_text", "label": "Team name",
                             "required": True},
                            {"key": f"players_{slug}", "type": "group",
                             "label": "Player", "repeatable": True,
                             "fields": [
                                 {"key": f"player_name_{slug}", "type": "short_text",
                                  "label": "Player name", "required": True},
                             ]},
                        ],
                    }
                ],
            }
        )
        category_groups.append({
            "category": v, "group": gkey, "team_name": tkey,
            "players_group": f"players_{slug}", "player_name": f"player_name_{slug}",
        })

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
                        "label": "Team",
                        "repeatable": True,
                        "fields": [
                            {"key": "team_name_all", "type": "short_text",
                             "label": "Team name", "required": True},
                            {"key": "players_all", "type": "group",
                             "label": "Player", "repeatable": True,
                             "fields": [
                                 {"key": "player_name_all", "type": "short_text",
                                  "label": "Player name", "required": True},
                             ]},
                        ],
                    }
                ],
            }
        )
        category_groups.append({
            "category": "", "group": "teams_all", "team_name": "team_name_all",
            "players_group": "players_all", "player_name": "player_name_all",
        })

    schema = {"version": 1, "sections": sections}
    bindings = {
        "institution_id": "institution_id",
        "contact_name": "contact_name",
        "contact_email": "contact_email",
        "contact_phone": "contact_phone",
        "category_groups": category_groups,
    }
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


def build_institution_form_schema(sports: list[dict]) -> dict:
    """Guided institution-registration form from the tournament's chosen sports:
    school details, a sport-selection question, per-sport category questions that
    reveal inline when that sport is picked, and a confirmation note. Fully
    editable afterwards — driven entirely by the sports config, nothing hardcoded.
    """
    sections: list[dict] = [
        {"key": "school", "title": "School details", "fields": [
            {"key": "school_name", "type": "short_text", "label": "School name",
             "required": True, "role": "title"},
            {"key": "contact_name", "type": "short_text", "label": "Your name",
             "required": True, "role": "name"},
            {"key": "contact_phone", "type": "phone", "label": "Contact number",
             "required": True, "role": "phone"},
            {"key": "contact_email", "type": "email", "label": "Email",
             "role": "email"},
        ]},
    ]
    active = [s for s in (sports or []) if s.get("name") and s.get("key")]
    if active:
        fields: list[dict] = [
            {"key": "sports", "type": "multi_choice", "required": True,
             "label": "Which sport(s) will your school participate in?",
             "options": [{"value": s["key"], "label": s["name"]} for s in active]},
        ]
        for s in active:
            # Flatten category → subcategory into leaf options ("Cat — Sub").
            # The chosen leaf is the registration bucket. Legacy string
            # categories (no subcategories) become a single option.
            leaves: list[str] = []
            for c in s.get("categories") or []:
                if isinstance(c, str):
                    cname, subs = c.strip(), []
                elif isinstance(c, dict):
                    cname = str(c.get("name") or "").strip()
                    subs = [
                        str(x).strip()
                        for x in (c.get("subcategories") or [])
                        if str(x).strip()
                    ]
                else:
                    continue
                if not cname:
                    continue
                if subs:
                    leaves.extend(f"{cname} — {sub}" for sub in subs)
                else:
                    leaves.append(cname)
            if leaves:
                fields.append({
                    "key": f"categories_{s['key']}"[:60],
                    "type": "multi_choice",
                    "label": f"{s['name']} categories",
                    # Revealed inline only when this sport is selected above.
                    "visibility": {"field": "sports", "op": "includes",
                                   "value": s["key"]},
                    "options": [{"value": _slug(leaf, f"c{i}"), "label": leaf}
                                for i, leaf in enumerate(leaves)],
                })
        sections.append({"key": "participation", "title": "Competition selection",
                         "fields": fields})
    sections.append({"key": "confirm", "title": "Final confirmation", "fields": [
        {"key": "confirm_note", "type": "section_text",
         "label": "Player names and documents must be submitted by the deadline."},
    ]})
    return {"version": 1, "sections": sections}


def generate_institution_form(*, tournament, created_by=None, request=None) -> Form:
    """Create a DRAFT institution-registration form from the tournament's sports,
    for the admin to review/edit/publish."""
    schema = build_institution_form_schema(tournament.sports or [])
    form = create_form(
        tournament=tournament,
        title="Institution registration",
        purpose=FormPurpose.ORGANIZATION_REGISTRATION,
        stage="org_registration",
        schema=schema,
        created_by=created_by,
        request=request,
    )
    form.settings = {
        **(form.settings or {}),
        "bindings": {
            "institution_name": "school_name",
            "contact_name": "contact_name",
            "contact_phone": "contact_phone",
            "contact_email": "contact_email",
        },
        "generated_from_sports": True,
    }
    form.save(update_fields=["settings"])
    return form
