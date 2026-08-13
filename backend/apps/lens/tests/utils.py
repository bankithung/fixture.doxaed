"""Shared builders for the lens suite — services only, no factories."""
from __future__ import annotations

import io
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

User = get_user_model()

PASSWORD = "FixtureDemo2026!"


def verified(email: str | None = None):
    u = User.objects.create_user(
        email=email or f"lens-{uuid.uuid4().hex[:8]}@test.local",
        password=PASSWORD,
        is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def setup_tournament(*, with_fixtures: bool = True, schools=("Springfield High",)):
    """Admin + tournament + one Institution per school (via register_school) +
    optionally one Match row (the spec-D4 fixtures-generated signal)."""
    from apps.matches.models import Match
    from apps.teams.services.registration import register_school
    from apps.tournaments.services.create import create_tournament

    admin = verified()
    t = create_tournament(user=admin, name="Lens Cup")
    institutions = []
    all_teams = []
    for name in schools:
        teams = register_school(
            tournament=t,
            school_name=name,
            teams=[{"name": f"{name} A"}, {"name": f"{name} B"}],
        )
        institutions.append(teams[0].institution)
        all_teams.extend(teams)
    if with_fixtures:
        Match.objects.create(
            organization=t.organization,
            tournament=t,
            home_team=all_teams[0],
            away_team=all_teams[1],
            match_no=1,
            leaf_key="football.open",
            scheduled_at=timezone.now() + timedelta(days=1),
        )
    return admin, t, institutions


def open_campaign(t, admin, **settings_kwargs):
    from apps.lens.services.campaign import open_campaign as _open

    campaign, _created = _open(tournament=t, by=admin, settings=settings_kwargs)
    return campaign


def mint_token(campaign, admin):
    """Issue codes and return ``(pass, session_token)`` for the first school —
    the credential the upload endpoints actually take, as if that school had
    scanned the shared card and typed its code."""
    from apps.lens.models import LensPass
    from apps.lens.services.passes import issue_codes, make_session_token

    rows, _skipped = issue_codes(campaign=campaign, by=admin)
    pass_ = LensPass.objects.get(id=rows[0]["pass_id"])
    return pass_, make_session_token(pass_)


def mint_code(campaign, admin):
    """``(pass, plaintext_code)`` for the first school."""
    from apps.lens.models import LensPass
    from apps.lens.services.passes import issue_codes

    rows, _skipped = issue_codes(campaign=campaign, by=admin)
    return LensPass.objects.get(id=rows[0]["pass_id"]), rows[0]["code"]


def share_token(campaign, admin):
    """Mint the campaign's one card and return its plaintext token."""
    from apps.lens.services.passes import mint_share_card

    _c, token = mint_share_card(campaign=campaign, by=admin)
    return token


def jpeg_file(
    name="photo.jpg",
    size=(1200, 800),
    content_type="image/jpeg",
    orientation: int | None = None,
):
    from PIL import Image

    buf = io.BytesIO()
    img = Image.new("RGB", size, (180, 40, 40))
    kwargs = {}
    if orientation is not None:
        exif = Image.Exif()
        exif[0x0112] = orientation
        kwargs["exif"] = exif
    img.save(buf, "JPEG", quality=85, **kwargs)
    return SimpleUploadedFile(name, buf.getvalue(), content_type=content_type)


def detail(response) -> str:
    d = response.json().get("detail")
    if isinstance(d, list):
        d = d[0]
    return str(d)
