"""Public Guest Lens routes (AllowAny) — mounted at ``/api/lens/`` from the
root urlconf. The manager tree lives in ``apps/tournaments/urls.py``; the
public album route sits next to the badges public routes in ``fixture/urls.py``.
"""
from __future__ import annotations

from django.urls import path

from apps.lens.views import (
    LensJoinView,
    LensJudgeDetailView,
    LensJudgePanelView,
    LensJudgeScoreView,
    LensJudgesView,
    LensJudgingResultsView,
    LensPassContextView,
    LensPassPhotoDetailView,
    LensPassPhotosView,
    LensPassStoryOrderView,
    LensPassStoryTitleView,
)

urlpatterns = [
    path("join/<str:token>/", LensJoinView.as_view(), name="lens-join"),
    # The judging panel: one signed link per judge, no sign-up.
    path("j/<str:token>/", LensJudgePanelView.as_view(), name="lens-judge-panel"),
    path(
        "j/<str:token>/scores/",
        LensJudgeScoreView.as_view(),
        name="lens-judge-score",
    ),
    # Manager tree for the panel itself.
    path(
        "campaigns/<uuid:campaign_id>/judges/",
        LensJudgesView.as_view(),
        name="lens-judges",
    ),
    path(
        "campaigns/<uuid:campaign_id>/judges/<uuid:judge_id>/",
        LensJudgeDetailView.as_view(),
        name="lens-judge-detail",
    ),
    path(
        "campaigns/<uuid:campaign_id>/judging/",
        LensJudgingResultsView.as_view(),
        name="lens-judging-results",
    ),
    path("p/<str:token>/", LensPassContextView.as_view(), name="lens-pass-context"),
    path(
        "p/<str:token>/photos/",
        LensPassPhotosView.as_view(),
        name="lens-pass-photos",
    ),
    path(
        "p/<str:token>/photos/<uuid:upload_ref>/",
        LensPassPhotoDetailView.as_view(),
        name="lens-pass-photo-detail",
    ),
    path(
        "p/<str:token>/stories/<uuid:story_id>/title/",
        LensPassStoryTitleView.as_view(),
        name="lens-pass-story-title",
    ),
    path(
        "p/<str:token>/stories/<uuid:story_id>/order/",
        LensPassStoryOrderView.as_view(),
        name="lens-pass-story-order",
    ),
]
