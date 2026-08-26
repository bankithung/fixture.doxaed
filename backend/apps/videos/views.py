"""Video albums: manager CRUD, and one public read.

Mirrors the venue/court CRUD already in the codebase — `accessible_tournaments`
gates every read (404 on no access, no existence leak, invariant 2) and
`can_manage_tournament` gates every write.
"""
from __future__ import annotations

from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from django.utils import timezone

from apps.tournaments.models import Tournament, TournamentStatus
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments
from apps.videos.models import TournamentVideo, VideoAlbum
from apps.teams.models import Institution
from apps.teams.services.crest import crest_url
from apps.videos.services.links import clean_link, youtube_id

_PUBLIC_STATUSES = [
    TournamentStatus.SCHEDULED, TournamentStatus.REGISTRATION_OPEN,
    TournamentStatus.LIVE, TournamentStatus.COMPLETED, TournamentStatus.PUBLISHED,
]


def clean_tags(raw) -> list[str]:
    """Host labels, de-duplicated case-insensitively and capped.

    Free text on purpose: nothing here decides what is worth tagging. The
    tournament's own categories are offered as suggestions, not as a schema.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise DRFValidationError({"detail": "tags_must_be_a_list"})
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        label = str(item or "").strip()[:40]
        if not label or label.lower() in seen:
            continue
        seen.add(label.lower())
        out.append(label)
    return out[:12]


def video_payload(v: TournamentVideo) -> dict:
    schools = [
        {"id": str(i.id), "name": i.name, "crest": crest_url(i.logo_ref)}
        for i in v.institutions.all()
        if i.deleted_at is None
    ]
    schools.sort(key=lambda s: s["name"].lower())
    return {
        "id": str(v.id),
        "event": v.event,
        "note": v.note,
        "youtube_url": v.youtube_url,
        "facebook_url": v.facebook_url,
        "instagram_url": v.instagram_url,
        # Parsed once, on the server: the page embeds the id, never the URL.
        "youtube_id": youtube_id(v.youtube_url),
        "played_on": v.played_on.isoformat() if v.played_on else None,
        "tags": list(v.tags or []),
        "schools": schools,
        "position": v.position,
    }


def album_payload(a: VideoAlbum) -> dict:
    videos = [
        v for v in a.videos.all() if v.deleted_at is None
    ]
    videos.sort(key=lambda v: (v.position, v.created_at))
    return {
        "id": str(a.id),
        "title": a.title,
        "description": a.description,
        "position": a.position,
        "videos": [video_payload(v) for v in videos],
        "video_count": len(videos),
    }


def _albums(tournament):
    return (
        VideoAlbum.objects.filter(tournament=tournament, deleted_at__isnull=True)
        .prefetch_related("videos", "videos__institutions")
        .order_by("position", "created_at")
    )


def _clean_links(data) -> dict:
    links = {
        "youtube_url": clean_link(data.get("youtube_url")),
        "facebook_url": clean_link(data.get("facebook_url")),
        "instagram_url": clean_link(data.get("instagram_url")),
    }
    if not any(links.values()):
        # An entry that points nowhere is not a video.
        raise DRFValidationError({"detail": "at_least_one_link_required"})
    return links


def _played_on(raw):
    """A date, or None. A malformed one is refused rather than silently
    dropped — a video filed under the wrong day is worse than an unfiled one."""
    from datetime import date

    s = str(raw or "").strip()
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        raise DRFValidationError({"detail": "played_on_must_be_a_date"}) from None


def _set_schools(video, tournament, raw):
    """Attach the schools in the footage, scoped to THIS tournament: an id from
    another workspace names nothing here (invariant 2)."""
    if raw is None:
        return
    if not isinstance(raw, list):
        raise DRFValidationError({"detail": "schools_must_be_a_list"})
    ids = [str(x).strip() for x in raw if str(x or "").strip()][:24]
    found = list(
        Institution.objects.filter(
            id__in=ids, tournament=tournament, deleted_at__isnull=True,
        )
    )
    if len(found) != len(set(ids)):
        raise DRFValidationError({"detail": "unknown_school"})
    video.institutions.set(found)


class TournamentVideoAlbumsView(GenericAPIView):
    """`GET/POST /api/tournaments/{id}/video-albums/` — the host's albums."""

    permission_classes = [IsAuthenticated]

    def _tournament(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        return Tournament.objects.select_related("organization").get(id=tournament_id)

    def get(self, request, tournament_id):
        from apps.tournaments.services.sports import iter_leaves

        t = self._tournament(request, tournament_id)
        schools = [
            {"id": str(i.id), "name": i.name, "crest": crest_url(i.logo_ref)}
            for i in Institution.objects.filter(
                tournament=t, deleted_at__isnull=True,
            ).order_by("name")
        ]
        # Tag SUGGESTIONS off the host's own category tree — every sport and
        # every category, offered as one-tap chips. They are suggestions: the
        # host types anything they like.
        suggested: list[str] = []
        for leaf in iter_leaves(t.sports):
            for label in [leaf["sport_name"], *leaf["path"]]:
                if label and label not in suggested:
                    suggested.append(str(label))
        return Response({
            "albums": [album_payload(a) for a in _albums(t)],
            "schools": schools,
            "suggested_tags": suggested[:40],
            "can_manage": can_manage_tournament(request.user, t),
        })

    def post(self, request, tournament_id):
        t = self._tournament(request, tournament_id)
        if not can_manage_tournament(request.user, t):
            raise PermissionDenied("not_tournament_manager")
        title = str(request.data.get("title") or "").strip()[:120]
        if not title:
            raise DRFValidationError({"detail": "title_required"})
        a = VideoAlbum.objects.create(
            organization=t.organization,
            tournament=t,
            title=title,
            description=str(request.data.get("description") or "").strip()[:2000],
            position=int(request.data.get("position") or 0),
            created_by=request.user,
        )
        return Response(album_payload(a), status=201)


class TournamentVideoAlbumDetailView(GenericAPIView):
    """`PATCH/DELETE /api/tournaments/{id}/video-albums/{album_id}/`."""

    permission_classes = [IsAuthenticated]

    def _album(self, request, tournament_id, album_id, *, write: bool):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if write and not can_manage_tournament(request.user, t):
            raise PermissionDenied("not_tournament_manager")
        a = VideoAlbum.objects.filter(
            id=album_id, tournament=t, deleted_at__isnull=True
        ).first()
        if a is None:
            raise NotFound("album_not_found")
        return a

    def patch(self, request, tournament_id, album_id):
        a = self._album(request, tournament_id, album_id, write=True)
        if "title" in request.data:
            title = str(request.data.get("title") or "").strip()[:120]
            if not title:
                raise DRFValidationError({"detail": "title_required"})
            a.title = title
        if "description" in request.data:
            a.description = str(request.data.get("description") or "").strip()[:2000]
        if "position" in request.data:
            a.position = int(request.data.get("position") or 0)
        a.save(update_fields=["title", "description", "position", "updated_at"])
        return Response(album_payload(a))

    def delete(self, request, tournament_id, album_id):
        a = self._album(request, tournament_id, album_id, write=True)
        # Soft delete, like every other removable row here: the videos go with
        # it and nothing is destroyed.
        now = timezone.now()
        a.videos.filter(deleted_at__isnull=True).update(deleted_at=now)
        a.deleted_at = now
        a.save(update_fields=["deleted_at"])
        return Response({"removed": True})


class TournamentVideosView(GenericAPIView):
    """`POST /api/tournaments/{id}/video-albums/{album_id}/videos/`."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id, album_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_manage_tournament(request.user, t):
            raise PermissionDenied("not_tournament_manager")
        a = VideoAlbum.objects.filter(
            id=album_id, tournament=t, deleted_at__isnull=True
        ).first()
        if a is None:
            raise NotFound("album_not_found")
        event = str(request.data.get("event") or "").strip()[:160]
        if not event:
            raise DRFValidationError({"detail": "event_required"})
        v = TournamentVideo.objects.create(
            organization=t.organization,
            album=a,
            event=event,
            note=str(request.data.get("note") or "").strip()[:2000],
            played_on=_played_on(request.data.get("played_on")),
            tags=clean_tags(request.data.get("tags")),
            position=int(request.data.get("position") or 0),
            created_by=request.user,
            **_clean_links(request.data),
        )
        _set_schools(v, t, request.data.get("schools"))
        return Response(video_payload(v), status=201)


class TournamentVideoDetailView(GenericAPIView):
    """`PATCH/DELETE /api/tournaments/{id}/videos/{video_id}/`."""

    permission_classes = [IsAuthenticated]

    def _video(self, request, tournament_id, video_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        t = Tournament.objects.select_related("organization").get(id=tournament_id)
        if not can_manage_tournament(request.user, t):
            raise PermissionDenied("not_tournament_manager")
        v = TournamentVideo.objects.filter(
            id=video_id, album__tournament=t, deleted_at__isnull=True
        ).first()
        if v is None:
            raise NotFound("video_not_found")
        return v

    def patch(self, request, tournament_id, video_id):
        v = self._video(request, tournament_id, video_id)
        if "event" in request.data:
            event = str(request.data.get("event") or "").strip()[:160]
            if not event:
                raise DRFValidationError({"detail": "event_required"})
            v.event = event
        if "note" in request.data:
            v.note = str(request.data.get("note") or "").strip()[:2000]
        if "position" in request.data:
            v.position = int(request.data.get("position") or 0)
        if "played_on" in request.data:
            v.played_on = _played_on(request.data.get("played_on"))
        if "tags" in request.data:
            v.tags = clean_tags(request.data.get("tags"))
        if "schools" in request.data:
            _set_schools(v, v.album.tournament, request.data.get("schools"))
        if any(k in request.data for k in
               ("youtube_url", "facebook_url", "instagram_url")):
            merged = {
                "youtube_url": v.youtube_url,
                "facebook_url": v.facebook_url,
                "instagram_url": v.instagram_url,
            }
            merged.update({k: request.data[k] for k in merged if k in request.data})
            for k, val in _clean_links(merged).items():
                setattr(v, k, val)
        v.save(update_fields=[
            "event", "note", "position", "played_on", "tags", "youtube_url",
            "facebook_url", "instagram_url", "updated_at",
        ])
        return Response(video_payload(v))

    def delete(self, request, tournament_id, video_id):
        v = self._video(request, tournament_id, video_id)
        v.deleted_at = timezone.now()
        v.save(update_fields=["deleted_at"])
        return Response({"removed": True})


class PublicTournamentVideosView(GenericAPIView):
    """`GET /api/public/tournaments/{slug}/{id}/videos/` — the Videos tab.

    Albums with at least one video, in the host's own order. Empty albums are
    withheld: a heading with nothing under it is not a section.
    """

    permission_classes = [AllowAny]

    def get(self, request, slug, tournament_id):
        t = Tournament.objects.filter(
            id=tournament_id, slug=slug, deleted_at__isnull=True,
            status__in=_PUBLIC_STATUSES,
        ).first()
        if t is None:
            raise NotFound("tournament_not_found")
        albums = [album_payload(a) for a in _albums(t)]
        albums = [a for a in albums if a["videos"]]
        videos = [v for a in albums for v in a["videos"]]
        # Facets are counted from the videos ON THE PAGE, so a filter can never
        # offer a choice that turns out to be empty.
        days: dict[str, int] = {}
        tags: dict[str, int] = {}
        schools: dict[str, dict] = {}
        for v in videos:
            if v["played_on"]:
                days[v["played_on"]] = days.get(v["played_on"], 0) + 1
            for tag in v["tags"]:
                tags[tag] = tags.get(tag, 0) + 1
            for s_ in v["schools"]:
                row = schools.setdefault(s_["id"], {**s_, "count": 0})
                row["count"] += 1
        return Response({
            "tournament": {
                "id": str(t.id), "slug": t.slug, "name": t.name, "status": t.status,
                "time_zone": t.time_zone,
            },
            "albums": albums,
            "facets": {
                "days": [
                    {"day": d, "count": n} for d, n in sorted(days.items())
                ],
                "tags": [
                    {"tag": k, "count": n}
                    for k, n in sorted(tags.items(), key=lambda kv: (-kv[1], kv[0].lower()))
                ],
                "schools": sorted(
                    schools.values(), key=lambda r: r["name"].lower()
                ),
            },
            "totals": {
                "albums": len(albums),
                "videos": len(videos),
            },
        })
