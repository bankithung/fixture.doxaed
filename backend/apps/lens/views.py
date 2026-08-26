"""Guest Lens endpoints.

Manager surface (mounted under ``/api/tournaments/{id}/lens/...``): campaign
lifecycle, pass cards (plaintext token appears ONLY in mint/rotate responses,
spec D12), moderation and awards. Gate = the ``teams/views.py`` recipe:
tournament exists + accessible (404, no existence leak) then
``can_manage_tournament`` (403).

Public surface (AllowAny): the pass page tree ``/api/lens/p/{token}/...`` and
the shared album ``/api/public/tournaments/{slug}/{id}/album/`` (approved
photos only, same status gating as the public badges gallery).
"""
from __future__ import annotations

from django.conf import settings as django_settings
from django.db.models import Count, Q
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from apps.lens.models import LensCampaign, LensPass, LensPhoto, LensStory
from apps.lens.services import campaign as campaign_service
from apps.lens.services import passes as pass_service
from apps.lens.services import photos as photo_service
from apps.lens.services import stories as stories_service
from apps.lens.throttling import LensJoinThrottle, LensUploadThrottle
from apps.tournaments.models import Tournament, TournamentStatus
from apps.tournaments.permissions import can_manage_tournament
from apps.tournaments.scope import accessible_tournaments

_PUBLIC_STATUSES = (
    TournamentStatus.PUBLISHED,
    TournamentStatus.REGISTRATION_OPEN,
    TournamentStatus.SCHEDULED,
    TournamentStatus.LIVE,
    TournamentStatus.COMPLETED,
)


# --- payload builders -------------------------------------------------------

def _campaign_payload(c: LensCampaign) -> dict:
    return {
        "id": str(c.id),
        "title": c.title,
        "tagline": c.tagline,
        "instructions": c.instructions,
        "consent_note": c.consent_note,
        "max_photos_per_institution": c.max_photos_per_institution,
        "award_categories": list(c.award_categories or []),
        "category_limits": dict(c.category_limits or {}),
        "story_categories": list(c.story_categories or []),
        "story_photos_per_entry": c.story_photos_per_entry,
        "is_open": c.is_open,
        # Whether a card exists, never its token.
        "share_minted_at": (
            c.share_minted_at.isoformat() if c.share_minted_at else None
        ),
        "opened_at": c.opened_at.isoformat() if c.opened_at else None,
        "closed_at": c.closed_at.isoformat() if c.closed_at else None,
        "created_at": c.created_at.isoformat(),
    }


def _media_url(name: str) -> str:
    return f"{django_settings.MEDIA_URL}{name}" if name else ""


def _pass_payload(p: LensPass, photos_used: int) -> dict:
    return {
        "id": str(p.id),
        "institution_id": str(p.institution_id),
        "institution_name": p.institution.name,
        "is_active": p.is_active,
        # Whether the school HAS a code, never the code: the plaintext exists
        # only in the response of the call that generated it.
        "has_code": bool(p.code_hash),
        "code_set_at": (
            p.code_set_at.isoformat() if p.code_set_at else None
        ),
        "photos_used": photos_used,
        "last_minted_at": p.last_minted_at.isoformat() if p.last_minted_at else None,
    }


def _photo_payload(p: LensPhoto) -> dict:
    return {
        "id": str(p.id),
        "upload_ref": str(p.upload_ref),
        "institution_id": str(p.institution_id),
        "institution_name": p.institution.name,
        "caption": p.caption,
        "category": p.category,
        "url": _media_url(p.image.name),
        "thumb_url": _media_url(p.thumb.name),
        "width": p.width,
        "height": p.height,
        "size": p.size,
        "status": p.status,
        "hidden_reason": p.hidden_reason,
        "award_category": p.award_category,
        "created_at": p.created_at.isoformat(),
    }


def _get_managed_tournament(request, tournament_id) -> Tournament:
    """The teams/views.py gate: 404 for inaccessible (no existence leak),
    403 for accessible non-managers."""
    tournament = (
        Tournament.objects.filter(id=tournament_id, deleted_at__isnull=True)
        .select_related("organization")
        .first()
    )
    if tournament is None or not accessible_tournaments(request.user).filter(
        id=tournament_id
    ).exists():
        raise NotFound("tournament_not_found")
    if not can_manage_tournament(request.user, tournament):
        raise PermissionDenied("not_tournament_manager")
    return tournament


def _manager_campaign_or_404(request, campaign_id):
    """A campaign the caller may manage. 404 on no access (invariant 2), 403
    on an accessible tournament the caller does not manage."""
    campaign = (
        LensCampaign.objects.filter(id=campaign_id)
        .select_related("tournament", "organization")
        .first()
    )
    if campaign is None:
        raise NotFound("campaign_not_found")
    _get_managed_tournament(request, campaign.tournament_id)
    return campaign


def _campaign_qs(tournament):
    return LensCampaign.objects.filter(tournament=tournament).order_by("created_at")


def _resolve_campaign_or_none(request, tournament) -> LensCampaign | None:
    """The campaign a request targets: ``?campaign=`` (GET) or ``campaign_id``
    (body), else the tournament's first campaign (legacy single-campaign
    callers). None when the tournament has no campaigns."""
    raw = request.query_params.get("campaign") or request.data.get("campaign_id")
    cid = photo_service.as_uuid(raw)
    qs = _campaign_qs(tournament)
    return qs.filter(id=cid).first() if cid else qs.first()


def _resolve_campaign(request, tournament) -> LensCampaign:
    """Like :func:`_resolve_campaign_or_none` but 404s when none match — for
    mutations that must target a real campaign."""
    c = _resolve_campaign_or_none(request, tournament)
    if c is None:
        raise NotFound("campaign_not_found")
    return c


def _event_id(request):
    return photo_service.as_uuid(request.data.get("event_id"))


# --- manager: campaign --------------------------------------------------------

class LensCampaignsView(GenericAPIView):
    """`GET /api/tournaments/{id}/lens/campaigns/` — list every Guest Lens
    campaign for the tournament (with light stats for the picker cards).
    `POST` — create a NEW campaign (title/settings in the body). Both are
    manager-gated; POST is idempotent on `event_id` and gated on fixtures."""

    permission_classes = [IsAuthenticated]

    def _summary(self, c: LensCampaign, stats: dict) -> dict:
        s = stats.get(c.id, {})
        return {
            **_campaign_payload(c),
            "photos_total": s.get("total", 0),
            "photos_pending": s.get("pending", 0),
            "passes_active": s.get("passes", 0),
        }

    def get(self, request, tournament_id):
        t = _get_managed_tournament(request, tournament_id)
        campaigns = list(_campaign_qs(t))
        ids = [c.id for c in campaigns]
        stats: dict = {cid: {"total": 0, "pending": 0, "passes": 0} for cid in ids}
        if ids:
            for row in (
                LensPhoto.objects.filter(campaign_id__in=ids)
                .values("campaign_id")
                .annotate(
                    total=Count("id"),
                    pending=Count(
                        "id",
                        filter=Q(hidden_at__isnull=True, approved_at__isnull=True),
                    ),
                )
            ):
                stats[row["campaign_id"]].update(
                    total=row["total"], pending=row["pending"]
                )
            for row in (
                LensPass.objects.filter(campaign_id__in=ids, is_active=True)
                .values("campaign_id")
                .annotate(n=Count("id"))
            ):
                stats[row["campaign_id"]]["passes"] = row["n"]
        return Response(
            {"campaigns": [self._summary(c, stats) for c in campaigns]}
        )

    def post(self, request, tournament_id):
        t = _get_managed_tournament(request, tournament_id)
        c, created = campaign_service.create_campaign(
            tournament=t, by=request.user, settings=request.data,
            event_id=_event_id(request), request=request,
        )
        return Response(
            {"campaign": _campaign_payload(c)}, status=201 if created else 200
        )


class LensOverviewView(GenericAPIView):
    """`GET /api/tournaments/{id}/lens/` overview; `PATCH` settings update."""

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        from apps.fixtures.services.draw_config import leaf_has_matches
        from apps.teams.models import Institution

        t = _get_managed_tournament(request, tournament_id)
        c = _resolve_campaign_or_none(request, t)

        institutions_total = (
            Institution.objects.filter(tournament=t, deleted_at__isnull=True)
            .exclude(status__in=["withdrawn", "rejected"])
            .count()
        )
        passes_payload: list[dict] = []
        stats = {
            "institutions_total": institutions_total,
            "passes_active": 0,
            "photos_total": 0,
            "photos_pending": 0,
            "photos_approved": 0,
            "photos_hidden": 0,
        }
        if c is not None:
            photos = LensPhoto.objects.filter(campaign=c)
            stats["photos_total"] = photos.count()
            stats["photos_hidden"] = photos.filter(hidden_at__isnull=False).count()
            stats["photos_approved"] = photos.filter(
                hidden_at__isnull=True, approved_at__isnull=False
            ).count()
            stats["photos_pending"] = photos.filter(
                hidden_at__isnull=True, approved_at__isnull=True
            ).count()
            used = dict(
                photos.values_list("institution_id")
                .annotate(n=Count("id"))
                .values_list("institution_id", "n")
            )
            passes = (
                LensPass.objects.filter(campaign=c)
                .select_related("institution")
                .order_by("institution__name")
            )
            stats["passes_active"] = sum(1 for p in passes if p.is_active)
            passes_payload = [
                _pass_payload(p, used.get(p.institution_id, 0)) for p in passes
            ]
        return Response({
            "campaign": _campaign_payload(c) if c else None,
            "fixtures_ready": leaf_has_matches(t, None),
            "stats": stats,
            "passes": passes_payload,
        })

    def patch(self, request, tournament_id):
        t = _get_managed_tournament(request, tournament_id)
        c = _resolve_campaign(request, t)
        c = campaign_service.update_settings(
            campaign=c, by=request.user, changes=request.data,
            event_id=_event_id(request), request=request,
        )
        return Response({"campaign": _campaign_payload(c)})


class LensOpenView(GenericAPIView):
    """`POST /api/tournaments/{id}/lens/open/` — open the campaign (201; 200
    on replay or when one already exists)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        t = _get_managed_tournament(request, tournament_id)
        c, created = campaign_service.open_campaign(
            tournament=t, by=request.user, settings=request.data,
            event_id=_event_id(request), request=request,
        )
        return Response(
            {"campaign": _campaign_payload(c)}, status=201 if created else 200
        )


class LensCloseView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        t = _get_managed_tournament(request, tournament_id)
        c = campaign_service.close_campaign(
            campaign=_resolve_campaign(request, t), by=request.user,
            event_id=_event_id(request), request=request,
        )
        return Response({"campaign": _campaign_payload(c)})


class LensReopenView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        t = _get_managed_tournament(request, tournament_id)
        c = campaign_service.reopen_campaign(
            campaign=_resolve_campaign(request, t), by=request.user,
            event_id=_event_id(request), request=request,
        )
        return Response({"campaign": _campaign_payload(c)})


# --- manager: passes ------------------------------------------------------------

class LensShareCardView(GenericAPIView):
    """`POST /api/tournaments/{id}/lens/share-card/` — mint the campaign's ONE
    card; re-minting invalidates the poster already on the wall, so it is
    never automatic.

    `GET` — the card IN USE, decrypted for the manager (owner 2026-08-25):
    the poster is re-viewable and re-printable after any refresh, on any
    device. `{"card": null}` when nothing has been minted yet."""

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        t = _get_managed_tournament(request, tournament_id)
        c = _resolve_campaign_or_none(request, t)
        if c is None:
            return Response({"card": None})
        return Response({"card": pass_service.current_card(c)})

    def post(self, request, tournament_id):
        t = _get_managed_tournament(request, tournament_id)
        c, token = pass_service.mint_share_card(
            campaign=_resolve_campaign(request, t), by=request.user,
            event_id=_event_id(request), request=request,
        )
        return Response({"card": pass_service.share_card_payload(c, token)})


class LensIssueCodesView(GenericAPIView):
    """`POST /api/tournaments/{id}/lens/passes/codes/` — give every registered
    school a code for the shared card. Plaintext codes appear ONLY here
    (spec D12). `institution_ids` re-issues for a chosen few; without it,
    schools that already hold a code keep it."""

    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id):
        t = _get_managed_tournament(request, tournament_id)
        ids = request.data.get("institution_ids") or None
        if ids is not None and not isinstance(ids, list):
            raise DRFValidationError({"institution_ids": "must be a list"})
        rows, skipped = pass_service.issue_codes(
            campaign=_resolve_campaign(request, t), by=request.user,
            institution_ids=ids,
            event_id=_event_id(request), request=request,
        )
        return Response({"codes": rows, "skipped": skipped})


def _get_pass(tournament, pass_id) -> LensPass:
    p = (
        LensPass.objects.filter(id=pass_id, campaign__tournament=tournament)
        .select_related("campaign", "institution")
        .first()
    )
    if p is None:
        raise NotFound("pass_not_found")
    return p


class LensPassRotateView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id, pass_id):
        """Fresh code for ONE school; the shared card is untouched."""
        t = _get_managed_tournament(request, tournament_id)
        p, code = pass_service.rotate_pass(
            pass_=_get_pass(t, pass_id), by=request.user,
            event_id=_event_id(request), request=request,
        )
        return Response({
            "code": {
                "pass_id": str(p.id),
                "institution_id": str(p.institution_id),
                "institution_name": p.institution.name,
                "code": code,
            }
        })


class LensPassRevokeView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id, pass_id):
        t = _get_managed_tournament(request, tournament_id)
        p = pass_service.revoke_pass(
            pass_=_get_pass(t, pass_id), by=request.user,
            event_id=_event_id(request), request=request,
        )
        photos_used = LensPhoto.objects.filter(
            campaign=p.campaign, institution=p.institution
        ).count()
        return Response({"pass": _pass_payload(p, photos_used)})


# --- manager: moderation ---------------------------------------------------------

class LensPhotoListView(GenericAPIView):
    """`GET /api/tournaments/{id}/lens/photos/?status=&institution_id=`"""

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        t = _get_managed_tournament(request, tournament_id)
        c = _resolve_campaign_or_none(request, t)
        if c is None:
            return Response({"photos": []})
        qs = (
            LensPhoto.objects.filter(campaign=c)
            .select_related("institution")
            .order_by("-created_at")
        )
        status = request.query_params.get("status") or ""
        if status == "pending":
            qs = qs.filter(hidden_at__isnull=True, approved_at__isnull=True)
        elif status == "approved":
            qs = qs.filter(hidden_at__isnull=True, approved_at__isnull=False)
        elif status == "hidden":
            qs = qs.filter(hidden_at__isnull=False)
        inst = photo_service.as_uuid(request.query_params.get("institution_id"))
        if inst is not None:
            qs = qs.filter(institution_id=inst)
        category = request.query_params.get("category") or ""
        if category:
            qs = qs.filter(category=category)
        return Response({"photos": [_photo_payload(p) for p in qs]})


def _get_photo(tournament, photo_id) -> LensPhoto:
    p = (
        LensPhoto.objects.filter(id=photo_id, campaign__tournament=tournament)
        .select_related("campaign", "institution")
        .first()
    )
    if p is None:
        raise NotFound("photo_not_found")
    return p


class LensPhotoApproveView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id, photo_id):
        t = _get_managed_tournament(request, tournament_id)
        p = photo_service.approve_photo(
            photo=_get_photo(t, photo_id), by=request.user,
            event_id=_event_id(request), request=request,
        )
        return Response({"photo": _photo_payload(p)})


class LensPhotoHideView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id, photo_id):
        t = _get_managed_tournament(request, tournament_id)
        p = photo_service.hide_photo(
            photo=_get_photo(t, photo_id), by=request.user,
            reason=str(request.data.get("reason") or ""),
            event_id=_event_id(request), request=request,
        )
        return Response({"photo": _photo_payload(p)})


class LensPhotoAwardView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id, photo_id):
        t = _get_managed_tournament(request, tournament_id)
        category = request.data.get("category")
        if category is None or not isinstance(category, str):
            raise DRFValidationError({"detail": "category_required"})
        p = photo_service.award_photo(
            photo=_get_photo(t, photo_id), by=request.user, category=category,
            event_id=_event_id(request), request=request,
        )
        return Response({"photo": _photo_payload(p)})


# --- manager: photo-story entries --------------------------------------------

class LensStoryListView(GenericAPIView):
    """`GET /api/tournaments/{id}/lens/stories/?status=&category=` — every
    photo-story entry with its ordered frames."""

    permission_classes = [IsAuthenticated]

    def get(self, request, tournament_id):
        t = _get_managed_tournament(request, tournament_id)
        c = _resolve_campaign_or_none(request, t)
        if c is None:
            return Response({"stories": []})
        qs = (
            LensStory.objects.filter(campaign=c)
            .select_related("institution")
            .order_by("-created_at")
        )
        status = request.query_params.get("status") or ""
        if status == "pending":
            qs = qs.filter(hidden_at__isnull=True, approved_at__isnull=True)
        elif status == "approved":
            qs = qs.filter(hidden_at__isnull=True, approved_at__isnull=False)
        elif status == "hidden":
            qs = qs.filter(hidden_at__isnull=False)
        inst = photo_service.as_uuid(request.query_params.get("institution_id"))
        if inst is not None:
            qs = qs.filter(institution_id=inst)
        category = request.query_params.get("category") or ""
        if category:
            qs = qs.filter(category=category)
        return Response({"stories": [_story_payload(s) for s in qs]})


def _get_story(tournament, story_id):
    from apps.lens.services import stories as story_service

    return story_service.get_managed_story(tournament, story_id)


class LensStoryApproveView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id, story_id):
        t = _get_managed_tournament(request, tournament_id)
        s = stories_service.approve_story(
            story=_get_story(t, story_id), by=request.user,
            event_id=_event_id(request), request=request,
        )
        return Response({"story": _story_payload(s)})


class LensStoryHideView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id, story_id):
        t = _get_managed_tournament(request, tournament_id)
        s = stories_service.hide_story(
            story=_get_story(t, story_id), by=request.user,
            reason=str(request.data.get("reason") or ""),
            event_id=_event_id(request), request=request,
        )
        return Response({"story": _story_payload(s)})


class LensStoryAwardView(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, tournament_id, story_id):
        t = _get_managed_tournament(request, tournament_id)
        category = request.data.get("category")
        if not isinstance(category, str):
            raise DRFValidationError({"detail": "category_required"})
        s = stories_service.award_story(
            story=_get_story(t, story_id), by=request.user, category=category,
            event_id=_event_id(request), request=request,
        )
        return Response({"story": _story_payload(s)})


# --- public: the shared card ------------------------------------------------

def _share_or_404(token: str) -> LensCampaign:
    c = pass_service.resolve_share(token)
    if c is None:
        raise NotFound("card_not_found")
    return c


class LensJoinView(GenericAPIView):
    """The door behind the ONE card.

    `GET /api/lens/join/{token}/` names the album and lists the schools that
    can sign in — names only, so the picker is usable without leaking anything
    a passer-by could not read off the fixture list.

    `POST` exchanges (institution, code) for a signed, expiring session token;
    that token, not the code, is what the upload endpoints take. Wrong codes
    are counted per school (5 → 15 min lockout) beneath the per-IP throttle,
    and a locked or unknown school answers identically to a wrong code.
    """

    permission_classes = [AllowAny]
    throttle_classes = [LensJoinThrottle]

    def get(self, request, token):
        c = _share_or_404(token)
        t = c.tournament
        passes = (
            LensPass.objects.filter(
                campaign=c, is_active=True, institution__deleted_at__isnull=True
            )
            .exclude(code_hash="")
            .select_related("institution")
            .order_by("institution__name")
        )
        return Response({
            "tournament": {"id": str(t.id), "slug": t.slug, "name": t.name},
            "campaign": {
                "id": str(c.id),
                "title": c.title,
                "tagline": c.tagline,
                "instructions": c.instructions,
                "consent_note": c.consent_note,
                "is_open": c.is_open,
            },
            "institutions": [
                {"id": str(p.institution_id), "name": p.institution.name}
                for p in passes
            ],
        })

    def post(self, request, token):
        c = _share_or_404(token)
        institution_id = str(request.data.get("institution_id") or "").strip()
        code = str(request.data.get("code") or "").strip()
        if not institution_id or not code:
            raise DRFValidationError({"code": "institution_and_code_required"})
        p = (
            LensPass.objects.filter(
                campaign=c, institution_id=institution_id, is_active=True,
                institution__deleted_at__isnull=True,
            )
            .select_related("institution", "campaign")
            .first()
        )
        # An unknown or revoked school must not be distinguishable from a bad
        # code, or the picker becomes a way to enumerate who is registered.
        if p is None:
            raise DRFValidationError({"code": "invalid_code"})
        ok, error = pass_service.verify_code(p, code)
        if not ok:
            raise DRFValidationError({"code": error or "invalid_code"})
        return Response({
            "token": pass_service.make_session_token(p),
            "institution": {"id": str(p.institution_id), "name": p.institution.name},
        })


# --- public: pass page -----------------------------------------------------------

def _resolve_or_404(token: str) -> LensPass:
    p = pass_service.resolve_pass(token)
    if p is None:
        raise NotFound("pass_not_found")
    return p


def _own_photo_payload(p: LensPhoto) -> dict:
    # Hidden photos read as "removed" on the public pass page: no reason, no
    # moderation vocabulary leaks to the uploader.
    status = "removed" if p.status == "hidden" else p.status
    return {
        "upload_ref": str(p.upload_ref),
        "url": _media_url(p.image.name),
        "thumb_url": _media_url(p.thumb.name),
        "caption": p.caption,
        "photographer": p.photographer,
        "category": p.category,
        "story_id": str(p.story_id) if p.story_id else None,
        "position": p.position,
        "status": status,
        "created_at": p.created_at.isoformat(),
    }


def _story_payload(s, *, own: bool = False) -> dict:
    """One story entry. ``own=True`` is the uploader's view (hidden reads as
    "removed", moderation vocabulary stays server-side); manager and public
    views read the full state."""
    frames = list(s.photos.order_by("position", "created_at"))
    out = {
        "id": str(s.id),
        "institution_id": str(s.institution_id),
        "institution_name": s.institution.name,
        "title": s.title,
        "description": s.description,
        "category": s.category,
        "award_category": s.award_category,
        "photos": [
            {
                "upload_ref": str(ph.upload_ref),
                "url": _media_url(ph.image.name),
                "thumb_url": _media_url(ph.thumb.name),
                "caption": ph.caption,
                "photographer": ph.photographer,
                "position": ph.position,
                # A frame can hold a prize of its own. Without this the award a
                # host declared on a photo INSIDE a story was invisible
                # everywhere: the wall excludes story frames by design, so
                # nothing ever carried it (owner 2026-08-26).
                "award_category": ph.award_category,
                "created_at": ph.created_at.isoformat(),
                **({} if own else {"status": ph.status}),
            }
            for ph in frames
        ],
        "created_at": s.created_at.isoformat(),
    }
    if not own:
        out["status"] = s.status
        out["hidden_reason"] = s.hidden_reason
    return out


class LensPassContextView(GenericAPIView):
    """`GET /api/lens/p/{token}/` — the no-login upload page context."""

    permission_classes = [AllowAny]

    def get(self, request, token):
        p = _resolve_or_404(token)
        c = p.campaign
        t = c.tournament
        photos = list(
            LensPhoto.objects.filter(campaign=c, institution=p.institution)
            .order_by("-created_at")
        )
        by_category: dict[str, int] = {}
        for ph in photos:
            if ph.category:
                by_category[ph.category] = by_category.get(ph.category, 0) + 1
        return Response({
            "tournament": {"id": str(t.id), "slug": t.slug, "name": t.name},
            "institution": {"id": str(p.institution_id), "name": p.institution.name},
            "campaign": {
                "title": c.title,
                "tagline": c.tagline,
                "instructions": c.instructions,
                "consent_note": c.consent_note,
                "is_open": c.is_open,
                "max_photos_per_institution": c.max_photos_per_institution,
                "award_categories": list(c.award_categories or []),
                "category_limits": dict(c.category_limits or {}),
                "story_categories": list(c.story_categories or []),
                "story_photos_per_entry": c.story_photos_per_entry,
            },
            "quota": {
                "used": len(photos),
                "max": c.max_photos_per_institution,
                "by_category": by_category,
            },
            "photos": [_own_photo_payload(ph) for ph in photos],
            "stories": [
                _story_payload(s, own=True)
                for s in LensStory.objects.filter(
                    campaign=c, institution=p.institution,
                ).select_related("institution").order_by("created_at")
            ],
        })


class LensPassPhotosView(GenericAPIView):
    """`POST /api/lens/p/{token}/photos/` — multipart upload (throttled per
    pass token, spec D14)."""

    permission_classes = [AllowAny]
    parser_classes = [MultiPartParser, FormParser]
    throttle_classes = [LensUploadThrottle]

    def post(self, request, token):
        p = _resolve_or_404(token)
        photo = photo_service.add_photo(
            pass_=p,
            file=request.FILES.get("file"),
            caption=str(request.data.get("caption") or ""),
            category=str(request.data.get("category") or ""),
            photographer=str(request.data.get("photographer") or ""),
            event_id=_event_id(request),
        )
        return Response({"photo": _own_photo_payload(photo)}, status=201)


class LensPassPhotoDetailView(GenericAPIView):
    """`DELETE /api/lens/p/{token}/photos/{upload_ref}/` — teacher removes
    their own pending photo (frees quota).

    `PATCH` — fix the caption of their own pending photo; approved/hidden
    ones are locked (moderated content belongs to the host)."""

    permission_classes = [AllowAny]
    throttle_classes = [LensUploadThrottle]

    def delete(self, request, token, upload_ref):
        p = _resolve_or_404(token)
        photo_service.remove_own_photo(pass_=p, upload_ref=upload_ref)
        return Response({"removed": True})

    def patch(self, request, token, upload_ref):
        p = _resolve_or_404(token)
        photo = photo_service.edit_own_caption(
            pass_=p, upload_ref=upload_ref,
            caption=str(request.data.get("caption") or ""),
        )
        return Response({"photo": _own_photo_payload(photo)})


class LensPassStoryTitleView(GenericAPIView):
    """`POST /api/lens/p/{token}/stories/{story_id}/title/` — the school names
    its photo-story entry ("A title for the photo story"). Own-story scoped;
    locked once moderated."""

    permission_classes = [AllowAny]
    throttle_classes = [LensUploadThrottle]

    def post(self, request, token, story_id):
        p = _resolve_or_404(token)
        story = photo_service.set_story_title(
            pass_=p, story_id=story_id,
            title=str(request.data.get("title") or ""),
            description=(
                str(request.data.get("description"))
                if request.data.get("description") is not None
                else None
            ),
        )
        return Response({"story": _story_payload(story, own=True)})


class LensPassStoryOrderView(GenericAPIView):
    """`POST /api/lens/p/{token}/stories/{story_id}/order/` — move one of the
    school's frames to 1-based `position`, closing the gap. This is how the
    intended reading order of a photo story gets authored."""

    permission_classes = [AllowAny]
    throttle_classes = [LensUploadThrottle]

    def post(self, request, token, story_id):
        p = _resolve_or_404(token)
        raw = request.data.get("upload_ref") or ""
        try:
            position = int(request.data.get("position"))
        except (TypeError, ValueError):
            raise DRFValidationError({"detail": "invalid_position"}) from None
        story = photo_service.reorder_story_photo(
            pass_=p, story_id=story_id, upload_ref=raw, position=position,
        )
        return Response({"story": _story_payload(story, own=True)})


# --- public: shared album ------------------------------------------------------

class PublicTournamentAlbumView(GenericAPIView):
    """`GET /api/public/tournaments/{slug}/{id}/album/` — the shared album:
    approved photos only, newest first. Same slug+status gate as the public
    badges gallery."""

    permission_classes = [AllowAny]

    def get(self, request, slug, tournament_id, campaign_id=None):
        t = Tournament.objects.filter(
            id=tournament_id, slug=slug, deleted_at__isnull=True,
            status__in=_PUBLIC_STATUSES,
        ).first()
        if t is None:
            raise NotFound("tournament_not_found")
        # One album per campaign: a campaign_id in the URL targets that album;
        # the legacy no-campaign URL falls back to the tournament's first.
        qs = LensCampaign.objects.filter(tournament=t).order_by("created_at")
        c = qs.filter(id=campaign_id).first() if campaign_id else qs.first()
        if c is None:
            return Response({
                "campaign": None,
                "award_categories": [],
                "institutions": [],
                "photos": [],
                "stories": [],
                "story_categories": [],
            })
        approved = (
            LensPhoto.objects.filter(
                campaign=c, hidden_at__isnull=True, approved_at__isnull=False,
                story__isnull=True,
            )
            .select_related("institution")
            .order_by("-created_at")
        )
        by_inst: dict[str, dict] = {}
        rows = []
        for p in approved:
            iid = str(p.institution_id)
            slot = by_inst.setdefault(
                iid, {"id": iid, "name": p.institution.name, "count": 0}
            )
            slot["count"] += 1
            rows.append({
                "upload_ref": str(p.upload_ref),
                "url": _media_url(p.image.name),
                "thumb_url": _media_url(p.thumb.name),
                "institution_name": p.institution.name,
                "caption": p.caption,
                "photographer": p.photographer,
                "category": p.category,
                "award_category": p.award_category,
                "created_at": p.created_at.isoformat(),
            })
        stories_qs = (
            LensStory.objects.filter(
                campaign=c, hidden_at__isnull=True, approved_at__isnull=False,
            )
            .select_related("institution")
            .prefetch_related("photos")
            .order_by("-created_at")
        )
        stories = list(stories_qs)
        # A story's frames are approved photographs too. Counting only the wall
        # told an album whose every entry was a story that it held 0 photos
        # from 0 schools, which is simply false (owner 2026-08-25).
        story_frames = 0
        for st in stories:
            frames = [f for f in st.photos.all() if f.hidden_at is None]
            story_frames += len(frames)
            iid = str(st.institution_id)
            slot = by_inst.setdefault(
                iid, {"id": iid, "name": st.institution.name, "count": 0}
            )
            slot["count"] += len(frames)
        return Response({
            "campaign": {"title": c.title, "tagline": c.tagline},
            "award_categories": list(c.award_categories or []),
            "story_categories": list(c.story_categories or []),
            "institutions": sorted(by_inst.values(), key=lambda r: r["name"]),
            "photos": rows,
            "stories": [_story_payload(s) for s in stories],
            "totals": {
                "photos": len(rows) + story_frames,
                "wall_photos": len(rows),
                "story_photos": story_frames,
                "stories": len(stories),
                "schools": len(by_inst),
            },
        })


# ---------------------------------------------------------------- judging ---

class LensJudgesView(GenericAPIView):
    """`GET/POST /api/lens/campaigns/{campaign_id}/judges/` — the panel.

    Manager-only: appointing a judge mints a link that scores entries, so it is
    the same authority as awarding a prize.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request, campaign_id):
        from apps.lens.services import judging

        campaign = _manager_campaign_or_404(request, campaign_id)
        judges = campaign.judges.all().order_by("name")
        return Response({
            "judges": [
                {
                    "id": str(j.id),
                    "name": j.name,
                    "email": j.email,
                    "revoked": bool(j.revoked_at),
                    "last_seen_at": j.last_seen_at.isoformat() if j.last_seen_at else None,
                    "scored": j.scores.count(),
                }
                for j in judges
            ],
            "entries": len(judging.entries(campaign)),
        })

    def post(self, request, campaign_id):
        from apps.lens.services import judging

        campaign = _manager_campaign_or_404(request, campaign_id)
        judge, token = judging.appoint(
            campaign=campaign,
            name=str(request.data.get("name") or ""),
            email=str(request.data.get("email") or ""),
            by=request.user,
        )
        # The link is shown ONCE, here: it is the credential, so it is not
        # stored in a readable form and cannot be listed again later.
        return Response(
            {"id": str(judge.id), "name": judge.name, "url": judging.judge_url(token)},
            status=201,
        )


class LensJudgeDetailView(GenericAPIView):
    """`DELETE /api/lens/campaigns/{campaign_id}/judges/{judge_id}/` — revoke."""

    permission_classes = [IsAuthenticated]

    def delete(self, request, campaign_id, judge_id):
        from apps.lens.models import LensJudge
        from apps.lens.services import judging

        campaign = _manager_campaign_or_404(request, campaign_id)
        judge = LensJudge.objects.filter(id=judge_id, campaign=campaign).first()
        if judge is None:
            raise NotFound("judge_not_found")
        judging.revoke(judge=judge)
        return Response({"revoked": True})


class LensJudgingResultsView(GenericAPIView):
    """`GET /api/lens/campaigns/{campaign_id}/judging/` — the panel's verdict,
    identities shown. Manager-only: this is the answer before it is announced."""

    permission_classes = [IsAuthenticated]

    def get(self, request, campaign_id):
        from apps.lens.services import judging

        campaign = _manager_campaign_or_404(request, campaign_id)
        return Response({"categories": judging.results(campaign)})


class LensJudgePanelView(GenericAPIView):
    """`GET /api/lens/j/{token}/` — the judging sheet, no login.

    The school and the photographer are NOT in this payload: the rules promise
    a view in which those identities are hidden, so they are omitted rather
    than merely left unrendered.
    """

    permission_classes = [AllowAny]

    def get(self, request, token):
        from apps.lens.services import judging

        judge = judging.resolve_judge(token)
        if judge is None:
            raise NotFound("judge_link_invalid")
        return Response(judging.panel_payload(judge))


class LensJudgeScoreView(GenericAPIView):
    """`POST /api/lens/j/{token}/scores/` — record or revise one sheet."""

    permission_classes = [AllowAny]
    throttle_classes = [LensUploadThrottle]

    def post(self, request, token):
        from apps.lens.services import judging

        judge = judging.resolve_judge(token)
        if judge is None:
            raise NotFound("judge_link_invalid")
        score = judging.submit_score(
            judge=judge,
            kind=str(request.data.get("kind") or "photo"),
            entry_id=str(request.data.get("entry_id") or ""),
            marks=request.data.get("marks"),
            note=str(request.data.get("note") or ""),
        )
        return Response({"total": score.total, "marks": score.marks}, status=200)
