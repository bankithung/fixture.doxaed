"""Repo-wide test fixups.

Python 3.14 removed the ability to ``copy.copy(super())`` that Django's
``BaseContext.__copy__`` relies on, so any template render under the test
client's instrumentation (which copies every render Context) explodes with
``AttributeError: 'super' object has no attribute 'dicts'``. Production is
unaffected — only instrumented test renders copy contexts. Patch in a
Py3.14-safe copy with identical semantics.
"""
from __future__ import annotations

from django.template.context import BaseContext


def _safe_copy(self):  # noqa: ANN001, ANN202 - Django duck type
    duplicate = self.__class__.__new__(self.__class__)
    duplicate.__dict__.update(self.__dict__)
    duplicate.dicts = self.dicts[:]
    return duplicate


BaseContext.__copy__ = _safe_copy
