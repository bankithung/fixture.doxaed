"""Streaming endpoints: the public "Watch live" redirects + the manager API
that binds a court to a stream.

**The redirect is the product.** A YouTube channel-level ``/live`` URL cannot be
printed next to Court 2, because with several courts live on one channel
YouTube resolves it to an arbitrary broadcast (six requests, five different
video ids). So the link on the poster, the QR code and the schedule row is
*ours* — ``/api/public/tournaments/<slug>/<uuid>/court/<court_id>/live/`` — and
this module resolves it, at click time, to whatever that court is actually
showing. The target changes during the day (broadcast opens, court rolls over
to a session 2, the day's archive replaces the live player), which is why every
response here carries ``Cache-Control: no-store``.

Gating on the public routes is copied verbatim from
``apps.fixtures.views.PublicTournamentScheduleView``: the (slug, UUID) pair must
resolve, the tournament must not be soft-deleted, and its status must be one of
the four public-facing ones. A wrong slug is a 404, not a redirect.
"""
from __future__ import annotations

import datetime as _dt
import uuid as _uuid
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.http import HttpResponseRedirect
from django.utils import timezone as dj_tz
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from apps.audit.services import emit_audit
from apps.fixtures.models import Court
from apps.streaming.models import CourtStream, StreamLink, StreamLinkScope
from apps.streaming.services.links import (
    CourtLinkResolver,
    WatchUrlError,
    validate_watch_url,
    watch_url_for_court,
    watch_url_for_match,
)
from apps.tournaments.models import Tournament
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments


# --------------------------------------------------------------- public gate
def _public_tournament(slug: str, tournament_id: Any) -> Tournament | None:
    """The (slug, UUID) public-visibility gate.

    Copied from ``PublicTournamentScheduleView`` (apps/fixtures/views.py) —
    deliberately the same four statuses and the same soft-delete filter, so a
    tournament that is invisible on the public schedule is equally invisible
    here. Do not invent a second gate.
    """
    from apps.tournaments.models import TournamentStatus

    public_statuses = (
        TournamentStatus.REGISTRATION_OPEN,
        TournamentStatus.SCHEDULED,
        TournamentStatus.LIVE,
        TournamentStatus.COMPLETED,
    )
    return Tournament.objects.filter(
        id=tournament_id,
        slug=slug,
        deleted_at__isnull=True,
        status__in=public_statuses,
    ).first()


def _tournament_tz(tournament: Tournament):
    from zoneinfo import ZoneInfo

    try:
        return ZoneInfo(tournament.time_zone)
    except (KeyError, ValueError):
        return dj_tz.get_default_timezone()


def _no_store(response):
    """The resolved target changes during the day — a cached redirect would
    pin a spectator to the morning's broadcast (or to a court that has since
    gone live somewhere else)."""
    response["Cache-Control"] = "no-store"
    return response


def _json_404(detail: str, **extra):
    return _no_store(Response({"detail": detail, **extra}, status=404))


def _redirect(url: str):
    return _no_store(HttpResponseRedirect(url))


# ------------------------------------------------------------ public views
class PublicCourtLiveRedirectView(GenericAPIView):
    """``GET /api/public/tournaments/{slug}/{id}/court/{court_id}/live/``

    302 to whatever this court is showing right now. This is the stable,
    printable, QR-able link — it belongs to the platform, not to YouTube, so it
    keeps working when the court opens a new broadcast, rolls over to a second
    session, or finishes and leaves an archive behind.

    404 (JSON) when the tournament is not publicly visible, the court is not in
    that tournament's workspace, or nothing is resolvable — never a redirect to
    a dead page.
    """

    permission_classes = [AllowAny]

    def get(self, request, slug, tournament_id, court_id):
        t = _public_tournament(slug, tournament_id)
        if t is None:
            return _json_404("tournament_not_found")
        court = Court.objects.filter(
            id=court_id, organization_id=t.organization_id, deleted_at__isnull=True
        ).first()
        if court is None:
            return _json_404("court_not_found")
        url = watch_url_for_court(court, tz=_tournament_tz(t))
        if not url:
            return _json_404(
                "stream_not_available",
                court_id=str(court.id),
                court_name=court.name,
            )
        return _redirect(url)


class PublicMatchWatchRedirectView(GenericAPIView):
    """``GET /api/public/matches/{match_id}/watch/``

    302 to the court's live stream while the match is on, and to the day's
    archive at ``&t=<offset>`` once it has finished — so a result row's "Watch"
    link opens at that match's first serve rather than at the top of a
    nine-hour video.

    Same public-visibility gate as the schedule, applied to the match's
    tournament (there is no slug in this URL to check, so the status + soft
    delete checks carry the whole gate).
    """

    permission_classes = [AllowAny]

    def get(self, request, match_id):
        from apps.matches.models import Match
        from apps.tournaments.models import TournamentStatus

        public_statuses = (
            TournamentStatus.REGISTRATION_OPEN,
            TournamentStatus.SCHEDULED,
            TournamentStatus.LIVE,
            TournamentStatus.COMPLETED,
        )
        m = (
            Match.objects.select_related("tournament")
            .filter(
                id=match_id,
                deleted_at__isnull=True,
                tournament__deleted_at__isnull=True,
                tournament__status__in=public_statuses,
            )
            .first()
        )
        if m is None:
            return _json_404("match_not_found")
        url = watch_url_for_match(m, tz=_tournament_tz(m.tournament))
        if not url:
            return _json_404("stream_not_available", match_id=str(m.id))
        return _redirect(url)


# ------------------------------------------------------------ manager API
def _stream_payload(court: Court, stream: CourtStream | None, resolver=None) -> dict:
    """The manager-facing view of one court's binding.

    ``yt_stream_key`` is **never** here — only ``has_stream_key``. It is an RTMP
    ingestion credential: anyone holding it can push video onto the organiser's
    channel, so it is write-only by design (see ``models.CourtStream``).
    """
    watch_url = ""
    enabled = False
    yt_stream_id = ""
    has_key = False
    if stream is not None:
        watch_url = stream.watch_url
        enabled = stream.enabled
        yt_stream_id = stream.yt_stream_id
        has_key = stream.has_stream_key
    return {
        "court_id": str(court.id),
        "court_name": court.name,
        "venue_id": str(court.venue_id),
        "index": court.index,
        "watch_url": watch_url,
        "enabled": enabled,
        "yt_stream_id": yt_stream_id,
        "has_stream_key": has_key,
        "live_watch_url": resolver.watch_url(court.id) if resolver else None,
        "is_streaming": bool(resolver and resolver.is_streaming(court.id)),
    }


def _public_court_link(tournament: Tournament, court: Court) -> str:
    """The stable link an organiser prints / turns into a QR code."""
    return (
        f"/api/public/tournaments/{tournament.slug}/{tournament.id}"
        f"/court/{court.id}/live/"
    )


def _publish_stream_tick(tournament_id, match_id=None) -> None:
    """Post-commit ``"stream"`` tick, so a pasted link reaches the pages that
    are ALREADY OPEN.

    Production, 2026-08-05: the public pages stop polling entirely while their
    SSE stream is connected (``refetchInterval: connected ? false : 60_000`` in
    ``frontend/src/features/fixtures/publicTournament.ts``) and refetch only when
    a tick arrives. Score writes publish one; stream-link and court-stream writes
    published *nothing* — so an organiser pasted a link for a live court and
    every already-open spectator page went on showing no "Watch live" button
    until someone reloaded by hand. Nobody reloads a page that is already showing
    the live score, so the feature read as broken. A watch link is part of the
    public schedule payload; writing one has to tick like any other change to it.

    ``match_id=None`` is ``publish.py``'s "batch change": a court-day, category
    or court-stream write flips the button on every match under that scope, so
    clients refetch the whole day rather than one row. Only a match-scoped link
    names a match.

    ``transaction.on_commit`` (invariant #4) because a tick that overtakes its
    own write makes the reader refetch the OLD payload — indistinguishable from
    never ticking at all, and unrecoverable until the next tick.

    KNOWN LIMIT: the fan-out is to the tournament in the URL. A court belongs to
    the *workspace*, so a court-stream write also changes what a second
    tournament sharing that hall resolves — that tournament's open pages will
    not learn about it until they reconnect. Ticking every tournament in the org
    would need a query on a write path that has none; the organiser is working
    in one tournament and that is the one that gets told.
    """
    from apps.live.publish import publish_tournament_tick

    tid, mid = tournament_id, match_id
    transaction.on_commit(lambda: publish_tournament_tick(tid, mid, "stream"))


def _as_uuid(raw) -> _uuid.UUID | None:
    try:
        return _uuid.UUID(str(raw))
    except (TypeError, ValueError, AttributeError):
        return None


def _event_id(request) -> _uuid.UUID | None:
    return _as_uuid(request.data.get("event_id"))


class _StreamingManagerBase(GenericAPIView):
    """The gate every streaming write shares.

    Split out of ``_CourtStreamBase`` when the scoped stream links arrived, so
    both surfaces resolve the tournament, the court and a pasted URL through the
    SAME code — a second copy of the 404-not-403 lookup is how a tenant leak
    gets introduced.
    """

    permission_classes = [IsAuthenticated]

    def _tournament(self, request, tournament_id) -> Tournament:
        # 404 (never 403) for a tournament outside the caller's access, so
        # nothing leaks across tenants (invariant 2).
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_manage_tournament(request.user, t):
            raise PermissionDenied("not_tournament_manager")
        return t

    def _court(self, tournament: Tournament, court_id) -> Court:
        """Scoped to the tournament's workspace: another org's court id smuggled
        in through a tournament the caller CAN manage resolves to nothing."""
        court = Court.objects.filter(
            id=court_id,
            organization_id=tournament.organization_id,
            deleted_at__isnull=True,
        ).first()
        if court is None:
            raise NotFound("court_not_found")
        return court

    def _clean_enabled(self, raw) -> bool:
        if isinstance(raw, bool):
            return raw
        return str(raw).strip().lower() in ("1", "true", "yes", "on")

    def _clean_watch_url(self, raw) -> str:
        try:
            return validate_watch_url(raw)
        except WatchUrlError as e:
            raise DRFValidationError(
                {"detail": e.code, "message": e.message}
            ) from e


class _CourtStreamBase(_StreamingManagerBase):

    def _stream(self, court: Court) -> CourtStream | None:
        """The court's ACTIVE binding (soft-deleted rows read as absent)."""
        return CourtStream.objects.filter(
            court=court, deleted_at__isnull=True
        ).first()

    def _replay(self, tournament: Tournament, event_id) -> CourtStream | None:
        """Invariant 3: a replayed ``event_id`` returns the row it already
        wrote, so a retry from a flaky phone on a school ground is a 200 and
        not a second write.

        Two lookups, because ``CourtStream.event_id`` only remembers the LAST
        token that wrote the row — a stale retry arriving after a later edit
        would otherwise stamp the old URL back on. The audit log keeps every
        token (``idempotency_key`` is unique there), so it is the durable
        record; this is the same trick ``tournaments.services.create`` uses.

        Both lookups are workspace-scoped: ``event_id`` is globally unique, so
        an unscoped match could hand back another tenant's row.
        """
        if not event_id:
            return None
        prior = CourtStream.objects.filter(
            event_id=event_id, organization_id=tournament.organization_id
        ).first()
        if prior is not None:
            return prior
        from apps.audit.models import AuditEvent

        event = AuditEvent.objects.filter(
            idempotency_key=event_id, target_type="court_stream"
        ).first()
        if event is None:
            return None
        return CourtStream.objects.filter(
            id=event.target_id, organization_id=tournament.organization_id
        ).first()

    def _write(self, request, t: Tournament, court: Court, data, *, partial: bool):
        """Create-or-update one court's binding. Returns ``(stream, created)``."""
        event_id = _event_id(request)
        # `court` is a OneToOneField, so a soft-deleted binding still occupies
        # the slot — re-binding a court after a DELETE must RESURRECT that row,
        # never insert a second one (which the unique constraint would refuse).
        stream = CourtStream.objects.filter(court=court).first()
        active = stream if (stream is not None and stream.deleted_at is None) else None
        before = (
            {"watch_url": active.watch_url, "enabled": active.enabled}
            if active is not None
            else None
        )
        fields: dict[str, Any] = {}
        if "watch_url" in data or not partial:
            fields["watch_url"] = self._clean_watch_url(data.get("watch_url"))
        if "enabled" in data:
            fields["enabled"] = self._clean_enabled(data.get("enabled"))
        elif "watch_url" in fields and fields["watch_url"] and active is None:
            # Pasting a URL for the first time IS switching the court on; making
            # the organiser flip a second toggle just to publish is a trap.
            fields["enabled"] = True

        with transaction.atomic():
            created = active is None
            if stream is None:
                stream = CourtStream(
                    court=court, organization_id=court.organization_id
                )
            for key, value in fields.items():
                setattr(stream, key, value)
            stream.deleted_at = None
            stream.event_id = event_id
            try:
                stream.save()
            except IntegrityError as e:
                # A globally-unique event_id already spent on a different row.
                raise DRFValidationError({"detail": "event_id_conflict"}) from e
            emit_audit(
                actor_user=request.user,
                actor_role="admin",
                event_type=(
                    "court_stream_created" if created else "court_stream_updated"
                ),
                target_type="court_stream",
                target_id=stream.id,
                payload_before=before,
                payload_after={
                    "court_id": str(court.id),
                    "watch_url": stream.watch_url,
                    "enabled": stream.enabled,
                },
                organization_id=t.organization_id,
                tournament_id=t.id,
                idempotency_key=event_id,
                request=request,
            )
            # Both callers (POST upsert, PATCH) come through here AFTER their
            # replay check, so a retried event_id never re-ticks a write it did
            # not make.
            _publish_stream_tick(t.id)
        return stream, created

    def _one(self, t: Tournament, court: Court, stream: CourtStream | None) -> dict:
        resolver = CourtLinkResolver([court], tz=_tournament_tz(t))
        return {
            **_stream_payload(court, stream, resolver),
            "public_link": _public_court_link(t, court),
        }


class TournamentCourtStreamsView(_CourtStreamBase):
    """``GET/POST /api/tournaments/{id}/court-streams/``

    GET lists every court in the workspace with its binding and its resolved
    live URL (bounded queries — two, whatever the court count). POST upserts one
    court's binding: ``{court_id, watch_url, enabled, event_id}``. 201 on
    create, 200 on update, and 200 on an ``event_id`` replay (invariant 3).

    Manager-gated (``can_manage_tournament``) — pasting a stream URL publishes
    a link on the public schedule, so it is not a plain-member verb.
    """

    def get(self, request, tournament_id):
        t = self._tournament(request, tournament_id)
        courts = list(
            Court.objects.filter(
                organization_id=t.organization_id, deleted_at__isnull=True
            ).order_by("name")
        )
        resolver = CourtLinkResolver(courts, tz=_tournament_tz(t))
        streams = {
            s.court_id: s
            for s in CourtStream.objects.filter(
                court_id__in=[c.id for c in courts], deleted_at__isnull=True
            )
        }
        return Response({
            "court_streams": [
                {
                    **_stream_payload(c, streams.get(c.id), resolver),
                    "public_link": _public_court_link(t, c),
                }
                for c in courts
            ]
        })

    def post(self, request, tournament_id):
        t = self._tournament(request, tournament_id)
        prior = self._replay(t, _event_id(request))
        if prior is not None:
            court = self._court(t, prior.court_id)
            return Response(self._one(t, court, prior), status=200)
        court_id = _as_uuid(request.data.get("court_id"))
        if court_id is None:
            raise DRFValidationError({"detail": "court_id_required"})
        court = self._court(t, court_id)
        stream, created = self._write(
            request, t, court, request.data, partial=False
        )
        return Response(self._one(t, court, stream), status=201 if created else 200)


class TournamentCourtStreamDetailView(_CourtStreamBase):
    """``GET/PATCH/DELETE /api/tournaments/{id}/court-streams/{court_id}/``

    PATCH edits ``watch_url`` / ``enabled`` in place (always 200, and an
    ``event_id`` replay is a no-op rather than a second write). DELETE
    soft-deletes the binding and is idempotent — a repeat is still 204.
    """

    def get(self, request, tournament_id, court_id):
        t = self._tournament(request, tournament_id)
        court = self._court(t, court_id)
        return Response(self._one(t, court, self._stream(court)))

    def patch(self, request, tournament_id, court_id):
        t = self._tournament(request, tournament_id)
        court = self._court(t, court_id)
        prior = self._replay(t, _event_id(request))
        if prior is not None and prior.court_id == court.id:
            return Response(self._one(t, court, prior), status=200)
        stream, _created = self._write(request, t, court, request.data, partial=True)
        return Response(self._one(t, court, stream), status=200)

    def delete(self, request, tournament_id, court_id):
        t = self._tournament(request, tournament_id)
        court = self._court(t, court_id)
        stream = self._stream(court)
        if stream is None:
            return Response(status=204)  # already gone — DELETE is idempotent
        stream.deleted_at = dj_tz.now()
        stream.event_id = None  # free the token; the row is no longer addressable
        stream.save(update_fields=["deleted_at", "event_id", "updated_at"])
        emit_audit(
            actor_user=request.user,
            actor_role="admin",
            event_type="court_stream_deleted",
            target_type="court_stream",
            target_id=stream.id,
            payload_before={
                "court_id": str(court.id),
                "watch_url": stream.watch_url,
                "enabled": stream.enabled,
            },
            organization_id=t.organization_id,
            tournament_id=t.id,
            idempotency_key=_event_id(request),
            request=request,
        )
        # Unbinding a court takes the button AWAY; a page still offering a link
        # to a stream the organiser has just retired is the same bug pointing
        # the other way. (The idempotent no-op above returns before this — it
        # changed nothing, so there is nothing to tell anyone about.)
        _publish_stream_tick(t.id)
        return Response(status=204)


class TournamentCourtBroadcastQrView(_StreamingManagerBase):
    """``GET /api/tournaments/{id}/court-streams/{court_id}/broadcast-qr/``

    A PNG QR code of this court's phone broadcast page, and the only control on
    the whole feature that actually works at a court.

    The URL it encodes —
    ``/broadcast/t/<slug>/<id>/court/Court%20%C2%B7%20T1`` — is *copyable* on a
    laptop and *unusable* there: the phone that films the match is a different
    device, and nobody types a percent-encoded venue string on a handset. The
    organiser points the phone's camera at this image and the broadcast page
    opens on the phone. That is the whole point of the endpoint.

    Manager-gated like every other streaming surface (``can_manage_tournament``
    via :class:`_StreamingManagerBase`), and served as an image rather than a
    JSON data URI so it is an ``<img src>`` the browser can cache, and a file
    an organiser can save and print for the court's clipboard.
    """

    def get(self, request, tournament_id, court_id):
        from django.http import HttpResponse
        from django.utils.text import slugify

        from apps.streaming.services.qr import (
            broadcast_court_url,
            public_base_url,
            qr_png,
        )

        t = self._tournament(request, tournament_id)
        court = self._court(t, court_id)
        url = broadcast_court_url(public_base_url(request), t, court)
        response = HttpResponse(qr_png(url), content_type="image/png")
        # Private: the image is behind a manager gate, so no shared cache may
        # keep it. Short-lived because renaming a court changes the payload.
        response["Cache-Control"] = "private, max-age=300"
        name = slugify(court.name) or "court"
        response["Content-Disposition"] = f'inline; filename="{name}-broadcast-qr.png"'
        # The URL is echoed in a header so a caller that wants the string (and
        # not the picture) does not have to rebuild it — and so a test can pin
        # the payload without decoding a PNG.
        response["X-Broadcast-Url"] = url
        return response


# ------------------------------------------------- scoped stream links (API)
def _link_payload(link: StreamLink) -> dict:
    """One scoped link, in the shape the manager UI edits it.

    Every scope target is present (null where it does not apply) so a client can
    render one table of "what is pinned where" without branching on ``scope``
    to know which key to read.
    """
    return {
        "id": str(link.id),
        "scope": link.scope,
        "match_id": str(link.match_id) if link.match_id else None,
        "court_id": str(link.court_id) if link.court_id else None,
        "day": link.day.isoformat() if link.day else None,
        "leaf_key": link.leaf_key,
        "watch_url": link.watch_url,
        "enabled": link.enabled,
        "updated_at": link.updated_at.isoformat() if link.updated_at else None,
    }


def _parse_day(raw) -> _dt.date:
    """``YYYY-MM-DD`` → date. The organiser is naming a LOCAL tournament day
    (the day the court is streaming), never a UTC instant — accepting a
    datetime here would invite a timezone-shifted key that no match resolves
    against."""
    value = str(raw or "").strip()
    if not value:
        raise DRFValidationError({"detail": "day_required"})
    try:
        return _dt.date.fromisoformat(value)
    except ValueError as e:
        raise DRFValidationError({"detail": "day_invalid"}) from e


class _StreamLinkBase(_StreamingManagerBase):
    """Shared resolution for the scoped-link endpoints.

    The three scopes differ only in what identifies the target; validation of
    the target is where the tenancy work happens, so it lives here rather than
    in each verb.
    """

    def _links(self, t: Tournament):
        """Every link this tournament's manager owns.

        Court-day links are keyed by a COURT, which belongs to the workspace
        rather than to one tournament (two tournaments can share a hall), so
        they are scoped by organisation — exactly like the court-streams
        listing, which shows every court in the workspace.
        """
        return StreamLink.objects.filter(
            Q(scope=StreamLinkScope.COURT_DAY, organization_id=t.organization_id)
            | Q(scope=StreamLinkScope.MATCH, match__tournament_id=t.id)
            | Q(scope=StreamLinkScope.CATEGORY, tournament_id=t.id),
            deleted_at__isnull=True,
        )

    def _scope(self, data) -> str:
        scope = str(data.get("scope") or "").strip()
        if scope not in StreamLinkScope.values:
            raise DRFValidationError({
                "detail": "scope_invalid",
                "message": f"scope must be one of {', '.join(StreamLinkScope.values)}",
            })
        return scope

    def _match(self, t: Tournament, raw_id):
        """The match must be IN this tournament: a match id from another
        workspace, smuggled through a tournament the caller can manage, must
        not become a link they own."""
        match_id = _as_uuid(raw_id)
        if match_id is None:
            raise DRFValidationError({"detail": "match_id_required"})
        from apps.matches.models import Match

        m = Match.objects.filter(
            id=match_id, tournament_id=t.id, deleted_at__isnull=True
        ).first()
        if m is None:
            raise NotFound("match_not_found")
        return m

    def _leaf_key(self, t: Tournament, raw) -> str:
        """The leaf must be a competition this tournament actually runs.

        Leaf keys are only unique within a tournament and are minted from
        ``Tournament.sports``; accepting a free-typed one would create a link
        that no match can ever match, and the organiser would be left staring
        at a row that does nothing.
        """
        from apps.tournaments.services.sports import iter_leaves

        leaf_key = str(raw or "").strip()
        if not leaf_key:
            raise DRFValidationError({"detail": "leaf_key_required"})
        known = {leaf["leaf_key"] for leaf in iter_leaves(t.sports or [])}
        if leaf_key not in known:
            raise DRFValidationError({
                "detail": "leaf_key_not_in_tournament",
                "message": "That category is not one this tournament runs.",
            })
        return leaf_key

    def _target(self, t: Tournament, scope: str, data) -> dict:
        """The scope's identifying columns, validated and tenancy-scoped.

        Returns the kwargs that both *find* an existing row and *create* a new
        one, so a lookup and an insert can never disagree about what "the same
        target" means.
        """
        if scope == StreamLinkScope.MATCH:
            return {"match": self._match(t, data.get("match_id"))}
        if scope == StreamLinkScope.COURT_DAY:
            court_id = _as_uuid(data.get("court_id"))
            if court_id is None:
                raise DRFValidationError({"detail": "court_id_required"})
            return {
                "court": self._court(t, court_id),
                "day": _parse_day(data.get("day")),
            }
        return {"tournament": t, "leaf_key": self._leaf_key(t, data.get("leaf_key"))}

    def _existing(self, scope: str, target: dict) -> StreamLink | None:
        """The ACTIVE row for this target, if any. Soft-deleted rows are left
        where they are: the partial unique constraints ignore them, so a
        re-bind inserts a fresh row and the deleted one stays as history."""
        return StreamLink.objects.filter(
            scope=scope, deleted_at__isnull=True, **target
        ).first()

    def _replay(self, t: Tournament, event_id) -> StreamLink | None:
        """Invariant 3, same two-lookup shape as the court-stream endpoints:
        the row remembers only the LAST token that wrote it, so the audit log
        (where ``idempotency_key`` is unique) is the durable record. Both
        lookups are workspace-scoped because ``event_id`` is globally unique.
        """
        if not event_id:
            return None
        prior = StreamLink.objects.filter(
            event_id=event_id, organization_id=t.organization_id
        ).first()
        if prior is not None:
            return prior
        from apps.audit.models import AuditEvent

        event = AuditEvent.objects.filter(
            idempotency_key=event_id, target_type="stream_link"
        ).first()
        if event is None:
            return None
        return StreamLink.objects.filter(
            id=event.target_id, organization_id=t.organization_id
        ).first()


class TournamentStreamLinksView(_StreamLinkBase):
    """``GET/POST /api/tournaments/{id}/stream-links/``

    The organiser's own links, at whichever scope they actually work at: one
    match, one court for one day, or one competition category. GET lists every
    active link; POST upserts the one for a target:

        {scope: "court_day", court_id, day: "2026-08-04", watch_url, event_id}
        {scope: "match",     match_id, watch_url, event_id}
        {scope: "category",  leaf_key, watch_url, event_id}

    201 on create, 200 on update, 200 on an ``event_id`` replay (invariant 3).
    A blank ``watch_url`` stores a cleared binding, which the resolver treats as
    "this level is not set" and falls through — the same meaning DELETE has, but
    without giving up the row's id.

    Manager-gated for the same reason the court-stream endpoints are: writing
    here publishes a link on the public schedule.
    """

    def get(self, request, tournament_id):
        t = self._tournament(request, tournament_id)
        links = self._links(t).order_by("scope", "created_at")
        return Response({"stream_links": [_link_payload(x) for x in links]})

    def post(self, request, tournament_id):
        t = self._tournament(request, tournament_id)
        event_id = _event_id(request)
        prior = self._replay(t, event_id)
        if prior is not None:
            return Response(_link_payload(prior), status=200)

        scope = self._scope(request.data)
        target = self._target(t, scope, request.data)
        watch_url = self._clean_watch_url(request.data.get("watch_url"))
        link = self._existing(scope, target)
        created = link is None
        before = (
            None if created
            else {"watch_url": link.watch_url, "enabled": link.enabled}
        )
        if link is None:
            link = StreamLink(
                scope=scope,
                organization_id=t.organization_id,
                **target,
            )
        link.watch_url = watch_url
        if "enabled" in request.data:
            link.enabled = self._clean_enabled(request.data.get("enabled"))
        link.event_id = event_id
        with transaction.atomic():
            try:
                link.save()
            except IntegrityError as e:
                # Either a globally-unique event_id already spent on another
                # row, or a racing writer that won the partial unique index.
                raise DRFValidationError({"detail": "event_id_conflict"}) from e
            emit_audit(
                actor_user=request.user,
                actor_role="admin",
                event_type=(
                    "stream_link_created" if created else "stream_link_updated"
                ),
                target_type="stream_link",
                target_id=link.id,
                payload_before=before,
                payload_after={
                    "scope": link.scope,
                    "target": link.target_key,
                    "watch_url": link.watch_url,
                    "enabled": link.enabled,
                },
                organization_id=t.organization_id,
                tournament_id=t.id,
                idempotency_key=event_id,
                request=request,
            )
            # THE paste. Everything downstream of this — the "Watch live"
            # button on every open schedule, live viewer and venue display —
            # only moves when a tick says so.
            _publish_stream_tick(t.id, link.match_id)
        return Response(_link_payload(link), status=201 if created else 200)


class TournamentStreamLinkDetailView(_StreamLinkBase):
    """``GET/PATCH/DELETE /api/tournaments/{id}/stream-links/{link_id}/``

    PATCH edits ``watch_url`` / ``enabled`` in place without restating the
    target. DELETE clears the link — a soft delete, so the level simply stops
    applying and the next one down takes over — and is idempotent.
    """

    def _link(self, t: Tournament, link_id) -> StreamLink:
        # Scoped through _links(), so another workspace's link id is a 404 even
        # when the caller can manage the tournament in the URL.
        link = self._links(t).filter(id=link_id).first()
        if link is None:
            raise NotFound("stream_link_not_found")
        return link

    def get(self, request, tournament_id, link_id):
        t = self._tournament(request, tournament_id)
        return Response(_link_payload(self._link(t, link_id)))

    def patch(self, request, tournament_id, link_id):
        t = self._tournament(request, tournament_id)
        link = self._link(t, link_id)
        event_id = _event_id(request)
        prior = self._replay(t, event_id)
        if prior is not None and prior.id == link.id:
            return Response(_link_payload(prior), status=200)
        before = {"watch_url": link.watch_url, "enabled": link.enabled}
        if "watch_url" in request.data:
            link.watch_url = self._clean_watch_url(request.data.get("watch_url"))
        if "enabled" in request.data:
            link.enabled = self._clean_enabled(request.data.get("enabled"))
        link.event_id = event_id
        with transaction.atomic():
            try:
                link.save()
            except IntegrityError as e:
                raise DRFValidationError({"detail": "event_id_conflict"}) from e
            emit_audit(
                actor_user=request.user,
                actor_role="admin",
                event_type="stream_link_updated",
                target_type="stream_link",
                target_id=link.id,
                payload_before=before,
                payload_after={
                    "scope": link.scope,
                    "target": link.target_key,
                    "watch_url": link.watch_url,
                    "enabled": link.enabled,
                },
                organization_id=t.organization_id,
                tournament_id=t.id,
                idempotency_key=event_id,
                request=request,
            )
            # Correcting a wrong URL, or switching a link off, is as urgent as
            # pasting one: spectators are on the wrong video until they hear.
            _publish_stream_tick(t.id, link.match_id)
        return Response(_link_payload(link), status=200)

    def delete(self, request, tournament_id, link_id):
        t = self._tournament(request, tournament_id)
        link = self._links(t).filter(id=link_id).first()
        if link is None:
            return Response(status=204)  # already cleared — DELETE is idempotent
        link.deleted_at = dj_tz.now()
        link.event_id = None  # free the token; the row is no longer addressable
        link.save(update_fields=["deleted_at", "event_id", "updated_at"])
        emit_audit(
            actor_user=request.user,
            actor_role="admin",
            event_type="stream_link_deleted",
            target_type="stream_link",
            target_id=link.id,
            payload_before={
                "scope": link.scope,
                "target": link.target_key,
                "watch_url": link.watch_url,
                "enabled": link.enabled,
            },
            organization_id=t.organization_id,
            tournament_id=t.id,
            idempotency_key=_event_id(request),
            request=request,
        )
        # Clearing a link hands the match back to the next level down, which is
        # a different URL (or none) — the open pages have to be told to look
        # again. The idempotent no-op above returns before this.
        _publish_stream_tick(t.id, link.match_id)
        return Response(status=204)


__all__ = [
    "PublicCourtLiveRedirectView",
    "PublicMatchWatchRedirectView",
    "TournamentCourtStreamDetailView",
    "TournamentCourtStreamsView",
    "TournamentStreamLinkDetailView",
    "TournamentStreamLinksView",
]
