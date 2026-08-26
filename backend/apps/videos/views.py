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
from apps.videos.services.links import clean_link, youtube_id

_PUBLIC_STATUSES = [
    TournamentStatus.SCHEDULED, TournamentStatus.REGISTRATION_OPEN,
    TournamentStatus.LIVE, TournamentStatus.COMPLETED, TournamentStatus.PUBLISHED,
]


def video_payload(v: TournamentVideo) -> dict:
    return {
        "id": str(v.id),
        "event": v.event,
        "note": v.note,
        "youtube_url": v.youtube_url,
        "facebook_url": v.facebook_url,
        "instagram_url": v.instagram_url,
        # Parsed once, on the server: the page embeds the id, never the URL.
        "youtube_id": youtube_id(v.youtube_url),
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
        .prefetch_related("videos")
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


class TournamentVideoAlbumsView(GenericAPIView):
    """`GET/POST /api/tournaments/{id}/video-albums/` — the host's albums."""

    permission_classes = [IsAuthenticated]

    def _tournament(self, request, tournament_id):
        if not accessible_tournaments(request.user).filter(id=tournament_id).exists():
            raise NotFound("tournament_not_found")
        return Tournament.objects.select_related("organization").get(id=tournament_id)

    def get(self, request, tournament_id):
        t = self._tournament(request, tournament_id)
        return Response({
            "albums": [album_payload(a) for a in _albums(t)],
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
            position=int(request.data.get("position") or 0),
            created_by=request.user,
            **_clean_links(request.data),
        )
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
            "event", "note", "position", "youtube_url", "facebook_url",
            "instagram_url", "updated_at",
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
        return Response({
            "tournament": {
                "id": str(t.id), "slug": t.slug, "name": t.name, "status": t.status,
            },
            "albums": albums,
            "totals": {
                "albums": len(albums),
                "videos": sum(a["video_count"] for a in albums),
            },
        })
