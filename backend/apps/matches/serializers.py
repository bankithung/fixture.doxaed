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


class MatchSerializer(serializers.ModelSerializer):
    home_team = serializers.SerializerMethodField()
    away_team = serializers.SerializerMethodField()
    scoring = serializers.SerializerMethodField()

    class Meta:
        model = Match
        fields = [
            "id", "stage", "stage_no", "group_label", "round_no", "match_no",
            "status", "home_team", "away_team", "home_score", "away_score",
            "home_pens", "away_pens", "scheduled_at", "locked_at", "called_at",
            "current_period", "sport", "set_scores", "leaf_key", "venue",
            "scoring", "home_source", "away_source",
        ]

    def get_scoring(self, obj):
        """Resolved set-scoring rules (override → sport profile), or None for
        goal-based matches — the FE entry UI renders from this instead of a
        hand-mirrored copy of backend defaults. List views must
        select_related("tournament") (the override lives on it)."""
        from apps.matches.services.set_scoring import rules_for_match

        return rules_for_match(obj)

    @staticmethod
    def _mini(team):
        if team is None:
            return None
        return {"id": str(team.id), "name": team.name, "short_name": team.short_name}

    def get_home_team(self, obj):
        return self._mini(obj.home_team)

    def get_away_team(self, obj):
        return self._mini(obj.away_team)


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


class RecordEventSerializer(serializers.Serializer):
    event_type = serializers.ChoiceField(choices=MatchEventType.values)
    side = serializers.ChoiceField(choices=["home", "away"], required=False, allow_blank=True)
    player_id = serializers.UUIDField(required=False)
    related_player_id = serializers.UUIDField(required=False)  # substitution-on / assist
    minute = serializers.IntegerField(required=False, min_value=0, max_value=200)
    event_id = serializers.UUIDField(required=False)


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


def _mini_team(team):
    if team is None:
        return None
    return {"id": str(team.id), "name": team.name, "short_name": team.short_name}


class LineupEntryReadSerializer(serializers.ModelSerializer):
    player_id = serializers.SerializerMethodField()
    player_name = serializers.SerializerMethodField()

    class Meta:
        model = LineupEntry
        fields = ["id", "player_id", "player_name", "role", "shirt_no"]

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
        return _mini_team(obj.team)

    def get_confirmed_by(self, obj):
        return str(obj.confirmed_by_id) if obj.confirmed_by_id else None


class LineupEntryInputSerializer(serializers.Serializer):
    player_id = serializers.UUIDField()
    role = serializers.ChoiceField(
        choices=LineupRole.values, required=False, default=LineupRole.STARTER
    )
    shirt_no = serializers.IntegerField(required=False, allow_null=True, min_value=0, max_value=999)


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
