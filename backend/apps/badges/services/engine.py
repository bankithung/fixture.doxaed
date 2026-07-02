"""Badge evaluation + idempotent reconciliation.

Everything is DERIVED from final results (like scores, standings, and
suspensions): no counters are maintained. ``recompute_badges`` computes the
full deserved set for a scope and reconciles it against stored awards —
missing ones are created, stale ones revoked (audited), matching ones left
untouched — so replays, corrections, and voids all converge. Triggered
post-commit after every terminal result, AFTER advancement (so a corrected
winner re-derives cleanly).
"""
from __future__ import annotations

import logging
from collections import defaultdict

from django.db import transaction
from django.utils import timezone

from apps.badges.catalog import BADGE_TEMPLATES
from apps.badges.models import BadgeAward, BadgeSubject
from apps.matches.models import Match, MatchEvent, MatchEventType, MatchStatus

logger = logging.getLogger(__name__)

_PLAYED = (MatchStatus.COMPLETED,)          # point metrics: real play only
_FINAL = (MatchStatus.COMPLETED, MatchStatus.WALKOVER)  # W/L + completeness
_OPEN = (
    MatchStatus.SCHEDULED, MatchStatus.LIVE, MatchStatus.HALF_TIME,
    MatchStatus.POSTPONED, MatchStatus.ABANDONED,
)


def _order_key(m: Match):
    return (m.scheduled_at or m.created_at, m.match_no or 0, str(m.id))


def _is_set_match(m: Match) -> bool:
    return bool(m.set_scores)


def _points(m: Match, team_id) -> tuple[int, int]:
    """(scored, conceded) for one side — set points when set-scored, goals
    otherwise."""
    home = team_id == m.home_team_id
    if _is_set_match(m):
        hs = sum(int(s[0]) for s in m.set_scores)
        as_ = sum(int(s[1]) for s in m.set_scores)
        return (hs, as_) if home else (as_, hs)
    h, a = m.home_score or 0, m.away_score or 0
    return (h, a) if home else (a, h)


def _sets(m: Match, team_id) -> tuple[int, int]:
    """(sets won, sets lost) for one side of a set-scored match."""
    won = lost = 0
    home = team_id == m.home_team_id
    for s in m.set_scores or []:
        mine, theirs = (s[0], s[1]) if home else (s[1], s[0])
        if mine > theirs:
            won += 1
        elif theirs > mine:
            lost += 1
    return won, lost


def _team_matches(matches, team_id):
    return [m for m in matches if team_id in (m.home_team_id, m.away_team_id)]


def _sport_of(m: Match) -> str:
    return (m.sport or "").lower()


def _param(template: dict, key: str, sport: str = ""):
    val = (template.get("params") or {}).get(key)
    if isinstance(val, dict):
        return val.get(sport, val.get("default"))
    return val


# --------------------------------------------------------------- evaluators
def _match_awards(m: Match) -> list[dict]:
    """Match-scope badges for one COMPLETED match with a winner."""
    out: list[dict] = []
    winner = m.winner_id
    if winner is None or m.status != MatchStatus.COMPLETED:
        return out
    sport = _sport_of(m)

    if _is_set_match(m):
        won, lost = _sets(m, winner)
        scored, conceded = _points(m, winner)
        if lost == 0 and won > 0:
            out.append(_award("straight_set_win", m, winner, {
                "set_scores": m.set_scores, "sets": f"{won}-{lost}",
            }))
        max_conceded = _param(BADGE_TEMPLATES["lockdown_match"], "max_conceded", sport)
        if max_conceded is not None and conceded <= int(max_conceded):
            out.append(_award("lockdown_match", m, winner, {
                "set_scores": m.set_scores, "conceded": conceded, "scored": scored,
            }))
        # Comeback: dropped the FIRST set, won the match.
        first = (m.set_scores or [[0, 0]])[0]
        first_mine = first[0] if winner == m.home_team_id else first[1]
        first_theirs = first[1] if winner == m.home_team_id else first[0]
        if first_mine < first_theirs:
            out.append(_award("comeback_win", m, winner, {
                "set_scores": m.set_scores, "lost_first_set": f"{first[0]}-{first[1]}",
            }))
    else:
        # Football comeback: trailed at any point in the goal log, then won.
        events = list(
            MatchEvent.objects.filter(
                match=m,
                event_type__in=(
                    MatchEventType.GOAL, MatchEventType.PENALTY_SCORED,
                    MatchEventType.OWN_GOAL,
                ),
            ).order_by("sequence_no")
        )
        voided = set(
            MatchEvent.objects.filter(
                match=m, event_type=MatchEventType.VOID, voids__isnull=False
            ).values_list("voids_id", flat=True)
        )
        h = a = 0
        trailed = False
        for e in events:
            if e.id in voided:
                continue
            scores_for_home = (
                e.team_id == m.home_team_id
                if e.event_type != MatchEventType.OWN_GOAL
                else e.team_id == m.away_team_id
            )
            h, a = (h + 1, a) if scores_for_home else (h, a + 1)
            mine = h if winner == m.home_team_id else a
            theirs = a if winner == m.home_team_id else h
            if mine < theirs:
                trailed = True
        if trailed:
            out.append(_award("comeback_win", m, winner, {
                "final": f"{m.home_score}-{m.away_score}", "trailed": True,
            }))
    return out


def _streak_awards(matches: list[Match], leaf_key: str, stage_no: int) -> list[dict]:
    """Consecutive-result badges over a team's played matches, in order."""
    out: list[dict] = []
    team_ids = {tid for m in matches for tid in (m.home_team_id, m.away_team_id) if tid}
    for tid in team_ids:
        mine = sorted(
            [m for m in _team_matches(matches, tid) if m.status in _PLAYED],
            key=_order_key,
        )
        sweep = ss_need = _param(BADGE_TEMPLATES["clean_sweep_streak"], "streak") or 2
        cs_need = _param(BADGE_TEMPLATES["clean_sheet_streak"], "streak") or 2
        sweep_run: list[Match] = []
        sheet_run: list[Match] = []
        sweep_done = sheet_done = False
        for m in mine:
            # Clean sweep: straight-set WINS in a row (set matches only).
            if _is_set_match(m) and m.winner_id == tid and _sets(m, tid)[1] == 0:
                sweep_run.append(m)
            else:
                sweep_run = []
            if not sweep_done and len(sweep_run) >= int(sweep):
                out.append(_scope_award(
                    "clean_sweep_streak", leaf_key, stage_no, "", "team", tid,
                    {"matches": [str(x.id) for x in sweep_run[: int(ss_need)]],
                     "streak": len(sweep_run)},
                ))
                sweep_done = True
            # Clean sheet: goal matches with zero conceded, in a row.
            if not _is_set_match(m) and _points(m, tid)[1] == 0:
                sheet_run.append(m)
            else:
                sheet_run = []
            if not sheet_done and len(sheet_run) >= int(cs_need):
                out.append(_scope_award(
                    "clean_sheet_streak", leaf_key, stage_no, "", "team", tid,
                    {"matches": [str(x.id) for x in sheet_run[: int(cs_need)]],
                     "streak": len(sheet_run)},
                ))
                sheet_done = True
    return out


def _group_awards(matches: list[Match], leaf_key: str, stage_no: int) -> list[dict]:
    """Group-complete badges, per group_label."""
    out: list[dict] = []
    groups = defaultdict(list)
    for m in matches:
        if m.stage == "group" and m.group_label:
            groups[m.group_label].append(m)
    for label, group in groups.items():
        if any(m.status in _OPEN for m in group):
            continue  # group not finished
        team_ids = {t for m in group for t in (m.home_team_id, m.away_team_id) if t}
        stats = {}
        for tid in team_ids:
            mine = [m for m in _team_matches(group, tid) if m.status in _FINAL]
            played = [m for m in mine if m.status in _PLAYED]
            wins = sum(1 for m in mine if m.winner_id == tid)
            losses = sum(1 for m in mine if m.winner_id and m.winner_id != tid)
            pf = sum(_points(m, tid)[0] for m in played)
            pa = sum(_points(m, tid)[1] for m in played)
            sets_lost = sum(_sets(m, tid)[1] for m in played if _is_set_match(m))
            any_sets = any(_is_set_match(m) for m in played)
            stats[tid] = {
                "wins": wins, "losses": losses, "pf": pf, "pa": pa,
                "pd": pf - pa, "sets_lost": sets_lost, "any_sets": any_sets,
            }
        if not stats:
            continue
        # Perfect Run: finished the group without losing a set (set sports).
        for tid, st in stats.items():
            if st["any_sets"] and st["sets_lost"] == 0 and st["wins"] > 0 and st["losses"] == 0:
                out.append(_scope_award(
                    "perfect_run", leaf_key, stage_no, label, "team", tid,
                    {"group": label, "wins": st["wins"], "sets_lost": 0},
                ))
        # Group Stage Dominator: most wins, zero losses, best PD (ties co-award).
        best_pd = max(st["pd"] for st in stats.values())
        max_wins = max(st["wins"] for st in stats.values())
        for tid, st in stats.items():
            if (
                st["losses"] == 0 and st["wins"] == max_wins and st["wins"] > 0
                and st["pd"] == best_pd
                and (not st["any_sets"] or st["sets_lost"] == 0)
            ):
                out.append(_scope_award(
                    "group_dominator", leaf_key, stage_no, label, "team", tid,
                    {"group": label, "wins": st["wins"],
                     "point_difference": st["pd"], "conceded": st["pa"]},
                ))
    return out


def _competition_awards(
    tournament, matches: list[Match], leaf_key: str, stage_no: int
) -> list[dict]:
    """Whole-competition superlatives — only once every match is final."""
    out: list[dict] = []
    if not matches or any(m.status in _OPEN for m in matches):
        return out
    played = [m for m in matches if m.status in _PLAYED]
    team_ids = {t for m in played for t in (m.home_team_id, m.away_team_id) if t}
    if team_ids:
        totals = {}
        for tid in team_ids:
            mine = [m for m in _team_matches(played, tid)]
            if len(mine) < int(_param(BADGE_TEMPLATES["best_defence"], "min_matches") or 1):
                continue
            pf = sum(_points(m, tid)[0] for m in mine)
            pa = sum(_points(m, tid)[1] for m in mine)
            totals[tid] = {"pf": pf, "pa": pa, "pd": pf - pa, "played": len(mine)}
        if totals:
            least = min(st["pa"] for st in totals.values())
            for tid, st in totals.items():
                if st["pa"] == least:
                    out.append(_scope_award(
                        "best_defence", leaf_key, stage_no, "", "team", tid,
                        {"conceded": st["pa"], "played": st["played"]},
                    ))
            best = max(st["pd"] for st in totals.values())
            for tid, st in totals.items():
                if st["pd"] == best and st["pd"] > 0:
                    out.append(_scope_award(
                        "point_difference", leaf_key, stage_no, "", "team", tid,
                        {"scored": st["pf"], "conceded": st["pa"],
                         "point_difference": st["pd"]},
                    ))
    # Golden Boot: top scorer over the leaf's goal matches.
    goal_matches = [m for m in played if not _is_set_match(m)]
    if goal_matches:
        voided = set(
            MatchEvent.objects.filter(
                tournament=tournament, event_type=MatchEventType.VOID,
                voids__isnull=False,
            ).values_list("voids_id", flat=True)
        )
        tally: dict = defaultdict(int)
        players: dict = {}
        for e in MatchEvent.objects.filter(
            match__in=goal_matches,
            event_type__in=(MatchEventType.GOAL, MatchEventType.PENALTY_SCORED),
            player__isnull=False,
        ).select_related("player"):
            if e.id in voided:
                continue
            tally[e.player_id] += 1
            players[e.player_id] = e.player
        min_goals = int(_param(BADGE_TEMPLATES["golden_boot"], "min_goals") or 1)
        if tally:
            top = max(tally.values())
            if top >= min_goals:
                for pid, n in tally.items():
                    if n == top:
                        out.append({
                            "badge_key": "golden_boot", "leaf_key": leaf_key,
                            "stage_no": stage_no, "group_label": "",
                            "subject_type": BadgeSubject.PLAYER,
                            "team_id": players[pid].team_id, "player_id": pid,
                            "match_id": None,
                            "evidence": {"goals": n},
                            "dedupe_key": f"golden_boot:{leaf_key}:{stage_no}::{pid}:scope",
                        })
    return out


def _award(badge_key: str, m: Match, team_id, evidence: dict) -> dict:
    return {
        "badge_key": badge_key, "leaf_key": m.leaf_key or "",
        "stage_no": m.stage_no or 0, "group_label": m.group_label or "",
        "subject_type": BadgeSubject.TEAM, "team_id": team_id, "player_id": None,
        "match_id": m.id, "evidence": evidence,
        "dedupe_key": f"{badge_key}:{m.leaf_key}:{m.stage_no}:{team_id}:{m.id}",
    }


def _scope_award(
    badge_key, leaf_key, stage_no, group_label, subject, subject_id, evidence
) -> dict:
    return {
        "badge_key": badge_key, "leaf_key": leaf_key, "stage_no": stage_no,
        "group_label": group_label, "subject_type": subject,
        "team_id": subject_id if subject == "team" else None,
        "player_id": subject_id if subject == "player" else None,
        "match_id": None, "evidence": evidence,
        "dedupe_key": (
            f"{badge_key}:{leaf_key}:{stage_no}:{group_label}:{subject_id}:scope"
        ),
    }


# ------------------------------------------------------------- reconciler
def recompute_badges(tournament, leaf_key: str | None = None) -> dict:
    """Compute the deserved award set for one competition (or the whole
    tournament) and reconcile against stored rows. Safe to call repeatedly."""
    if not (getattr(tournament, "rules", None) or {}).get("badges", {}).get(
        "enabled", True
    ):
        return {"created": 0, "revoked": 0}

    qs = Match.objects.filter(
        tournament=tournament, deleted_at__isnull=True
    ).select_related("home_team", "away_team")
    if leaf_key is not None:
        qs = qs.filter(leaf_key=leaf_key)
    matches = list(qs)

    deserved: dict[str, dict] = {}
    by_scope: dict = defaultdict(list)
    for m in matches:
        by_scope[(m.leaf_key or "", m.stage_no or 0)].append(m)
    for (lk, sn), scope_matches in by_scope.items():
        rows: list[dict] = []
        for m in scope_matches:
            rows.extend(_match_awards(m))
        rows.extend(_streak_awards(scope_matches, lk, sn))
        rows.extend(_group_awards(scope_matches, lk, sn))
        rows.extend(_competition_awards(tournament, scope_matches, lk, sn))
        for r in rows:
            deserved[r["dedupe_key"]] = r

    created = revoked = 0
    with transaction.atomic():
        existing = {
            a.dedupe_key: a
            for a in BadgeAward.objects.select_for_update().filter(
                tournament=tournament, revoked_at__isnull=True,
                **({"leaf_key": leaf_key} if leaf_key is not None else {}),
            )
        }
        for key, row in deserved.items():
            if key in existing:
                continue
            BadgeAward.objects.create(
                organization_id=tournament.organization_id,
                tournament=tournament,
                **row,
            )
            created += 1
        for key, award in existing.items():
            if key not in deserved:
                award.revoked_at = timezone.now()
                award.save(update_fields=["revoked_at"])
                revoked += 1
    if created or revoked:
        logger.info(
            "badges reconciled t=%s leaf=%s created=%d revoked=%d",
            tournament.id, leaf_key, created, revoked,
        )
    return {"created": created, "revoked": revoked}


def fire_badge_recompute(match_id) -> None:
    """Post-commit hook (registered after advancement): recompute the
    finished match's competition. Best-effort — never crashes the request."""
    try:
        m = Match.objects.select_related("tournament").filter(id=match_id).first()
        if m is not None:
            recompute_badges(m.tournament, leaf_key=m.leaf_key or "")
    except Exception:  # pragma: no cover - hook must never break scoring
        logger.exception("badge recompute failed for match=%s", match_id)
