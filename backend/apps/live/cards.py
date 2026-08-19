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


# Side of the square a crest is fitted into, and the gap to the team name.
_CREST = 72
_CREST_GAP = 18


def _crest_images(m: Match) -> dict[str, Image.Image | None]:
    """``{"home": img|None, "away": img|None}`` — each team's crest as an RGBA
    thumbnail, in ONE query for the pair.

    Read through the upload row's own ``file`` field rather than fetching the
    signed crest URL over HTTP: this renderer runs inside the very process
    that would serve that URL, so an HTTP round trip would be the server
    calling itself and would stall the card whenever the worker pool is busy.

    Every failure path returns None and the card falls back to its existing
    text-only layout. A share card is the image WhatsApp unfurls for a
    forwarded match link; it must never 500 over decoration, so a missing
    file, an unreadable image or a ref pointing at nothing all degrade
    silently rather than raise.
    """
    out: dict[str, Image.Image | None] = {"home": None, "away": None}
    try:
        from apps.forms.models import FormFileUpload

        refs: dict[str, str] = {}
        for side, team in (("home", m.home_team if m.home_team_id else None),
                           ("away", m.away_team if m.away_team_id else None)):
            if team is None:
                continue
            ref = getattr(team, "logo_ref", None)
            if not ref:
                inst = getattr(team, "institution", None)
                ref = getattr(inst, "logo_ref", None) if inst else None
            if ref:
                refs[side] = str(ref)
        if not refs:
            return out
        rows = {
            str(u.upload_ref): u
            for u in FormFileUpload.objects.filter(upload_ref__in=set(refs.values()))
        }
        for side, ref in refs.items():
            out[side] = _load_crest(rows.get(ref))
    except Exception:  # decoration, never a failed card
        return {"home": None, "away": None}
    return out


def _load_crest(upload) -> Image.Image | None:
    """One upload row decoded to an RGBA thumbnail, or None on anything odd
    (no row, no file on disk, a PDF someone uploaded as a logo)."""
    if upload is None or not upload.file:
        return None
    try:
        with upload.file.open("rb") as fh:
            img = Image.open(fh)
            img.load()
        img = img.convert("RGBA")
        img.thumbnail((_CREST, _CREST), Image.LANCZOS)
        return img
    except Exception:  # see _crest_images: decoration, never a failed card
        return None


def _paste_crest(img: Image.Image, crest: Image.Image, left: int, mid_y: int):
    """Paste a crest centred inside its _CREST box, honouring transparency."""
    x = left + (_CREST - crest.width) // 2
    y = mid_y - crest.height // 2
    img.paste(crest, (x, y), crest)


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
    #
    # When EITHER side has a crest the gutter is reserved on BOTH, so the two
    # names keep one shared size and stay mirror-symmetric; a school with no
    # badge simply sits further in rather than being typeset larger than its
    # opponent.
    crests = _crest_images(m)
    badged = crests["home"] is not None or crests["away"] is not None
    gutter = (_CREST + _CREST_GAP) if badged else 0
    f_team = _fit(d, max(home, away, key=len), 500 - gutter, 52)
    name_y = 248
    mid_y = name_y + f_team.size // 2
    d.text((90 + gutter, name_y), home, font=f_team, fill=_INK)
    aw = d.textlength(away, font=f_team)
    d.text((_W - 90 - gutter - aw, name_y), away, font=f_team, fill=_INK)
    if crests["home"] is not None:
        _paste_crest(img, crests["home"], 90, mid_y)
    if crests["away"] is not None:
        _paste_crest(img, crests["away"], _W - 90 - _CREST, mid_y)

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
            Match.objects.select_related(
                "home_team", "away_team", "tournament",
                # A team's crest falls back to its school's, so the
                # institutions come along here instead of in two more queries.
                "home_team__institution", "away_team__institution",
            )
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

def render_tournament_card(t, n_matches: int, live_now: int) -> bytes:
    """1200x630 card for a forwarded TOURNAMENT link (audit gap: /t/ links
    unfurled without an image while /m/ links got the full card)."""
    img = Image.new("RGB", (_W, _H), _BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, _W, 10], fill=_PRIMARY)

    _center(d, "FIXTURE", 56, _font(30), _PRIMARY)
    name_font = _fit(d, t.name, _W - 160, 72)
    _center(d, t.name, 170, name_font, _INK)

    line = f"{n_matches} matches"
    if live_now:
        line += f"  |  {live_now} live now"
    _center(d, line, 300, _font(40, bold=False), _MUTED)

    season = (t.season or "").strip()
    if season:
        _center(d, season, 372, _font(34, bold=False), _MUTED)

    _center(d, "Schedule, live scores, standings and brackets", 480,
            _font(32, bold=False), _MUTED)
    d.rectangle([0, _H - 10, _W, _H], fill=_PRIMARY)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class TournamentCardView(GenericAPIView):
    """`GET /api/live/tournament-card/{id}.png` — the tournament share card."""

    permission_classes = [AllowAny]

    def get(self, request, tournament_id):
        from apps.tournaments.models import Tournament

        t = Tournament.objects.filter(
            id=tournament_id, deleted_at__isnull=True
        ).first()
        if t is None:
            raise NotFound("tournament_not_found")
        n = Match.objects.filter(tournament=t, deleted_at__isnull=True).count()
        live_now = Match.objects.filter(
            tournament=t, deleted_at__isnull=True,
            status__in=(MatchStatus.LIVE, MatchStatus.HALF_TIME),
        ).count()
        png = render_tournament_card(t, n, live_now)
        resp = HttpResponse(png, content_type="image/png")
        resp["Cache-Control"] = "public, max-age=300"
        return resp

