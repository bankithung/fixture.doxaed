"""Team crests — one resolver, so every fixture surface shows the same badge.

A crest belongs to the SCHOOL. The team form asks each school for its logo once
per submission (owner 2026-08-17), so the file lands on ``Institution.logo_ref``
and every team of that school wears it. ``Team.logo_ref`` is the override: a
form generated before the logo moved to the participants sheet asked for one per
team row, and a house in a within-school event shares its host institution with
every other house, so it needs a badge of its own.

**Why a resolver rather than a field read.** A crest appears beside a team name
in a fixture list, a bracket node, a scoreboard, a printed sheet and a public
match page — dozens of call sites, most of them rendering many teams at once. A
per-team lookup would be an N+1 on every one of them, and the manager-gated
roster-detail endpoint the Teams tab uses could not serve the public pages at
all. So: one bulk map, built once per request, and a URL anyone may load.

**The URL is a capability, not a session.** ``upload_url`` mints a signed
``?t=`` token that :class:`~apps.forms.views.ServeUploadView` accepts from an
unauthenticated visitor — the same pattern the public form prefill already uses.
That is what lets a crest render on a public match centre and inside a printed
PDF without a login.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from apps.forms.services.uploads import upload_url


def crest_url(logo_ref: Any) -> str:
    """A loadable URL for one crest ref, or "" when there is no crest.

    Never raises on junk: a crest is decoration, and a bad ref must degrade to
    initials rather than break the fixture that carries it.
    """
    if not logo_ref:
        return ""
    return upload_url(str(logo_ref))


def team_crest(team) -> str:
    """The crest URL for a single Team — its own override, else its school's.

    Prefer :func:`crest_map` when rendering more than one team: this touches
    ``team.institution`` and will lazy-load it if the caller did not
    ``select_related``.
    """
    if team is None:
        return ""
    own = getattr(team, "logo_ref", None)
    if own:
        return crest_url(own)
    inst = getattr(team, "institution", None)
    return crest_url(getattr(inst, "logo_ref", None)) if inst else ""


def crest_map(teams: Iterable[Any]) -> dict[str, str]:
    """``{str(team_id): url}`` for many teams in ONE pass, no per-team query.

    Takes ``Team`` instances (ideally ``select_related("institution")``); any
    team without a crest is simply absent from the map, so a caller can write
    ``crests.get(str(tid), "")`` and never branch on None.
    """
    out: dict[str, str] = {}
    for tm in teams:
        if tm is None:
            continue
        url = team_crest(tm)
        if url:
            out[str(tm.id)] = url
    return out


def crest_map_for_ids(team_ids: Iterable[Any]) -> dict[str, str]:
    """``{str(team_id): url}`` from ids alone — for payloads that only carry
    ids (match rows, bracket nodes, schedule assignments). One query."""
    from apps.teams.models import Team

    ids = {str(i) for i in team_ids if i}
    if not ids:
        return {}
    return crest_map(
        Team.objects.filter(id__in=ids)
        .select_related("institution")
        .only("id", "logo_ref", "institution__logo_ref")
    )


def crest_map_for_tournament(tournament_id) -> dict[str, str]:
    """Every crest in one tournament, keyed by team id. The right call for a
    page that lists a whole day's matches: one query for the lot."""
    from apps.teams.models import Team

    return crest_map(
        Team.objects.filter(tournament_id=tournament_id, deleted_at__isnull=True)
        .select_related("institution")
        .only("id", "logo_ref", "institution__logo_ref")
    )
