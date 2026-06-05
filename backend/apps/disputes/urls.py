from __future__ import annotations

from django.urls import path

from apps.disputes.views import (
    RejectDisputeView,
    ResolveDisputeView,
    WithdrawDisputeView,
)

# Mounted at /api/disputes/
urlpatterns = [
    path("<uuid:dispute_id>/resolve/", ResolveDisputeView.as_view(), name="dispute-resolve"),
    path("<uuid:dispute_id>/reject/", RejectDisputeView.as_view(), name="dispute-reject"),
    path("<uuid:dispute_id>/withdraw/", WithdrawDisputeView.as_view(), name="dispute-withdraw"),
]
