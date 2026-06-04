"""Constants for the organizations app.

RESERVED_SLUGS — DNS / surface names that must never be claimed by an
Organization. Enforced both at form / serializer validation AND at the
service layer (slug.create / slug.change_slug) per the locked invariant
that the slug-reserved check is service-layer, not just form-layer.

Subdomain reservation list — covers the common operational subdomains
(`www`, `api`, `admin`, `sadmin`, `static`, `assets`, …) plus a handful of
brand / safety reservations.
"""
from __future__ import annotations

import re

# DNS-safe slug regex: 1-63 chars, lowercase a-z0-9, hyphen-separated,
# no leading/trailing hyphen.
SLUG_REGEX = re.compile(r"^(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

# Reserved subdomain / slug list (~30 entries). Lowercase canonical form.
RESERVED_SLUGS: frozenset[str] = frozenset(
    {
        # Operational subdomains
        "www",
        "api",
        "admin",
        "sadmin",
        "static",
        "assets",
        "cdn",
        "media",
        "mail",
        "smtp",
        "imap",
        "ftp",
        "ssh",
        "vpn",
        "ns",
        "ns1",
        "ns2",
        "mx",
        # Product surfaces
        "app",
        "auth",
        "login",
        "signup",
        "billing",
        "support",
        "help",
        "docs",
        "blog",
        "status",
        "dashboard",
        "console",
        # Brand / safety
        "fixture",
        "doxaed",
        "root",
        "system",
        "test",
        "demo",
        "staging",
        "dev",
    }
)
