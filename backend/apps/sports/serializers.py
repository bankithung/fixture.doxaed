"""Read-only serializers for the sports catalog.

The Phase 1A surface is read-only — write paths arrive in Phase 1B
when each sport's per-sport plugin app starts shipping.
"""
from __future__ import annotations

from rest_framework import serializers

from apps.sports.models import Sport


class SportSerializer(serializers.ModelSerializer):
    class Meta:
        model = Sport
        fields = (
            "id",
            "code",
            "name",
            "category",
            "status",
            "description",
            "indigenous_to",
            "is_team_sport",
            "is_individual_sport",
            "icon",
            "display_order",
        )
        read_only_fields = fields
