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
                else f"{sname} — {' — '.join(path_names)}"
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
                "Categories" if not path_names else " — ".join(path_names)
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
                {"key": f"player_name_{slug}", "type": "short_text",
                 "label": "Player name", "required": True},
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
                             "required": True},
                            players,
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
            {"key": "sports", "type": "multi_choice", "required": True,
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
