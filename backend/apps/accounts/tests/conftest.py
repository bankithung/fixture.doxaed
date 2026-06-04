"""Pytest conftest for the accounts app.

Disables ``django-axes`` middleware for the duration of accounts unit
tests except where explicitly testing lockout — axes mutates the DB on
every login attempt and we don't want that coupling in unit tests.

The ``test_login_flow.py`` module re-enables it locally for the lockout
test.
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _disable_axes(settings):
    settings.AXES_ENABLED = False


@pytest.fixture
def axes_enabled(settings):
    settings.AXES_ENABLED = True
    return settings
