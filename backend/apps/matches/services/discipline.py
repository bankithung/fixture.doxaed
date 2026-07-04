"""Derived suspensions (PRD §5.8) — discipline is COMPUTED from the immutable
event log, never stored, exactly like scores and standings. `rules.discipline`
supplies the policy: `yellow_suspension_threshold` (accumulated yellows across
matches) and `red_matches_banned`. A second yellow in one match counts as a
red. The declared rule had no consumer before this module (C19): cards were
logged and never turned into consequences.
"""
from __future__ import annotations

from collections import defaultdict

from apps.matches.models import Match, MatchEvent, MatchEventType, MatchStatus

_FINAL = (MatchStatus.COMPLETED, MatchStatus.WALKOVER)
_CARDS = (MatchEventType.YELLOW_CARD, MatchEventType.RED_CARD)


def _match_order_key(m: Match):
    return (m.scheduled_at or m.created_at, m.match_no or 0, str(m.id))


def compute_suspensions(tournament) -> list[dict]:
    """Every suspension the card log implies, chronological, with served
    counts. A ban starts AFTER its triggering match and is served by the
    player's team's subsequent FINAL matches. Voided cards do not count."""
    from apps.tournaments.services.rules import merge_rules

    policy = merge_rules(getattr(tournament, "rules", None)).get("discipline") or {}
    y_threshold = int(policy.get("yellow_suspension_threshold") or 0)
    red_ban = max(1, int(policy.get("red_matches_banned") or 1))
    # P5: FIFA-style wipe — accumulated (single) yellows reset entering the
    # last N knockout rounds (2 = semis + final; Art. 12 World Cup regs
    # wipe after the quarter finals). Straight reds and two-yellows-in-one-
    # match always survive the wipe.
    wipe_last_rounds = int(policy.get("yellow_wipe_final_rounds") or 0)

    events = list(
        MatchEvent.objects.filter(
            tournament=tournament, event_type__in=_CARDS, player__isnull=False
        )
        .select_related("player", "player__person", "player__team", "match")
        .order_by("match_id", "sequence_no")
    )
    if not events:
        return []
    voided = set(
        MatchEvent.objects.filter(
            tournament=tournament, event_type=MatchEventType.VOID,
            voids__isnull=False,
        ).values_list("voids_id", flat=True)
    )
    events = [e for e in events if e.id not in voided]
    if not events:
        return []

    # Ordered final matches per team (the "served by" clock).
    team_ids = {e.player.team_id for e in events}
    team_matches: dict = defaultdict(list)
    for m in Match.objects.filter(
        tournament=tournament, deleted_at__isnull=True, status__in=_FINAL
    ):
        for tid in (m.home_team_id, m.away_team_id):
            if tid in team_ids:
                team_matches[tid].append(m)
    for tid in team_matches:
        team_matches[tid].sort(key=_match_order_key)

    # The wipe boundary: the first of the last N knockout rounds.
    wipe_boundary = None
    if wipe_last_rounds:
        rounds = [
            m.round_no for ms in team_matches.values() for m in ms
            if m.stage == "knockout" and m.round_no
        ] or [
            m.round_no
            for m in Match.objects.filter(
                tournament=tournament, stage="knockout",
                deleted_at__isnull=True, round_no__isnull=False,
            )
        ]
        if rounds:
            wipe_boundary = max(rounds) - wipe_last_rounds + 1

    # Cards per player per match, in match order.
    per_player: dict = defaultdict(lambda: defaultdict(lambda: {"y": 0, "r": 0}))
    match_by_id: dict = {}
    for e in events:
        match_by_id[e.match_id] = e.match
        counts = per_player[e.player][e.match_id]
        if e.event_type == MatchEventType.YELLOW_CARD:
            counts["y"] += 1
        else:
            counts["r"] += 1

    out: list[dict] = []
    for player, by_match in per_player.items():
        ordered = sorted(by_match.items(), key=lambda kv: _match_order_key(match_by_id[kv[0]]))
        acc_yellows = 0
        wiped = False
        for match_id, counts in ordered:
            trigger = match_by_id[match_id]
            if (
                wipe_last_rounds and not wiped and wipe_boundary is not None
                and trigger.stage == "knockout"
                and (trigger.round_no or 0) >= wipe_boundary
            ):
                acc_yellows = 0
                wiped = True
            reasons: list[tuple[str, int]] = []
            if counts["r"] >= 1 or counts["y"] >= 2:
                # A straight red, or two yellows in one match.
                reasons.append(
                    ("red_card" if counts["r"] else "second_yellow", red_ban)
                )
            else:
                acc_yellows += counts["y"]
                if y_threshold and acc_yellows >= y_threshold:
                    reasons.append(("yellow_accumulation", 1))
                    acc_yellows = 0
            for reason, banned in reasons:
                later = [
                    m for m in team_matches.get(player.team_id, [])
                    if _match_order_key(m) > _match_order_key(trigger)
                ]
                served = min(len(later), banned)
                out.append({
                    "player_id": str(player.id),
                    "player_name": (
                        player.person.full_name if player.person_id else str(player.id)
                    ),
                    "team_id": str(player.team_id),
                    "team_name": player.team.name if player.team_id else "",
                    "reason": reason,
                    "triggered_match_id": str(trigger.id),
                    "banned_matches": banned,
                    "served": served,
                    "active": served < banned,
                })
    out.sort(key=lambda r: (not r["active"], r["team_name"], r["player_name"]))
    return out


def suspended_player_ids(tournament) -> set[str]:
    """Players currently serving a ban (lineup hard-block, PRD §5.4)."""
    return {r["player_id"] for r in compute_suspensions(tournament) if r["active"]}
