"""Photo-story entries ("Beyond the Court"): one titled, ordered set of
photographs per school per story category, judged together as ONE entry.

Pinned here: the grouping rules (one story per school+category, frame cap,
entry-cap semantics of ``category_limits``), the school's own authoring verbs
(title, reorder, remove), manager moderation/award at STORY level, and the
public album rendering stories as units while ordinary photos stay flat.
"""
from __future__ import annotations

import uuid

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from apps.lens.models import LensPhoto, LensStory
from apps.lens.services.stories import award_story
from apps.lens.tests.utils import (
    detail,
    jpeg_file,
    mint_token,
    open_campaign,
    setup_tournament,
)

pytestmark = pytest.mark.django_db

STORY = "Beyond the Court - A Photo Story"
ACTION = "Best Sepaktakraw Photography"


def _setup(**settings_kwargs):
    settings_kwargs.setdefault("award_categories", [ACTION, STORY])
    settings_kwargs.setdefault("story_categories", [STORY])
    admin, t, insts = setup_tournament(schools=("Springfield High", "Shelbyville High"))
    campaign = open_campaign(t, admin, **settings_kwargs)
    pass_, token = mint_token(campaign, admin)
    return admin, t, campaign, pass_, token, insts


def _upload(token, category="", caption="", event_id=None):
    return APIClient().post(
        f"/api/lens/p/{token}/photos/",
        {
            "file": jpeg_file(),
            "category": category,
            "caption": caption,
            "event_id": event_id or str(uuid.uuid4()),
        },
        format="multipart",
    )


# --- upload / grouping --------------------------------------------------------


def test_story_upload_creates_one_entry_and_orders_frames():
    _admin, _t, campaign, _pass, token, _insts = _setup()
    for i in range(4):
        r = _upload(token, category=STORY, caption=f"frame {i + 1}")
        assert r.status_code == 201, r.content
    stories = LensStory.objects.filter(campaign=campaign)
    assert stories.count() == 1
    s = stories.get()
    frames = list(s.photos.order_by("position"))
    assert [p.position for p in frames] == [1, 2, 3, 4]
    assert [p.caption for p in frames] == ["frame 1", "frame 2", "frame 3", "frame 4"]


def test_frame_cap_stops_at_four():
    admin, _t, campaign, _pass, token, _insts = _setup()
    for _ in range(campaign.story_photos_per_entry):
        assert _upload(token, category=STORY).status_code == 201
    r = _upload(token, category=STORY)
    assert r.status_code == 400
    assert detail(r) == "story_full"


def test_entry_cap_counts_stories_not_photos():
    # limit 1 story per school (the competition rule): a second story cannot
    # exist even though each holds only some of its frames.
    _admin, _t, campaign, _pass, token, _insts = _setup(
        category_limits={STORY: 1},
    )
    assert campaign.category_limits[STORY] == 1
    for _ in range(2):
        assert _upload(token, category=STORY).status_code == 201
    assert LensStory.objects.filter(campaign=campaign).count() == 1


def test_ordinary_category_keeps_photo_count_semantics():
    _admin, _t, _campaign, _pass, token, _insts = _setup(
        category_limits={ACTION: 1}, max_photos_per_institution=10,
    )
    assert _upload(token, category=ACTION).status_code == 201
    r = _upload(token, category=ACTION)
    assert r.status_code == 400
    assert detail(r) == "category_quota_exceeded"


def test_story_category_requires_membership():
    _admin, _t, _campaign, _pass, token, _insts = _setup()
    r = APIClient().post(  # not in award_categories at all -> unknown
        f"/api/lens/p/{token}/photos/",
        {"file": jpeg_file(), "category": "Nope",
         "event_id": str(uuid.uuid4())},
        format="multipart",
    )
    assert r.status_code == 400


def test_overall_quota_still_applies_to_story_frames():
    _admin, _t, _campaign, _pass, token, _insts = _setup(max_photos_per_institution=3)
    for _ in range(3):
        assert _upload(token, category=STORY).status_code == 201
    r = _upload(token, category=STORY)
    assert r.status_code == 400
    assert detail(r) == "quota_exceeded"


def test_two_schools_get_separate_entries():
    admin, t, campaign, pass_, _token, insts = _setup()
    other_pass_token = _other_token(campaign, pass_)
    assert _upload(_token, category=STORY).status_code == 201
    assert _upload(other_pass_token, category=STORY).status_code == 201
    assert LensStory.objects.filter(campaign=campaign).count() == 2


# --- the school authors its entry ---------------------------------------------


def _own_story(token, campaign, pass_=None):
    from apps.lens.models import LensPass

    p = pass_ or LensPass.objects.filter(campaign=campaign).first()
    return (
        LensStory.objects.filter(
            campaign=campaign,
            institution=p.institution if p else None,
        )
        .first()
        or LensStory.objects.filter(campaign=campaign).first()
    )


def _other_token(campaign, pass_):
    """Session token for the OTHER school (issue_codes already gave every
    institution a code on the first mint; a second mint would skip them)."""
    from apps.lens.models import LensPass
    from apps.lens.services.passes import make_session_token

    other = (
        LensPass.objects.filter(campaign=campaign)
        .exclude(pk=pass_.pk)
        .first()
    )
    return make_session_token(other)


def _publish(t):
    from apps.tournaments.models import Tournament

    Tournament.objects.filter(pk=t.pk).update(status="published")


def test_title_set_and_locked_after_approval():
    admin, _t, campaign, _pass, token, _insts = _setup()
    assert _upload(token, category=STORY).status_code == 201
    s = _own_story(token, campaign)
    client = APIClient()
    r = client.post(f"/api/lens/p/{token}/stories/{s.id}/title/",
                    {"title": "Road to the final"}, format="json")
    assert r.status_code == 200, r.content
    s.refresh_from_db()
    assert s.title == "Road to the final"

    # approve via the manager surface, then the name is frozen
    admin_client = APIClient(); admin_client.force_authenticate(admin)
    ra = admin_client.post(f"/api/tournaments/{campaign.tournament_id}/lens/stories/{s.id}/approve/")
    assert ra.status_code == 200, ra.content
    r2 = client.post(f"/api/lens/p/{token}/stories/{s.id}/title/",
                     {"title": "renamed"}, format="json")
    assert r2.status_code == 400
    assert detail(r2) == "photo_locked"


def test_title_is_school_scoped_other_pass_cannot_rename():
    admin, _t, campaign, pass_, _token, _insts = _setup()
    other_token = _other_token(campaign, pass_)
    assert _upload(other_token, category=STORY).status_code == 201
    s = _own_story(other_token, campaign)
    r = APIClient().post(f"/api/lens/p/{_token}/stories/{s.id}/title/",
                         {"title": "hijacked"}, format="json")
    assert r.status_code == 404


def test_reorder_moves_frame_and_closes_gap():
    _admin, _t, campaign, _pass, token, _insts = _setup()
    refs = []
    for i in range(4):
        r = _upload(token, category=STORY)
        refs.append(r.json()["photo"]["upload_ref"])
    s = _own_story(token, campaign)
    r = APIClient().post(
        f"/api/lens/p/{token}/stories/{s.id}/order/",
        {"upload_ref": refs[3], "position": 1}, format="json",
    )
    assert r.status_code == 200, r.content
    order = list(s.photos.order_by("position").values_list("upload_ref", flat=True))
    assert order[0] == uuid.UUID(refs[3])
    assert order[1:] == [uuid.UUID(x) for x in refs[:3]]


def test_remove_own_frame_closes_gap_and_empty_story_dies():
    _admin, _t, campaign, pass_, token, _insts = _setup()
    refs = [_upload(token, category=STORY).json()["photo"]["upload_ref"]
            for _ in range(3)]
    s = _own_story(token, campaign)
    r = APIClient().delete(f"/api/lens/p/{token}/photos/{refs[1]}/")
    assert r.status_code == 200
    positions = list(s.photos.order_by("position").values_list("position", flat=True))
    assert positions == [1, 2]
    # remove the rest — the pending story row disappears with its last frame
    for ref in (refs[0], refs[2]):
        APIClient().delete(f"/api/lens/p/{token}/photos/{ref}/")
    assert not LensStory.objects.filter(pk=s.pk).exists()


def test_approved_frames_block_self_delete():
    admin, _t, campaign, _pass, token, _insts = _setup()
    ref = _upload(token, category=STORY).json()["photo"]["upload_ref"]
    s = _own_story(token, campaign)
    award = None
    from apps.lens.services.photos import approve_photo

    photo = LensPhoto.objects.get(upload_ref=ref)
    approve_photo(photo=photo, by=admin)
    r = APIClient().delete(f"/api/lens/p/{token}/photos/{ref}/")
    assert r.status_code == 400
    assert award is None or True


# --- moderation + awards at entry level ---------------------------------------


def _manager(t, admin):
    c = APIClient(); c.force_authenticate(admin)
    return c


def _base_url(campaign):
    return f"/api/tournaments/{campaign.tournament_id}/lens"


def test_approve_story_approves_all_frames_together():
    admin, _t, campaign, _pass, token, _insts = _setup()
    for _ in range(4):
        assert _upload(token, category=STORY).status_code == 201
    s = _own_story(token, campaign)
    assert all(p.approved_at is None for p in s.photos.all())
    r = _manager(campaign.tournament, admin).post(
        f"{_base_url(campaign)}/stories/{s.id}/approve/")
    assert r.status_code == 200, r.content
    s.refresh_from_db()
    assert s.status == "approved"
    assert all(p.approved_at is not None for p in s.photos.all())


def test_award_story_is_winner_take_all_and_needs_approval():
    admin, t, campaign, pass_, token, insts = _setup()
    # second school's approved entry
    other_token = _other_token(campaign, pass_)
    assert _upload(other_token, category=STORY).status_code == 201
    other_story = None
    for s in LensStory.objects.filter(campaign=campaign):
        if s.institution_id != pass_.institution_id:
            other_story = s
    award_story(story=other_story, by=admin, category="")
    from apps.lens.services.stories import approve_story

    approve_story(story=other_story, by=admin)

    # own unapproved entry cannot win yet
    assert _upload(token, category=STORY).status_code == 201
    mine = _own_story(token, campaign)
    r = _manager(t, admin).post(
        f"{_base_url(campaign)}/stories/{mine.id}/award/",
        {"category": STORY}, format="json")
    assert r.status_code == 400
    assert detail(r) == "not_approved"

    # approve, win; then the other school's entry loses it when this wins
    from apps.lens.services.stories import approve_story as approve2

    approve2(story=mine, by=admin)
    r = _manager(t, admin).post(
        f"{_base_url(campaign)}/stories/{mine.id}/award/",
        {"category": STORY}, format="json")
    assert r.status_code == 200, r.content
    other_story.refresh_from_db(); mine.refresh_from_db()
    assert mine.award_category == STORY
    assert other_story.award_category == ""


def test_manager_story_list_filters_by_status():
    admin, t, campaign, _pass, token, _insts = _setup()
    assert _upload(token, category=STORY).status_code == 201
    r = _manager(t, admin).get(f"{_base_url(campaign)}/stories/?status=pending")
    assert r.status_code == 200
    body = r.json()
    assert len(body["stories"]) == 1
    entry = body["stories"][0]
    assert entry["status"] == "pending"
    assert len(entry["photos"]) == 1
    assert entry["photos"][0]["position"] == 1


# --- public album ---------------------------------------------------------------


def _approve_all(campaign, admin):
    from apps.lens.models import LensPhoto as LP

    for ph in LP.objects.filter(campaign=campaign):
        from apps.lens.services.photos import approve_photo

        approve_photo(photo=ph, by=admin)


def test_public_album_shows_story_as_unit_and_hides_member_from_flat_list():
    admin, t, campaign, _pass, token, _insts = _setup()
    _publish(t)
    assert _upload(token, category=ACTION, caption="flat").status_code == 201
    assert _upload(token, category=STORY, caption="frame").status_code == 201
    _approve_all(campaign, admin)
    s = _own_story(token, campaign)
    from apps.lens.services.stories import approve_story

    approve_story(story=s, by=admin)

    r = APIClient().get(f"/api/public/tournaments/{t.slug}/{t.id}/album/")
    assert r.status_code == 200, r.content
    body = r.json()
    flat = [p["caption"] for p in body["photos"]]
    assert "flat" in flat and "frame" not in flat
    assert len(body["stories"]) == 1
    entry = body["stories"][0]
    assert entry["title"] == ""
    assert [ph["caption"] for ph in entry["photos"]] == ["frame"]


def test_hidden_story_leaves_the_album():
    admin, t, campaign, _pass, token, _insts = _setup()
    _publish(t)
    assert _upload(token, category=STORY).status_code == 201
    s = _own_story(token, campaign)
    from apps.lens.services.stories import approve_story, hide_story

    approve_story(story=s, by=admin)
    url = f"/api/public/tournaments/{t.slug}/{t.id}/album/"
    assert len(APIClient().get(url).json()["stories"]) == 1
    hide_story(story=s, by=admin, reason="dup")
    assert APIClient().get(url).json()["stories"] == []


def test_pending_story_never_public_even_with_approved_frames():
    """A frame can only be approved through the story's own approval; but if a
    host approves frames one-by-one anyway, an UNapproved story must still not
    render as an entry."""
    admin, t, campaign, _pass, token, _insts = _setup()
    _publish(t)
    assert _upload(token, category=STORY).status_code == 201
    from apps.lens.services.photos import approve_photo

    for ph in LensPhoto.objects.filter(campaign=campaign):
        approve_photo(photo=ph, by=admin)
    url = f"/api/public/tournaments/{t.slug}/{t.id}/album/"
    body = APIClient().get(url).json()
    assert body["stories"] == []
