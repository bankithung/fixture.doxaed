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
from apps.tournaments.services.sports import sports_inputs_hash

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


def _category_chain(
    sport: dict, *, used: set[str], sports_field: str = "sports"
) -> tuple[list[dict], list[str], dict[str, str]]:
    """One multi_choice per BRANCH node of a sport's category tree —
    progressive disclosure to arbitrary depth (owner 2026-06-10: the old
    generator stacked every leaf flat in a single per-sport field). Each
    field's options are one node's children (values = stable path keys); its
    ``visibility`` points at the PARENT field, so picking "U19" reveals the
    U19 question, picking "Boys" reveals U19 — Boys, and so on. Plain
    schema-data on the existing visibility primitive — the admin can edit or
    rebuild the same logic in the builder (D-W2-1, nothing renderer-special).

    Required-on-visible closes partial picks: the server validates only
    visible fields, so every branch a respondent opens must be answered while
    untouched branches stay silent.

    Returns (fields, field_keys, leaf_fields) where leaf_fields maps each
    LEAF path key -> the (deepest) field key carrying it as an option — what
    per-leaf team sections gate on.
    """
    from apps.tournaments.services.sports import LEAF_SEP, sport_nodes

    skey = sport["key"]
    sname = sport.get("name") or skey
    fields: list[dict] = []
    keys: list[str] = []
    leaf_fields: dict[str, str] = {}
    nodes = sport_nodes(sport)
    if not nodes:
        return fields, keys, leaf_fields

    def mint(path_keys: list[str]) -> str:
        k = f"categories_{_slug('_'.join(path_keys), 'cat')}"[:60]
        while k in used:
            k += "_x"
        used.add(k)
        return k

    def add_field(
        children: list[dict],
        parent_field: str | None,
        parent_value: str | None,
        path_keys: list[str],
        path_names: list[str],
    ) -> None:
        fkey = mint(path_keys)
        fields.append({
            "key": fkey,
            "type": "multi_choice",
            "label": (
                f"{sname} categories" if not path_names
                else f"{sname} · {' · '.join(path_names)}"
            ),
            "required": True,
            # Presentation grouping (owner 2026-06-10: the flat run of chain
            # questions was "very confusing") — renderers draw all of one
            # sport's questions inside a single card, indented per level,
            # using the sport-less short label. Pure metadata: validation,
            # branching and the builder all keep using label/visibility.
            "group": skey,
            "group_label": sname,
            "indent": len(path_keys) - 1,
            "short_label": (
                "Categories" if not path_names else " · ".join(path_names)
            ),
            # Chain questions stay out of the public directory's filters/
            # stats — the single Competition filter covers them (W2).
            "directory": False,
            "visibility": (
                {"field": sports_field, "op": "includes", "value": skey}
                if parent_field is None
                else {"field": parent_field, "op": "includes", "value": parent_value}
            ),
            "options": [
                {"value": LEAF_SEP.join([*path_keys, c["key"]]), "label": c["name"]}
                for c in children
            ],
        })
        keys.append(fkey)
        for c in children:
            value = LEAF_SEP.join([*path_keys, c["key"]])
            kids = c.get("children") or []
            if kids:
                add_field(kids, fkey, value,
                          [*path_keys, c["key"]], [*path_names, c["name"]])
            else:
                leaf_fields[value] = fkey

    add_field(nodes, None, None, [skey], [])
    return fields, keys, leaf_fields


def _leaf_options(tournament) -> list[tuple[str, str, dict]]:
    """(value, label, extra) category options straight from the tournament's
    sports config: value = stable leaf key, label = 'Sport — path', extra
    carries the structural binding for mapping."""
    from apps.tournaments.services.sports import iter_leaves

    out: list[tuple[str, str, dict]] = []
    for leaf in iter_leaves(getattr(tournament, "sports", None) or []):
        label = (
            f"{leaf['sport_name']} · {leaf['label']}" if leaf["path"]
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
    # Progressive selector (sports config available): a sport question + one
    # question per branch level, mirroring the institution form (W2-A). Each
    # leaf section then gates on the DEEPEST field carrying that leaf.
    chain_fields: list[dict] = []
    leaf_gate: dict[str, dict] = {}
    if tournament is not None and getattr(tournament, "sports", None):
        cat_opts = _leaf_options(tournament)
        active = [s for s in tournament.sports
                  if s.get("name") and s.get("key")]
        if active:
            used: set[str] = set()
            chain_fields.append({
                "key": "sports", "type": "multi_choice", "required": True,
                "label": "Which sport(s) are you entering teams for?",
                "options": [{"value": s["key"], "label": s["name"]}
                            for s in active],
            })
            for s in active:
                cfields, _ckeys, leaf_fields = _category_chain(s, used=used)
                chain_fields.extend(cfields)
                for lk, fk in leaf_fields.items():
                    leaf_gate[lk] = {"field": fk, "op": "includes", "value": lk}
                if not leaf_fields:
                    # Sport-level leaf: ticking the sport IS the selection.
                    leaf_gate[s["key"]] = {
                        "field": "sports", "op": "includes", "value": s["key"],
                    }
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

    # Within-school (spec 2026-08-16 §D6): the competitor is a HOUSE, and there
    # is no Stage-1 form — this one IS the registration. Same generator, same
    # traversal engine, same regeneration contract; only the competitor question
    # and the person fields differ, because "School" and "Region" are
    # meaningless inside one school.
    intra = bool(
        tournament is not None
        and getattr(tournament, "scope", "") == "intra_school"
    )
    # Participants-first (spec 2026-08-17): the school already declared every
    # student and teacher, so this form PICKS from that list instead of asking
    # for the same names, classes and dates of birth a second time. The options
    # are deliberately empty in the schema — a roll of children is PII and is
    # served only to a caller that has proved it is this school.
    roster = bool(
        tournament is not None
        and getattr(tournament, "roster_mode", "") == "roster_first"
    )
    noun = (getattr(tournament, "group_kind", "") or "house") if intra else ""
    noun_label = {
        "house": "house", "class": "class", "form": "form",
        "department": "department",
    }.get(noun, "house")

    competitor_field = (
        {
            "key": "house_id",
            "type": "dropdown",
            "label": f"Which {noun_label} are you registering for?",
            "required": True,
            "options": [],
            # Live-bound, exactly like institution_list: the public form fills
            # these from the houses entered in this event at fetch time.
            "data_source": {"type": "house_list"},
        }
        if intra
        else {
            "key": "institution_id",
            "type": "dropdown",
            "label": "Select your institution",
            "required": True,
            "options": [],
            # Live-bound: the public form fills these from the current
            # registered institutions at fetch time (always up to date).
            "data_source": {"type": "institution_list"},
        }
    )

    sections: list[dict] = [
        {
            "key": "institution",
            "title": f"Your {noun_label}" if intra else "Your institution",
            "fields": [
                competitor_field,
                # Contact carried over from Stage 1 (prefilled, editable) so a
                # school confirms rather than re-enters it. Optional: a per-
                # institution link prefills these; the public link leaves blank.
                {"key": "contact_name", "type": "short_text",
                 "label": "Contact person", "required": False},
                {"key": "contact_email", "type": "email",
                 "label": "Contact email", "required": False},
                {"key": "contact_phone", "type": "phone",
                 "label": "Contact phone", "required": False},
                # Competition selector: the progressive sport→category chain
                # when the sports config drove generation (W2-A); else the
                # flat categories multi-choice (hand-built Stage-1 forms).
                *(
                    chain_fields
                    if chain_fields
                    else [
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

    # THE PARTICIPANTS SHEET, INSIDE THIS FORM (owner 2026-08-17).
    #
    # Participants-first used to mean a SECOND form: a separate sheet an
    # organizer had to publish, each school code-verified again, before the
    # pickers here had anything in them. In practice that left a team form whose
    # every dropdown was empty and no way to fill it from where you were
    # standing. The school now declares its people in step one of THIS form and
    # picks them in the steps that follow — one visit, one gate, one submission.
    #
    # Each row carries a generated ``row_key`` id. The pickers store that id
    # rather than the typed name, which is the whole point: two children with
    # the same name stay two children, and the mapper can tell which one a team
    # meant. Names are still what a human reads, so the id never surfaces.
    participants_section: list[dict] = []
    if roster:
        participants_section = [{
            "key": "participants",
            "title": "Your participants",
            "description": (
                "Enter everyone taking part for your institution, once. "
                "The teams you enter next pick from this list."
            ),
            "fields": [
                {
                    "key": "participant_students",
                    "type": "group",
                    "label": "Student",
                    "repeatable": True,
                    "row_key": "participant_id",
                    "help": (
                        "Every student who will play in any competition. "
                        "Enter each one once, even if they play in several."
                    ),
                    "fields": [
                        {"key": "participant_id", "type": "hidden", "label": ""},
                        {"key": "participant_name", "type": "short_text",
                         "label": "Full name", "required": True},
                        {"key": "participant_class", "type": "short_text",
                         "label": "Class & section", "required": False},
                        {"key": "participant_roll", "type": "short_text",
                         "label": "Roll number", "required": False,
                         "help": "Used to tell two same-named students apart."},
                        {"key": "participant_dob", "type": "date",
                         "label": "Date of birth", "required": False},
                        {"key": "participant_gender", "type": "dropdown",
                         "label": "Gender", "required": False,
                         "options": [
                             {"value": "male", "label": "Male"},
                             {"value": "female", "label": "Female"},
                             {"value": "other", "label": "Other"},
                         ]},
                    ],
                },
                {
                    "key": "participant_staff",
                    "type": "group",
                    "label": "Teacher in charge",
                    "repeatable": True,
                    "row_key": "staff_id",
                    "help": (
                        "The teachers travelling with your teams. A teacher "
                        "cannot be in two places at once, so the draw keeps "
                        "their matches apart."
                    ),
                    "fields": [
                        {"key": "staff_id", "type": "hidden", "label": ""},
                        {"key": "staff_full_name", "type": "short_text",
                         "label": "Full name", "required": True},
                        {"key": "staff_phone", "type": "phone",
                         "label": "Phone", "required": False},
                    ],
                },
            ],
        }]
        sections.extend(participants_section)

    category_groups: list[dict] = []
    used_slugs: set[str] = set()
    for v, lbl, extra in cat_opts:
        slug = _slug(v, f"cat{len(category_groups)}")
        while slug in used_slugs:
            slug += "_x"
        used_slugs.add(slug)
        gkey, tkey = f"teams_{slug}", f"team_name_{slug}"

        # Roster bounds from the category's format node (W2-B): a 1v1 leaf
        # starts at exactly 1 player; the admin widens max_items in the
        # builder to allow substitutes. No format → unbounded, as before.
        players: dict = {
            "key": f"players_{slug}", "type": "group",
            "label": "Player", "repeatable": True,
            "fields": [
                *([
                    {"key": f"player_member_{slug}", "type": "dropdown",
                     "label": "Student", "required": True, "options": [],
                     # Bound to the sheet at the top of THIS form, so the list
                     # is whatever the school just typed — no second form, no
                     # second code, nothing to publish first.
                     "data_source": {
                         "type": "form_group",
                         "group": "participant_students",
                         "value_field": "participant_id",
                         "label_field": "participant_name",
                         "hint_field": "participant_class",
                     },
                     "help": "Pick from the participants you entered in step 1."},
                    {"key": f"player_jersey_{slug}", "type": "number",
                     "label": "Jersey number", "required": False},
                ] if roster else []),
                # Typed identity — only when nobody was declared up front.
                # Asking a school to re-enter a name, class and date of birth
                # it has already given is how the two lists drift apart.
                *([] if roster else [
                    {"key": f"player_name_{slug}", "type": "short_text",
                     "label": "Student name" if intra else "Player name",
                     "required": True},
                    # School-internal identity. A within-school form asks the
                    # things a school actually knows a child by; asking for
                    # their "school" and "region" inside one school is noise.
                    *([
                        {"key": f"player_class_{slug}", "type": "short_text",
                         "label": "Class & section", "required": True,
                         "help": "e.g. 9-B"},
                        {"key": f"player_roll_{slug}", "type": "short_text",
                         "label": "Roll number", "required": False},
                    ] if intra else []),
                    {"key": f"player_dob_{slug}", "type": "date",
                     "label": "Date of birth", "required": True},
                    {"key": f"player_docs_{slug}", "type": "file_upload",
                     "label": "Documents (ID / certificate)", "required": False,
                     "multiple": True,
                     "help": "Optional — upload one or more. Images are "
                             "compressed automatically."},
                ]),
            ],
        }
        if tournament is not None and getattr(tournament, "sports", None):
            from apps.tournaments.services.sports import leaf_roster_rules

            rules = leaf_roster_rules(tournament.sports, v)
            if rules.get("squad_min"):
                players["min_items"] = rules["squad_min"]
            if rules.get("squad_max"):
                players["max_items"] = rules["squad_max"]
            pps = rules.get("players_per_side")
            if pps:
                lo, hi = rules.get("squad_min"), rules.get("squad_max")
                players["help"] = (
                    f"{pps} on the field; squad of {lo}" if lo == hi
                    else f"{pps} on the field; squad of {lo}-{hi}" if lo and hi
                    else f"{pps} players per side"
                )

        # Age rule (W2: age groups carry numbers) — shown to respondents so
        # the eligibility expectation is explicit on the form itself.
        age_line = ""
        if tournament is not None and getattr(tournament, "sports", None):
            from apps.tournaments.services.sports import (
                age_rule_label,
                leaf_age_rule,
            )

            age_line = age_rule_label(leaf_age_rule(tournament.sports, v))

        sections.append(
            {
                "key": f"cat_{slug}",
                "title": f"Teams — {lbl}",
                **(
                    {"description": f"Age limit: {age_line}."}
                    if age_line
                    else {}
                ),
                "visibility": leaf_gate.get(
                    v, {"field": "categories", "op": "includes", "value": v}
                ),
                "fields": [
                    {
                        "key": gkey,
                        "type": "group",
                        "label": "Team",
                        "repeatable": True,
                        "fields": [
                            {"key": tkey, "type": "short_text", "label": "Team name",
                             "required": False,
                             "help": "Leave blank to use your institution's name."},
                            {"key": f"team_logo_{slug}", "type": "file_upload",
                             "label": "Team logo", "required": False,
                             "accept": "image/*",
                             "help": "Optional — upload an image; it's compressed automatically."},
                            # The teacher in charge: PICKED once the school has
                            # declared its staff, because the draw keys its
                            # keep-apart rule on that exact person. Typed
                            # otherwise, exactly as before.
                            ({"key": f"staff_{slug}", "type": "group",
                              "label": "Teacher in charge", "repeatable": True,
                              "fields": [
                                  {"key": f"staff_member_{slug}",
                                   "type": "dropdown", "label": "Teacher",
                                   "required": True, "options": [],
                                   "data_source": {
                                       "type": "form_group",
                                       "group": "participant_staff",
                                       "value_field": "staff_id",
                                       "label_field": "staff_full_name",
                                   },
                                   "help": "One teacher cannot be in two "
                                           "places at once — the draw keeps "
                                           "their matches apart."},
                                  {"key": f"staff_role_{slug}",
                                   "type": "short_text", "label": "Role",
                                   "required": False,
                                   "help": "Optional — e.g. coach, escort."},
                              ]}
                             if roster else
                             {"key": f"coaches_{slug}", "type": "group",
                              "label": "Coach", "repeatable": True, "fields": [
                                  {"key": f"coach_name_{slug}", "type": "short_text",
                                   "label": "Coach name", "required": True},
                                  {"key": f"coach_docs_{slug}", "type": "file_upload",
                                   "label": "Coach documents", "required": False,
                                   "multiple": True,
                                   "help": "Optional — upload one or more."},
                              ]}),
                            players,
                        ],
                    }
                ],
            }
        )
        category_groups.append({
            "category": v, "group": gkey, "team_name": tkey,
            "players_group": f"players_{slug}", "player_name": f"player_name_{slug}",
            # Extra collected fields (mapping reads player_dob; the rest are
            # captured on the response + uploads for the admin to review).
            "player_dob": f"player_dob_{slug}",
            "player_docs": f"player_docs_{slug}",
            "team_logo": f"team_logo_{slug}",
            "coaches_group": f"coaches_{slug}",
            "coach_name": f"coach_name_{slug}",
            "coach_docs": f"coach_docs_{slug}",
            # Participants-first pointers (spec 2026-08-17). Present only on a
            # form generated for a tournament that declares people first; the
            # mapper reads a picked member id where it finds one and falls back
            # to the typed name otherwise, so BOTH shapes keep working.
            **({
                "player_member": f"player_member_{slug}",
                "player_jersey": f"player_jersey_{slug}",
                "staff_group": f"staff_{slug}",
                "staff_member": f"staff_member_{slug}",
                "staff_role": f"staff_role_{slug}",
            } if roster else {}),
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
                             "label": "Team name", "required": False,
                             "help": "Leave blank to use your institution's name."},
                            {"key": "team_logo_all", "type": "file_upload",
                             "label": "Team logo", "required": False,
                             "accept": "image/*",
                             "help": "Optional — upload an image; it's compressed automatically."},
                            {"key": "coaches_all", "type": "group", "label": "Coach",
                             "repeatable": True, "fields": [
                                 {"key": "coach_name_all", "type": "short_text",
                                  "label": "Coach name", "required": True},
                                 {"key": "coach_docs_all", "type": "file_upload",
                                  "label": "Coach documents", "required": False,
                                  "multiple": True, "help": "Optional — upload one or more."},
                             ]},
                            {"key": "players_all", "type": "group",
                             "label": "Player", "repeatable": True,
                             "fields": [
                                 {"key": "player_name_all", "type": "short_text",
                                  "label": "Player name", "required": True},
                                 {"key": "player_dob_all", "type": "date",
                                  "label": "Date of birth", "required": True},
                                 {"key": "player_docs_all", "type": "file_upload",
                                  "label": "Documents (ID / certificate)",
                                  "required": False, "multiple": True,
                                  "help": "Optional — upload one or more."},
                             ]},
                        ],
                    }
                ],
            }
        )
        category_groups.append({
            "category": "", "group": "teams_all", "team_name": "team_name_all",
            "players_group": "players_all", "player_name": "player_name_all",
            "player_dob": "player_dob_all", "player_docs": "player_docs_all",
            "team_logo": "team_logo_all", "coaches_group": "coaches_all",
            "coach_name": "coach_name_all", "coach_docs": "coach_docs_all",
        })

    schema = {"version": 1, "sections": sections}
    bindings = {
        # Competitor-agnostic pointers (spec 2026-08-16): every consumer that
        # used to read `institution_id` blindly can now ask what KIND of
        # competitor this form registers, and which answer key carries it.
        "competitor_kind": "house" if intra else "institution",
        "competitor_id": "house_id" if intra else "institution_id",
        "institution_id": "institution_id",
        "contact_name": "contact_name",
        "contact_email": "contact_email",
        "contact_phone": "contact_phone",
        "category_groups": category_groups,
        # The in-form participants sheet (owner 2026-08-17). Present only when
        # the tournament declares people first; the mapper creates these rows
        # BEFORE the teams, then resolves each pick against them by row id.
        **({
            "participants": {
                "students_group": "participant_students",
                "student_id": "participant_id",
                "student_name": "participant_name",
                "student_class": "participant_class",
                "student_roll": "participant_roll",
                "student_dob": "participant_dob",
                "student_gender": "participant_gender",
                "staff_group": "participant_staff",
                "staff_id": "staff_id",
                "staff_name": "staff_full_name",
                "staff_phone": "staff_phone",
            },
        } if roster else {}),
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
        "inputs_hash": sports_inputs_hash(tournament.sports),
    }
    form.save(update_fields=["settings"])
    return form


def build_institution_form_schema(sports: list[dict]) -> tuple[dict, dict]:
    """Guided institution-registration form from the tournament's chosen sports:
    school details, a sport-selection question, then a PROGRESSIVE chain of
    category questions — one per branch level — that reveal as the respondent
    drills in (sport → U19 → Boys → 5v5), and a confirmation note. Fully
    editable afterwards — driven entirely by the sports config + the standard
    visibility primitive, nothing hardcoded.

    Option values are stable path keys ('football.u15.girls'), so renames
    never orphan answers, and downstream mapping/fixtures get a structural
    reference instead of a display-string slug.

    Returns (schema, meta) where meta carries the structural tags stored in
    Form.settings so team-form derivation and response mapping never guess by
    field position (spec 2026-06-10 B2/B4 + Wave 2 W2-A):
      - category_fields:     sport_key → TOP category field key (back-compat)
      - category_fields_all: sport_key → [every category field key, walk order]
      - leaf_values:         snapshot of all leaf keys (mapping keeps only
                             selected values that are real competitions;
                             branch-level picks are navigation, not entries)
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
    category_fields_all: dict[str, list[str]] = {}
    if active:
        used: set[str] = set()
        from apps.tournaments.services.sports import sport_nodes

        # Sports WITH categories ask follow-up questions; ones without are a
        # single open competition — say so on the form, or ticking a
        # category-less sport looks like "nothing happened" (owner 2026-06-10).
        no_cat = [s["name"] for s in active if not sport_nodes(s)]
        fields: list[dict] = [
            # directory:False — the public directory's Competitions tree
            # already groups by sport; a separate sports filter/column/stat
            # duplicated it (owner 2026-06-10).
            {"key": "sports", "type": "multi_choice", "required": True,
             "directory": False,
             "label": "Which sport(s) will your school participate in?",
             **(
                 {"help": (
                     "Sports with categories will ask follow-up questions. "
                     + ", ".join(no_cat)
                     + (" has" if len(no_cat) == 1 else " have")
                     + " no categories — ticking it is your full entry."
                 )}
                 if no_cat
                 else {}
             ),
             "options": [{"value": s["key"], "label": s["name"]} for s in active]},
        ]
        for s in active:
            # A sport with no categories has only its sport-level leaf:
            # ticking the sport IS the registration, so no extra fields.
            cfields, ckeys, _leaf_fields = _category_chain(s, used=used)
            if ckeys:
                category_fields[s["key"]] = ckeys[0]
                category_fields_all[s["key"]] = ckeys
                fields.extend(cfields)
        sections.append({"key": "participation", "title": "Competition selection",
                         "fields": fields})
    sections.append({"key": "confirm", "title": "Final confirmation", "fields": [
        {"key": "confirm_note", "type": "section_text",
         "label": "Player names and documents must be submitted by the deadline."},
    ]})
    meta = {
        "category_fields": category_fields,
        "category_fields_all": category_fields_all,
        "leaf_values": [lf["leaf_key"] for lf in iter_leaves(active)],
    }
    return {"version": 1, "sections": sections}, meta


def reconcile_institution_form_schema(
    existing_schema: dict | None,
    sports: list[dict],
    existing_settings: dict | None,
) -> tuple[dict, dict]:
    """Smart rebuild (invariant 10 done as a MERGE, not a replace): apply only
    the structural deltas from the current sports config onto the admin's
    EXISTING institution form, instead of overwriting it with a fresh default.

    Generated competition questions carry STABLE keys (minted from node keys, not
    display names) and stable option values (path keys), so we reconcile by key:
      * a retained competition question keeps the admin's label/help/required/
        order/group, but has its OPTIONS + branching refreshed (renamed leaves,
        added/removed options, retargeted visibility);
      * a question whose competition was deleted is dropped;
      * a brand-new competition's question is inserted next to its sport group
        (kept contiguous so the renderer's per-sport card stays intact).
    Custom fields the admin added, label edits, reordering, the school/confirm
    sections and any extra sections are all preserved.

    Falls back to a clean build when there's nothing to merge onto (no existing
    schema). Returns (schema, meta) exactly like ``build_institution_form_schema``.
    """
    fresh_schema, meta = build_institution_form_schema(sports)
    if not existing_schema or not existing_schema.get("sections"):
        return fresh_schema, meta

    fresh_by_key: dict[str, dict] = {}
    fresh_order: list[str] = []
    for sec in fresh_schema["sections"]:
        for f in sec["fields"]:
            fresh_by_key[f["key"]] = f
            fresh_order.append(f["key"])

    # Keys the generator OWNS in the fresh build: the sports question + every
    # category-chain field.
    fresh_gen: set[str] = {"sports"}
    for keys in meta["category_fields_all"].values():
        fresh_gen.update(keys)

    # Keys the CURRENT form was generated with (from its stored tags) — lets us
    # tell an old generated question apart from an admin-added custom field.
    es = existing_settings or {}
    managed: set[str] = set(fresh_gen)
    managed.add(es.get("sports_field") or "sports")
    for keys in (es.get("category_fields_all") or {}).values():
        managed.update(keys)
    managed.update((es.get("category_fields") or {}).values())

    # On a retained question, refresh ONLY the data-bearing parts — keep every
    # presentation/label edit the admin made.
    refresh = ("options", "visibility")
    seen: set[str] = set()
    new_sections: list[dict] = []
    for sec in existing_schema.get("sections", []):
        out_fields: list[dict] = []
        for f in sec.get("fields", []):
            k = f.get("key")
            if k in managed:
                fresh = fresh_by_key.get(k)
                if fresh is None:
                    continue  # its competition was removed → drop the question
                merged = dict(f)
                for attr in refresh:
                    if attr in fresh:
                        merged[attr] = fresh[attr]
                    else:
                        merged.pop(attr, None)
                out_fields.append(merged)
                seen.add(k)
            else:
                out_fields.append(f)  # custom field → untouched
        new_sections.append({**sec, "fields": out_fields})

    # Questions for NEW competitions, in fresh walk order.
    to_add = [
        fresh_by_key[k]
        for k in fresh_order
        if k in fresh_gen and k != "sports" and k not in seen
    ]
    sports_missing = "sports" in fresh_by_key and "sports" not in seen
    if to_add or sports_missing:
        part = next(
            (s for s in new_sections if s.get("key") == "participation"), None
        )
        if part is None:
            part = {
                "key": "participation",
                "title": "Competition selection",
                "fields": [],
            }
            idx = next(
                (i for i, s in enumerate(new_sections) if s.get("key") == "confirm"),
                len(new_sections),
            )
            new_sections.insert(idx, part)
        if sports_missing:
            part["fields"].insert(0, fresh_by_key["sports"])
        for f in to_add:
            grp = f.get("group")
            pos = None
            for i, ef in enumerate(part["fields"]):
                if grp is not None and ef.get("group") == grp:
                    pos = i  # keep last → block stays contiguous
            if pos is None:
                part["fields"].append(f)
            else:
                part["fields"].insert(pos + 1, f)

    return {"version": existing_schema.get("version", 1), "sections": new_sections}, meta


# --------------------------------------------------------------- participants
#: The competitor-facing questions asked about each KIND of participant, as
#: plain schema data. Every entry is editable in the builder afterwards — the
#: generator seeds a sensible sheet, it does not own it (owner 2026-08-17: "no
#: hard-coded rules … let the user decide based on their requirements").
#: ``bind`` names the RosterMember column an answer lands in; a question with
#: no ``bind`` is kept in ``attributes``, so an admin can add anything the
#: event needs without a schema change.
def _participant_fields(kind: str, *, intra: bool) -> list[dict]:
    if kind == "teacher":
        return [
            {"key": "teacher_name", "type": "short_text", "required": True,
             "label": "Teacher name", "bind": "full_name"},
            {"key": "teacher_designation", "type": "short_text", "required": False,
             "label": "Designation"},
            {"key": "teacher_phone", "type": "phone", "required": True,
             "label": "Mobile number", "bind": "contact_phone",
             "help": "The organizer calls this number on the day."},
            {"key": "teacher_email", "type": "email", "required": False,
             "label": "Email", "bind": "contact_email"},
            {"key": "teacher_docs", "type": "file_upload", "required": False,
             "multiple": True, "label": "ID / authorization letter",
             "help": "Optional — upload one or more."},
        ]
    return [
        {"key": "student_name", "type": "short_text", "required": True,
         "label": "Student name", "bind": "full_name"},
        {"key": "student_class", "type": "short_text", "required": True,
         "label": "Class & section", "bind": "class_section", "help": "e.g. 9-B"},
        {"key": "student_roll", "type": "short_text", "required": False,
         "label": "Roll number", "bind": "roll_no",
         "help": "Your school's own number — it keeps a re-submitted list from "
                 "duplicating this student."},
        {"key": "student_gender", "type": "single_choice", "required": False,
         "label": "Gender", "bind": "gender",
         "options": [{"value": "male", "label": "Male"},
                     {"value": "female", "label": "Female"},
                     {"value": "other", "label": "Other"}]},
        {"key": "student_dob", "type": "date", "required": True,
         "label": "Date of birth", "bind": "date_of_birth"},
        *([] if intra else [
            {"key": "student_phone", "type": "phone", "required": False,
             "label": "Contact number", "bind": "contact_phone"},
        ]),
        {"key": "student_docs", "type": "file_upload", "required": False,
         "multiple": True, "label": "Documents (ID / birth certificate)",
         "help": "Optional — upload one or more. Images are compressed automatically."},
    ]


def build_participants_form_schema(tournament) -> tuple[dict, dict]:
    """(schema, bindings) for the participants form (spec 2026-08-17).

    ONE sheet per school: every student, and every teacher travelling with
    them. No competition questions at all — who is entering which event is the
    team form's job, and asking it here would make the school answer twice.

    The two repeatable groups are ordinary schema groups on the existing
    engine, so the admin can add, remove or reorder questions in the builder
    exactly as with any other form.
    """
    intra = getattr(tournament, "scope", "") == "intra_school"
    noun_label = {
        "house": "house", "class": "class", "form": "form",
        "department": "department",
    }.get(getattr(tournament, "group_kind", "") or "house", "house")

    competitor_field = (
        {"key": "house_id", "type": "dropdown", "required": True,
         "label": f"Which {noun_label} are you entering participants for?",
         "options": [], "data_source": {"type": "house_list"}}
        if intra
        else {"key": "institution_id", "type": "dropdown", "required": True,
              "label": "Select your institution", "options": [],
              "data_source": {"type": "institution_list"}}
    )

    groups: list[dict] = []
    sections: list[dict] = [
        {
            "key": "institution",
            "title": f"Your {noun_label}" if intra else "Your institution",
            "description": (
                "List everyone taking part first. Teams are built afterwards by "
                "picking from this list, so nobody is entered twice by mistake."
            ),
            "fields": [
                competitor_field,
                {"key": "contact_name", "type": "short_text",
                 "label": "Contact person", "required": False},
                {"key": "contact_email", "type": "email",
                 "label": "Contact email", "required": False},
                {"key": "contact_phone", "type": "phone",
                 "label": "Contact phone", "required": False},
            ],
        }
    ]
    for kind, gkey, title, label, description in (
        ("student", "students", "Students", "Student",
         "Everyone who will compete, in any sport. Enter each student once — "
         "you pick them per team on the next form."),
        ("teacher", "teachers", "Teachers in charge", "Teacher",
         "The staff travelling with the team. A teacher can only be in one "
         "place at a time, so the draw keeps their competitions apart."),
    ):
        fields = _participant_fields(kind, intra=intra)
        sections.append({
            "key": f"section_{gkey}",
            "title": title,
            "description": description,
            "fields": [{
                "key": gkey, "type": "group", "label": label,
                "repeatable": True,
                "min_items": 1 if kind == "student" else 0,
                "fields": fields,
            }],
        })
        name_key = next(
            (f["key"] for f in fields if f.get("bind") == "full_name"), ""
        )
        groups.append({
            "kind": kind,
            "group": gkey,
            "name": name_key,
            # answer key -> RosterMember column. Everything else in the row is
            # preserved on the member's `attributes`.
            "fields": {
                f["bind"]: f["key"] for f in fields
                if f.get("bind") and f["bind"] != "full_name"
            },
        })

    bindings = {
        "competitor_kind": "house" if intra else "institution",
        "competitor_id": "house_id" if intra else "institution_id",
        "institution_id": "institution_id",
        "contact_name": "contact_name",
        "contact_email": "contact_email",
        "contact_phone": "contact_phone",
        "participant_groups": groups,
    }
    return {"version": 1, "sections": sections}, bindings


def generate_participants_form(*, tournament, created_by=None, request=None) -> Form:
    """Create the DRAFT participants form for the admin to review and publish."""
    schema, bindings = build_participants_form_schema(tournament)
    form = create_form(
        tournament=tournament,
        title="Participant registration",
        purpose=FormPurpose.PARTICIPANT_REGISTRATION,
        stage="roster",
        schema=schema,
        created_by=created_by,
        request=request,
    )
    form.settings = {
        **(form.settings or {}),
        "bindings": bindings,
        "inputs_hash": sports_inputs_hash(tournament.sports),
    }
    form.save(update_fields=["settings"])
    return form


def generate_institution_form(*, tournament, created_by=None, request=None) -> Form:
    """Create a DRAFT institution-registration form from the tournament's sports,
    for the admin to review/edit/publish."""
    schema, cat_meta = build_institution_form_schema(tournament.sports or [])
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
        **cat_meta,
        # Staleness fingerprint (invariant 10): compared against the live
        # sports config to flag forms generated from an older category set.
        "inputs_hash": sports_inputs_hash(tournament.sports),
    }
    form.save(update_fields=["settings"])
    return form
