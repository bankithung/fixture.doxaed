"""Live-streaming integration (YouTube Live).

Two layers, deliberately separated:

* ``apps.streaming.services`` is pure and injectable (plain ids/strings/
  datetimes in, dataclasses out) — the YouTube API client, its error taxonomy,
  OAuth refresh credentials, and the pure planning helpers (VOD offsets,
  chapter lists, session rollover). None of it imports a Django model.
* ``models`` / ``views`` / ``services.links`` wire that to the domain: a
  permanent ``CourtStream`` per court, one ``CourtBroadcast`` per court per
  DAY, and the public "Watch live" redirects that resolve a court (or a match)
  to whatever it is actually showing right now.
"""
