"""Server-rendered share cards (P6 reach): a 1200x630 PNG scoreline per
match — the image WhatsApp/OG unfurls show when a match link is forwarded.
The single highest ROI-to-effort growth item from the benchmark research:
school communities share links in WhatsApp groups, and a forwarded link
that SHOWS the score is the growth loop.

Pillow + system DejaVu fonts (no new deps on the live box). Rendered on
demand, cacheable: ETag = match id + updated_at, so a score change busts it.
"""
from __future__ import annotations

import io

from django.http import HttpResponse
from PIL import Image, ImageDraw, ImageFont
from rest_framework.exceptions import NotFound
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny

from apps.matches.models import Match, MatchStatus

_W, _H = 1200, 630
_FONT_DIR = "/usr/share/fonts/truetype/dejavu"

# Brand palette (matches the app's primary green on white).
_BG = (255, 255, 255)
_INK = (15, 23, 42)          # slate-900
_MUTED = (100, 116, 139)     # slate-500
_PRIMARY = (12, 141, 98)     # the app green
_CARD = (241, 245, 244)


def _font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    return ImageFont.truetype(f"{_FONT_DIR}/{name}", size)


def _fit(draw, text: str, max_width: int, size: int, bold=True, floor=28):
    """Shrink the font until the text fits (long school names)."""
    while size > floor:
        f = _font(size, bold)
        if draw.textlength(text, font=f) <= max_width:
            return f
        size -= 4
    return _font(floor, bold)


def _center(draw, text, y, font, fill):
    w = draw.textlength(text, font=font)
    draw.text(((_W - w) / 2, y), text, font=font, fill=fill)


def render_match_card(m: Match) -> bytes:
    img = Image.new("RGB", (_W, _H), _BG)
    d = ImageDraw.Draw(img)

    # Top band: brand + tournament name.
    d.rectangle([0, 0, _W, 8], fill=_PRIMARY)
    _center(d, "FIXTURE", 36, _font(26), _PRIMARY)
    tname = m.tournament.name[:80]
    _center(d, tname, 78, _fit(d, tname, _W - 160, 40), _MUTED)

    home = (m.home_team.name if m.home_team_id else "TBD")[:48]
    away = (m.away_team.name if m.away_team_id else "TBD")[:48]
    live = m.status in (MatchStatus.LIVE, MatchStatus.HALF_TIME)
    final = m.status in (MatchStatus.COMPLETED, MatchStatus.WALKOVER)

    # Status pill.
    label = (
        "LIVE" if live else
        "FULL TIME" if m.status == MatchStatus.COMPLETED else
        "WALKOVER" if m.status == MatchStatus.WALKOVER else
        "UPCOMING"
    )
    pf = _font(30)
    pw = d.textlength(label, font=pf) + 48
    d.rounded_rectangle(
        [(_W - pw) / 2, 150, (_W + pw) / 2, 204], radius=27,
        fill=_PRIMARY if live else _CARD,
    )
    _center(d, label, 158, pf, _BG if live else _MUTED)

    # Team names on their own row; the score/vs sits BELOW them so long
    # school names never collide with the center column.
    f_team = _fit(d, max(home, away, key=len), 500, 52)
    d.text((90, 248), home, font=f_team, fill=_INK)
    aw = d.textlength(away, font=f_team)
    d.text((_W - 90 - aw, 248), away, font=f_team, fill=_INK)

    if live or final:
        if m.set_scores and not final:
            cur = m.set_scores[-1]
            score = f"{cur[0]} - {cur[1]}"
            sub = f"Set {len(m.set_scores)}"
        else:
            score = f"{m.home_score or 0} - {m.away_score or 0}"
            sub = (
                "Sets " + ", ".join(f"{a}-{b}" for a, b in m.set_scores)
                if m.set_scores else ""
            )
        f_score = _font(104)
        _center(d, score, 340, f_score, _PRIMARY if live else _INK)
        if sub:
            _center(d, sub[:60], 468, _font(34, bold=False), _MUTED)
    else:
        _center(d, "vs", 352, _font(64), _MUTED)
        when = (
            m.scheduled_at.strftime("%a %d %b, %H:%M UTC")
            if m.scheduled_at else "Schedule to follow"
        )
        _center(d, when, 456, _font(34, bold=False), _MUTED)

    # Footer: venue + call to action.
    footer = " · ".join(x for x in (m.venue, "Live scores on Fixture") if x)
    _center(d, footer[:90], 556, _font(28, bold=False), _MUTED)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


class MatchCardView(GenericAPIView):
    """`GET /api/public/match-card/{match_id}.png` — the OG/share image."""

    permission_classes = [AllowAny]

    def get(self, request, match_id):
        m = (
            Match.objects.select_related("home_team", "away_team", "tournament")
            .filter(id=match_id, deleted_at__isnull=True)
            .first()
        )
        if m is None:
            raise NotFound("match_not_found")
        etag = f'"{m.id}-{m.updated_at.timestamp()}"'
        if request.headers.get("If-None-Match") == etag:
            return HttpResponse(status=304)
        png = render_match_card(m)
        resp = HttpResponse(png, content_type="image/png")
        resp["ETag"] = etag
        resp["Cache-Control"] = "public, max-age=60"
        return resp
