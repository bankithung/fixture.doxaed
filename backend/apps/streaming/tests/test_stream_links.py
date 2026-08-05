"""``StreamLink`` — the hand-pasted watch links, and the precedence rule that
decides which one a spectator actually gets.

The rule (owner, 2026-08-04: *"per court and per day there will be one live
stream link… there can also be one per sport category, or even per match"*,
most-specific-wins), resolving a match:

1. the link on that match
2. the link for that match's court on that match's day
3. the auto-created ``CourtBroadcast`` for that court+day
4. the link for that match's sport category (its ``leaf_key``)
5. the court's standing ``CourtStream``
6. ``None``

Two things this file exists to pin, beyond "each level wins":

* **a hand-pasted day link beats the automation** (2 over 3) — the human is the
  one looking at the encoder — while the automation still beats anything less
  specific than the day it belongs to (3 over 4 and 5);
* **``&t=`` is a level-3-only suffix.** It is an offset into the broadcast's own
  recording, so appending it to a pasted URL would seek into someone else's
  video (or into a ``youtu.be`` link where the separator is not even ``&``).

Every day in here is derived from the match under test — ``local_day(kickoff,
tz)``, never ``local_day()``. A link filed under "today" plus a match pinned to
a fixed date agree on exactly one calendar day of the year; this suite has been
bitten by that twice already.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from django.db import IntegrityError, transaction

from apps.matches.models import MatchStatus
from apps.streaming.models import BroadcastLifecycle, StreamLink, StreamLinkScope
from apps.streaming.services.links import (
    CourtLinkResolver,
    local_day,
    watch_url_for_court,
    watch_url_for_match,
)
from apps.streaming.tests.support import (
    CATEGORY_LINK_URL,
    COURT_DAY_LINK_URL,
    COURT_STREAM_URL,
    MATCH_LINK_URL,
    VIDEO_ID,
    WATCH_URL,
    make_broadcast,
    make_category_link,
    make_court_day_link,
    make_match,
    make_match_link,
    make_stream,
    make_tournament,
    tz_of,
    with_categories,
)

pytestmark = pytest.mark.django_db

#: The one instant every test in this file schedules against. Fixed, not
#: "today", and every derived day comes off it.
KICKOFF = datetime(2026, 8, 3, 11, 0)


def _kickoff(t) -> datetime:
    return KICKOFF.replace(tzinfo=tz_of(t))


def _ladder(levels: set[str], *, status: str = MatchStatus.SCHEDULED):
    """A tournament with exactly ``levels`` of the precedence ladder set.

    Returns ``(tournament, court, match)``. Building every scenario from one
    function is deliberate: a level "falling through when unset" and the next
    level "winning" are the same experiment run twice, and writing them apart
    is how the two drift.
    """
    _admin, t, courts = make_tournament()
    leaf, _other = with_categories(t)
    court = courts[0]
    tz = tz_of(t)
    kickoff = _kickoff(t)
    day = local_day(kickoff, tz)

    m = make_match(
        t,
        court,
        status=status,
        scheduled_at=kickoff,
        started_at=kickoff if status != MatchStatus.SCHEDULED else None,
        leaf_key=leaf,
    )
    if "match" in levels:
        make_match_link(m)
    if "court_day" in levels:
        make_court_day_link(court, day)
    if "broadcast" in levels:
        make_broadcast(
            court,
            day,
            video_id=VIDEO_ID,
            actual_start_utc=kickoff - timedelta(hours=1),
            lifecycle=BroadcastLifecycle.COMPLETE,
        )
    if "category" in levels:
        make_category_link(t, leaf)
    if "stream" in levels:
        make_stream(court, watch_url=COURT_STREAM_URL)
    return t, court, m


ALL_LEVELS = ["match", "court_day", "broadcast", "category", "stream"]


# --------------------------------------------------- each level, in its turn
@pytest.mark.parametrize(
    ("levels", "expected"),
    [
        # The full ladder: the most specific rung wins…
        (ALL_LEVELS, MATCH_LINK_URL),
        # …and knocking out that rung promotes exactly the next one down.
        (ALL_LEVELS[1:], COURT_DAY_LINK_URL),
        (ALL_LEVELS[2:], WATCH_URL),
        (ALL_LEVELS[3:], CATEGORY_LINK_URL),
        (ALL_LEVELS[4:], COURT_STREAM_URL),
        ([], None),
        # Every rung in isolation resolves to itself — a level must not need a
        # lower one present to work.
        (["match"], MATCH_LINK_URL),
        (["court_day"], COURT_DAY_LINK_URL),
        (["broadcast"], WATCH_URL),
        (["category"], CATEGORY_LINK_URL),
        (["stream"], COURT_STREAM_URL),
        # The two orderings the owner asked about by name.
        (["match", "court_day"], MATCH_LINK_URL),
        (["court_day", "broadcast"], COURT_DAY_LINK_URL),
        (["broadcast", "category"], WATCH_URL),
        (["broadcast", "stream"], WATCH_URL),
        (["category", "stream"], CATEGORY_LINK_URL),
    ],
)
def test_the_precedence_ladder(levels, expected):
    t, _court, m = _ladder(set(levels))
    assert watch_url_for_match(m, tz=tz_of(t)) == expected


def test_a_match_link_beats_a_court_day_link():
    """Stated on its own because it is the owner's headline case: 'even per
    match it can be different'."""
    t, _court, m = _ladder({"match", "court_day", "broadcast", "stream"})
    assert watch_url_for_match(m, tz=tz_of(t)) == MATCH_LINK_URL


def test_a_court_day_link_beats_the_auto_created_broadcast():
    """The one inversion of "newest automation wins": a human pasting today's
    link for this court is overruling the API, on purpose."""
    t, court, m = _ladder({"court_day", "broadcast", "stream"})
    assert watch_url_for_match(m, tz=tz_of(t)) == COURT_DAY_LINK_URL
    # …and the court-level resolver agrees, for the same day.
    assert watch_url_for_court(
        court, _kickoff(t), tz=tz_of(t)
    ) == COURT_DAY_LINK_URL


def test_the_broadcast_still_beats_a_category_link():
    """A category link is a standing default; today's broadcast is a statement
    about today. Less specific must not overtake more specific."""
    t, _court, m = _ladder({"broadcast", "category", "stream"})
    assert watch_url_for_match(m, tz=tz_of(t)) == WATCH_URL


# ------------------------------------------------- falling through when unset
def test_a_disabled_link_falls_through_to_the_next_level():
    """``enabled=False`` is an off switch that actually switches off — unlike
    ``CourtStream.enabled``, which only gates "is this court on air". An
    override you cannot un-override without deleting the row is a trap."""
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    kickoff = _kickoff(t)
    make_court_day_link(courts[0], local_day(kickoff, tz), enabled=False)
    make_stream(courts[0], watch_url=COURT_STREAM_URL)
    m = make_match(t, courts[0], scheduled_at=kickoff)
    assert watch_url_for_match(m, tz=tz) == COURT_STREAM_URL


def test_a_blank_url_on_a_link_falls_through_rather_than_blanking_the_match():
    """A cleared binding means "this level is not set", not "this match has no
    stream" — otherwise clearing the most specific rung would black out the
    match instead of handing it back to the court."""
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    kickoff = _kickoff(t)
    m = make_match(t, courts[0], scheduled_at=kickoff)
    make_match_link(m, watch_url="")
    make_stream(courts[0], watch_url=COURT_STREAM_URL)
    assert watch_url_for_match(m, tz=tz) == COURT_STREAM_URL


def test_a_soft_deleted_link_stops_resolving():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    kickoff = _kickoff(t)
    m = make_match(t, courts[0], scheduled_at=kickoff)
    link = make_match_link(m)
    make_stream(courts[0], watch_url=COURT_STREAM_URL)
    assert watch_url_for_match(m, tz=tz) == MATCH_LINK_URL
    link.deleted_at = datetime.now(UTC)
    link.save(update_fields=["deleted_at"])
    assert watch_url_for_match(m, tz=tz) == COURT_STREAM_URL


def test_a_court_day_link_belongs_to_ITS_day_only():
    """The whole point of the court+day scope: yesterday's link must not follow
    the court into today, and today's must not rewrite yesterday's results."""
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    day1 = _kickoff(t)
    day2 = day1 + timedelta(days=1)
    make_court_day_link(courts[0], local_day(day2, tz))
    make_stream(courts[0], watch_url=COURT_STREAM_URL)
    m1 = make_match(t, courts[0], match_no=1, scheduled_at=day1)
    m2 = make_match(t, courts[0], match_no=2, scheduled_at=day2)
    assert watch_url_for_match(m1, tz=tz) == COURT_STREAM_URL
    assert watch_url_for_match(m2, tz=tz) == COURT_DAY_LINK_URL


def test_a_category_link_only_covers_its_own_leaf():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    u15, u17 = with_categories(t)
    kickoff = _kickoff(t)
    make_category_link(t, u15)
    mine = make_match(t, courts[0], match_no=1, scheduled_at=kickoff, leaf_key=u15)
    theirs = make_match(t, courts[0], match_no=2, scheduled_at=kickoff, leaf_key=u17)
    assert watch_url_for_match(mine, tz=tz) == CATEGORY_LINK_URL
    assert watch_url_for_match(theirs, tz=tz) is None


def test_a_blank_leaf_key_match_never_matches_a_category_link():
    """A blank ``leaf_key`` is the legacy whole-tournament draw, not a category
    — it must not collide with a category row."""
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    leaf, _other = with_categories(t)
    make_category_link(t, leaf)
    m = make_match(t, courts[0], scheduled_at=_kickoff(t), leaf_key="")
    assert watch_url_for_match(m, tz=tz) is None


def test_a_category_link_does_not_cross_tournaments():
    """Leaf keys are only unique WITHIN a tournament — ``football.u15`` exists
    in every football tournament in the country."""
    _admin_a, t_a, courts_a = make_tournament(name="Cup A")
    _admin_b, t_b, courts_b = make_tournament(name="Cup B")
    leaf, _other = with_categories(t_a)
    with_categories(t_b)
    make_category_link(t_a, leaf)
    mine = make_match(t_a, courts_a[0], scheduled_at=_kickoff(t_a), leaf_key=leaf)
    theirs = make_match(t_b, courts_b[0], scheduled_at=_kickoff(t_b), leaf_key=leaf)
    assert watch_url_for_match(mine, tz=tz_of(t_a)) == CATEGORY_LINK_URL
    assert watch_url_for_match(theirs, tz=tz_of(t_b)) is None


# ------------------------------------------------- links without a court at all
def test_a_match_link_resolves_for_a_match_with_no_court():
    """Levels 1 and 4 are pinned to the match, not to a surface — a fixture
    that has not been given a court yet can still be watchable."""
    _admin, t, _courts = make_tournament()
    m = make_match(t, None, scheduled_at=_kickoff(t))
    make_match_link(m)
    assert watch_url_for_match(m, tz=tz_of(t)) == MATCH_LINK_URL


def test_a_category_link_resolves_for_a_match_with_no_court():
    _admin, t, _courts = make_tournament()
    leaf, _other = with_categories(t)
    m = make_match(t, None, scheduled_at=_kickoff(t), leaf_key=leaf)
    make_category_link(t, leaf)
    assert watch_url_for_match(m, tz=tz_of(t)) == CATEGORY_LINK_URL


# --------------------------------------------------------- the &t= suffix rule
@pytest.mark.parametrize(
    ("levels", "expected"),
    [
        (["match", "broadcast", "stream"], MATCH_LINK_URL),
        (["court_day", "broadcast", "stream"], COURT_DAY_LINK_URL),
        (["category", "stream"], CATEGORY_LINK_URL),
    ],
)
def test_the_vod_offset_is_never_appended_to_a_hand_pasted_link(levels, expected):
    """The match is FINISHED and the broadcast has an ``actual_start_utc``, so
    every ingredient for a ``&t=`` is present — and it must still not appear:
    the offset is measured into the broadcast's own recording."""
    t, _court, m = _ladder(set(levels), status=MatchStatus.COMPLETED)
    url = watch_url_for_match(m, tz=tz_of(t))
    assert url == expected
    assert "&t=" not in url


def test_the_vod_offset_is_still_appended_when_the_broadcast_wins():
    t, _court, m = _ladder(
        {"broadcast", "category", "stream"}, status=MatchStatus.COMPLETED
    )
    assert watch_url_for_match(m, tz=tz_of(t)) == f"{WATCH_URL}&t={3600 - 15}"


# ------------------------------ the day a match belongs to (production case)
#: A second court-day URL, so a test asserting WHICH day's link won reads as the
#: answer rather than as "the same constant twice".
OTHER_DAY_LINK_URL = "https://www.youtube.com/watch?v=0therDayLnk"


def _delayed(t, court, *, status=MatchStatus.LIVE, match_no: int = 1):
    """A match SCHEDULED for one day and STARTED on another — the shape 27 of
    "Dimapur Tourni"'s 122 matches were in on 2026-08-05, including the one that
    was live on the public page with no "Watch live" button::

        Court · T1   scheduled 2026-08-29 05:20+00   started 2026-08-05 05:05+00

    Returns ``(match, started_day, scheduled_day)``. Both days come off
    ``KICKOFF``, 26 days apart and in production's direction (started BEFORE the
    day the fixture list was published under). Deriving either from
    ``local_day()`` would make the test agree with the calendar on one day of
    the year — this suite has been bitten by exactly that four times.
    """
    tz = tz_of(t)
    started = _kickoff(t)
    scheduled = started + timedelta(days=26)
    m = make_match(
        t,
        court,
        match_no=match_no,
        status=status,
        scheduled_at=scheduled,
        started_at=started,
    )
    return m, local_day(started, tz), local_day(scheduled, tz)


def test_a_match_started_off_its_scheduled_day_takes_the_scheduled_days_link():
    """THE production bug. The organiser pasted one ``court_day`` link per court
    for the published day; every match started on some other date resolved to
    nothing at all, and the live one showed no button."""
    _admin, t, courts = make_tournament()
    m, _started_day, scheduled_day = _delayed(t, courts[0])
    make_court_day_link(courts[0], scheduled_day)
    assert watch_url_for_match(m, tz=tz_of(t)) == COURT_DAY_LINK_URL


def test_the_started_days_link_wins_when_both_days_have_one():
    """The fallback is a fallback: a genuinely delayed match belongs to the day
    it really ran on, and that day's link is the one the organiser is watching."""
    _admin, t, courts = make_tournament()
    m, started_day, scheduled_day = _delayed(t, courts[0])
    make_court_day_link(courts[0], started_day, watch_url=COURT_DAY_LINK_URL)
    make_court_day_link(courts[0], scheduled_day, watch_url=OTHER_DAY_LINK_URL)
    assert watch_url_for_match(m, tz=tz_of(t)) == COURT_DAY_LINK_URL


def test_the_scheduled_days_link_still_outranks_the_started_days_broadcast():
    """Level before day: the day fallback refines WHICH key level 2 is looked up
    under, it does not demote level 2 below level 3. A human who pasted a link
    for the published day still overrules the automation."""
    _admin, t, courts = make_tournament()
    m, started_day, scheduled_day = _delayed(t, courts[0])
    make_court_day_link(courts[0], scheduled_day)
    make_broadcast(courts[0], started_day, video_id=VIDEO_ID)
    assert watch_url_for_match(m, tz=tz_of(t)) == COURT_DAY_LINK_URL


def test_the_started_days_broadcast_beats_the_scheduled_days():
    _admin, t, courts = make_tournament()
    m, started_day, scheduled_day = _delayed(t, courts[0])
    make_broadcast(courts[0], started_day, video_id=VIDEO_ID)
    make_broadcast(courts[0], scheduled_day, video_id="Sched0uledB")
    assert watch_url_for_match(m, tz=tz_of(t)) == WATCH_URL


def test_no_vod_offset_when_the_broadcast_came_from_the_fallback_day():
    """``&t=`` is seconds into THIS recording. A broadcast reached through the
    scheduled-day fallback is not the recording the match ran inside: here the
    subtraction is negative by 26 days, which ``vod_offset_seconds`` clamps to
    ``&t=0`` — a link that claims the match is at the very top of an archive it
    does not appear in. No offset at all is the honest answer."""
    _admin, t, courts = make_tournament()
    m, _started_day, scheduled_day = _delayed(t, courts[0], status=MatchStatus.COMPLETED)
    make_broadcast(
        courts[0],
        scheduled_day,
        video_id=VIDEO_ID,
        actual_start_utc=_kickoff(t) + timedelta(days=26, hours=-1),
        lifecycle=BroadcastLifecycle.COMPLETE,
    )
    url = watch_url_for_match(m, tz=tz_of(t))
    assert url == WATCH_URL
    assert "&t=" not in url


def test_the_offset_is_still_appended_on_the_day_the_match_really_ran():
    """The other half of the rule: the guard must not cost a delayed match the
    deep link into the archive it IS in."""
    _admin, t, courts = make_tournament()
    m, started_day, scheduled_day = _delayed(t, courts[0], status=MatchStatus.COMPLETED)
    make_broadcast(
        courts[0],
        started_day,
        video_id=VIDEO_ID,
        actual_start_utc=_kickoff(t) - timedelta(hours=1),
        lifecycle=BroadcastLifecycle.COMPLETE,
    )
    make_broadcast(courts[0], scheduled_day, video_id="Sched0uledB")
    assert watch_url_for_match(m, tz=tz_of(t)) == f"{WATCH_URL}&t={3600 - 15}"


def test_a_link_on_neither_of_the_matchs_days_still_does_not_apply():
    """The fallback adds ONE day, it does not make court-day links global — a
    link for some third day must stay where it was pasted."""
    _admin, t, courts = make_tournament()
    m, started_day, _scheduled_day = _delayed(t, courts[0])
    make_court_day_link(courts[0], started_day + timedelta(days=1))
    make_stream(courts[0], watch_url=COURT_STREAM_URL)
    assert watch_url_for_match(m, tz=tz_of(t)) == COURT_STREAM_URL


@pytest.mark.parametrize(
    "setup",
    [
        # (which day gets a link, which day gets a broadcast) — every
        # combination the fallback can reach, so the two implementations are
        # compared on the fallback itself and not only on the happy path.
        ("scheduled", None),
        ("started", None),
        ("both", None),
        (None, "scheduled"),
        (None, "started"),
        (None, "both"),
        ("scheduled", "started"),
        ("started", "scheduled"),
    ],
)
def test_the_bulk_resolver_agrees_with_the_single_row_helper_on_the_fallback(setup):
    link_day, broadcast_day = setup
    _admin, t, courts = make_tournament()
    court = courts[0]
    m, started_day, scheduled_day = _delayed(t, court, status=MatchStatus.COMPLETED)
    days = {"started": [started_day], "scheduled": [scheduled_day],
            "both": [started_day, scheduled_day]}
    for day in days.get(link_day, []):
        make_court_day_link(
            court,
            day,
            watch_url=(
                COURT_DAY_LINK_URL if day == started_day else OTHER_DAY_LINK_URL
            ),
        )
    for day in days.get(broadcast_day, []):
        make_broadcast(
            court,
            day,
            video_id=VIDEO_ID if day == started_day else "Sched0uledB",
            actual_start_utc=_kickoff(t) - timedelta(hours=1),
            lifecycle=BroadcastLifecycle.COMPLETE,
        )
    single = watch_url_for_match(m, tz=tz_of(t))
    r = CourtLinkResolver([court], tz=tz_of(t), tournament=t)
    assert r.watch_url_for_match(m) == single
    assert single is not None  # every combination resolves to SOMETHING


def test_the_fallback_costs_the_bulk_resolver_no_extra_query(
    django_assert_num_queries,
):
    """Still three queries, and still zero per match: broadcasts and court-day
    links are preloaded for every day, so the second day is a dict lookup."""
    _admin, t, courts = make_tournament()
    matches = []
    for i, court in enumerate(courts):
        m, _started, scheduled_day = _delayed(t, court, match_no=i + 1)
        make_court_day_link(court, scheduled_day)
        matches.append(m)
    with django_assert_num_queries(3):
        r = CourtLinkResolver(courts, tz=tz_of(t), tournament=t)
    with django_assert_num_queries(0):
        urls = [r.watch_url_for_match(m) for m in matches]
    assert urls == [COURT_DAY_LINK_URL] * len(matches)


# ------------------------------------------------------------ court resolution
def test_watch_url_for_court_walks_levels_2_3_5():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    when = _kickoff(t)
    day = local_day(when, tz)
    court = courts[0]
    make_stream(court, watch_url=COURT_STREAM_URL)
    assert watch_url_for_court(court, when, tz=tz) == COURT_STREAM_URL
    make_broadcast(court, day, video_id=VIDEO_ID)
    assert watch_url_for_court(court, when, tz=tz) == WATCH_URL
    make_court_day_link(court, day)
    assert watch_url_for_court(court, when, tz=tz) == COURT_DAY_LINK_URL


# --------------------------------------------------------------- bulk resolver
def test_the_bulk_resolver_agrees_with_the_single_row_helpers_at_every_level():
    """The resolver is a second implementation of the same rule, so it is only
    correct while it agrees with the first one — level by level."""
    for levels in ([], *[ALL_LEVELS[i:] for i in range(len(ALL_LEVELS))]):
        t, court, m = _ladder(set(levels))
        r = CourtLinkResolver([court], tz=tz_of(t), tournament=t)
        assert r.watch_url_for_match(m) == watch_url_for_match(m, tz=tz_of(t))
        assert r.watch_url(court.id, local_day(_kickoff(t), tz_of(t))) == (
            watch_url_for_court(court, _kickoff(t), tz=tz_of(t))
        )


def test_the_bulk_resolver_costs_no_query_per_match(django_assert_num_queries):
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    leaf, _other = with_categories(t)
    kickoff = _kickoff(t)
    make_category_link(t, leaf)
    matches = []
    for i in range(12):
        m = make_match(
            t,
            courts[i % len(courts)],
            match_no=i + 1,
            scheduled_at=kickoff + timedelta(minutes=i),
            leaf_key=leaf,
        )
        make_match_link(m, watch_url=MATCH_LINK_URL if i == 0 else "")
        matches.append(m)
    make_court_day_link(courts[1], local_day(kickoff, tz))
    with django_assert_num_queries(3):
        r = CourtLinkResolver(courts, tz=tz, tournament=t)
    with django_assert_num_queries(0):
        urls = [r.watch_url_for_match(m) for m in matches]
    assert urls[0] == MATCH_LINK_URL
    # Everything on court 2 takes the court-day link; everything else the
    # category link. Nothing is left unresolved.
    assert set(urls[1:]) == {COURT_DAY_LINK_URL, CATEGORY_LINK_URL}


def test_the_bulk_resolver_can_take_matches_without_a_tournament():
    """The ``matches=`` fallback, for callers that hold rows but no tournament
    (the tournament join is the schedule's cheaper path, not the only one)."""
    _admin, t, courts = make_tournament()
    m = make_match(t, courts[0], scheduled_at=_kickoff(t))
    make_match_link(m)
    r = CourtLinkResolver(courts, tz=tz_of(t), matches=[m])
    assert r.watch_url_for_match(m) == MATCH_LINK_URL


def test_an_enabled_court_day_link_reads_as_on_air():
    """``is_streaming`` lights up the spectator grid. An organiser who pasted
    TODAY's URL for this court and left it enabled has said it is streaming —
    the same statement ``CourtStream.enabled`` makes about a standing link."""
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    when = _kickoff(t)
    make_court_day_link(courts[0], local_day(when, tz))
    r = CourtLinkResolver(courts, when=when, tz=tz)
    assert r.is_streaming(courts[0].id) is True
    assert r.is_streaming(courts[1].id) is False


def test_a_disabled_court_day_link_does_not_read_as_on_air():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    when = _kickoff(t)
    make_court_day_link(courts[0], local_day(when, tz), enabled=False)
    r = CourtLinkResolver(courts, when=when, tz=tz)
    assert r.is_streaming(courts[0].id) is False


# ------------------------------------------------------------ the constraints
def test_one_active_link_per_match():
    _admin, t, courts = make_tournament()
    m = make_match(t, courts[0], scheduled_at=_kickoff(t))
    make_match_link(m)
    with pytest.raises(IntegrityError), transaction.atomic():
        make_match_link(m, watch_url=COURT_DAY_LINK_URL)


def test_one_active_link_per_court_and_day():
    _admin, t, courts = make_tournament()
    day = local_day(_kickoff(t), tz_of(t))
    make_court_day_link(courts[0], day)
    with pytest.raises(IntegrityError), transaction.atomic():
        make_court_day_link(courts[0], day, watch_url=MATCH_LINK_URL)


def test_one_active_link_per_category():
    _admin, t, _courts = make_tournament()
    leaf, _other = with_categories(t)
    make_category_link(t, leaf)
    with pytest.raises(IntegrityError), transaction.atomic():
        make_category_link(t, leaf, watch_url=MATCH_LINK_URL)


def test_the_same_court_can_hold_a_link_for_every_day():
    _admin, t, courts = make_tournament()
    tz = tz_of(t)
    first = _kickoff(t)
    for offset in range(3):
        make_court_day_link(courts[0], local_day(first + timedelta(days=offset), tz))
    assert StreamLink.objects.filter(court=courts[0]).count() == 3


def test_a_soft_deleted_link_frees_its_slot():
    """The unique constraints are partial on ``deleted_at`` for this: clearing
    a link and pasting a new one is the ordinary Tuesday-morning operation."""
    _admin, t, courts = make_tournament()
    day = local_day(_kickoff(t), tz_of(t))
    first = make_court_day_link(courts[0], day)
    first.deleted_at = datetime.now(UTC)
    first.save(update_fields=["deleted_at"])
    make_court_day_link(courts[0], day, watch_url=MATCH_LINK_URL)
    assert StreamLink.objects.filter(
        court=courts[0], deleted_at__isnull=True
    ).count() == 1


@pytest.mark.parametrize(
    "kwargs",
    [
        # court_day with no day: would never match a lookup, and would never
        # announce itself as broken either.
        {"scope": StreamLinkScope.COURT_DAY, "day": None},
        # match scope pointing at nothing.
        {"scope": StreamLinkScope.MATCH},
        # category scope with a blank leaf.
        {"scope": StreamLinkScope.CATEGORY, "leaf_key": ""},
    ],
)
def test_the_database_refuses_a_row_whose_target_does_not_match_its_scope(kwargs):
    _admin, t, courts = make_tournament()
    fields = {"court": courts[0], "day": local_day(_kickoff(t), tz_of(t))}
    fields.update(kwargs)
    if fields["scope"] != StreamLinkScope.COURT_DAY:
        fields["court"] = None
        fields["day"] = None
    if fields["scope"] == StreamLinkScope.CATEGORY:
        fields["tournament"] = t
    with pytest.raises(IntegrityError), transaction.atomic():
        StreamLink.objects.create(
            organization_id=t.organization_id,
            watch_url=MATCH_LINK_URL,
            **fields,
        )
