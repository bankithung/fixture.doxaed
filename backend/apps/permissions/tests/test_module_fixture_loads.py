"""load_modules management command — exactly 23 rows, idempotent."""
from __future__ import annotations

import pytest
from django.core.management import call_command

from apps.permissions.models import Module


@pytest.mark.django_db
def test_load_modules_creates_23_rows():
    call_command("load_modules")
    assert Module.objects.count() == 23


@pytest.mark.django_db
def test_load_modules_idempotent():
    call_command("load_modules")
    first = Module.objects.count()
    call_command("load_modules")
    second = Module.objects.count()
    assert first == second == 23


@pytest.mark.django_db
def test_module_codes_are_unique_and_well_formed():
    call_command("load_modules")
    codes = list(Module.objects.values_list("code", flat=True))
    assert len(codes) == len(set(codes)), "module codes must be unique"
    # Spot-check a couple of well-known codes from Appendix A.2.
    assert "tournament.editor" in codes
    assert "match.scoring_console" in codes
    assert "personal.profile" in codes
    # B.16 additions:
    assert "tournament.report_export" in codes
    assert "tournament.organizer_checklist" in codes
    assert "tournament.day_pack_export" in codes
    # Registration form builder module.
    assert "forms" in codes
