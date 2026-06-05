from __future__ import annotations

from rest_framework import serializers

from apps.disputes.models import Dispute


class DisputeSerializer(serializers.ModelSerializer):
    class Meta:
        model = Dispute
        fields = [
            "id", "kind", "description", "status", "resolution", "match",
            "created_at", "reviewed_at",
        ]


class RaiseDisputeSerializer(serializers.Serializer):
    kind = serializers.CharField(max_length=64)
    description = serializers.CharField()
    match_id = serializers.UUIDField(required=False)
    event_id = serializers.UUIDField(required=False)


class ResolveDisputeSerializer(serializers.Serializer):
    resolution = serializers.CharField()
