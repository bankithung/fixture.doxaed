"""permissions services — resolver and grant write paths.

Public surface:
    from apps.permissions.services import (
        effective_modules, has_module, set_grant, bulk_set_grants, clear_grants,
    )
"""
from apps.permissions.services.grants import (
    bulk_set_grants,
    clear_grants,
    set_grant,
)
from apps.permissions.services.resolver import effective_modules, has_module

__all__ = [
    "bulk_set_grants",
    "clear_grants",
    "effective_modules",
    "has_module",
    "set_grant",
]
