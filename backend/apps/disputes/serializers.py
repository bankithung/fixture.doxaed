from __future__ import annotations

from rest_framework import serializers

from apps.disputes.models import Dispute


class DisputeSerializer(serializers.ModelSerializer):
    match_label = serializers.SerializerMethodField()

    class Meta:
        model = Dispute
        fields = [
            "id", "kind", "description", "status", "resolution", "match",
            "match_label", "created_at", "reviewed_at",
        ]

    def get_match_label(self, obj):
        m = obj.match
        if m is None:
            return None
        home = m.home_team.name if m.home_team_id else "TBD"
        away = m.away_team.name if m.away_team_id else "TBD"
        return f"{home} vs {away}"


class RaiseDisputeSerializer(serializers.Serializer):
    kind = serializers.CharField(max_length=64)
    description = serializers.CharField()
    match_id = serializers.UUIDField(required=False)
    event_id = serializers.UUIDField(required=False)


class ResolveDisputeSerializer(serializers.Serializer):
    resolution = serializers.CharField()
