"""effective_modules() resolver — Appendix A.4.

Algorithm (corrected for multi-role):
  1. Find all active OrganizationMembership rows for (user, org). Collect
     their `role` values into a set.
  2. For each Module in the catalog, if any role in the user's role-set
     appears in `module.default_for_roles`, the module is in the base set.
  3. Apply MembershipModuleGrant overrides for (user, org):
        - state=grant → add module code to set.
        - state=deny  → remove module code from set.
        - state=default → no-op.
  4. Return the resulting frozenset of module CODES.

Caching: Django cache backend (locmem in dev, Redis in prod) under
key `effective_modules:{user.id}:{org.id}`, TTL 5 minutes. Cache is
invalidated on every grant write at the service layer (see
`apps.permissions.services.grants`). The full Redis pub/sub
invalidation contract (Appendix B.3) is deferred to Phase 1B —
TODOs are left at the cache.delete() call sites.

Public API:
    effective_modules(user, organization) -> frozenset[str]
    has_module(user, organization, module_code) -> bool
"""
from __future__ import annotations

import uuid
from collections.abc import Iterable

from django.core.cache import cache

# Cache key prefix and TTL
CACHE_KEY_PREFIX = "effective_modules"
CACHE_TTL_SECONDS = 300  # 5 minutes


def cache_key(user_id: uuid.UUID, organization_id: uuid.UUID) -> str:
    """Build the cache key for a (user, organization) pair."""
    return f"{CACHE_KEY_PREFIX}:{user_id}:{organization_id}"


def invalidate_cache(user_id: uuid.UUID, organization_id: uuid.UUID) -> None:
    """Drop the cache entry for (user, org).

    TODO (Appendix B.3): publish to Redis pub/sub channel
    `effective_modules_invalidate` so other ASGI workers also drop
    their local-mem cache. Phase 1A is single-process safe via the
    shared backend; cross-worker invalidation lands in Phase 1B.
    """
    cache.delete(cache_key(user_id, organization_id))


def _user_active_roles(user, organization) -> set[str]:
    """Return the set of MembershipRole string values active for (user, org)."""
    # Local import to avoid circular import at module load time.
    from apps.organizations.models import OrganizationMembership

    return set(
        OrganizationMembership.objects.filter(
            user=user,
            organization=organization,
            is_active=True,
        ).values_list("role", flat=True)
    )


def _base_modules_for_roles(roles: Iterable[str]) -> set[str]:
    """Union of `default_for_roles` membership across the role set.

    Returns module CODES. Empty role set → empty set.
    """
    from apps.permissions.models import Module

    role_set = set(roles)
    if not role_set:
        return set()

    base: set[str] = set()
    for code, default_for in Module.objects.values_list(
        "code", "default_for_roles"
    ):
        if not default_for:
            continue
        if role_set.intersection(default_for):
            base.add(code)
    return base


def _apply_overrides(base: set[str], user, organization) -> set[str]:
    """Apply MembershipModuleGrant overrides for (user, org)."""
    from apps.permissions.models import GrantState, MembershipModuleGrant

    rows = MembershipModuleGrant.objects.filter(
        user=user, organization=organization
    ).select_related("module").values_list("module__code", "state")

    out = set(base)
    for code, state in rows:
        if state == GrantState.GRANT:
            out.add(code)
        elif state == GrantState.DENY:
            out.discard(code)
        # DEFAULT → no-op
    return out


def effective_modules(user, organization) -> frozenset[str]:
    """Return the set of module CODES the user has effective access to in org.

    Caches the result for 5 minutes. Pass an organization instance with a
    `.id` attribute (the resolver does not load it).
    """
    if user is None or not getattr(user, "is_authenticated", True):
        return frozenset()

    user_id = getattr(user, "id", None) or getattr(user, "pk", None)
    org_id = getattr(organization, "id", None) or getattr(organization, "pk", None)
    if user_id is None or org_id is None:
        return frozenset()

    key = cache_key(user_id, org_id)
    cached = cache.get(key)
    if cached is not None:
        return cached

    roles = _user_active_roles(user, organization)
    base = _base_modules_for_roles(roles)
    final = _apply_overrides(base, user, organization)

    result = frozenset(final)
    cache.set(key, result, CACHE_TTL_SECONDS)
    return result


def has_module(user, organization, module_code: str) -> bool:
    """Convenience: True iff `module_code` is in the user's effective set."""
    return module_code in effective_modules(user, organization)


# --------------------------------------------------------------------------- tournament scope
# The tournament-scoped twin (spec 2026-06-10 P5): same algorithm, with roles
# read from ACTIVE TournamentMembership rows and overrides from
# TournamentModuleGrant. This is what finally connects the module catalog to
# the tournament workspace — tournament-only invitees used to resolve to an
# empty set because only OrganizationMembership was consulted.

TOURNAMENT_CACHE_KEY_PREFIX = "effective_tournament_modules"


def tournament_cache_key(user_id: uuid.UUID, tournament_id: uuid.UUID) -> str:
    return f"{TOURNAMENT_CACHE_KEY_PREFIX}:{user_id}:{tournament_id}"


def invalidate_tournament_cache(user_id: uuid.UUID, tournament_id: uuid.UUID) -> None:
    cache.delete(tournament_cache_key(user_id, tournament_id))


def _tournament_active_roles(user, tournament) -> set[str]:
    from apps.tournaments.models import (
        TournamentMembership,
        TournamentMembershipStatus,
    )

    return set(
        TournamentMembership.objects.filter(
            user=user,
            tournament=tournament,
            status=TournamentMembershipStatus.ACTIVE,
        ).values_list("role", flat=True)
    )


def _apply_tournament_overrides(base: set[str], user, tournament) -> set[str]:
    from apps.permissions.models import GrantState, TournamentModuleGrant

    rows = TournamentModuleGrant.objects.filter(
        user=user, tournament=tournament
    ).values_list("module__code", "state")
    out = set(base)
    for code, state in rows:
        if state == GrantState.GRANT:
            out.add(code)
        elif state == GrantState.DENY:
            out.discard(code)
    return out


def effective_tournament_modules(user, tournament) -> frozenset[str]:
    """Module codes the user can use inside this tournament: union of
    ``default_for_roles`` over their active tournament roles, then per-member
    TournamentModuleGrant overrides. Org-admins of the owning workspace get
    the full catalog (they can manage everything anyway). Cached 5 minutes;
    invalidated on every grant/membership write."""
    if user is None or not getattr(user, "is_authenticated", True):
        return frozenset()
    user_id = getattr(user, "id", None)
    trn_id = getattr(tournament, "id", None)
    if user_id is None or trn_id is None:
        return frozenset()

    key = tournament_cache_key(user_id, trn_id)
    cached = cache.get(key)
    if cached is not None:
        return cached

    from apps.organizations.models import MembershipRole, OrganizationMembership
    from apps.permissions.models import Module

    if OrganizationMembership.objects.filter(
        user=user,
        organization_id=tournament.organization_id,
        role=MembershipRole.ADMIN,
        is_active=True,
    ).exists():
        result = frozenset(Module.objects.values_list("code", flat=True))
    else:
        roles = _tournament_active_roles(user, tournament)
        base = _base_modules_for_roles(roles)
        result = frozenset(_apply_tournament_overrides(base, user, tournament))

    cache.set(key, result, CACHE_TTL_SECONDS)
    return result


def has_tournament_module(user, tournament, module_code: str) -> bool:
    return module_code in effective_tournament_modules(user, tournament)
