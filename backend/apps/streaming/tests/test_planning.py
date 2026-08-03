"""Pure planning helpers — no I/O, so these are plain unit tests."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from apps.streaming.services.planning import (
    MIN_CHAPTER_SECONDS,
    build_chapters,
    format_timestamp,
    needs_session_rollover,
    vod_offset_seconds,
)

BROADCAST_START = datetime(2026, 8, 3, 3, 30, 0, tzinfo=UTC)


# ------------------------------------------------------------ vod_offset_seconds
def test_offset_subtracts_the_lead_in() -> None:
    match_start = BROADCAST_START + timedelta(minutes=10)
    # 600s into the archive, minus the 15s lead-in so the link lands just
    # before the first serve.
    assert vod_offset_seconds(match_start, BROADCAST_START) == 585


def test_offset_clamps_negatives_to_zero() -> None:
    """A match that 'started' before the broadcast must yield 0, never a negative."""
    earlier = BROADCAST_START - timedelta(minutes=5)
    assert vod_offset_seconds(earlier, BROADCAST_START) == 0


def test_offset_clamps_to_zero_inside_the_lead_in_window() -> None:
    # 10s in, minus a 15s lead-in, would be -5.
    assert vod_offset_seconds(BROADCAST_START + timedelta(seconds=10), BROADCAST_START) == 0


def test_offset_at_exactly_the_lead_in_is_zero() -> None:
    assert vod_offset_seconds(BROADCAST_START + timedelta(seconds=15), BROADCAST_START) == 0


def test_offset_accepts_a_custom_lead_in() -> None:
    match_start = BROADCAST_START + timedelta(minutes=2)
    assert vod_offset_seconds(match_start, BROADCAST_START, lead_in=0) == 120
    assert vod_offset_seconds(match_start, BROADCAST_START, lead_in=30) == 90


def test_offset_floors_fractional_seconds_downwards() -> None:
    match_start = BROADCAST_START + timedelta(seconds=100, microseconds=900_000)
    assert vod_offset_seconds(match_start, BROADCAST_START, lead_in=0) == 100


def test_offset_normalises_across_timezones() -> None:
    kolkata = timezone(timedelta(hours=5, minutes=30))
    match_start = (BROADCAST_START + timedelta(minutes=10)).astimezone(kolkata)
    assert vod_offset_seconds(match_start, BROADCAST_START) == 585


@pytest.mark.parametrize("naive_first", [True, False])
def test_offset_rejects_naive_datetimes(naive_first: bool) -> None:
    naive = datetime(2026, 8, 3, 3, 40, 0)
    args = (naive, BROADCAST_START) if naive_first else (BROADCAST_START, naive)
    with pytest.raises(ValueError, match="timezone-aware"):
        vod_offset_seconds(*args)


# --------------------------------------------------------------- build_chapters
def test_chapters_synthesise_a_leading_zero_timestamp() -> None:
    out = build_chapters([(300, "Match 1"), (900, "Match 2")])
    lines = out.splitlines()
    assert lines[0] == "00:00 Warm-up"
    assert lines[1] == "5:00 Match 1"
    assert lines[2] == "15:00 Match 2"


def test_chapters_keep_a_caller_supplied_zero_entry() -> None:
    out = build_chapters([(0, "Opening"), (300, "Match 1"), (900, "Match 2")])
    assert out.splitlines()[0] == "00:00 Opening"
    assert "Warm-up" not in out


def test_the_first_timestamp_is_literally_double_zero_colon_double_zero() -> None:
    out = build_chapters([(0, "A"), (60, "B"), (120, "C")])
    assert out.startswith("00:00 A")
    assert not out.startswith("0:00 ")


def test_fewer_than_three_chapters_returns_empty_so_the_caller_skips_the_update() -> None:
    assert build_chapters([]) == ""
    assert build_chapters([(300, "Only match")]) == ""  # 00:00 + one = 2 chapters
    assert build_chapters([(0, "A"), (600, "B")]) == ""


def test_exactly_three_chapters_is_accepted() -> None:
    assert build_chapters([(0, "A"), (600, "B"), (1200, "C")]).count("\n") == 2


def test_entries_closer_than_ten_seconds_are_dropped() -> None:
    out = build_chapters([(0, "A"), (5, "B"), (9, "C"), (600, "D"), (1200, "E")])
    assert [line.split(" ", 1)[1] for line in out.splitlines()] == ["A", "D", "E"]


def test_exactly_ten_seconds_apart_is_allowed() -> None:
    out = build_chapters([(0, "A"), (10, "B"), (20, "C")])
    assert out.splitlines() == ["00:00 A", "0:10 B", "0:20 C"]


def test_dropping_below_three_chapters_returns_empty() -> None:
    # 00:00 + three entries all inside the 10s window -> 1 usable chapter.
    assert build_chapters([(1, "A"), (2, "B"), (3, "C")]) == ""


def test_min_gap_is_configurable() -> None:
    assert build_chapters([(0, "A"), (5, "B"), (10, "C")], min_gap=5).count("\n") == 2
    assert MIN_CHAPTER_SECONDS == 10


def test_entries_are_sorted_and_deduplicated() -> None:
    out = build_chapters([(1200, "C"), (0, "A"), (600, "B"), (1200, "C again")])
    assert out.splitlines() == ["00:00 A", "10:00 B", "20:00 C"]


def test_timestamps_switch_to_hours_past_one_hour() -> None:
    # 3590 -> 3600 is exactly the 10s minimum, so both survive and the format
    # switch at the hour boundary is what is actually under test.
    out = build_chapters([(0, "Warm-up"), (3590, "Just under"), (3600, "On the hour")])
    assert out.splitlines() == [
        "00:00 Warm-up",
        "59:50 Just under",
        "1:00:00 On the hour",
    ]


def test_long_day_timestamps_are_h_mm_ss() -> None:
    out = build_chapters([(0, "A"), (3661, "B"), (39_845, "C")])
    assert out.splitlines() == ["00:00 A", "1:01:01 B", "11:04:05 C"]


def test_labels_are_flattened_so_a_newline_cannot_break_the_list() -> None:
    out = build_chapters([(0, "A"), (600, "Semi\nfinal   1"), (1200, "  C  ")])
    assert out.splitlines() == ["00:00 A", "10:00 Semi final 1", "20:00 C"]


def test_blank_labels_are_dropped() -> None:
    out = build_chapters([(0, "A"), (600, "   "), (1200, "C"), (1800, "D")])
    assert out.splitlines() == ["00:00 A", "20:00 C", "30:00 D"]


def test_negative_offsets_are_clamped_not_rejected() -> None:
    out = build_chapters([(-30, "Before"), (600, "B"), (1200, "C")])
    assert out.splitlines()[0] == "00:00 Before"


def test_a_blank_lead_label_cannot_forge_a_zero_chapter() -> None:
    assert build_chapters([(600, "B"), (1200, "C")], lead_label="  ") == ""


@pytest.mark.parametrize(
    ("seconds", "expected"),
    [
        (0, "00:00"),
        (-5, "00:00"),
        (9, "0:09"),
        (59, "0:59"),
        (60, "1:00"),
        (3599, "59:59"),
        (3600, "1:00:00"),
        (3661, "1:01:01"),
        (43_200, "12:00:00"),
    ],
)
def test_format_timestamp(seconds: int, expected: str) -> None:
    assert format_timestamp(seconds) == expected


# -------------------------------------------------------- needs_session_rollover
def test_rollover_is_false_below_the_limit() -> None:
    now = BROADCAST_START + timedelta(hours=10, minutes=59, seconds=59)
    assert needs_session_rollover(BROADCAST_START, now) is False


def test_rollover_is_true_at_exactly_eleven_hours() -> None:
    """The boundary is a deadline, not a target — 11:00:00 rolls over."""
    now = BROADCAST_START + timedelta(hours=11)
    assert needs_session_rollover(BROADCAST_START, now) is True


def test_rollover_is_true_past_the_limit() -> None:
    now = BROADCAST_START + timedelta(hours=11, seconds=1)
    assert needs_session_rollover(BROADCAST_START, now) is True


def test_rollover_limit_is_configurable() -> None:
    now = BROADCAST_START + timedelta(hours=6)
    assert needs_session_rollover(BROADCAST_START, now, limit_hours=6) is True
    assert needs_session_rollover(BROADCAST_START, now, limit_hours=6.5) is False


def test_rollover_fires_before_youtubes_twelve_hour_archive_cliff() -> None:
    """11h default leaves an hour of margin before the 12h no-archive cliff."""
    twelve = BROADCAST_START + timedelta(hours=12)
    assert needs_session_rollover(BROADCAST_START, twelve - timedelta(hours=1)) is True


def test_rollover_rejects_naive_datetimes() -> None:
    naive = datetime(2026, 8, 3, 15, 0, 0)
    with pytest.raises(ValueError, match="timezone-aware"):
        needs_session_rollover(BROADCAST_START, naive)
    with pytest.raises(ValueError, match="timezone-aware"):
        needs_session_rollover(naive, BROADCAST_START)
