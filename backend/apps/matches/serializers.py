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
)


class MatchSerializer(serializers.ModelSerializer):
    home_team = serializers.SerializerMethodField()
    away_team = serializers.SerializerMethodField()

    class Meta:
        model = Match
        fields = [
            "id", "stage", "group_label", "round_no", "match_no", "status",
            "home_team", "away_team", "home_score", "away_score", "scheduled_at",
            "current_period",
        ]

    @staticmethod
    def _mini(team):
        if team is None:
            return None
        return {"id": str(team.id), "name": team.name, "short_name": team.short_name}

    def get_home_team(self, obj):
        return self._mini(obj.home_team)

    def get_away_team(self, obj):
        return self._mini(obj.away_team)


class RecordScoreSerializer(serializers.Serializer):
    home_score = serializers.IntegerField(min_value=0, max_value=99)
    away_score = serializers.IntegerField(min_value=0, max_value=99)
    event_id = serializers.UUIDField(required=False)


class RecordEventSerializer(serializers.Serializer):
    event_type = serializers.ChoiceField(choices=MatchEventType.values)
    side = serializers.ChoiceField(choices=["home", "away"], required=False, allow_blank=True)
    player_id = serializers.UUIDField(required=False)
    related_player_id = serializers.UUIDField(required=False)  # substitution-on / assist
    minute = serializers.IntegerField(required=False, min_value=0, max_value=200)
    event_id = serializers.UUIDField(required=False)


class TransitionSerializer(serializers.Serializer):
    to_status = serializers.CharField(max_length=16)
    reason = serializers.CharField(required=False, allow_blank=True)


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
