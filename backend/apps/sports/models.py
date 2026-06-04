"""Sports catalog — Phase 1B scaffold.

This app holds ONLY the catalog of sports the platform plans to support.
Each sport ships as its own per-sport plugin (its own Django app under
``apps.sports.<sport_code>``) when Phase 1B work for that sport begins.
Until then, every row is a metadata stub with ``status="planned"``.

The catalog is loaded from ``apps/sports/fixtures/sports.json`` via:

    python manage.py load_sports

It is intentionally NOT org-scoped — sports are platform-level metadata.
Per-org sport opt-in (which sports an organization actually offers) is
modelled separately when Tournament work begins.
"""
from __future__ import annotations

from django.db import models
from django.utils.translation import gettext_lazy as _

from apps.accounts.models import uuid7


class SportStatus(models.TextChoices):
    """Lifecycle of a sport entry in the catalog.

    `planned`     — placeholder; no per-sport plugin yet.
    `coming_soon` — plugin in development; visible in UI as "soon".
    `active`      — fully wired (Tournament + Match + rules engine ship).
    `deprecated`  — sport is being retired; existing tournaments allowed
                    to finish, no new ones.
    """

    PLANNED = "planned", _("Planned")
    COMING_SOON = "coming_soon", _("Coming soon")
    ACTIVE = "active", _("Active")
    DEPRECATED = "deprecated", _("Deprecated")


class SportCategory(models.TextChoices):
    """Coarse grouping for catalog UI filters.

    Aligned to common Indian school/college meet categories
    (SGFI / CBSE / AIU classifications).
    """

    TEAM = "team", _("Team")
    INDIVIDUAL = "individual", _("Individual")
    RACKET = "racket", _("Racket")
    COMBAT = "combat", _("Combat / Martial arts")
    ATHLETICS = "athletics", _("Athletics")
    AQUATICS = "aquatics", _("Aquatics")
    GYMNASTICS = "gymnastics", _("Gymnastics")
    STRENGTH = "strength", _("Strength sports")
    SHOOTING = "shooting", _("Shooting / Archery")
    MIND = "mind", _("Mind sports")
    INDIGENOUS = "indigenous", _("Indigenous / Traditional")
    ADVENTURE = "adventure", _("Adventure / Outdoor")
    OTHER = "other", _("Other")


class Sport(models.Model):
    """One row per sport the platform plans to support.

    Phase 1A ships the catalog only — every row starts with
    ``status="planned"``. As Phase 1B work for a sport begins, its row
    is flipped to ``coming_soon`` (announce it on the public marketing
    surface) and finally ``active`` once the rules engine + UI ship.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    # Stable slug — used in URLs and as the per-sport plugin app suffix
    # (e.g., code="football" → future app "apps.sports.football"). Must be
    # lowercase, ASCII, hyphen-separated.
    code = models.SlugField(max_length=64, unique=True)

    name = models.CharField(max_length=200)

    category = models.CharField(
        max_length=32,
        choices=SportCategory.choices,
        default=SportCategory.OTHER,
        db_index=True,
    )

    status = models.CharField(
        max_length=16,
        choices=SportStatus.choices,
        default=SportStatus.PLANNED,
        db_index=True,
    )

    description = models.TextField(blank=True)

    # Human-readable origin label (e.g., "India", "Maharashtra", "Manipur",
    # "International"). Useful for surfacing indigenous Indian sports
    # distinctly. Free-form by design — not a FK to a country/state table.
    indigenous_to = models.CharField(max_length=128, blank=True, default="")

    is_team_sport = models.BooleanField(default=False)
    is_individual_sport = models.BooleanField(default=False)

    # When the per-sport plugin app is built (Phase 1B), this field is
    # populated with its dotted Python path (e.g., "apps.sports.football").
    # Used by the live runtime to dispatch sport-specific behavior.
    # Null while the sport is in `planned` / `coming_soon` state.
    python_module_path = models.CharField(max_length=200, blank=True, default="")

    # Optional icon hint for the UI. Free-form (Lucide icon name, emoji,
    # or static path). The frontend chooses how to interpret.
    icon = models.CharField(max_length=64, blank=True, default="")

    # Sort order for catalog UI; lower first. Defaults to 1000 so
    # newly-added sports land at the bottom.
    display_order = models.PositiveIntegerField(default=1000)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "sports"
        db_table = "sports_sport"
        ordering = ["display_order", "name"]
        indexes = [
            models.Index(fields=["status"], name="sport_status_idx"),
            models.Index(fields=["category"], name="sport_category_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.name} ({self.code})"
