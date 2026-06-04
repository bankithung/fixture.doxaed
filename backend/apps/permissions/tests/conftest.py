"""Shared fixtures for permissions tests."""
from __future__ import annotations

import pytest
from django.core.cache import cache
from django.core.management import call_command


@pytest.fixture(autouse=True)
def _clear_cache():
    """Reset Django cache between tests so resolver cache doesn't leak."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def loaded_modules(db):
    """Load the 22-module catalog into the DB (idempotent)."""
    call_command("load_modules")
