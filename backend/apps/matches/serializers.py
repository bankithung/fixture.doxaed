from __future__ import annotations

from rest_framework import serializers

from apps.matches.models import Match, MatchEventType


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
    minute = serializers.IntegerField(required=False, min_value=0, max_value=200)
    event_id = serializers.UUIDField(required=False)


class TransitionSerializer(serializers.Serializer):
    to_status = serializers.CharField(max_length=16)
    reason = serializers.CharField(required=False, allow_blank=True)
