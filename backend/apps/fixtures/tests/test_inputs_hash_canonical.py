"""Increment 0 — the inputs_hash canonicalizer must be a NO-OP for every
existing (stage-less) format, so adding `stages` later can't flip every
competition to "inputs changed" (multi-stage design §10.3, R1)."""
from __future__ import annotations

from apps.fixtures.services.generate import (
    _HASH_EXCLUDED_KEYS,
    _canonical_draw_for_hash,
)


def _legacy(cfg: dict) -> dict:
    """The pre-canonicalizer payload (plain excluded-key filter)."""
    return {k: v for k, v in cfg.items() if k not in _HASH_EXCLUDED_KEYS}


def test_canonical_is_byte_identical_without_stages():
    for fmt in ("round_robin", "knockout", "groups_knockout", "swiss",
                "double_elim", "by_category"):
        cfg = {
            "format": fmt, "group_size": 4, "advance_per_group": 2,
            "advance_best_thirds": 0, "knockout_seeding": "cross", "legs": 1,
            "third_place": True, "plate": False, "balance_groups": True,
            "swiss_rounds": None, "seeding": "registration",
            # excluded keys that must NOT enter the hash
            "seed": 7, "match_duration_minutes": 20, "calendar": {},
        }
        assert _canonical_draw_for_hash(cfg) == _legacy(cfg)


def test_empty_or_absent_stages_yield_the_same_payload():
    base = {"format": "round_robin", "group_size": 4}
    assert _canonical_draw_for_hash({**base, "stages": []}) == _canonical_draw_for_hash(base)
    assert _canonical_draw_for_hash({**base, "stages": None}) == _canonical_draw_for_hash(base)
    assert "stages" not in _canonical_draw_for_hash({**base, "stages": []})


def test_stages_drop_flat_mirror_and_strip_ids_names():
    cfg = {
        "format": "groups_knockout", "group_size": 5, "advance_per_group": 2,
        "third_place": False, "match_duration_minutes": 15,
        "stages": [
            {"id": "aaa", "name": "Groups", "type": "round_robin", "group_size": 5},
            {"id": "bbb", "name": "KO", "type": "knockout",
             "from": {"stage": "aaa", "method": "top_n_per_group", "advance_per_group": 2}},
        ],
    }
    out = _canonical_draw_for_hash(cfg)
    # flat mirror dropped (stages authoritative); excluded key still gone
    for k in ("format", "group_size", "advance_per_group", "third_place",
              "match_duration_minutes"):
        assert k not in out
    # ids + cosmetic names stripped; from.stage rewritten id → positional index
    assert out["stages"][0] == {"type": "round_robin", "group_size": 5}
    assert out["stages"][1]["from"]["stage"] == 0
    assert "id" not in out["stages"][1] and "name" not in out["stages"][1]


def test_renaming_a_stage_or_new_id_does_not_change_the_payload():
    mk = lambda name, sid: {  # noqa: E731
        "stages": [{"id": sid, "name": name, "type": "round_robin", "group_size": 4}]
    }
    assert _canonical_draw_for_hash(mk("Groups", "x")) == _canonical_draw_for_hash(
        mk("Pool Phase", "y")
    )
