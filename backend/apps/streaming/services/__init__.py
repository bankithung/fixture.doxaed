"""YouTube Live service layer — pure, injectable, model-free.

Import surface:

* :mod:`.youtube`     — ``YouTubeLiveClient``, ``Stream``, ``Broadcast``, ``VideoDetails``
* :mod:`.credentials` — ``RefreshTokenCredentials`` (OAuth refresh-token flow)
* :mod:`.transport`   — ``HttpTransport`` protocol + ``HttpxTransport`` default
* :mod:`.errors`      — the typed error taxonomy callers branch on
* :mod:`.planning`    — pure helpers (VOD offsets, chapter lists, session rollover)

Nothing in here imports a Django model. Wiring to ``Match``/``Court`` rows
happens in a later increment.
"""
