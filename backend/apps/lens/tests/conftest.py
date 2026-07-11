"""Lens test isolation: every test writes media + quarantine under tmp_path,
never into the real media tree (this box's dev DB/media ARE production)."""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolated_media(settings, tmp_path):
    settings.MEDIA_ROOT = str(tmp_path / "media")
    settings.LENS_QUARANTINE_ROOT = str(tmp_path / "quarantine")
