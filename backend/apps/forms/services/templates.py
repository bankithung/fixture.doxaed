"""Built-in starter form templates + the copy-from-existing logic.

Templates are validated schemas (+ bindings) an organizer can drop into a blank
form so they don't start from scratch. `copy_into` also powers copying from any
form the user can access (e.g. a previous tournament's form)."""
from __future__ import annotations

from typing import Any

# Built-in templates. `id` is namespaced "template:<slug>" so the copy endpoint
# can tell a template apart from a real form UUID.
BUILTIN_TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "template:institution-registration",
        "title": "Institution registration",
        "purpose": "organization_registration",
        "description": "Schools/colleges apply: details, contact, sport + the categories they'll enter.",
        "schema": {
            "version": 1,
            "sections": [
                {
                    "key": "details",
                    "title": "Institution details",
                    "fields": [
                        {"key": "institution_name", "type": "short_text",
                         "label": "Institution / school name", "required": True},
                        {"key": "contact_name", "type": "short_text", "label": "Contact person"},
                        {"key": "contact_email", "type": "email", "label": "Contact email"},
                        {"key": "contact_phone", "type": "phone", "label": "Contact phone"},
                        {"key": "region", "type": "short_text", "label": "District / region"},
                    ],
                },
                {
                    "key": "participation",
                    "title": "Participation",
                    "fields": [
                        {"key": "sport", "type": "single_choice", "label": "Sport",
                         "options": [
                             {"value": "Football", "label": "Football"},
                             {"value": "Volleyball", "label": "Volleyball"},
                             {"value": "Sepak Takraw", "label": "Sepak Takraw"},
                             {"value": "Table Tennis", "label": "Table Tennis"},
                         ]},
                        {"key": "categories", "type": "multi_choice",
                         "label": "Categories you will enter",
                         "options": [
                             {"value": "U-14", "label": "U-14"},
                             {"value": "U-16", "label": "U-16"},
                             {"value": "U-19", "label": "U-19"},
                             {"value": "Open", "label": "Open"},
                         ]},
                    ],
                },
            ],
        },
        "settings": {
            "bindings": {
                "institution_name": "institution_name",
                "contact_name": "contact_name",
                "contact_email": "contact_email",
                "contact_phone": "contact_phone",
                "region": "region",
                "categories": "categories",
            }
        },
    },
    {
        "id": "template:multi-sport-institution",
        "title": "Multi-sport institution registration",
        "purpose": "organization_registration",
        "description": (
            "Schools pick a competition; the matching category questions appear "
            "automatically (Sepak Takraw and/or Table Tennis). Fully editable."
        ),
        "schema": {
            "version": 1,
            "sections": [
                {
                    "key": "school",
                    "title": "School details",
                    "fields": [
                        {"key": "school_name", "type": "short_text",
                         "label": "School name", "required": True, "role": "title"},
                        {"key": "contact_name", "type": "short_text",
                         "label": "Your name", "required": True, "role": "name"},
                        {"key": "contact_phone", "type": "phone",
                         "label": "Contact number", "required": True, "role": "phone"},
                        {"key": "contact_email", "type": "email",
                         "label": "Email", "role": "email"},
                    ],
                },
                {
                    "key": "competition",
                    "title": "Competition selection",
                    "fields": [
                        {"key": "competition", "type": "single_choice", "required": True,
                         "label": "Which competition will your school participate in?",
                         "options": [
                             {"value": "sepak", "label": "Sepak Takraw only"},
                             {"value": "tt", "label": "Table Tennis only"},
                             {"value": "both", "label": "Both"},
                             {"value": "none", "label": "Not participating"},
                         ]},
                        # Revealed inline when the answer is one of [sepak, both].
                        {"key": "sepak_categories", "type": "multi_choice",
                         "label": "Sepak Takraw categories",
                         "visibility": {"field": "competition", "op": "in",
                                        "value": ["sepak", "both"]},
                         "options": [
                             {"value": "u14_boys", "label": "U-14 Boys"},
                             {"value": "u14_girls", "label": "U-14 Girls"},
                         ]},
                        # Revealed inline when the answer is one of [tt, both].
                        {"key": "tt_categories", "type": "multi_choice",
                         "label": "Table Tennis categories",
                         "visibility": {"field": "competition", "op": "in",
                                        "value": ["tt", "both"]},
                         "options": [
                             {"value": "u14_boys_singles", "label": "U-14 Boys Singles"},
                             {"value": "u14_boys_doubles", "label": "U-14 Boys Doubles"},
                             {"value": "u14_girls_singles", "label": "U-14 Girls Singles"},
                             {"value": "u14_girls_doubles", "label": "U-14 Girls Doubles"},
                             {"value": "a14_boys_singles", "label": "Above 14 Boys Singles"},
                             {"value": "a14_boys_doubles", "label": "Above 14 Boys Doubles"},
                             {"value": "a14_girls_singles", "label": "Above 14 Girls Singles"},
                             {"value": "a14_girls_doubles", "label": "Above 14 Girls Doubles"},
                         ]},
                    ],
                },
                {
                    "key": "confirm",
                    "title": "Final confirmation",
                    "fields": [
                        {"key": "confirm_note", "type": "section_text",
                         "label": ("Player names and documents must be submitted by "
                                   "20 August 2026.")},
                    ],
                },
            ],
        },
        "settings": {
            "bindings": {
                "institution_name": "school_name",
                "contact_name": "contact_name",
                "contact_phone": "contact_phone",
                "contact_email": "contact_email",
            }
        },
    },
    {
        "id": "template:team-registration",
        "title": "Team registration",
        "purpose": "team_registration",
        "description": "One institution enters a team + its players.",
        "schema": {
            "version": 1,
            "sections": [
                {
                    "key": "team",
                    "title": "Team",
                    "fields": [
                        {"key": "institution_name", "type": "short_text",
                         "label": "Your institution", "required": True},
                        {"key": "team_name", "type": "short_text", "label": "Team name",
                         "required": True},
                        {"key": "players", "type": "group", "label": "Players",
                         "repeatable": True, "fields": [
                             {"key": "full_name", "type": "short_text",
                              "label": "Player name", "required": True},
                             {"key": "jersey_no", "type": "number", "label": "Jersey #"},
                         ]},
                    ],
                },
            ],
        },
        "settings": {
            "bindings": {
                "school_name": "institution_name",
                "team_name": "team_name",
                "players_group": "players",
                "player_name": "full_name",
            }
        },
    },
]

_BY_ID = {t["id"]: t for t in BUILTIN_TEMPLATES}


def template_summaries() -> list[dict[str, Any]]:
    return [
        {
            "id": t["id"],
            "title": t["title"],
            "purpose": t["purpose"],
            "description": t["description"],
            "field_count": sum(len(s.get("fields", [])) for s in t["schema"]["sections"]),
            "is_template": True,
        }
        for t in BUILTIN_TEMPLATES
    ]


def get_template(template_id: str) -> dict[str, Any] | None:
    return _BY_ID.get(template_id)
