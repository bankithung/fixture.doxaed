"""Live-streaming integration (YouTube Live).

Currently service-layer only: no models, no views, no migrations — so this app
is deliberately NOT in ``INSTALLED_APPS`` yet. Everything under
``apps.streaming.services`` is pure and injectable (plain ids/strings/datetimes
in, dataclasses out) so it can be unit-tested without a database and wired to
domain models later.
"""
