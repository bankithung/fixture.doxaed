"""The judging panel: appointed judges, anonymised entries, scores, results.

Three rules from the competition drive everything here.

**A judge is appointed, not registered.** The panel is photographers and
teachers invited for the day, so a judge gets the same kind of credential a
school gets — one signed link, no sign-up.

**The judging view hides who took the photograph.** The rules promise judges
"a separate view in which the school's and photographer's identities are
hidden", so the anonymised payload is built by OMISSION rather than by asking
the page not to render fields it was handed.

**A story is ONE entry.** Its four photographs are scored together, which the
unique constraint on (judge, story) enforces as much as this module does.
"""
from __future__ import annotations

import hashlib
import secrets

from django.core import signing
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound
from rest_framework.exceptions import ValidationError as DRFValidationError

from apps.lens.models import LensJudge, LensPhoto, LensScore, LensStory
from apps.lens.rubrics import clean_marks, guide_for, rubric_for, score_total

SALT = "lens-judge-link"
#: A judging window outlives the meet: a panel often sits days later.
MAX_AGE = 30 * 24 * 60 * 60


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def make_token(judge: LensJudge) -> str:
    return signing.dumps({"j": str(judge.id), "c": str(judge.campaign_id)}, salt=SALT)


def read_token(token: str):
    try:
        return signing.loads(token, salt=SALT, max_age=MAX_AGE)
    except Exception:
        return None


def resolve_judge(token: str) -> LensJudge | None:
    payload = read_token(token)
    if payload is None:
        return None
    judge = (
        LensJudge.objects.select_related("campaign")
        .filter(id=payload["j"], campaign_id=payload["c"], revoked_at__isnull=True)
        .first()
    )
    return judge


def appoint(*, campaign, name: str, email: str = "", by=None) -> tuple[LensJudge, str]:
    """Add a judge to the panel and mint their link."""
    name = (name or "").strip()[:120]
    if not name:
        raise DRFValidationError({"detail": "name_required"})
    judge = LensJudge.objects.create(
        organization=campaign.organization,
        campaign=campaign,
        name=name,
        email=(email or "").strip()[:254],
        created_by=by,
    )
    token = make_token(judge)
    judge.token_hash = _hash(token)
    judge.minted_at = timezone.now()
    judge.save(update_fields=["token_hash", "minted_at"])
    return judge, token


def judge_url(token: str) -> str:
    from django.conf import settings as django_settings

    base = getattr(
        django_settings, "PUBLIC_BASE_URL", "https://fixture.doxaed.com"
    ).rstrip("/")
    return f"{base}/lens/judge/{token}"


def revoke(*, judge: LensJudge) -> LensJudge:
    judge.revoked_at = timezone.now()
    judge.save(update_fields=["revoked_at"])
    return judge


def _live_photos(campaign):
    """Entries in the judgeable pool: published, not hidden, not a story frame.

    "Publication in the gallery means an entry has been approved for judging"
    — so the pool is exactly what the public can see, no more.
    """
    return (
        LensPhoto.objects.filter(
            campaign=campaign, hidden_at__isnull=True,
            approved_at__isnull=False, story__isnull=True,
        )
        .exclude(category="")
        .order_by("category", "created_at")
    )


def _live_stories(campaign):
    return (
        LensStory.objects.filter(
            campaign=campaign, hidden_at__isnull=True, approved_at__isnull=False,
        )
        .prefetch_related("photos")
        .order_by("category", "created_at")
    )


def entries(campaign, *, anonymous: bool = True) -> list[dict]:
    """Every judgeable entry. ``anonymous`` omits the school and the
    photographer — it does not merely hide them from the template."""
    from apps.lens.views import _media_url

    out: list[dict] = []
    for p in _live_photos(campaign):
        row = {
            "kind": "photo",
            "id": str(p.upload_ref),
            "category": p.category,
            "caption": p.caption,
            "photos": [
                {"url": _media_url(p.image.name), "thumb_url": _media_url(p.thumb.name)}
            ],
        }
        if not anonymous:
            row["school"] = p.institution.name
            row["photographer"] = p.photographer
        out.append(row)
    for s in _live_stories(campaign):
        frames = sorted(s.photos.all(), key=lambda f: (f.position, f.created_at))
        row = {
            "kind": "story",
            "id": str(s.id),
            "category": s.category,
            "caption": s.title,
            "description": s.description,
            "photos": [
                {"url": _media_url(f.image.name), "thumb_url": _media_url(f.thumb.name)}
                for f in frames
            ],
        }
        if not anonymous:
            row["school"] = s.institution.name
        out.append(row)
    return out


def _subject(campaign, kind: str, entry_id: str):
    if kind == "story":
        s = LensStory.objects.filter(
            campaign=campaign, id=entry_id, hidden_at__isnull=True,
            approved_at__isnull=False,
        ).first()
        if s is None:
            raise NotFound("entry_not_found")
        return None, s
    p = LensPhoto.objects.filter(
        campaign=campaign, upload_ref=entry_id, hidden_at__isnull=True,
        approved_at__isnull=False, story__isnull=True,
    ).first()
    if p is None:
        raise NotFound("entry_not_found")
    return p, None


def submit_score(*, judge: LensJudge, kind: str, entry_id: str, marks, note: str = ""):
    """Record (or revise) one judge's sheet for one entry."""
    campaign = judge.campaign
    photo, story = _subject(campaign, kind, entry_id)
    rubric = rubric_for(story is not None)
    try:
        clean = clean_marks(rubric, marks)
    except ValueError as exc:
        raise DRFValidationError({"detail": str(exc)}) from None
    total = score_total(rubric, clean)
    with transaction.atomic():
        score, _created = LensScore.objects.update_or_create(
            judge=judge,
            photo=photo,
            story=story,
            defaults={
                "organization": campaign.organization,
                "campaign": campaign,
                "marks": clean,
                "total": total,
                "note": (note or "").strip()[:2000],
            },
        )
        judge.last_seen_at = timezone.now()
        judge.save(update_fields=["last_seen_at"])
    return score


def my_scores(judge: LensJudge) -> dict:
    """This judge's sheets, keyed by entry, so the page can show progress."""
    out: dict = {}
    for s in LensScore.objects.filter(judge=judge).select_related("photo", "story"):
        key = str(s.story_id) if s.story_id else str(s.photo.upload_ref)
        out[key] = {"marks": s.marks, "total": s.total, "note": s.note}
    return out


def results(campaign) -> list[dict]:
    """The panel's verdict, per category.

    Ranked by the AVERAGE of the sheets returned, not the sum: a judge who has
    not scored an entry must not push it down the order. Entries nobody scored
    are listed last, and say so.
    """
    rows = entries(campaign, anonymous=False)
    scores: dict[str, list[LensScore]] = {}
    for s in LensScore.objects.filter(campaign=campaign).select_related(
        "photo", "story"
    ):
        key = str(s.story_id) if s.story_id else str(s.photo.upload_ref)
        scores.setdefault(key, []).append(s)

    by_category: dict[str, list[dict]] = {}
    for row in rows:
        got = scores.get(row["id"], [])
        judged = len(got)
        avg = round(sum(x.total for x in got) / judged, 1) if judged else None
        by_category.setdefault(row["category"], []).append({
            **row,
            "judges": judged,
            "average": avg,
            "sheets": [
                {"judge": x.judge.name, "total": x.total, "marks": x.marks,
                 "note": x.note}
                for x in sorted(got, key=lambda y: y.judge.name.lower())
            ],
        })

    out = []
    for category, items in by_category.items():
        items.sort(key=lambda r: (r["average"] is None, -(r["average"] or 0)))
        for i, item in enumerate(items):
            item["rank"] = i + 1 if item["average"] is not None else None
        out.append({
            "category": category,
            "is_story": bool(items and items[0]["kind"] == "story"),
            "entries": items,
        })
    out.sort(key=lambda r: r["category"].lower())
    return out


def panel_payload(judge: LensJudge) -> dict:
    """Everything the judging page needs, with identities left out."""
    campaign = judge.campaign
    rows = entries(campaign, anonymous=True)
    mine = my_scores(judge)
    return {
        "judge": {"name": judge.name},
        "campaign": {"title": campaign.title, "tagline": campaign.tagline},
        "rubrics": {
            "photo": {"criteria": rubric_for(False), "guide": guide_for(False)},
            "story": {"criteria": rubric_for(True), "guide": guide_for(True)},
        },
        "entries": [{**row, "score": mine.get(row["id"])} for row in rows],
        "totals": {
            "entries": len(rows),
            "scored": sum(1 for row in rows if row["id"] in mine),
        },
    }
