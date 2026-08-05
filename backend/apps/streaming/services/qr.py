"""The phone broadcast URL, and the QR code that gets it onto a phone.

Owner, 2026-08-05: *"look how the fuck do you think the user will know the
link"* — with the real problem underneath it being that

    https://fixture.doxaed.com/broadcast/t/<slug>/<id>/court/Court%20%C2%B7%20T1

is only ever **copyable on a laptop**. A clipboard button on a laptop cannot
put a URL onto the handset that is going to film the match, and nobody types
``%C2%B7`` on a phone keyboard. A QR code is the only control that crosses that
gap, so the setup page renders one per court and this module is what draws it.

Two rules the rest of the file exists to keep:

* **The court in the URL is the fixture's venue display string**, not the
  court's UUID (``matchesOnCourt``/``normalizeCourt`` in
  ``frontend/src/features/overlay/overlayState.ts`` compare the path segment
  against ``Match.venue``). ``Court2 · T3`` therefore has to leave here as
  ``Court2%20%C2%B7%20T3``, byte for byte what ``routes.broadcastCourt``
  produces in the client — :func:`_quote_court` is ``encodeURIComponent``, not
  Python's default ``quote``.
* **The payload is absolute**, scheme and host included: a QR is scanned by a
  camera that has no page to be relative to.

Rendering follows the ``qrcode`` idiom already used three times in this
codebase (``apps/lens/services/passes.py``, ``apps/accounts/services/twofa.py``,
``apps/badges/services/cards.py``) — the ``QRCode(box_size=…, border=…)`` form
from the badges share card, because this one is scanned off a laptop screen
from arm's length and has to be big.
"""
from __future__ import annotations

import io
from urllib.parse import quote

from django.conf import settings as django_settings

#: ``encodeURIComponent``'s unreserved set. Python's ``quote`` leaves
#: ``A-Za-z0-9_.-~`` alone; JavaScript also leaves ``!*'()``. Passing them as
#: ``safe`` is what makes the two encoders agree — and they MUST agree, because
#: the URL in the QR and the URL under the copy button are the same URL and an
#: organiser comparing them must not see two strings.
_JS_SAFE = "!*'()"

#: Big enough to scan from arm's length off a laptop screen: a ~100-character
#: URL is a version 6-7 symbol (41-45 modules), so 10px modules + a 4-module
#: quiet zone is a ~530px PNG. Smaller than this is where scanning starts to
#: fail on cheap handsets, which is the whole reason the page exists.
_BOX_SIZE = 10
_BORDER = 4


def _quote_court(court_name: str) -> str:
    """The venue string as ``encodeURIComponent`` would leave it."""
    return quote(court_name, safe=_JS_SAFE)


def public_base_url(request=None) -> str:
    """Absolute ``scheme://host`` for links we hand out.

    ``PUBLIC_BASE_URL`` wins when it is configured (the idiom the rest of the
    backend uses), because that is the deployment's own statement about which
    host is public. Otherwise the request's own origin is used rather than a
    hard-coded production host: a QR generated on a staging or local instance
    has to open THAT instance, or it silently sends a volunteer's phone to a
    tournament that is not theirs.
    """
    configured = getattr(django_settings, "PUBLIC_BASE_URL", "")
    if configured:
        return str(configured).rstrip("/")
    if request is not None:
        return request.build_absolute_uri("/").rstrip("/")
    return "https://fixture.doxaed.com"


def broadcast_court_url(base_url: str, tournament, court) -> str:
    """The absolute phone camera + scoreboard URL for ONE court.

    Mirrors ``routes.broadcastCourt(slug, id, court)`` in the client exactly —
    same path, same encoding. Two producers of one string is a risk taken
    knowingly: the client needs it without a round trip (copy button, selectable
    text) and the QR renderer needs it server-side, and both are pinned by
    tests to the same ``Court2%20%C2%B7%20T3`` shape.
    """
    return (
        f"{base_url}/broadcast/t/{quote(str(tournament.slug), safe=_JS_SAFE)}"
        f"/{tournament.id}/court/{_quote_court(court.name)}"
    )


def qr_png(payload: str, *, box_size: int = _BOX_SIZE, border: int = _BORDER) -> bytes:
    """A black-on-white PNG encoding ``payload``.

    Error correction stays at the library default (M, ~15%): a screen-rendered
    code is not going to be smudged or printed badly, and a lower version keeps
    the modules large, which is what actually decides whether a phone locks on.
    """
    import qrcode

    qr = qrcode.QRCode(box_size=box_size, border=border)
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
