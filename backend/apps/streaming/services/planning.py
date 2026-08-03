"""Pure planning helpers for the live-streaming pipeline. No I/O, no models.

Three jobs, each of which exists because of a specific YouTube behaviour that
bites in production:

* :func:`vod_offset_seconds` — where a match sits inside the day's archive.
* :func:`build_chapters` — a chapter list YouTube will actually accept.
* :func:`needs_session_rollover` — split the day before YouTube refuses to
  archive it at all.

Everything here takes aware datetimes and plain values and returns plain values,
so it is unit-testable without a database, a network, or Django.
"""
from __future__ import annotations

import math
import re
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Final

#: YouTube requires the first chapter to be exactly 00:00 and rejects the whole
#: list otherwise (it silently renders no chapters at all — no error, no hint).
_FIRST_TIMESTAMP: Final = "00:00"

#: YouTube requires at least three chapters, each at least 10 seconds long.
MIN_CHAPTERS: Final = 3
MIN_CHAPTER_SECONDS: Final = 10

#: Sessions longer than 12 hours may not be archived by YouTube AT ALL, so we
#: force a rollover an hour early. See :func:`needs_session_rollover`.
DEFAULT_SESSION_LIMIT_HOURS: Final = 11.0

_WHITESPACE = re.compile(r"\s+")


def vod_offset_seconds(
    match_started_at: datetime,
    broadcast_actual_start: datetime,
    lead_in: int = 15,
) -> int:
    """Seconds into the archive where a match's deep-link should point.

    The archive clock starts when the *broadcast* went live, which is earlier
    than the match — the court's encoder is pushing while players warm up. So
    the offset is ``match_started_at - broadcast_actual_start``, minus a
    ``lead_in`` so the link lands just *before* the first serve instead of a
    beat after it (arriving mid-rally reads as a broken link).

    Clamped at 0: a match whose recorded start precedes the broadcast's — clock
    skew between the scorer's tablet and YouTube, or a match started before the
    stream was up — must produce ``0``, not a negative ``&t=`` that YouTube
    ignores or that renders as a broken timestamp in a chapter list.

    Floors to whole seconds (YouTube's ``&t=`` is integer seconds anyway) and
    rounds *down*, keeping the "just before" guarantee.

    :raises ValueError: if either datetime is naive. Comparing a naive local
        time with an aware UTC one is how you get an offset that is exactly the
        timezone offset wrong — 5h30m into the wrong match, in this deployment.
    """
    _require_aware(match_started_at, "match_started_at")
    _require_aware(broadcast_actual_start, "broadcast_actual_start")

    delta = (match_started_at - broadcast_actual_start).total_seconds() - lead_in
    if delta <= 0:
        return 0
    return math.floor(delta)


def build_chapters(
    entries: Sequence[tuple[int, str]],
    *,
    lead_label: str = "Warm-up",
    min_gap: int = MIN_CHAPTER_SECONDS,
) -> str:
    """Render ``(offset_seconds, label)`` pairs as a YouTube chapter block.

    YouTube's chapter rules are strict and **fail silently** — break any one of
    them and the video simply shows no chapters, with no error anywhere:

    1. the first timestamp must be exactly ``00:00``;
    2. there must be at least three chapters;
    3. timestamps must be strictly ascending;
    4. every chapter must be at least 10 seconds long.

    This function enforces all four:

    * a leading ``00:00`` entry (``lead_label``, default "Warm-up") is
      synthesised when the first match starts later than the broadcast;
    * entries are sorted and de-duplicated;
    * an entry closer than ``min_gap`` to the previously kept one is **dropped**
      (merged into its predecessor) rather than shifted — a 4-second "chapter"
      is a scoring glitch, not a real segment, and shifting timestamps would
      make every later link point at the wrong rally;
    * if fewer than :data:`MIN_CHAPTERS` survive, returns ``""`` so the caller
      **skips the description update entirely** rather than writing a list
      YouTube will ignore.

    Timestamps are ``M:SS`` under an hour and ``H:MM:SS`` from an hour on; the
    first is always the literal ``00:00``.

    .. note::
       Rule 4 also applies to the *last* chapter, which needs 10 seconds of
       video after it. We cannot check that here — the archive length is not
       known at build time. The caller should drop a trailing chapter that
       starts within 10s of the broadcast's end.

    :returns: newline-joined ``"<timestamp> <label>"`` lines, or ``""``.
    """
    normalised: list[tuple[int, str]] = []
    for offset, label in entries:
        clean = _clean_label(label)
        if not clean:
            continue
        normalised.append((max(0, int(offset)), clean))

    # Stable sort: equal offsets keep caller order, and the first of them wins
    # the de-duplication below.
    normalised.sort(key=lambda pair: pair[0])

    if not normalised or normalised[0][0] != 0:
        lead = _clean_label(lead_label)
        if lead:
            normalised.insert(0, (0, lead))

    kept: list[tuple[int, str]] = []
    for offset, label in normalised:
        if not kept:
            kept.append((offset, label))
            continue
        if offset - kept[-1][0] >= min_gap:
            kept.append((offset, label))
        # else: too close to the previous chapter -> merged into it (dropped).

    if len(kept) < MIN_CHAPTERS or kept[0][0] != 0:
        return ""

    return "\n".join(f"{format_timestamp(offset)} {label}" for offset, label in kept)


def format_timestamp(seconds: int) -> str:
    """Seconds -> a YouTube chapter timestamp.

    ``0`` renders as the literal ``00:00`` (YouTube wants the first chapter in
    exactly that form); otherwise ``M:SS`` below an hour and ``H:MM:SS`` from an
    hour up. Negative input is clamped to 0.
    """
    total = max(0, int(seconds))
    if total == 0:
        return _FIRST_TIMESTAMP
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def needs_session_rollover(
    actual_start: datetime,
    now: datetime,
    limit_hours: float = DEFAULT_SESSION_LIMIT_HOURS,
) -> bool:
    """Has this broadcast run long enough that we must split the session?

    **YouTube may not archive a stream longer than 12 hours at all.** Not
    truncate — not archive. A tournament day that runs 07:00 to 19:30 on one
    broadcast can therefore end with no VOD whatsoever, which destroys every
    match deep-link for that court retroactively.

    So we force-complete at ``limit_hours`` (default 11, an hour of margin for
    the transition and for clock disagreement) and open a "Session 2" bound to
    the **same reusable stream** — the court's encoder keeps pushing to the same
    key and never has to be touched.

    Returns ``True`` at exactly the limit (``>=``): the boundary is a deadline,
    not a target.

    :raises ValueError: if either datetime is naive.
    """
    _require_aware(actual_start, "actual_start")
    _require_aware(now, "now")
    return (now - actual_start) >= timedelta(hours=limit_hours)


# --------------------------------------------------------------------- private
def _require_aware(value: datetime, name: str) -> None:
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise ValueError(f"{name} must be timezone-aware (UTC); got naive {value!r}")


def _clean_label(label: str) -> str:
    """Collapse whitespace and strip newlines.

    A newline inside a label would split one chapter into two malformed lines
    and take the whole list down with it (rule 3 breaks, chapters vanish).
    """
    return _WHITESPACE.sub(" ", str(label)).strip()
