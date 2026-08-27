"""The number a fixture calls each of its matches by.

ONE RULE, SERVER-SIDE (owner 2026-08-27: "all the fixtures used in all pages
should use only one source of truth, not different in different pages").

Every surface prints a match number — the public schedule sheet, the bracket
tree, the printed court grid and run sheet, the fixture editor, the scorer's
pre-match card — and each of them used to count for itself. They agreed only
by luck: the printed grid tie-broke inside a round on a uuid and numbered the
sepak takraw quarter-finals 16..19 in a different order than the public sheet,
so its own "Winner of Match 18" named a game the board called M16. A number
that means two things is worse than no number: it is what an official reads
out to send two teams to a table.

So the fixture states it. `fixture_no` rides every match payload, and a page
prints what it is given rather than deriving anything.

The rule itself is the DRAW's order, never the calendar's — competition, then
stage, then round, then the match's place in that round (`match_no`, the
tournament-wide sequence the generator hands out in emission order). A number
therefore never moves when the schedule is repaired.

And each COMPETITION counts from one (owner 2026-08-19: "count match by
category — Boys U14 match 1, Girls U14 match 1"). One run to 113 across a
whole meet said nothing about how big any category was; per category, the last
number IS that category's match count, and every bracket pointer names a match
in its own competition, so "Winner of M5" stays unambiguous beside the category
the row already names.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from apps.matches.models import Match

#: Everything the rule reads. A caller with rows already in hand can hand them
#: over instead of paying for a second query.
FIELDS = ("id", "leaf_key", "stage", "stage_no", "round_no", "match_no")


def _field(row: Any, key: str) -> Any:
    """One accessor for every shape a fixture row arrives in."""
    return row.get(key) if isinstance(row, dict) else getattr(row, key, None)


def _sort_key(row: Any) -> tuple:
    return (
        _field(row, "leaf_key") or "",
        _field(row, "stage") or "",
        _field(row, "stage_no") or 0,
        _field(row, "round_no") or 0,
        _field(row, "match_no") or 0,
        str(_field(row, "id")),
    )


def number_rows(rows: Iterable[Any]) -> dict[str, int]:
    """`{str(match id): number}` for rows that already carry `FIELDS`.

    Accepts model instances, dicts or `.values()` rows — the payload builders
    each hold a different shape of the same fixture, and every one of them must
    be able to ask for the numbering rather than re-derive it.
    """
    per_leaf: dict[str, int] = {}
    out: dict[str, int] = {}
    for row in sorted(rows, key=_sort_key):
        leaf = _field(row, "leaf_key") or "_"
        n = per_leaf.get(leaf, 0) + 1
        per_leaf[leaf] = n
        out[str(_field(row, "id"))] = n
    return out


def fixture_numbers(tournament_id) -> dict[str, int]:
    """The whole tournament's numbering, in one query.

    Soft-deleted matches are excluded, exactly as every reader of the fixture
    excludes them: a match removed by a re-draw must not hold a number and push
    the ones after it along.
    """
    return number_rows(
        Match.objects.filter(
            tournament_id=tournament_id, deleted_at__isnull=True
        ).values(*FIELDS)
    )
