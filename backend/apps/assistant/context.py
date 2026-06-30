"""Build the live setup snapshot the assistant reasons over.

The snapshot is injected into the Gemini ``system_instruction`` on every call
(so the model always sees current journey position, dates, venues, formats,
competitions and what each section still needs) and is also returned verbatim by
the ``get_setup_state`` tool. This is what makes the assistant feel "smart" —
it always knows exactly where the organiser is and what's left.
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

# Friendly names — the assistant must NEVER show raw enum codes to the user.
STATUS_LABELS = {
    "draft": "Draft",
    "published": "Published",
    "registration_open": "Registration open",
    "scheduled": "Scheduled",
    "live": "Live",
    "completed": "Completed",
    "archived": "Archived",
}

# The setup funnel (matches the on-screen stage stepper).
STAGE_ORDER = ["setup", "org_registration", "team_registration", "members", "fixtures", "ready"]
STAGE_LABELS = {
    "setup": "Setup",
    "org_registration": "Institution registration",
    "team_registration": "Team registration",
    "members": "Members & roles",
    "fixtures": "Fixtures",
    "ready": "Ready",
}


def _team_counts(tournament) -> dict[str, int]:
    counts: dict[str, int] = {}
    rows = Team.objects.filter(
        tournament=tournament, status=TeamStatus.REGISTERED, deleted_at__isnull=True
    ).values_list("leaf_key", flat=True)
    for lk in rows:
        counts[lk or ""] = counts.get(lk or "", 0) + 1
    return counts


def _format_is_explicit(draw_config: dict, leaf_key: str, sport_key: str) -> bool:
    """True if a format was actually chosen at any layer (not the implicit
    league default the cards warn about). A multi-stage plan (stored under
    `stages`, not `format`) counts as an explicit choice too."""
    for layer in ("*", f"sport:{sport_key}", leaf_key):
        cfg = draw_config.get(layer)
        if isinstance(cfg, dict) and (cfg.get("format") or cfg.get("stages")):
            return True
    return False


def build_state(tournament) -> dict[str, Any]:
    """Structured snapshot of the current fixture setup + journey position."""
    leaves = iter_leaves(tournament.sports)
    counts = _team_counts(tournament)
    cal = (effective_draw_config(tournament).get("calendar")) or {}
    dc = tournament.draw_config or {}
    cons = tournament.constraints or []

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
                "format_chosen": _format_is_explicit(dc, lf["leaf_key"], lf["sport_key"]),
                "group_size": eff.get("group_size"),
                "advance_per_group": eff.get("advance_per_group"),
            }
        )

    def _count(ctype: str) -> int:
        return sum(1 for c in cons if c.get("type") == ctype)

    sections = {
        "dates_set": bool(cal.get("date_start") and cal.get("date_end")),
        "play_times_set": bool(
            cal.get("daily_start") and cal.get("daily_end") and cal.get("slot_minutes")
        ),
        "venues": len(venues),
        "courts": sum(v["courts"] for v in venues),
        "breaks_set": bool(_count("min_rest_minutes") or _count("max_matches_per_team_per_day")),
        "ceremonies": _count("ceremony_block"),
        "clash_rules": _count("no_concurrent_competitions"),
        "session_windows": _count("category_session_window"),
        "concurrency_caps": _count("official_capacity"),
        "formats_chosen": sum(1 for c in competitions if c["format_chosen"]),
        "competitions_total": len(competitions),
        "competitions_with_teams": sum(1 for c in competitions if c["teams"] > 0),
    }

    return {
        "name": tournament.name,
        "status": tournament.status,
        "stage": getattr(tournament, "stage", "") or "",
        "calendar": {
            "date_start": cal.get("date_start"),
            "date_end": cal.get("date_end"),
            "daily_start": cal.get("daily_start"),
            "daily_end": cal.get("daily_end"),
            "slot_minutes": cal.get("slot_minutes"),
        },
        "venues": venues,
        "competitions": competitions,
        "constraints": cons,
        "sections": sections,
    }


def _fmt(fmt: str | None) -> str:
    return FORMAT_LABELS.get(fmt or "", fmt or "not set")


def render_state(state: dict[str, Any]) -> str:
    """LLM-readable rendering: journey position + each setup section's status."""
    sec = state["sections"]
    cal = state["calendar"]
    lines: list[str] = []

    # --- Where you are (journey) ---------------------------------------
    status = STATUS_LABELS.get(state["status"], state["status"])
    stage = state["stage"]
    if stage in STAGE_ORDER:
        pos = STAGE_ORDER.index(stage) + 1
        lines.append(
            f"WHERE YOU ARE: Status is '{status}'. Setup step {pos} of {len(STAGE_ORDER)} "
            f"- '{STAGE_LABELS[stage]}'. The other steps are: "
            + " -> ".join(STAGE_LABELS[s] for s in STAGE_ORDER) + "."
        )
    else:
        lines.append(f"WHERE YOU ARE: Status is '{status}'.")
    lines.append("You are helping with FIXTURE SETUP, which has these sections:")

    # --- Section 1: When & where ---------------------------------------
    w = []
    w.append(
        f"dates {cal['date_start']}->{cal['date_end']}" if sec["dates_set"]
        else "dates NOT SET")
    w.append(
        f"play times {cal['daily_start']}-{cal['daily_end']} ({cal['slot_minutes']} min/match)"
        if sec["play_times_set"] else "play times NOT SET")
    w.append(f"{sec['venues']} venue(s), {sec['courts']} court(s)" if sec["venues"]
             else "NO venues")
    w.append("breaks set" if sec["breaks_set"] else "breaks NOT SET")
    if sec["ceremonies"]:
        w.append(f"{sec['ceremonies']} ceremony(ies)")
    lines.append("  1) When & where: " + "; ".join(w) + ".")
    if state["venues"]:
        for v in state["venues"]:
            used = ", ".join(v["sports"]) if v["sports"] else "any sport"
            lines.append(f"       - '{v['name']}': {v['courts']} court(s), used by {used}.")

    # --- Section 2: Clashes & sessions ---------------------------------
    lines.append(
        f"  2) Clashes & sessions (optional): {sec['clash_rules']} clash rule(s), "
        f"{sec['session_windows']} session window(s), {sec['concurrency_caps']} concurrency cap(s)."
    )

    # --- Section 3: How each competition plays -------------------------
    lines.append(
        f"  3) How each competition plays: {sec['formats_chosen']} of "
        f"{sec['competitions_total']} competitions have a chosen format "
        f"(the rest fall back to the league default). Use these exact identifiers:"
    )
    for c in state["competitions"]:
        chosen = (_fmt(c["format"]) if c["format_chosen"]
                  else f"{_fmt(c['format'])} (DEFAULT, not chosen)")
        extra = ""
        if c["format"] == "groups_knockout":
            extra = f", groups of {c['group_size']}, top {c['advance_per_group']} advance"
        lines.append(
            f"       * {c['label']} [leaf_key={c['leaf_key']}, sport_key={c['sport_key']}, "
            f"{c['teams']} teams] -> {chosen}{extra}"
        )

    lines.append(
        f"  Next: once formats are chosen, {sec['competitions_with_teams']} competitions are "
        "ready to preview & publish (the organiser's own click)."
    )
    return "\n".join(lines)


SYSTEM_TEMPLATE = """\
You are the setup assistant for a sports fixture / tournament platform. Act like \
an expert tournament organiser who configures everything for the user by chatting \
- the user should only have to type. Be warm, concise, proactive and concrete, \
and use plain language (organisers are not software experts). NEVER show raw codes \
like "registration_open" or a leaf_key to the user - say "Registration is open", \
"the U-14 Boys singles", etc.

Today's date is {today}. The tournament timezone is {tz}.

TOURNAMENT: "{name}".
{state}

WHAT YOU DO - guide the whole FIXTURE SETUP section by section, and DO it for them:
  1) When & where - match days, venues (courts), daily play times, breaks/ceremonies.
  2) Clashes & sessions (optional) - stop competitions overlapping, pin a competition
     to a time of day, or cap how many matches run at once.
  3) How each competition plays - choose a format for each sport or category.
Then tell them to use the on-screen "Preview the draw" and publish buttons.

HOW TO BEHAVE:
- Always know where they are. If asked "what stage / what's done / what's next", \
answer from WHERE YOU ARE + the section status above, in friendly words, then offer \
the next concrete step.
- Be proactive and work section by section. After doing something, say what's left \
and offer to do it. Lead the user; don't make them figure out the form.
- If the user says "set it all up", "do everything", or is vague, PROPOSE a sensible \
plan for THIS tournament using the competitions, team counts and courts shown above, \
then APPLY it with the tools. Only ask a question for a fact you truly cannot infer \
(e.g. the match dates if they are not set). Don't ask the user to fill anything in \
the form themselves.
- Focus on what is MISSING. Do NOT overwrite a section that is already set (dates, \
breaks, venues, etc.) unless the user asks or the value is clearly wrong.
- To set a format, PREFER the sport_key scope to do a whole sport in one step; use a \
leaf_key only when one category differs, and scope "all" for the whole tournament. \
Before you finish a "set everything up" request, make sure EVERY competition has a \
chosen format (none left on the default) - check the state and set any that remain.
- Good defaults when the user is unsure: knockout for singles/doubles brackets; \
group stage -> knockout (groups of 4, top 2 advance, balanced) for round-robin-into-\
finals; ~2 courts per sport; 10-15 min rest between a team's matches; ~20-30 min per \
table-tennis match. Confirm briefly after applying.

LIMITS:
- You configure the SETUP only. You never preview, generate, or publish the schedule \
- those are the organiser's on-screen buttons. If asked, point them to "Preview the \
draw" then publish.
- Make one tool call per distinct change (several in a row is fine). Never invent \
competitions, venues, or team numbers - use only what the state shows.
"""


def system_prompt(tournament, focus: str | None = None) -> str:
    state = build_state(tournament)
    tz = getattr(tournament, "timezone", "") or "Asia/Kolkata"
    prompt = SYSTEM_TEMPLATE.format(
        today=timezone.localdate().isoformat(),
        tz=tz,
        name=state["name"],
        state=render_state(state),
    )
    if focus:
        prompt += (
            f"\nCURRENT FOCUS: The user opened the assistant from '{focus}'. "
            "Interpret their message as being about that section/input, answer "
            "specifically, and offer to do it for them. If their first message is "
            "vague (e.g. 'set this up', 'what do you recommend'), act on this focus."
        )
    return prompt

