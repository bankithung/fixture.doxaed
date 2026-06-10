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


def _find_categories_fields(org_form: Form | None) -> list[dict]:
    """The org-reg choice field(s) whose options become the per-category
    sections. Honors the generator's settings tag first (the per-sport
    category fields), then falls back to the first multi_choice for hand-built
    forms — explicitly skipping the sport-selector field, which is a sport
    list, not a category list (spec 2026-06-10 B2)."""
    if org_form is None:
        return []
    schema = org_form.schema or {}
    settings = org_form.settings or {}
    by_key: dict[str, dict] = {}
    for sec in schema.get("sections", []):
        for f in sec.get("fields", []):
            if f.get("key"):
                by_key[f["key"]] = f
    tagged = [
        by_key[k]
        for k in (settings.get("category_fields") or {}).values()
        if k in by_key and by_key[k].get("options")
    ]
    if tagged:
        return tagged
    sports_key = settings.get("sports_field") or "sports"
    choice = [
        f
        for f in by_key.values()
        if f.get("type") in CHOICE_TYPES and f.get("options")
        and f.get("key") != sports_key
    ]
    for f in choice:
        if f.get("type") == "multi_choice":
            return [f]
    return [choice[0]] if choice else []


def _leaf_options(tournament) -> list[tuple[str, str, dict]]:
    """(value, label, extra) category options straight from the tournament's
    sports config: value = stable leaf key, label = 'Sport — path', extra
    carries the structural binding for mapping."""
    from apps.tournaments.services.sports import iter_leaves

    out: list[tuple[str, str, dict]] = []
    for leaf in iter_leaves(getattr(tournament, "sports", None) or []):
        label = (
            f"{leaf['sport_name']} — {leaf['label']}" if leaf["path"]
            else leaf["sport_name"]
        )
        out.append((
            leaf["leaf_key"], label,
            {"sport_key": leaf["sport_key"], "leaf_key": leaf["leaf_key"],
             "label": label},
        ))
    return out


def build_team_form_schema(
    org_form: Form | None, tournament=None
) -> tuple[dict, dict]:
    """Return (schema, bindings) for the generated team-registration form.

    Category sections come from the tournament's sports config when it exists
    (one section per category LEAF — the structural source of truth), else from
    the org form's category field(s) (hand-built Stage-1 forms)."""
    cat_opts: list[tuple[str, str, dict]] = []
    if tournament is not None and getattr(tournament, "sports", None):
        cat_opts = _leaf_options(tournament)
    if not cat_opts:
        for cat_field in _find_categories_fields(org_form):
            for o in cat_field.get("options", []) or []:
                v = str(_opt_value(o))
                # Values minted by the institution-form generator ARE leaf
                # keys (sport-prefixed); carry the structure through.
                cat_opts.append((
                    v, str(_opt_label(o)),
                    {"sport_key": v.split(".", 1)[0] if "." in v else "",
                     "leaf_key": v, "label": str(_opt_label(o))},
                ))

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
                            "options": [
                                {"value": v, "label": lbl}
                                for v, lbl, _x in cat_opts
                            ],
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
    for v, lbl, extra in cat_opts:
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
            # Structural binding (spec 2026-06-10): mapping stamps these onto
            # the created Team rows so fixtures scope per leaf, not by string.
            "sport_key": extra.get("sport_key", ""),
            "leaf_key": extra.get("leaf_key", v),
            "label": extra.get("label", lbl),
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
    schema, bindings = build_team_form_schema(org_form, tournament=tournament)
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


def build_institution_form_schema(sports: list[dict]) -> tuple[dict, dict]:
    """Guided institution-registration form from the tournament's chosen sports:
    school details, a sport-selection question, per-sport category questions that
    reveal inline when that sport is picked, and a confirmation note. Fully
    editable afterwards — driven entirely by the sports config, nothing hardcoded.

    Category options walk the recursive node tree down to its LEAVES; option
    values are stable leaf keys ('football.u15.girls'), so renames never orphan
    answers, and downstream mapping/fixtures get a structural reference instead
    of a display-string slug.

    Returns (schema, category_fields) where category_fields maps sport_key →
    the form field key carrying that sport's category selection (stored in
    Form.settings so team-form derivation and response mapping never guess by
    field position again — spec 2026-06-10 B2/B4).
    """
    from apps.tournaments.services.sports import iter_leaves

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
    category_fields: dict[str, str] = {}
    if active:
        fields: list[dict] = [
            {"key": "sports", "type": "multi_choice", "required": True,
             "label": "Which sport(s) will your school participate in?",
             "options": [{"value": s["key"], "label": s["name"]} for s in active]},
        ]
        for s in active:
            # All category leaves of this sport (recursive tree → flat leaf
            # list). A sport with no categories has only its sport-level leaf:
            # ticking the sport IS the registration, so no extra field.
            leaves = [lf for lf in iter_leaves([s]) if lf["path"]]
            if leaves:
                fkey = f"categories_{s['key']}"[:60]
                category_fields[s["key"]] = fkey
                fields.append({
                    "key": fkey,
                    "type": "multi_choice",
                    "label": f"{s['name']} categories",
                    # Revealed inline only when this sport is selected above.
                    "visibility": {"field": "sports", "op": "includes",
                                   "value": s["key"]},
                    "options": [
                        {"value": lf["leaf_key"], "label": lf["label"]}
                        for lf in leaves
                    ],
                })
        sections.append({"key": "participation", "title": "Competition selection",
                         "fields": fields})
    sections.append({"key": "confirm", "title": "Final confirmation", "fields": [
        {"key": "confirm_note", "type": "section_text",
         "label": "Player names and documents must be submitted by the deadline."},
    ]})
    return {"version": 1, "sections": sections}, category_fields


def generate_institution_form(*, tournament, created_by=None, request=None) -> Form:
    """Create a DRAFT institution-registration form from the tournament's sports,
    for the admin to review/edit/publish."""
    schema, category_fields = build_institution_form_schema(tournament.sports or [])
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
        # Structural tags consumed by team-form derivation and response
        # mapping (no more guessing fields by position/type).
        "sports_field": "sports",
        "category_fields": category_fields,
    }
    form.save(update_fields=["settings"])
    return form
