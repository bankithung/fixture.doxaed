"""The judging panel: appointed judges, anonymised entries, scores, results.

Three rules from the competition drive these tests: a judge is appointed rather
than registered, the judging view hides who took the photograph, and a photo
story is ONE entry judged as a whole.
"""
from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.lens.models import LensPhoto, LensScore
from apps.lens.rubrics import PHOTO_RUBRIC, STORY_RUBRIC, score_total
from apps.lens.services import judging
from apps.lens.services import photos as photo_service
from apps.lens.tests.utils import (
    jpeg_file, mint_token, open_campaign, setup_tournament,
)

pytestmark = pytest.mark.django_db

SEPAK = "Best Sepaktakraw Photograph"
STORY = "Beyond the Court: A Photo Story"


def _campaign():
    admin, t, _ = setup_tournament()
    campaign = open_campaign(
        t, admin,
        award_categories=[SEPAK, STORY],
        story_categories=[STORY],
        story_photos_per_entry=4,
        category_limits={SEPAK: 4, STORY: 4},
        publish_on_upload=True,
    )
    pass_, _tok = mint_token(campaign, admin)
    return admin, campaign, pass_


def _photo(pass_, category=SEPAK, caption="", photographer="R. Ao"):
    return photo_service.add_photo(
        pass_=pass_, file=jpeg_file(), category=category,
        caption=caption, photographer=photographer,
    )


def test_rubrics_are_the_published_ones_and_total_one_hundred():
    assert sum(r["max"] for r in PHOTO_RUBRIC) == 100
    assert sum(r["max"] for r in STORY_RUBRIC) == 100
    assert [r["label"] for r in PHOTO_RUBRIC][0] == "Timing and Action"
    assert [r["label"] for r in STORY_RUBRIC][0] == "Storytelling and Narrative"


def test_a_judges_view_omits_the_school_and_the_photographer():
    """The rules promise judges a view in which those identities are hidden,
    so they are left OUT of the payload rather than merely unrendered."""
    admin, campaign, pass_ = _campaign()
    _photo(pass_, caption="The winning spike", photographer="A. Jamir")
    judge, token = judging.appoint(campaign=campaign, name="M. Sema", by=admin)

    body = APIClient().get(f"/api/lens/j/{token}/").json()
    entry = body["entries"][0]
    assert entry["caption"] == "The winning spike"
    assert "school" not in entry
    assert "photographer" not in entry
    assert "A. Jamir" not in str(body)
    assert body["judge"]["name"] == "M. Sema"


def test_a_judge_scores_an_entry_and_can_revise_it():
    admin, campaign, pass_ = _campaign()
    photo = _photo(pass_)
    judge, token = judging.appoint(campaign=campaign, name="M. Sema", by=admin)
    c = APIClient()

    marks = {"timing": 28, "composition": 18, "emotion": 12,
             "technical": 13, "originality": 8, "relevance": 9}
    r = c.post(
        f"/api/lens/j/{token}/scores/",
        {"kind": "photo", "entry_id": str(photo.upload_ref), "marks": marks},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.json()["total"] == score_total(PHOTO_RUBRIC, marks) == 88

    # Revising replaces the sheet rather than adding a second one.
    c.post(
        f"/api/lens/j/{token}/scores/",
        {"kind": "photo", "entry_id": str(photo.upload_ref),
         "marks": {**marks, "timing": 30}},
        format="json",
    )
    assert LensScore.objects.filter(judge=judge, photo=photo).count() == 1
    assert LensScore.objects.get(judge=judge, photo=photo).total == 90


def test_a_mark_above_its_criterion_maximum_is_refused():
    admin, campaign, pass_ = _campaign()
    photo = _photo(pass_)
    _judge, token = judging.appoint(campaign=campaign, name="M. Sema", by=admin)
    r = APIClient().post(
        f"/api/lens/j/{token}/scores/",
        {"kind": "photo", "entry_id": str(photo.upload_ref),
         "marks": {"timing": 31}},
        format="json",
    )
    assert r.status_code == 400
    assert "mark_out_of_range" in str(r.json())


def test_a_photo_story_is_one_entry_judged_on_the_story_rubric():
    admin, campaign, pass_ = _campaign()
    for _ in range(4):
        _photo(pass_, category=STORY)
    photo_service.set_story_title(
        pass_=pass_,
        story_id=str(LensPhoto.objects.filter(category=STORY).first().story_id),
        title="Road to the final",
    )
    _judge, token = judging.appoint(campaign=campaign, name="M. Sema", by=admin)

    body = APIClient().get(f"/api/lens/j/{token}/").json()
    story = next(e for e in body["entries"] if e["kind"] == "story")
    # FOUR photographs, ONE entry.
    assert len(story["photos"]) == 4
    assert story["caption"] == "Road to the final"
    assert [e["kind"] for e in body["entries"]].count("story") == 1
    assert body["rubrics"]["story"]["criteria"][0]["key"] == "storytelling"

    r = APIClient().post(
        f"/api/lens/j/{token}/scores/",
        {"kind": "story", "entry_id": story["id"],
         "marks": {"storytelling": 27, "sequence": 17}},
        format="json",
    )
    assert r.status_code == 200
    assert r.json()["total"] == 44


def test_results_rank_by_average_so_an_unscored_sheet_does_not_demote():
    admin, campaign, pass_ = _campaign()
    a = _photo(pass_, caption="A")
    b = _photo(pass_, caption="B")
    one, tok1 = judging.appoint(campaign=campaign, name="One", by=admin)
    _two, tok2 = judging.appoint(campaign=campaign, name="Two", by=admin)
    c = APIClient()
    # A is scored 90 by BOTH judges; B is scored 95 by one only.
    for tok in (tok1, tok2):
        c.post(f"/api/lens/j/{tok}/scores/",
               {"kind": "photo", "entry_id": str(a.upload_ref),
                "marks": {"timing": 30, "composition": 20, "emotion": 15,
                          "technical": 15, "originality": 10}},
               format="json")
    c.post(f"/api/lens/j/{tok1}/scores/",
           {"kind": "photo", "entry_id": str(b.upload_ref),
            "marks": {"timing": 30, "composition": 20, "emotion": 15,
                      "technical": 15, "originality": 10, "relevance": 10}},
           format="json")

    cats = {r["category"]: r for r in judging.results(campaign)}
    ranked = cats[SEPAK]["entries"]
    # B averages 100 over one sheet and leads; a missing sheet did not sink it.
    assert ranked[0]["caption"] == "B"
    assert ranked[0]["average"] == 100
    assert ranked[0]["judges"] == 1
    assert ranked[1]["caption"] == "A"
    assert ranked[1]["judges"] == 2
    # The manager's view DOES name the school — this is the answer, not the
    # anonymised sheet.
    assert "school" in ranked[0]
    assert one.name


def test_an_unscored_entry_is_listed_last_and_says_so():
    admin, campaign, pass_ = _campaign()
    _photo(pass_, caption="Nobody scored me")
    cats = judging.results(campaign)
    entry = cats[0]["entries"][0]
    assert entry["judges"] == 0
    assert entry["average"] is None
    assert entry["rank"] is None


def test_a_revoked_link_stops_working():
    admin, campaign, pass_ = _campaign()
    _photo(pass_)
    judge, token = judging.appoint(campaign=campaign, name="M. Sema", by=admin)
    assert APIClient().get(f"/api/lens/j/{token}/").status_code == 200
    judging.revoke(judge=judge)
    assert APIClient().get(f"/api/lens/j/{token}/").status_code == 404


def test_only_published_entries_reach_the_panel():
    """"Publication in the gallery means an entry has been approved for
    judging" — so a hidden photo leaves the pool."""
    admin, campaign, pass_ = _campaign()
    photo = _photo(pass_)
    _judge, token = judging.appoint(campaign=campaign, name="M. Sema", by=admin)
    assert len(APIClient().get(f"/api/lens/j/{token}/").json()["entries"]) == 1

    from django.utils import timezone

    LensPhoto.objects.filter(pk=photo.pk).update(hidden_at=timezone.now())
    assert APIClient().get(f"/api/lens/j/{token}/").json()["entries"] == []


def test_publish_on_upload_still_lets_a_school_name_its_story():
    """Publishing on upload approves instantly, and the old lock keyed on
    "approved" — which would have made the mandatory story title impossible to
    set (owner 2026-08-26). The lock is about MODERATION, not publication."""
    admin, campaign, pass_ = _campaign()
    for _ in range(2):
        _photo(pass_, category=STORY)
    story_id = str(LensPhoto.objects.filter(category=STORY).first().story_id)

    story = photo_service.set_story_title(
        pass_=pass_, story_id=story_id, title="Road to the final",
        description="From warm-up to podium",
    )
    assert story.title == "Road to the final"
    assert story.approved_at is not None

    # Once an organiser HIDES it, the school no longer owns it.
    from django.utils import timezone

    from apps.lens.models import LensStory

    LensStory.objects.filter(pk=story.pk).update(hidden_at=timezone.now())
    with pytest.raises(Exception):
        photo_service.set_story_title(
            pass_=pass_, story_id=story_id, title="Changed my mind",
        )
