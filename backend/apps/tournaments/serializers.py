from __future__ import annotations

from rest_framework import serializers

from apps.tournaments.models import Tournament, TournamentMembershipRole


class TournamentSerializer(serializers.ModelSerializer):
    organization_slug = serializers.CharField(source="organization.slug", read_only=True)
    sport_code = serializers.CharField(source="sport.code", read_only=True, default=None)

    class Meta:
        model = Tournament
        fields = [
            "id",
            "slug",
            "name",
            "status",
            "organization_slug",
            "sport_code",
            "time_zone",
            "created_at",
        ]
        read_only_fields = fields


class TournamentCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200)
    sport_code = serializers.CharField(required=False, allow_blank=True)
    event_id = serializers.UUIDField(required=False)


class TournamentInvitationCreateSerializer(serializers.Serializer):
    email = serializers.EmailField()
    role = serializers.ChoiceField(choices=TournamentMembershipRole.choices)
    event_id = serializers.UUIDField(required=False)
