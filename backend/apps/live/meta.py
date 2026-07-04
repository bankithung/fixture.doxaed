"""Bot-facing OG meta for shared match links (P6 reach).

The SPA serves one static index.html for every route, so a forwarded
/m/:id link unfurled identically (and scorelessly) everywhere — the exact
opposite of the WhatsApp-first goal. nginx routes known link-preview bots
here instead; humans keep getting the SPA. The page carries og:image
pointing at the server-rendered share card, so the forwarded link SHOWS
the score.
"""
from __future__ import annotations

from django.http import HttpResponse
from django.utils.html import escape
from rest_framework.exceptions import NotFound
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny

from apps.matches.models import Match, MatchStatus

_BASE = "https://fixture.doxaed.com"


class MatchMetaView(GenericAPIView):
    """`GET /api/live/match-meta/{match_id}/` — OG/Twitter meta HTML."""

    permission_classes = [AllowAny]

    def get(self, request, match_id):
        m = (
            Match.objects.select_related("home_team", "away_team", "tournament")
            .filter(id=match_id, deleted_at__isnull=True)
            .first()
        )
        if m is None:
            raise NotFound("match_not_found")

        home = m.home_team.name if m.home_team_id else "TBD"
        away = m.away_team.name if m.away_team_id else "TBD"
        live = m.status in (MatchStatus.LIVE, MatchStatus.HALF_TIME)
        final = m.status in (MatchStatus.COMPLETED, MatchStatus.WALKOVER)
        if live or final:
            if m.set_scores and not final:
                cur = m.set_scores[-1]
                scoreline = f"{home} {cur[0]} - {cur[1]} {away}"
            else:
                scoreline = f"{home} {m.home_score or 0} - {m.away_score or 0} {away}"
            state = "LIVE" if live else "Full time"
            title = f"{scoreline} ({state})"
        else:
            title = f"{home} vs {away}"
        desc_bits = [m.tournament.name]
        if m.venue:
            desc_bits.append(m.venue)
        desc_bits.append("Live scores on Fixture")
        description = " · ".join(desc_bits)

        url = f"{_BASE}/m/{m.id}"
        image = f"{_BASE}/api/live/match-card/{m.id}.png"
        t, d_ = escape(title), escape(description)
        html = f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>{t}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Fixture">
<meta property="og:title" content="{t}">
<meta property="og:description" content="{d_}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{t}">
<meta name="twitter:description" content="{d_}">
<meta name="twitter:image" content="{image}">
</head><body>{t}</body></html>"""
        resp = HttpResponse(html, content_type="text/html; charset=utf-8")
        resp["Cache-Control"] = "public, max-age=60"
        return resp
