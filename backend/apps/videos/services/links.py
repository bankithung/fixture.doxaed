"""Reading a published video link.

A host pastes whatever their browser gave them, which for YouTube alone is five
different shapes. The id is what an embed needs, so parsing happens ONCE here
and both the API and the page read the result.
"""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

#: youtu.be/ID, /watch?v=ID, /embed/ID, /shorts/ID, /live/ID
_YT_PATH = re.compile(r"^/(?:embed|shorts|live|v)/([A-Za-z0-9_-]{6,})")
_YT_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com",
    "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com",
}


def youtube_id(url: str) -> str:
    """The video id in a YouTube link, or "" when it is not one.

    Never raises: a host pasting a malformed link gets an entry with no
    embed, not a 500.
    """
    if not url:
        return ""
    try:
        p = urlparse(url.strip())
    except ValueError:
        return ""
    host = (p.hostname or "").lower()
    if host in ("youtu.be", "www.youtu.be"):
        seg = p.path.lstrip("/").split("/")[0]
        return seg if re.fullmatch(r"[A-Za-z0-9_-]{6,}", seg or "") else ""
    if host not in _YT_HOSTS:
        return ""
    m = _YT_PATH.match(p.path or "")
    if m:
        return m.group(1)
    vid = (parse_qs(p.query or "").get("v") or [""])[0]
    return vid if re.fullmatch(r"[A-Za-z0-9_-]{6,}", vid or "") else ""


def is_http_url(url: str) -> bool:
    """A link we are willing to store and later hand to a browser."""
    if not url:
        return False
    try:
        p = urlparse(url.strip())
    except ValueError:
        return False
    return p.scheme in ("http", "https") and bool(p.netloc)


def clean_link(url: object) -> str:
    """Normalise one submitted link. Anything that is not an http(s) URL is
    dropped rather than stored, so the page never renders a javascript: href."""
    s = str(url or "").strip()[:500]
    return s if is_http_url(s) else ""
