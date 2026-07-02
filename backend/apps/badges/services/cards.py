"""Share-card rendering (owner: "this creates nice social media posts").

A 1200x630 PNG (the OG-image size WhatsApp/Facebook unfurl) per award:
badge name, subject, the evidence numbers, tournament name, and a QR code to
the public badges gallery. Rendered with Pillow (already a dependency via
qrcode[pil]) and cached under MEDIA_ROOT/badges/ — regeneration is idempotent
per award id + evidence hash. No em/en dashes or arrows in any string (owner
rule); numbers use the mono face as the tabular stand-in.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from django.conf import settings

from apps.badges.catalog import BADGE_TEMPLATES

_FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")
_W, _H = 1200, 630
# The one sanctioned decorative palette outside app tokens is the FifaBracket
# purple/gold; share cards reuse it so exports feel like the bracket family.
_BG = (38, 24, 74)
_GOLD = (212, 175, 55)
_WHITE = (245, 245, 250)
_MUTED = (178, 172, 205)


def _fonts():
    from PIL import ImageFont

    return {
        "title": ImageFont.truetype(str(_FONT_DIR / "DejaVuSans-Bold.ttf"), 72),
        "subject": ImageFont.truetype(str(_FONT_DIR / "DejaVuSans-Bold.ttf"), 48),
        "body": ImageFont.truetype(str(_FONT_DIR / "DejaVuSans.ttf"), 34),
        "small": ImageFont.truetype(str(_FONT_DIR / "DejaVuSans.ttf"), 26),
        "mono": ImageFont.truetype(str(_FONT_DIR / "DejaVuSansMono-Bold.ttf"), 40),
    }


def _evidence_line(award) -> str:
    ev = award.evidence or {}
    if "conceded" in ev and award.badge_key == "lockdown_match":
        sets_txt = ", ".join(f"{s[0]}-{s[1]}" for s in ev.get("set_scores", []))
        return f"Conceded only {ev['conceded']} points ({sets_txt})"
    if "set_scores" in ev:
        return ", ".join(f"{s[0]}-{s[1]}" for s in ev["set_scores"])
    if "point_difference" in ev:
        return f"Point difference +{ev['point_difference']}"
    if "goals" in ev:
        return f"{ev['goals']} goals"
    if "streak" in ev:
        return f"{ev['streak']} in a row"
    if "wins" in ev:
        return f"{ev['wins']} wins, no defeats"
    if "final" in ev:
        return f"Final score {ev['final']}"
    return ""


def card_path(award) -> Path:
    stamp = hashlib.sha256(
        json.dumps(award.evidence or {}, sort_keys=True).encode()
    ).hexdigest()[:12]
    return Path(settings.MEDIA_ROOT) / "badges" / f"{award.id}-{stamp}.png"


def render_share_card(award) -> Path:
    """Render (or reuse) the award's share card; returns the PNG path."""
    out = card_path(award)
    if out.exists():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)

    from PIL import Image, ImageDraw
    import qrcode

    f = _fonts()
    img = Image.new("RGB", (_W, _H), _BG)
    d = ImageDraw.Draw(img)

    # Gold frame + accent bar.
    d.rectangle([24, 24, _W - 24, _H - 24], outline=_GOLD, width=4)
    d.rectangle([24, 24, _W - 24, 40], fill=_GOLD)

    template = BADGE_TEMPLATES.get(award.badge_key, {})
    name = template.get("name", award.badge_key)
    subject = (
        award.player.person.full_name
        if award.player_id and award.player.person_id
        else (award.team.name if award.team_id else "")
    )
    d.text((70, 100), name.upper(), font=f["title"], fill=_GOLD)
    d.text((70, 210), subject, font=f["subject"], fill=_WHITE)

    evidence = _evidence_line(award)
    if evidence:
        d.text((70, 300), evidence, font=f["mono"], fill=_WHITE)
    desc = template.get("description", "")
    if desc:
        d.text((70, 370), desc, font=f["body"], fill=_MUTED)

    d.text((70, _H - 120), award.tournament.name, font=f["body"], fill=_WHITE)
    d.text(
        (70, _H - 74),
        "fixture.doxaed.com", font=f["small"], fill=_MUTED,
    )

    # QR to the public badges gallery (verification).
    url = (
        f"https://fixture.doxaed.com/t/{award.tournament.slug}"
        f"/{award.tournament_id}/badges"
    )
    qr = qrcode.QRCode(box_size=4, border=1)
    qr.add_data(url)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    qr_size = 150
    qr_img = qr_img.resize((qr_size, qr_size))
    img.paste(qr_img, (_W - qr_size - 70, _H - qr_size - 70))

    img.save(out, "PNG")
    return out
