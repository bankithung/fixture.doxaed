"""Per-competition draw configuration (fixture-engine redesign spec §2.1).

``Tournament.draw_config`` is a JSONB blob keyed by category-leaf key, with
``"*"`` as the tournament-wide default layer. It holds GENERATION inputs
(format, group size, legs, seeding method, third place) — deliberately
outside ``Tournament.rules``: rules freeze at registration_open (invariant 7,
the participant contract) while draw config is routinely finalized after
registration closes and is governed by invariant 10 (inputs_hash staleness)
instead.

Effective config layering (back-compat — spec §2.1):

    DEFAULT_DRAW_CONFIG < legacy rules keys (format/group_size/
    advance_per_group) < draw_config["*"] < draw_config[leaf] <
    explicit API request params

Explicit request params always win, so every existing caller keeps working.
Stored layers stay SPARSE (only the keys the organizer set) so "*" and
per-leaf precedence keep composing.
"""
from __future__ import annotations

import copy
from typing import Any

from django.utils import timezone

DEFAULT_DRAW_CONFIG: dict[str, Any] = {
    "format": "round_robin",         # round_robin | knockout | groups_knockout
                                     # | swiss | double_elim
    "group_size": 5,
    # R3 FIFA-style auto group-sizing: when true, ``group_size`` is the TARGET
    # and the engine derives ceil(n/target) even-sized groups (no orphan group).
    # Off by default for back-compat; the format board turns it on for new
    # groups_knockout configs.
    "balance_groups": False,
    "advance_per_group": 2,
    "advance_best_thirds": 0,        # best next-placed cross-group qualifiers
    "legs": 1,                       # 1 | 2 (double round-robin, mirrored 2nd cycle)
    "swiss_rounds": None,            # format="swiss": rounds; None = ceil(log2 n), cap n-1
    # Swiss bye bookkeeping persisted BY generation (increment P) — one entry
    # {"round": int, "team_id": str} per odd-count round; the bye team is
    # credited full win points in the Swiss pairing standings. Never an input
    # (excluded from inputs_hash, like "seed").
    "swiss_byes": [],
    "seeding": "registration",       # registration | random | snake | seeded
    "knockout_seeding": "cross",     # cross | overall (groups→knockout pool)
    "seed": None,                    # RNG seed; persisted on first random draw
    "third_place": False,            # knockout formats only
    "plate": False,                  # consolation plate over round-1 losers
    # seeded_byes = classic bracket: field padded to a power of two, ALL byes
    # burned in round 1 (federation standard). pair_all (owner ask 2026-07-13)
    # = every round pairs as many entrants as possible in order; only a
    # leftover odd slot is byed forward, so a 20-team field plays a full
    # 10-match round 1 (at the cost of byes landing deeper when counts go odd).
    "bye_policy": "seeded_byes",
    "min_entries_action": "prompt",  # prompt | cancel (auto_champion deferred — §9 A6)
    "constraints_reviewed_at": None,  # ISO timestamp ("Mark reviewed" — §9 A10)
    # Global-setup wizard calendar (§5.1 "wizard-saved dates"; only meaningful
    # on the "*" layer): slot-time data, excluded from the draw inputs_hash.
    "calendar": None,
    # Per-competition match length (minutes). Layered scalar: "*" = tournament
    # default, "<leaf>" = per-category override. Scheduling-only (it changes how
    # long a match BLOCKS the calendar, never WHO plays WHOM) so it is excluded
    # from inputs_hash. None = inherit (sport override → SPORT_PROFILES → global
    # slot_minutes). Resolved by scheduler.duration_for().
    "match_duration_minutes": None,
    # Composable MULTI-STAGE plan (owner ask 2026-06-27). None/[] = single-stage
    # (derive from `format`, back-compat). A non-empty ordered list is the
    # authoritative stage plan: each element a StageSpec (see _validate_stages).
    # Multi-stage design §3; canonicalized out of inputs_hash double-counting by
    # _canonical_draw_for_hash. Participant-facing SCORING still lives in
    # rules.by_leaf (frozen) — stages are structure, governed by invariant 10.
    "stages": None,
}

_FORMATS = {"round_robin", "knockout", "groups_knockout", "swiss",
            "double_elim"}
_SEEDINGS = {"registration", "random", "snake", "seeded"}
_KNOCKOUT_SEEDINGS = {"cross", "overall"}
_BYE_POLICIES = {"seeded_byes", "pair_all"}
_MIN_ENTRIES_ACTIONS = {"prompt", "cancel"}

# --- Multi-stage (stages) schema ------------------------------------------
_STAGE_TYPES = {"round_robin", "knockout", "swiss", "double_elim"}
_QUAL_METHODS = {"top_n_per_group", "winners", "losers", "all", "overall_top_n"}
_MAX_STAGES = 4
_STAGE_KEYS = {"id", "name", "type", "group_size", "balance_groups",
               "min_matches_per_team", "legs", "partition", "seeding",
               "third_place", "plate", "swiss_rounds", "from"}
_FROM_KEYS = {"stage", "method", "advance_per_group", "advance_best_thirds",
              "seeding"}

# Legacy rules keys that act as a fallback layer below draw_config (§2.1).
_LEGACY_RULES_KEYS = ("format", "group_size", "advance_per_group")


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


_CALENDAR_KEYS = {"date_start", "date_end", "daily_start", "daily_end",
                  "slot_minutes"}


def _validate_calendar(cal: Any) -> None:
    """The wizard-saved calendar: None or a sparse dict of ISO dates ("YYYY-
    MM-DD"), wall-clock times ("HH:MM" — invariant 14 / §9 A4) and a positive
    slot length."""
    from datetime import date, time

    if cal is None:
        return
    if not isinstance(cal, dict):
        raise ValueError("calendar must be an object")
    unknown = set(cal) - _CALENDAR_KEYS
    if unknown:
        raise ValueError(f"unknown calendar keys: {sorted(unknown)}")
    for key, parse, what in (
        ("date_start", date.fromisoformat, "an ISO date"),
        ("date_end", date.fromisoformat, "an ISO date"),
        ("daily_start", time.fromisoformat, "an HH:MM time"),
        ("daily_end", time.fromisoformat, "an HH:MM time"),
    ):
        v = cal.get(key)
        if v is None:
            continue
        try:
            if not isinstance(v, str):
                raise ValueError
            parse(v)
        except ValueError:
            raise ValueError(f"calendar.{key} must be {what} string") from None
    sm = cal.get("slot_minutes")
    if sm is not None and (not _is_int(sm) or sm < 1):
        raise ValueError("calendar.slot_minutes must be a positive integer")


def _validate_stage_params(s: dict[str, Any]) -> None:
    """Per-type scalar checks for one stage's own params (mirrors the flat
    scalar rules so greedy/validate never diverge)."""
    if "group_size" in s and (not _is_int(s["group_size"]) or s["group_size"] < 2):
        raise ValueError("stage group_size must be an integer >= 2")
    if "legs" in s and s["legs"] not in (1, 2):
        raise ValueError("stage legs must be 1 or 2")
    if "seeding" in s and s["seeding"] not in _SEEDINGS:
        raise ValueError(f"unknown stage seeding: {s['seeding']!r}")
    if "swiss_rounds" in s and s["swiss_rounds"] is not None \
            and (not _is_int(s["swiss_rounds"]) or s["swiss_rounds"] < 1):
        raise ValueError("stage swiss_rounds must be a positive integer")
    for b in ("balance_groups", "third_place", "plate"):
        if b in s and not isinstance(s[b], bool):
            raise ValueError(f"stage {b} must be a boolean")
    if "partition" in s and s["partition"] not in ("", "category"):
        raise ValueError("stage partition must be '' or 'category'")
    mm = s.get("min_matches_per_team")
    if "min_matches_per_team" in s and mm is not None:
        if s.get("type") != "round_robin":
            raise ValueError("min_matches_per_team is only valid on a round_robin stage")
        if not _is_int(mm) or mm < 1:
            raise ValueError("min_matches_per_team must be a positive integer")


def _validate_stages(stages: Any) -> None:
    """Validate the multi-stage plan (multi-stage design §3.4). None/[] is OK
    (single-stage). Enforces: known type, unique ids, a backward-only `from`
    on every stage past the first (none on the first), the FIFA cross-field
    guard (top_n advance < source group_size), terminal-stage-must-be-last, and
    the v1 single-swiss / single-randomized guard."""
    if stages is None:
        return
    if not isinstance(stages, list):
        raise ValueError("stages must be a list")
    if not stages:
        return  # [] = single-stage (derive from the flat format)
    if len(stages) > _MAX_STAGES:
        raise ValueError(f"stages must have at most {_MAX_STAGES} entries")

    for i, s in enumerate(stages):
        if not isinstance(s, dict):
            raise ValueError("each stage must be an object")
        unknown = set(s) - _STAGE_KEYS
        if unknown:
            raise ValueError(f"unknown stage keys: {sorted(unknown)}")
        if s.get("type") not in _STAGE_TYPES:
            raise ValueError(f"unknown stage type: {s.get('type')!r}")
        if "id" in s and (not isinstance(s["id"], str) or not s["id"]):
            raise ValueError("stage id must be a non-empty string")
        _validate_stage_params(s)
        frm = s.get("from")
        if i == 0:
            if frm:
                raise ValueError("the first stage cannot have a 'from' block")
        elif frm is not None:
            if not isinstance(frm, dict):
                raise ValueError("stage 'from' must be an object")
            unk = set(frm) - _FROM_KEYS
            if unk:
                raise ValueError(f"unknown from keys: {sorted(unk)}")
            if frm.get("method", "top_n_per_group") not in _QUAL_METHODS:
                raise ValueError(f"unknown qualification method: {frm.get('method')!r}")
            apg = frm.get("advance_per_group", 1)
            if not _is_int(apg) or apg < 1:
                raise ValueError("from.advance_per_group must be an integer >= 1")
            abt = frm.get("advance_best_thirds", 0)
            if not _is_int(abt) or abt < 0:
                raise ValueError("from.advance_best_thirds must be an integer >= 0")
            if "seeding" in frm and frm["seeding"] not in _KNOCKOUT_SEEDINGS:
                raise ValueError("from.seeding must be 'cross' or 'overall'")

    ids = [s["id"] for s in stages if "id" in s]
    if len(ids) != len(set(ids)):
        raise ValueError("stage ids must be unique")
    idx_by_id = {s["id"]: i for i, s in enumerate(stages) if "id" in s}

    # terminal (single-winner) brackets must be the last stage
    for s in stages[:-1]:
        if s["type"] in ("knockout", "double_elim"):
            raise ValueError("a knockout must be the last stage")

    for i, s in enumerate(stages):
        if i == 0:
            continue
        frm = s.get("from") or {}
        ref = frm.get("stage")
        if ref is not None and (ref not in idx_by_id or idx_by_id[ref] >= i):
            raise ValueError("from.stage must reference an earlier stage")
        src_i = idx_by_id.get(ref, i - 1) if ref else i - 1
        src = stages[src_i]
        if frm.get("method", "top_n_per_group") == "top_n_per_group" \
                and src.get("type") == "round_robin":
            gs = src.get("group_size", DEFAULT_DRAW_CONFIG["group_size"])
            if frm.get("advance_per_group", 1) >= gs:
                raise ValueError("advance_per_group must be smaller than the source group_size")

    if sum(1 for s in stages if s["type"] == "swiss") > 1:
        raise ValueError("at most one swiss stage is allowed in v1")
    if sum(1 for s in stages if s.get("seeding") == "random") > 1:
        raise ValueError("at most one randomized-seeding stage is allowed in v1")


def _validate_layer(layer: dict[str, Any]) -> None:
    """Validate one (sparse) stored layer. Cross-field checks (§9 A8) run
    against the layer's own values falling back to the defaults."""
    if "format" in layer and layer["format"] not in _FORMATS:
        raise ValueError(f"unknown draw format: {layer['format']!r}")
    if "seeding" in layer and layer["seeding"] not in _SEEDINGS:
        raise ValueError(f"unknown seeding method: {layer['seeding']!r}")
    if "knockout_seeding" in layer \
            and layer["knockout_seeding"] not in _KNOCKOUT_SEEDINGS:
        raise ValueError(
            f"unknown knockout_seeding: {layer['knockout_seeding']!r}"
        )
    if "bye_policy" in layer and layer["bye_policy"] not in _BYE_POLICIES:
        raise ValueError(f"unsupported bye_policy: {layer['bye_policy']!r}")
    if "min_entries_action" in layer \
            and layer["min_entries_action"] not in _MIN_ENTRIES_ACTIONS:
        raise ValueError(
            f"unsupported min_entries_action: {layer['min_entries_action']!r}"
        )
    if "legs" in layer and layer["legs"] not in (1, 2):
        raise ValueError("legs must be 1 or 2")
    if "swiss_rounds" in layer and layer["swiss_rounds"] is not None \
            and (not _is_int(layer["swiss_rounds"]) or layer["swiss_rounds"] < 1):
        raise ValueError("swiss_rounds must be a positive integer")
    if "swiss_byes" in layer:
        byes = layer["swiss_byes"]
        if not isinstance(byes, list) or not all(
            isinstance(b, dict) and _is_int(b.get("round")) and b.get("team_id")
            for b in byes
        ):
            raise ValueError("swiss_byes must be a list of {round, team_id}")
    if "third_place" in layer and not isinstance(layer["third_place"], bool):
        raise ValueError("third_place must be a boolean")
    if "plate" in layer and not isinstance(layer["plate"], bool):
        raise ValueError("plate must be a boolean")
    if "seed" in layer and layer["seed"] is not None and not _is_int(layer["seed"]):
        raise ValueError("seed must be an integer")
    if "constraints_reviewed_at" in layer \
            and layer["constraints_reviewed_at"] is not None \
            and not isinstance(layer["constraints_reviewed_at"], str):
        raise ValueError("constraints_reviewed_at must be an ISO timestamp string")
    if "calendar" in layer:
        _validate_calendar(layer["calendar"])
    if "match_duration_minutes" in layer \
            and layer["match_duration_minutes"] is not None \
            and (not _is_int(layer["match_duration_minutes"])
                 or layer["match_duration_minutes"] < 1):
        raise ValueError("match_duration_minutes must be a positive integer")
    if "balance_groups" in layer and not isinstance(layer["balance_groups"], bool):
        raise ValueError("balance_groups must be a boolean")
    if "stages" in layer:
        _validate_stages(layer["stages"])

    group_size = layer.get("group_size", DEFAULT_DRAW_CONFIG["group_size"])
    advance = layer.get("advance_per_group", DEFAULT_DRAW_CONFIG["advance_per_group"])
    if "group_size" in layer and (not _is_int(group_size) or group_size < 2):
        raise ValueError("group_size must be an integer >= 2")  # §9 A8
    if "advance_per_group" in layer and (not _is_int(advance) or advance < 1):
        raise ValueError("advance_per_group must be an integer >= 1")
    best_thirds = layer.get("advance_best_thirds")
    if "advance_best_thirds" in layer \
            and (not _is_int(best_thirds) or best_thirds < 0):
        raise ValueError("advance_best_thirds must be an integer >= 0")
    if advance >= group_size:
        raise ValueError("advance_per_group must be smaller than group_size")  # §9 A8


def merge_draw_config(
    partial: dict[str, Any] | None,
    base: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Whitelist-merge a partial onto a stored layer (NOT onto the defaults —
    layers stay sparse so "*"/leaf precedence keeps working). Raises
    ValueError on unknown keys or invalid values (mirrors ``merge_rules``)."""
    unknown = set(partial or {}) - set(DEFAULT_DRAW_CONFIG)
    if unknown:
        raise ValueError(f"unknown draw_config keys: {sorted(unknown)}")
    out = dict(base or {})
    out.update(partial or {})
    _validate_layer(out)
    return out


def effective_draw_config(
    tournament,
    leaf_key: str | None = None,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve the effective draw config for one competition (spec §2.1):
    defaults < legacy rules keys < draw_config["*"] < draw_config["sport:<k>"]
    < draw_config[leaf] < ``overrides`` (explicit request params — copied
    verbatim so legacy API format values like "by_category" keep winning
    unchanged). The sport layer (owner ask 2026-06-25) lets one write set the
    format for every category of a sport — "all Table Tennis is knockout" —
    inherited by each leaf unless that leaf overrides it."""
    from apps.tournaments.services.sports import sport_for_leaf

    out = copy.deepcopy(DEFAULT_DRAW_CONFIG)
    rules = tournament.rules or {}
    for key in _LEGACY_RULES_KEYS:
        if key in rules:
            out[key] = rules[key]
    stored = tournament.draw_config or {}
    layers = ["*"]
    if leaf_key and leaf_key != "*":
        if leaf_key.startswith("sport:"):
            layers.append(leaf_key)
        else:
            sport = sport_for_leaf(tournament.sports, leaf_key)
            if sport:
                layers.append(f"sport:{sport}")
            layers.append(leaf_key)
    for layer_key in layers:
        layer = stored.get(layer_key)
        if isinstance(layer, dict):
            for k, v in layer.items():
                if k in DEFAULT_DRAW_CONFIG:
                    out[k] = v
    for k, v in (overrides or {}).items():
        if k in DEFAULT_DRAW_CONFIG and v is not None:
            out[k] = v
    return out


def _derive_stages_from_format(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """A one-stage plan derived from the legacy flat `format` — so single-format
    competitions read as a one-element stage list and generate byte-identically.
    `groups_knockout` derives ONE round_robin stage (its knockout stays the
    manual knockout_from_groups call); multi-stage auto-fire is opt-in only via
    an explicit `stages` list (multi-stage design §3.5, P0 #5)."""
    fmt = cfg.get("format", "round_robin")
    seeding = cfg.get("seeding", "registration")
    if fmt == "knockout":
        return [{"type": "knockout", "seeding": seeding,
                 "third_place": cfg.get("third_place", False),
                 "plate": cfg.get("plate", False)}]
    if fmt == "swiss":
        return [{"type": "swiss", "seeding": seeding,
                 "swiss_rounds": cfg.get("swiss_rounds")}]
    if fmt == "double_elim":
        return [{"type": "double_elim", "seeding": seeding}]
    if fmt == "by_category":
        return [{"type": "round_robin", "legs": cfg.get("legs", 1),
                 "seeding": seeding, "partition": "category"}]
    # round_robin AND groups_knockout → a single round_robin stage
    return [{"type": "round_robin", "group_size": cfg.get("group_size", 5),
             "balance_groups": cfg.get("balance_groups", False),
             "legs": cfg.get("legs", 1), "seeding": seeding}]


def effective_stages(
    tournament, leaf_key: str | None = None, cfg: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """The normalized ordered stage list for one competition. A non-empty stored
    `stages` wins; otherwise derive a one-stage plan from the flat format (zero
    migration, byte-identical generation). Derived stages carry deterministic
    synthetic ids so id-keyed code stays uniform."""
    if cfg is None:
        cfg = effective_draw_config(tournament, leaf_key)
    stages = cfg.get("stages")
    if stages:
        return [dict(s) for s in stages]
    derived = _derive_stages_from_format(cfg)
    for i, s in enumerate(derived):
        s.setdefault("id", f"legacy:{leaf_key or '*'}:{i}")
    return derived


def fill_stage_ids(stages: Any) -> Any:
    """Auto-fill any missing stage `id` with a uuid7 (invariant 1) so stored
    stages always carry a stable handle, even if a client omits one."""
    if not isinstance(stages, list):
        return stages
    from apps.accounts.models import uuid7

    for s in stages:
        if isinstance(s, dict) and not s.get("id"):
            s["id"] = str(uuid7())
    return stages


def leaf_has_matches(tournament, leaf_key: str | None) -> bool:
    """True once non-deleted matches exist in scope — the per-leaf freeze
    signal (§2.1): edits stay allowed but the UI shows the invariant-10
    regenerate/keep/diff banner."""
    from django.db.models import Q

    from apps.matches.models import Match

    qs = Match.objects.filter(tournament=tournament, deleted_at__isnull=True)
    lk = str(leaf_key or "*")
    if lk.startswith("sport:"):
        sport = lk[len("sport:"):]
        qs = qs.filter(Q(leaf_key=sport) | Q(leaf_key__startswith=f"{sport}."))
    elif lk != "*":
        qs = qs.filter(leaf_key=lk)
    return qs.exists()


def update_draw_config(
    *, tournament, leaf_key: str, partial: dict[str, Any] | None,
    by, event_id=None, request=None,
):
    """Update one layer of ``tournament.draw_config`` (manager/bracket-editor
    verb — the view gates it). Whitelist merge, idempotent on ``event_id``
    (invariant 3, via AuditEvent), audited as ``draw_config_updated``.

    ``leaf_key`` is "*" (tournament-wide defaults), "sport:<sport_key>" (every
    category of one sport — owner ask 2026-06-25), or a configured category
    leaf key. Raises ValueError on an unknown sport/leaf/keys/values.
    """
    from django.db import transaction

    from apps.audit.models import ActorRole, AuditEvent
    from apps.audit.services import emit_audit
    from apps.tournaments.services.sports import iter_leaves

    leaf_key = str(leaf_key or "*")
    if leaf_key.startswith("sport:"):
        sport_key = leaf_key[len("sport:"):]
        known_sports = {s.get("key") for s in (tournament.sports or [])}
        if sport_key not in known_sports:
            raise ValueError(f"unknown sport_key: {sport_key!r}")
    elif leaf_key != "*":
        known = {leaf["leaf_key"] for leaf in iter_leaves(tournament.sports)}
        if leaf_key not in known:
            raise ValueError(f"unknown leaf_key: {leaf_key!r}")

    if event_id is not None:
        prior = AuditEvent.objects.filter(
            idempotency_key=event_id, event_type="draw_config_updated"
        ).first()
        if prior is not None:
            return tournament  # replay (invariant 3)

    stored = dict(tournament.draw_config or {})
    before = stored.get(leaf_key)
    merged = merge_draw_config(partial, base=before)
    if isinstance(merged.get("stages"), list):
        fill_stage_ids(merged["stages"])

    with transaction.atomic():
        stored[leaf_key] = merged
        tournament.draw_config = stored
        tournament.last_manual_edit_at = timezone.now()
        tournament.save(update_fields=["draw_config", "last_manual_edit_at"])
        emit_audit(
            actor_user=by,
            actor_role=ActorRole.ADMIN,
            event_type="draw_config_updated",
            target_type="tournament",
            target_id=tournament.id,
            organization_id=tournament.organization_id,
            tournament_id=tournament.id,
            idempotency_key=event_id,
            payload_before={"leaf_key": leaf_key, "config": before},
            payload_after={"leaf_key": leaf_key, "config": merged},
            request=request,
        )
    return tournament
