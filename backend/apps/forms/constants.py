from __future__ import annotations

from django.db import models
from django.utils.translation import gettext_lazy as _


class FormStatus(models.TextChoices):
    DRAFT = "draft", _("Draft")
    OPEN = "open", _("Open")
    CLOSED = "closed", _("Closed")


class FormPurpose(models.TextChoices):
    ORGANIZATION_REGISTRATION = "organization_registration", _("Organization registration")
    TEAM_REGISTRATION = "team_registration", _("Team registration")
    GENERIC = "generic", _("Generic")


class ResponseStatus(models.TextChoices):
    SUBMITTED = "submitted", _("Submitted")
    ACCEPTED = "accepted", _("Accepted")
    REJECTED = "rejected", _("Rejected")
    WAITLISTED = "waitlisted", _("Waitlisted")


# Canonical map between a tournament setup STAGE and the registration form
# PURPOSE that belongs to it. Single source of truth for: stage-binding at form
# creation, auto-close/reopen on stage transitions, and team-form generation.
# Stage keys are TournamentStage values, kept as plain string literals to avoid
# a forms -> tournaments import cycle (tournaments already imports forms).
STAGE_TO_PURPOSE: dict[str, str] = {
    "org_registration": FormPurpose.ORGANIZATION_REGISTRATION.value,
    "team_registration": FormPurpose.TEAM_REGISTRATION.value,
}
PURPOSE_TO_STAGE: dict[str, str] = {v: k for k, v in STAGE_TO_PURPOSE.items()}


# Field types whose answers are simple scalars/lists. The registry in
# services/fields.py is the source of truth for coerce/validate behaviour.
FIELD_TYPES = frozenset({
    "short_text", "long_text", "single_choice", "multi_choice", "dropdown",
    "email", "phone", "number", "date", "time", "rating", "linear_scale",
    "address", "file_upload", "section_text", "yes_no", "group",
})

# Field types that carry an `options` array.
CHOICE_TYPES = frozenset({"single_choice", "multi_choice", "dropdown"})

# Display-only types that never produce an answer.
DISPLAY_TYPES = frozenset({"section_text"})

# Visibility rule operators (see services/validation.py).
VISIBILITY_OPS = frozenset({
    "equals", "not_equals", "in", "includes", "gt", "lt", "answered",
})

# Roles that promote an answer onto a FormResponse column.
PROMOTED_ROLES = frozenset({"email", "phone", "name", "title"})
