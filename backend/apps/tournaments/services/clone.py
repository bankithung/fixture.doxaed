"""Clone one tournament END-TO-END into a workspace (owner ask, 2026-08-23).

``copy_fixture_setup`` moves SETTINGS onto an existing tournament. This is the
other half: a full fork. The clone is a fresh Tournament row carrying the
source's whole shape — sports tree, rules, constraints, draw config and
scheduling config, venues + court reservations, registration forms, every
institution / team / player / roster member, and the FIXTURE ITSELF: matches
with their slots, scores, statuses, event history, lineups and officials, so
the copy opens looking exactly like the original, brackets and standings
included (standings derive from the copied events; advancement pointers keep
working because they are remapped to the new match ids).

What deliberately does NOT carry over:
- people's platform identity (`Person`, `SchoolProfile`, users) — those are
  GLOBAL rows shared by reference, not duplicated;
- form RESPONSES and their mapped submissions — a clone is a new event with
  the same paperwork, not the same paperwork trail;
- fixture snapshots, notifications, disputes, lens photos and stream links —
  operational artifacts of the ORIGINAL event.

The clone lands in the CALLER's chosen organization (default: their personal
workspace), which is what makes "any user can clone any tournament" safe:
nothing is written into the source's tenant, and every copied row that carries
an `organization` FK points at the target org.

Idempotent on a client ``event_id`` (invariant 3). Audited as
``tournament_cloned``.
"""
from __future__ import annotations

import copy as _copy
from typing import Any

from django.db import transaction

#: JSONB pointer dicts (home_source/away_source) key their references under
#: these suffixes; anything else in the dict is scalar and passes through.
_TEAM_POINTER_KEYS = ("team_id", "team")
_MATCH_POINTER_KEYS = ("match_id",)


def _remap_pointers(value: Any, maps) -> Any:
    """Deep-walk a JSONB structure replacing old ids via ``maps`` lookups."""
    if isinstance(value, list):
        return [_remap_pointers(v, maps) for v in value]
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if isinstance(v, (str,)) and _is_uuid(v):
                if k in _TEAM_POINTER_KEYS:
                    v = maps.teams.get(v, v)
                elif k in _MATCH_POINTER_KEYS:
                    v = maps.matches.get(v, v)
            elif k in _MATCH_POINTER_KEYS and isinstance(v, int):
                pass  # match_no stays identical by design
            out[k] = _remap_pointers(v, maps)
        return out
    return value


def _is_uuid(s: str) -> bool:
    try:
        from uuid import UUID

        UUID(s)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


class _Maps:
    """old-id -> new-id for every copied row family."""

    def __init__(self):
        self.groups: dict[str, str] = {}
        self.courts: dict[str, str] = {}
        self.institutions: dict[str, str] = {}
        self.roster_members: dict[str, str] = {}
        self.teams: dict[str, str] = {}
        self.players: dict[str, str] = {}
        self.ties: dict[str, str] = {}
        self.matches: dict[str, str] = {}
        self.events: dict[str, str] = {}

    def get(self, kind: str) -> dict[str, str]:
        return getattr(self, kind)


def _clone_fields(instance, exclude: set[str]) -> dict[str, Any]:
    """Every local column of ``instance`` except pk/excluded, ready for create()."""
    out = {}
    for f in instance._meta.local_fields:
        if f.primary_key or f.name in exclude or f.name in ("created_at", "updated_at"):
            continue  # fresh timestamps on the copy
        out[f.attname] = getattr(instance, f.attname)
    return out


def _unique_slug(base: str, taken: set[str], max_len: int) -> str:
    slug, n = base[:max_len], 2
    while slug in taken:
        suffix = f"-{n}"
        slug = base[: max_len - len(suffix)] + suffix
        n += 1
    taken.add(slug)
    return slug


def clone_tournament(
    *,
    source,
    target_org,
    by,
    name: str | None = None,
    include_matches: bool = True,
    event_id: str | None = None,
    request=None,
):
    """Fork ``source`` into ``target_org`` and return the new Tournament."""
    from apps.audit.models import ActorRole, AuditEvent
    from apps.audit.services import emit_audit
    from apps.fixtures.models import Court, Venue
    from apps.forms.models import Form
    from apps.matches.models import (
        Lineup,
        LineupEntry,
        Match,
        MatchEvent,
        MatchIncident,
        MatchOfficial,
        MatchTie,
    )
    from apps.teams.models import (
        Institution,
        Player,
        RosterMember,
        Team,
        TeamGroup,
        TeamStaff,
    )
    from apps.tournaments.models import (
        Tournament,
        TournamentMembership,
        TournamentMembershipRole,
        TournamentMembershipStatus,
    )
    from apps.tournaments.services.create import (
        _ensure_season,
        _pick_unique_tournament_slug,
    )

    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="tournament_cloned"
        ).first()
        if prior is not None:
            tid = (prior.payload_after or {}).get("clone_tournament_id")
            if tid:
                return Tournament.objects.get(id=tid)
            raise ValueError("replay_missing_payload")

    maps = _Maps()

    with transaction.atomic():
        # Lock the source so two concurrent clones can't interleave reads.
        source = type(source).objects.select_for_update().get(pk=source.pk)

        # -- 1. The Tournament row itself ------------------------------------
        t_fields = _clone_fields(source, exclude={
            "organization", "sport", "season_ref", "slug", "name",
            "created_by", "deleted_at",
        })
        new_slug = _pick_unique_tournament_slug(target_org, name or f"{source.name} (Clone)")
        season = _ensure_season(target_org)
        tn = Tournament.objects.create(
            organization=target_org,
            sport=source.sport,
            season_ref=season if source.season_ref_id else None,
            slug=new_slug,
            name=(name or f"{source.name} (Clone)")[:200],
            created_by=by,
            **t_fields,
        )

        # -- 2. Seasons' groups (houses/classes), venues + courts ------------
        src_season = getattr(source.season_ref, "id", None)
        for g in TeamGroup.objects.filter(organization=source.organization_id).exclude(
            deleted_at__isnull=False
        ):
            ng = TeamGroup.objects.create(
                organization=target_org,
                season=season if g.season_id == src_season else g.season,
                **{
                    k: v
                    for k, v in _clone_fields(g, exclude={"organization", "season"}).items()
                },
            )
            maps.groups[str(g.id)] = str(ng.id)

        venue_map: dict[str, Venue] = {}
        for v in Venue.objects.filter(
            organization=source.organization_id, deleted_at__isnull=True
        ):
            nv, _ = Venue.objects.get_or_create(
                organization=target_org,
                name=v.name,
                defaults={
                    "venue_type": v.venue_type,
                    "windows": v.windows,
                    "count": v.count,
                    "unavailable_dates": v.unavailable_dates,
                    "sports": v.sports,
                    "breaks": v.breaks,
                    "created_by": by,
                },
            )
            venue_map[str(v.id)] = nv
        for c in Court.objects.filter(
            organization=source.organization_id, deleted_at__isnull=True
        ):
            nc, _ = Court.objects.get_or_create(
                organization=target_org,
                venue=venue_map[str(c.venue_id)],
                name=c.name,
                defaults={
                    "index": c.index,
                    "competitions": c.competitions,
                    "exclusive": c.exclusive,
                },
            )
            maps.courts[str(c.id)] = str(nc.id)

        # -- 3. Institutions -> roster members -------------------------------
        for inst in Institution.objects.filter(tournament=source, deleted_at__isnull=True):
            ni = Institution.objects.create(
                organization=target_org,
                tournament=tn,
                school_profile=inst.school_profile,
                created_by=by,
                **_clone_fields(inst, exclude={
                    "organization", "tournament", "school_profile", "created_by",
                    # Access codes belong to the ORIGINAL event's contacts.
                    "team_code_hash", "team_code_sent_at", "team_code_enc",
                    "team_code_prev_hash", "team_code_prev_until",
                    "deleted_at",
                }),
            )
            maps.institutions[str(inst.id)] = str(ni.id)

        for rm in RosterMember.objects.filter(tournament=source, deleted_at__isnull=True):
            nrm = RosterMember.objects.create(
                organization=target_org,
                tournament=tn,
                institution_id=maps.institutions[str(rm.institution_id)],
                group=(
                    maps.groups.get(str(rm.group_id))
                    if rm.group_id else None
                ),
                person=rm.person,
                created_by=by,
                **_clone_fields(rm, exclude={
                    "organization", "tournament", "institution", "group",
                    "person", "created_by", "deleted_at",
                }),
            )
            maps.roster_members[str(rm.id)] = str(nrm.id)

        # -- 4. Teams (+ players, staff) --------------------------------------
        for team in Team.objects.filter(tournament=source, deleted_at__isnull=True):
            nt = Team.objects.create(
                organization=target_org,
                tournament=tn,
                institution_id=(
                    maps.institutions.get(str(team.institution_id))
                    if team.institution_id else None
                ),
                group_id=maps.groups.get(str(team.group_id)) if team.group_id else None,
                created_by=by,
                **_clone_fields(team, exclude={
                    "organization", "tournament", "institution", "group",
                    "created_by", "deleted_at",
                }),
            )
            maps.teams[str(team.id)] = str(nt.id)
        for player in Player.objects.filter(tournament=source, deleted_at__isnull=True):
            np_ = Player.objects.create(
                organization=target_org,
                tournament=tn,
                team_id=maps.teams[str(player.team_id)],
                person=player.person,
                added_by=by,
                **_clone_fields(player, exclude={
                    "organization", "tournament", "team", "person",
                    "added_by", "deleted_at",
                }),
            )
            maps.players[str(player.id)] = str(np_.id)
        for staff in TeamStaff.objects.filter(
            organization=source.organization_id,
            team_id__in=maps.teams.keys(),
        ):
            TeamStaff.objects.create(
                organization=target_org,
                team_id=maps.teams[str(staff.team_id)],
                member_id=maps.roster_members.get(str(staff.member_id)),
                **_clone_fields(staff, exclude={
                    "organization", "team", "member",
                }),
            )

        # -- 5. Registration forms (definitions only; responses stay behind) --
        for form in Form.objects.filter(tournament=source, deleted_at__isnull=True):
            Form.objects.create(
                organization=target_org,
                tournament=tn,
                created_by=by,
                response_count=0,
                **_clone_fields(form, exclude={
                    "organization", "tournament", "created_by",
                    "response_count", "deleted_at",
                }),
            )

        # -- 6. THE FIXTURE ---------------------------------------------------
        if include_matches:
            class _PointerMaps:
                teams = maps.teams
                matches = maps.matches

            pointer_maps = _PointerMaps()

            ties = {str(t_.id): t_ for t_ in MatchTie.objects.filter(tournament=source)}
            for tie in ties.values():
                ntie = MatchTie.objects.create(
                    organization=target_org,
                    tournament=tn,
                    home_team_id=maps.teams.get(str(tie.home_team_id)),
                    away_team_id=maps.teams.get(str(tie.away_team_id)),
                    **_clone_fields(tie, exclude={
                        "organization", "tournament", "home_team", "away_team",
                    }),
                )
                maps.ties[str(tie.id)] = str(ntie.id)

            matches = list(
                Match.objects.filter(tournament=source).order_by("match_no", "id")
            )
            # First pass: rows with remapped FKs and POINTER dicts.
            staged: dict[str, dict[str, Any]] = {}
            for m in matches:
                fields = _clone_fields(m, exclude={
                    "organization", "tournament", "home_team", "away_team",
                    "court", "tie", "scorer",
                })
                fields["home_team_id"] = maps.teams.get(str(m.home_team_id))
                fields["away_team_id"] = maps.teams.get(str(m.away_team_id))
                fields["court_id"] = maps.courts.get(str(m.court_id))
                fields["tie_id"] = maps.ties.get(str(m.tie_id))
                fields["scorer"] = m.scorer
                fields["home_source"] = _remap_pointers(
                    _copy.deepcopy(m.home_source), pointer_maps
                )
                fields["away_source"] = _remap_pointers(
                    _copy.deepcopy(m.away_source), pointer_maps
                )
                staged[str(m.id)] = fields
                nm = Match(**fields, tournament=tn, organization=target_org)
                nm.save()
                maps.matches[str(m.id)] = str(nm.id)

            # Event-sourced state of record (invariant 4): the copy replays
            # identically because its events come along, gaps and all.
            events = list(
                MatchEvent.objects.filter(tournament=source).order_by("sequence_no", "id")
            )
            new_events: list[MatchEvent] = []
            void_positions: list[int] = []
            for e in events:
                obj = MatchEvent(
                    organization=target_org,
                    tournament=tn,
                    match_id=maps.matches[str(e.match_id)],
                    team_id=maps.teams.get(str(e.team_id)),
                    player_id=maps.players.get(str(e.player_id)),
                    related_player_id=maps.players.get(str(e.related_player_id)),
                    created_by=e.created_by,
                    # ``event_id`` is the CLIENT's idempotency key (invariant 3)
                    # and unique across the whole table, so carrying it over
                    # made the copy collide with its own source the moment a
                    # tournament with a scored match was cloned (prod
                    # 2026-08-28: ``duplicate key value violates unique
                    # constraint "matches_match_event_event_id_key"``). A
                    # copied event was never submitted by anyone; it has no
                    # key.
                    **_clone_fields(e, exclude={
                        "organization", "tournament", "match", "team", "player",
                        "related_player", "voids", "created_by", "event_id",
                    }),
                )
                if e.voids_id:
                    void_positions.append(len(new_events))
                new_events.append(obj)
            MatchEvent.objects.bulk_create(new_events, batch_size=500)
            # Second pass: repoint VOID corrections at the COPIED events.
            if void_positions:
                old_to_new = {e.id: n.id for e, n in zip(events, new_events, strict=False)}
                for idx in void_positions:
                    old_voids = events[idx].voids_id
                    new_events[idx].voids_id = old_to_new.get(old_voids)
                MatchEvent.objects.bulk_update(
                    [new_events[i] for i in void_positions], ["voids"], batch_size=200
                )

            # Lineups, incidents, officials — the match-day furniture.
            for lu in Lineup.objects.filter(match_id__in=maps.matches.keys()):
                nlu = Lineup.objects.create(
                    organization=target_org,
                    match_id=maps.matches[str(lu.match_id)],
                    team_id=maps.teams.get(str(lu.team_id)),
                    confirmed_by=lu.confirmed_by,
                    **_clone_fields(lu, exclude={
                        "organization", "match", "team", "confirmed_by",
                    }),
                )
                LineupEntry.objects.bulk_create(
                    [
                        LineupEntry(
                            lineup=nlu,
                            player_id=maps.players.get(str(entry.player_id)),
                            **_clone_fields(entry, exclude={"lineup", "player"}),
                        )
                        for entry in lu.entries.all()
                    ],
                    batch_size=500,
                )
            MatchIncident.objects.bulk_create(
                [
                    MatchIncident(
                        organization=target_org,
                        match_id=maps.matches[str(i.match_id)],
                        reported_by=i.reported_by,
                        player_id=maps.players.get(str(i.player_id)),
                        # Same unique client key as the events above.
                        **_clone_fields(i, exclude={
                            "organization", "match", "reported_by", "player",
                            "event_id",
                        }),
                    )
                    for i in MatchIncident.objects.filter(match_id__in=maps.matches.keys())
                ],
                batch_size=500,
            )
            MatchOfficial.objects.bulk_create(
                [
                    MatchOfficial(
                        organization=target_org,
                        match_id=maps.matches[str(o.match_id)],
                        user=o.user,
                        assigned_by=o.assigned_by,
                        **_clone_fields(o, exclude={
                            "organization", "match", "user", "assigned_by",
                        }),
                    )
                    for o in MatchOfficial.objects.filter(
                        match_id__in=list(maps.matches.keys())
                    )
                ],
                batch_size=500,
            )

        # -- 7. The cloner runs their copy ------------------------------------
        TournamentMembership.objects.get_or_create(
            tournament=tn,
            user=by,
            defaults={
                "role": TournamentMembershipRole.ADMIN,
                "status": TournamentMembershipStatus.ACTIVE,
                "assigned_by": by,
            },
        )

        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="tournament_cloned",
            target_type="tournament",
            target_id=tn.id,
            organization_id=target_org.id,
            idempotency_key=event_id,
            payload_after={
                "source_tournament_id": str(source.id),
                "clone_tournament_id": str(tn.id),
                "teams": len(maps.teams),
                "matches": len(maps.matches),

                "include_matches": include_matches,
            },
            request=request,
        )
    return tn
