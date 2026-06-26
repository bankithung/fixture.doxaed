"""Build the live setup snapshot the assistant reasons over.

The snapshot is injected into the Gemini ``system_instruction`` on every call
(so the model always sees current dates/venues/formats/competitions) and is also
returned verbatim by the ``get_setup_state`` tool.
"""
from __future__ import annotations

from typing import Any

from django.utils import timezone

from apps.fixtures.models import Venue
from apps.fixtures.services.draw_config import effective_draw_config
from apps.teams.models import Team, TeamStatus
from apps.tournaments.services.sports import iter_leaves

FORMAT_LABELS = {
    "round_robin": "Round-robin (league)",
    "knockout": "Knockout (single elimination)",
    "groups_knockout": "Group stage -> Knockout",
    "swiss": "Swiss",
    "double_elim": "Double elimination",
}


def _team_counts(tournament) -> dict[str, int]:
    counts: dict[str, int] = {}
    rows = Team.objects.filter(
        tournament=tournament, status=TeamStatus.REGISTERED, deleted_at__isnull=True
    ).values_list("leaf_key", flat=True)
    for lk in rows:
        counts[lk or ""] = counts.get(lk or "", 0) + 1
    return counts


def build_state(tournament) -> dict[str, Any]:
    """Structured snapshot of the current fixture setup."""
    leaves = iter_leaves(tournament.sports)
    counts = _team_counts(tournament)
    cal = (effective_draw_config(tournament).get("calendar")) or {}

    venues = [
        {
            "name": v.name,
            "courts": v.count,
            "type": v.venue_type or "",
            "sports": v.sports or [],
            "windows": v.windows or [],
        }
        for v in Venue.objects.filter(
            organization=tournament.organization, deleted_at__isnull=True
        ).order_by("name")
    ]

    competitions = []
    for lf in leaves:
        eff = effective_draw_config(tournament, lf["leaf_key"])
        competitions.append(
            {
                "leaf_key": lf["leaf_key"],
                "label": lf["label"],
                "sport_key": lf["sport_key"],
                "sport_name": lf["sport_name"],
                "teams": counts.get(lf["leaf_key"], 0),
                "format": eff.get("format"),
                "group_size": eff.get("group_size"),
                "advance_per_group": eff.get("advance_per_group"),
                "balance_groups": eff.get("balance_groups"),
            }
        )

    return {
        "name": tournament.name,
        "status": tournament.status,
        "calendar": {
            "date_start": cal.get("date_start"),
            "date_end": cal.get("date_end"),
            "daily_start": cal.get("daily_start"),
            "daily_end": cal.get("daily_end"),
            "slot_minutes": cal.get("slot_minutes"),
        },
        "venues": venues,
        "competitions": competitions,
        "constraints": tournament.constraints or [],
    }


def _fmt(fmt: str | None) -> str:
    return FORMAT_LABELS.get(fmt or "", fmt or "not set")


def render_state(state: dict[str, Any]) -> str:
    """Human/LLM-readable rendering of the snapshot for the system prompt."""
    lines: list[str] = []
    cal = state["calendar"]
    if cal.get("date_start") or cal.get("date_end"):
        lines.append(
            f"- Match days: {cal.get('date_start') or '?'} to {cal.get('date_end') or '?'}; "
            f"daily {cal.get('daily_start') or '09:00'}-{cal.get('daily_end') or '18:00'}, "
            f"{cal.get('slot_minutes') or '?'} min per match."
        )
    else:
        lines.append("- Match days: NOT SET (ask the user, then call set_schedule_window).")

    if state["venues"]:
        for v in state["venues"]:
            used = ", ".join(v["sports"]) if v["sports"] else "any sport"
            win = ""
            if v["windows"]:
                w = v["windows"][0]
                win = f", open {w.get('from')}-{w.get('to')}"
            lines.append(f"- Venue '{v['name']}': {v['courts']} court(s), used by {used}{win}.")
    else:
        lines.append("- Venues: NONE yet (add with add_or_update_venue).")

    lines.append("- Competitions (use these exact leaf_key / sport_key values):")
    for c in state["competitions"]:
        extra = ""
        if c["format"] == "groups_knockout":
            extra = f" (groups of {c['group_size']}, top {c['advance_per_group']} advance)"
        lines.append(
            f"    * {c['label']}  [leaf_key={c['leaf_key']}, sport_key={c['sport_key']}, "
            f"{c['teams']} teams]  format: {_fmt(c['format'])}{extra}"
        )

    cons = state["constraints"]
    if cons:
        summ = ", ".join(
            f"{c.get('type')}({c.get('scope', 'all')})" for c in cons
        )
        lines.append(f"- Existing scheduling rules: {summ}")
    else:
        lines.append("- Scheduling rules (breaks, days off, ceremonies, clashes): none set.")
    return "\n".join(lines)


SYSTEM_TEMPLATE = """\
You are the setup assistant for a sports fixture / tournament platform. You help \
the organiser configure the "Fixture setup" form for ONE tournament and you can \
fill it in for them by calling tools. Be warm, concise, and concrete. Use simple \
language (the organisers are not software experts).

Today's date is {today}. The tournament timezone is {tz}.

TOURNAMENT: "{name}" (status: {status}).
CURRENT SETUP:
{state}

HOW TO HELP:
- Answer questions about the form plainly (e.g. what "courts", "rest", or a \
clash rule means).
- When the user asks you to set something up, CALL THE TOOLS to apply it — do not \
just describe what to do. After acting, briefly confirm what you changed.
- If you are missing a fact you need (e.g. the dates, or how many courts each \
sport has), ASK ONE short question rather than guessing. Don't ask for things \
already shown in CURRENT SETUP.
- To set a competition's format, use the exact leaf_key (one competition) or \
sport_key (all of a sport) from CURRENT SETUP. Use scope "all" for the whole \
tournament.
- Knockout suits singles/doubles brackets; "groups_knockout" (group stage then \
knockout) suits round-robin-into-finals; "round_robin" is a pure league.
- Reasonable defaults if the user is unsure: 2 courts per sport, ~20-30 min per \
table-tennis match, a 10-15 min rest between a team's matches.

LIMITS:
- You configure the setup ONLY. You never generate, preview, or publish the \
schedule — the organiser does that themselves with the on-screen buttons. If \
asked, tell them to click "Preview the draw" / "Publish" when ready.
- Make one tool call per distinct change; you may make several in a row to \
complete a request. Never invent competitions, venues, or team numbers.
"""


def system_prompt(tournament) -> str:
    state = build_state(tournament)
    tz = getattr(tournament, "timezone", "") or "Asia/Kolkata"
    return SYSTEM_TEMPLATE.format(
        today=timezone.localdate().isoformat(),
        tz=tz,
        name=state["name"],
        status=state["status"],
        state=render_state(state),
    )
