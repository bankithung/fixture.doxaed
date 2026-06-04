"""Backwards-compatible alias for the legacy demo-admin seeder.

The original script seeded a single admin user. It has been superseded
by ``seed_full_demo.py`` which seeds all 7 Phase 1A roles. Running this
file delegates to the full seed so old commands still work.

Run with:  python manage.py shell < scripts/seed_demo_admin.py
"""
from __future__ import annotations

import os
import runpy

# Resolve scripts/seed_full_demo.py relative to *this* file when possible,
# otherwise fall back to a path relative to the current working directory
# (which is what `manage.py shell < scripts/...` uses — cwd = backend/).
_candidates = []
try:
    _candidates.append(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed_full_demo.py")
    )
except NameError:  # __file__ not defined when piped via stdin
    pass
_candidates.append(os.path.join(os.getcwd(), "scripts", "seed_full_demo.py"))

_target = next((p for p in _candidates if os.path.isfile(p)), None)
if _target is None:
    raise FileNotFoundError(
        "seed_full_demo.py not found relative to this file or cwd; "
        "run from the backend/ directory."
    )

runpy.run_path(_target, run_name="__main__")
