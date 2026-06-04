"""Pytest conftest for the organizations app."""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _disable_axes(settings):
    settings.AXES_ENABLED = False
