from __future__ import annotations

from rest_framework import serializers

from apps.matches.models import (
    Lineup,
    LineupEntry,
    LineupRole,
    Match,
    MatchEventType,
    MatchIncident,
    MatchIncidentKind,
    MatchOfficial,
    MatchOfficialRole,
)
from apps.teams.services.crest import team_crest


def team_mini(team):
    """The one team stub every match payload carries: id, name, short name,
    crest.

    This existed TWICE — ``MatchSerializer._mini`` and a module-level
    ``_mini_team`` for lineups, byte-identical. Two copies of a shape means the
    next key added lands in one of them, and a lineup's team silently stops
    matching the same team in the match header. There is now one.

    ``crest`` is always a string ("" when the team has no badge) so a renderer
    falls back to initials without a null check. Resolving it reads
    ``team.institution``, so every queryset feeding this must
    ``select_related`` the institution or a whole day of fixtures becomes an
    N+1.
    """
    if team is None:
        return None
    return {
        "id": str(team.id),
        "name": team.name,
        "short_name": team.short_name,
        "crest": team_crest(team),
    }


class MatchSerializer(serializers.ModelSerializer):
    home_team = serializers.SerializerMethodField()
    away_team = serializers.SerializerMethodField()
    scoring = serializers.SerializerMethodField()
    duration_minutes = serializers.SerializerMethodField()
    fixture_no = serializers.SerializerMethodField()

    class Meta:
        model = Match
        fields = [
            "id", "stage", "stage_no", "group_label", "round_no", "match_no",
            "fixture_no",
            "status", "home_team", "away_team", "home_score", "away_score",
            "home_pens", "away_pens", "scheduled_at", "locked_at", "called_at",
            "current_period", "sport", "set_scores", "leaf_key", "venue",
            "scoring", "home_source", "away_source", "duration_minutes",
        ]

    def get_duration_minutes(self, obj):
        """This match's own length in minutes, or null when nothing sets one.

        The printable fixture needs an END time beside the start, and only the
        tournament knows how long one of ITS games runs. Resolved by the same
        helper the scheduler uses, and memoised per (sport, competition) so a
        92-match list does not re-read the draw config 92 times."""
        from apps.matches.services.set_scoring import match_duration_minutes

        cache = getattr(self, "_duration_cache", None)
        if cache is None:
            cache = self._duration_cache = {}
        key = (obj.tournament_id, obj.sport or "", obj.leaf_key or "")
        if key not in cache:
            cache[key] = match_duration_minutes(
                obj.tournament, obj.sport, obj.leaf_key or "",
            )
        return cache[key]

    def get_fixture_no(self, obj):
        """The number the FIXTURE calls this match by — counted within its own
        competition, and the SAME number every other surface prints (see
        `services/numbering.py`). `match_no` stays what it always was: the
        tournament-wide emission sequence the draw hands out.

        Memoised per tournament, so a 92-match list costs one extra query."""
        from apps.matches.services.numbering import fixture_numbers

        # A list view that builds ONE serializer per row (the ops board does)
        # would otherwise pay a query per match, so it hands the whole map in
        # through the context. Everything else memoises per serializer.
        given = self.context.get("fixture_nos")
        if isinstance(given, dict):
            return given.get(str(obj.id))
        cache = getattr(self, "_fixture_no_cache", None)
        if cache is None:
            cache = self._fixture_no_cache = {}
        if obj.tournament_id not in cache:
            cache[obj.tournament_id] = fixture_numbers(obj.tournament_id)
        return cache[obj.tournament_id].get(str(obj.id))

    def get_scoring(self, obj):
        """Resolved set-scoring rules (override → sport profile), or None for
        goal-based matches — the FE entry UI renders from this instead of a
        hand-mirrored copy of backend defaults. List views must
        select_related("tournament") (the override lives on it)."""
        from apps.matches.services.set_scoring import rules_for_match

        return rules_for_match(obj)

    def get_home_team(self, obj):
        return team_mini(obj.home_team)

    def get_away_team(self, obj):
        return team_mini(obj.away_team)


class MatchOfficialSerializer(serializers.ModelSerializer):
    """Read shape for an assigned official: who + which role + acceptance."""

    user_id = serializers.SerializerMethodField()
    name = serializers.SerializerMethodField()

    class Meta:
        model = MatchOfficial
        fields = ["id", "user_id", "name", "role", "status"]

    def get_user_id(self, obj):
        return str(obj.user_id)

    def get_name(self, obj):
        return obj.user.name or obj.user.email


class AssignOfficialSerializer(serializers.Serializer):
    user_id = serializers.UUIDField()
    role = serializers.ChoiceField(choices=MatchOfficialRole.values)
    event_id = serializers.UUIDField(required=False)


class RecordScoreSerializer(serializers.Serializer):
    home_score = serializers.IntegerField(min_value=0, max_value=99)
    away_score = serializers.IntegerField(min_value=0, max_value=99)
    event_id = serializers.UUIDField(required=False)


class RecordSetScoreSerializer(serializers.Serializer):
    """Set/game-based result: a list of [home, away] point pairs per set."""
    set_scores = serializers.ListField(
        child=serializers.ListField(
            child=serializers.IntegerField(min_value=0, max_value=99),
            min_length=2,
            max_length=2,
        ),
        min_length=1,
        max_length=9,
    )
    event_id = serializers.UUIDField(required=False)


class AmendSetResultSerializer(RecordSetScoreSerializer):
    """Manager correction of a COMPLETED set result — a reason is mandatory
    (the amend is audited; corrections must be justifiable)."""
    reason = serializers.CharField(max_length=500)


class RecordEventSerializer(serializers.Serializer):
    event_type = serializers.ChoiceField(choices=MatchEventType.values)
    side = serializers.ChoiceField(choices=["home", "away"], required=False, allow_blank=True)
    player_id = serializers.UUIDField(required=False)
    related_player_id = serializers.UUIDField(required=False)  # substitution-on / assist
    minute = serializers.IntegerField(required=False, min_value=0, max_value=200)
    event_id = serializers.UUIDField(required=False)
    # VOID target: the sequence_no of the event being reversed (P7a undo —
    # void_match_event was unreachable from the API before this field).
    voids_seq = serializers.IntegerField(required=False, min_value=1)
    # Sport-specific annotation payload (P2): fault reasons, scoring side,
    # serve context. Small structured dict; DRF was silently DROPPING it.
    detail = serializers.DictField(required=False)

    def validate_detail(self, value):
        import json

        if len(json.dumps(value)) > 1000:
            raise serializers.ValidationError("detail_too_large")
        return value


class RecordShootoutSerializer(serializers.Serializer):
    """Penalty-shootout result for a drawn knockout match — must be decisive."""

    home_pens = serializers.IntegerField(min_value=0, max_value=99)
    away_pens = serializers.IntegerField(min_value=0, max_value=99)
    event_id = serializers.UUIDField(required=False)

    def validate(self, attrs):
        if attrs["home_pens"] == attrs["away_pens"]:
            raise serializers.ValidationError("shootout_must_be_decisive")
        return attrs


class RescheduleMatchSerializer(serializers.Serializer):
    """Manual reslot (control-room repair): at least one of scheduled_at /
    venue. ``scheduled_at`` stays a raw ISO string here — the service treats
    naive values as tournament-local wall clock (invariant 14), which DRF's
    DateTimeField would silently re-anchor to the server timezone."""

    scheduled_at = serializers.CharField(required=False)
    venue = serializers.CharField(required=False, allow_blank=True, max_length=120)
    force = serializers.BooleanField(required=False, default=False)
    event_id = serializers.UUIDField(required=False)

    def validate(self, attrs):
        if "scheduled_at" not in attrs and "venue" not in attrs:
            raise serializers.ValidationError("nothing_to_change")
        return attrs


class DelayMatchSerializer(serializers.Serializer):
    """Delay cascade (control-room repair, increment C): shift a match by
    +minutes; cascade pushes later same-venue matches just enough to restore
    venue non-overlap + rest gaps."""

    minutes = serializers.IntegerField(min_value=1, max_value=480)
    cascade = serializers.BooleanField(required=False, default=True)
    force = serializers.BooleanField(required=False, default=False)
    event_id = serializers.UUIDField(required=False)


class TransitionSerializer(serializers.Serializer):
    to_status = serializers.CharField(max_length=16)
    reason = serializers.CharField(required=False, allow_blank=True)
    # Walkover only: the team being awarded the match (stamps the conventional
    # walkover score so winner_id/advancement/standings all resolve).
    winner_team_id = serializers.UUIDField(required=False)


class LineupEntryReadSerializer(serializers.ModelSerializer):
    player_id = serializers.SerializerMethodField()
    player_name = serializers.SerializerMethodField()

    class Meta:
        model = LineupEntry
        # positional_role feeds the per-sport court view (sepak regu slots,
        # football lines) on the admin console, same as the public hub.
        fields = ["id", "player_id", "player_name", "role", "shirt_no",
                  "positional_role"]

    def get_player_id(self, obj):
        return str(obj.player_id)

    def get_player_name(self, obj):
        person = getattr(obj.player, "person", None)
        return person.full_name if person else None


class LineupSerializer(serializers.ModelSerializer):
    team = serializers.SerializerMethodField()
    entries = LineupEntryReadSerializer(many=True, read_only=True)
    confirmed_by = serializers.SerializerMethodField()

    class Meta:
        model = Lineup
        fields = ["id", "team", "entries", "confirmed_at", "confirmed_by", "updated_at"]

    def get_team(self, obj):
        return team_mini(obj.team)

    def get_confirmed_by(self, obj):
        return str(obj.confirmed_by_id) if obj.confirmed_by_id else None


class LineupEntryInputSerializer(serializers.Serializer):
    player_id = serializers.UUIDField()
    role = serializers.ChoiceField(
        choices=LineupRole.values, required=False, default=LineupRole.STARTER
    )
    shirt_no = serializers.IntegerField(required=False, allow_null=True, min_value=0, max_value=999)
    # Sport slot (sepak regu "tekong"/"left_inside"/"right_inside", football
    # line) — placed on the per-sport court visual.
    positional_role = serializers.CharField(
        required=False, allow_blank=True, max_length=40,
    )


class SetLineupSerializer(serializers.Serializer):
    team_id = serializers.UUIDField()
    entries = LineupEntryInputSerializer(many=True)
    event_id = serializers.UUIDField(required=False)


class ConfirmLineupSerializer(serializers.Serializer):
    team_id = serializers.UUIDField()
    event_id = serializers.UUIDField(required=False)


class MatchIncidentSerializer(serializers.ModelSerializer):
    reported_by = serializers.SerializerMethodField()
    player_id = serializers.SerializerMethodField()

    class Meta:
        model = MatchIncident
        fields = [
            "id", "kind", "description", "minute", "player_id",
            "reported_by", "created_at",
        ]

    def get_reported_by(self, obj):
        return str(obj.reported_by_id) if obj.reported_by_id else None

    def get_player_id(self, obj):
        return str(obj.player_id) if obj.player_id else None


class FileIncidentSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=MatchIncidentKind.values)
    description = serializers.CharField()
    minute = serializers.IntegerField(required=False, allow_null=True, min_value=0, max_value=200)
    player_id = serializers.UUIDField(required=False, allow_null=True)
    event_id = serializers.UUIDField(required=False)
