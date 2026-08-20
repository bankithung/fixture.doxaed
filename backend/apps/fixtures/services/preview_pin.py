"""The previewed draw, PINNED (owner 2026-08-20).

The preview was a pure simulate that re-ran from scratch on every visit. That
is fine while every competition is seeded by registration order — the draw is
then a function of the registration list, so it comes back identical — but it
was never a promise, and it broke in both directions:

* A competition seeded at RANDOM minted a fresh seed on every preview, so the
  organizer was shown a different fixture each time they opened the page.
* "Try another draw" lived only in the open tab. Leave the page and the draw
  you liked was gone for good, replaced by the tournament's configured one.

So the winning draw is now pinned: the per-competition SEEDS (never the
matches) are written under ``draw_config["preview_pin"]`` and replayed on
every later preview, so the fixture is the same one on any device, for any
manager, until it is deliberately or necessarily redrawn:

* **Try another draw** ignores the pin, re-rolls and re-pins the winner.
* **The draw inputs change** — a team registered or withdrew, a format or a
  pairing rule was edited — and the pin no longer describes a draw that
  could be made. It is redrawn AUTOMATICALLY and the payload says so
  (owner: "fresh draw need to be automatic"), because replaying seeds
  against a different entry list is not the fixture that was approved.

**A pin is a seed, not a fixture.** Nothing about the matches is committed —
preview still writes no `Match` row, takes no `event_id`, and publishing is
still the only thing that creates a fixture (D6). ``preview_pin`` is also
inert to every reader of ``draw_config``: ``effective_draw_config`` resolves
only the ``"*"``, ``"sport:<k>"`` and leaf layers and copies only known keys,
and ``compute_inputs_hash`` hashes the EFFECTIVE config, so the pin can never
perturb the hash that decides whether the pin itself is stale.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from django.db import transaction
from django.utils import timezone

PIN_KEY = "preview_pin"
#: The bucket an all-competitions preview pins under. Not a leaf key, and not
#: "*" either — "*" IS a config layer and must stay one.
ALL_SCOPE = "__all__"
#: The legacy whole-tournament single preview. Its own bucket, because it
#: draws ONE combined fixture where ``__all__`` draws each competition on its
#: own config — the two are different fixtures and must not share a pin.
WHOLE_SCOPE = "__whole__"


def leaf_scope(leaf_key: str | None) -> str:
    """The pin bucket for a single-competition preview."""
    return f"leaf:{leaf_key}" if leaf_key else WHOLE_SCOPE


def fingerprint(tournament, leaf_keys: list[str | None]) -> str:
    """What the pin was drawn against.

    Every scoped ``inputs_hash`` (teams + effective draw config + pairing
    constraints) rolled into one digest. The CALENDAR is deliberately absent:
    moving the tournament's dates or hours re-times the fixture but must not
    re-pair it — an organizer who lengthens the day should not find the whole
    draw rearranged as a side effect.
    """
    from apps.fixtures.services.generate import compute_inputs_hash

    parts = sorted(
        (str(lk or ""), compute_inputs_hash(tournament, lk or None))
        for lk in leaf_keys
    )
    return hashlib.sha256(
        json.dumps(parts, sort_keys=True).encode("utf-8")
    ).hexdigest()


def read_pin(tournament, scope: str) -> dict[str, Any] | None:
    """The stored pin for this scope, or None when nothing is pinned."""
    pins = (tournament.draw_config or {}).get(PIN_KEY)
    if not isinstance(pins, dict):
        return None
    pin = pins.get(scope)
    return pin if isinstance(pin, dict) else None


def pin_is_current(pin: dict[str, Any] | None, current: str) -> bool:
    """Does this pin still describe a draw of the tournament as it stands?"""
    return bool(pin) and pin.get("fingerprint") == current


def write_pin(
    tournament, scope: str, *,
    seeds: dict[str, int | None], overrides: dict[str, Any] | None,
    current: str,
) -> dict[str, Any]:
    """Pin this scope's winning draw, and return the pin as stored.

    A seed ALONE does not describe a draw. "Try another draw" works by
    overriding every competition to random seeding, and a competition
    configured for registration order ignores any seed it is handed — so
    replaying the seeds without the override that made them meaningful hands
    back the tournament's configured draw and silently loses the shuffle the
    organizer chose. The pin therefore records both: the ``overrides`` the
    draw ran under, and the seeds it settled on.

    The row is re-read FOR UPDATE and the other keys merged back, so two
    managers previewing at the same moment cannot clobber each other's
    competitions (or the config layers a wizard saved a second earlier).
    ``last_manual_edit_at`` is deliberately untouched: pinning is the system
    remembering its own draw, not a manual edit of the setup (invariant 10).
    """
    pin = {
        # JSON keys are strings; the seeds come back through json as strings
        # too, so store and read them that way rather than half-and-half.
        "seeds": {str(k): v for k, v in seeds.items()},
        "overrides": dict(overrides) if overrides else None,
        "fingerprint": current,
        "created_at": timezone.now().isoformat(),
    }
    model = type(tournament)
    with transaction.atomic():
        row = model.objects.select_for_update().get(pk=tournament.pk)
        stored = dict(row.draw_config or {})
        pins = dict(stored.get(PIN_KEY) or {})
        pins[scope] = pin
        stored[PIN_KEY] = pins
        row.draw_config = stored
        row.save(update_fields=["draw_config"])
    # Keep the in-memory tournament the caller is still using in step with
    # what was written, so a later read in the same request sees the pin.
    merged = dict(tournament.draw_config or {})
    merged_pins = dict(merged.get(PIN_KEY) or {})
    merged_pins[scope] = pin
    merged[PIN_KEY] = merged_pins
    tournament.draw_config = merged
    return pin


def pin_payload(
    pin: dict[str, Any] | None, *, redrawn: bool, reason: str | None,
) -> dict[str, Any]:
    """What the preview body tells the client about its own stability.

    ``reason`` is why a fresh draw happened: ``first_preview`` (nothing was
    pinned yet), ``inputs_changed`` (the entry list, a format or a pairing
    rule moved), ``redraw_requested`` (Try another draw) or ``unplaceable``
    (the pinned draw could no longer be given times, so a better one was
    searched for). ``null`` when the pinned draw was replayed untouched.
    """
    return {
        "pinned": bool(pin),
        "created_at": (pin or {}).get("created_at"),
        "redrawn": redrawn,
        "reason": reason,
    }
