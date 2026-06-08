from __future__ import annotations

from rest_framework import serializers


class PlayerInSerializer(serializers.Serializer):
    full_name = serializers.CharField(max_length=200)
    jersey_no = serializers.IntegerField(required=False, min_value=1, max_value=999)
    position = serializers.CharField(required=False, allow_blank=True, max_length=16)
    dob_year = serializers.IntegerField(required=False, min_value=1950, max_value=2025)
    is_goalkeeper = serializers.BooleanField(required=False, default=False)
    captain = serializers.BooleanField(required=False, default=False)


class TeamInSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200)
    short_name = serializers.CharField(required=False, allow_blank=True, max_length=40)
    players = PlayerInSerializer(many=True, required=False, default=list)


class InstitutionInSerializer(serializers.Serializer):
    """Admin direct-add / edit of an Institution (Stage-1)."""

    name = serializers.CharField(max_length=200)
    kind = serializers.ChoiceField(
        choices=["school", "college", "university", "club", "academy", "other"],
        required=False, default="school",
    )
    region = serializers.CharField(required=False, allow_blank=True, max_length=120)
    short_name = serializers.CharField(required=False, allow_blank=True, max_length=40)
    contact_name = serializers.CharField(required=False, allow_blank=True, max_length=200)
    contact_email = serializers.EmailField(required=False, allow_blank=True)
    contact_phone = serializers.CharField(required=False, allow_blank=True, max_length=32)


class SchoolRegistrationSerializer(serializers.Serializer):
    """Payload a school submits via the public registration link."""

    school_name = serializers.CharField(max_length=200)
    teams = TeamInSerializer(many=True)
    event_id = serializers.UUIDField(required=False)

    def validate_teams(self, value):
        if not value:
            raise serializers.ValidationError("Submit at least one team.")
        for team in value:
            captains = [p for p in team.get("players", []) if p.get("captain")]
            if len(captains) > 1:
                raise serializers.ValidationError(
                    f"Team '{team['name']}' has more than one captain."
                )
        return value
