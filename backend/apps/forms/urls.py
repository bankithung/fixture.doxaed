from __future__ import annotations

from django.urls import path

from apps.forms.views import (
    FieldTypesView,
    FormCloseView,
    FormDetailView,
    FormDuplicateView,
    FormPublishView,
)

# Mounted at /api/forms/
urlpatterns = [
    path("field-types/", FieldTypesView.as_view(), name="form-field-types"),
    path("<uuid:form_id>/", FormDetailView.as_view(), name="form-detail"),
    path("<uuid:form_id>:publish/", FormPublishView.as_view(), name="form-publish"),
    path("<uuid:form_id>:close/", FormCloseView.as_view(), name="form-close"),
    path("<uuid:form_id>:duplicate/", FormDuplicateView.as_view(), name="form-duplicate"),
]
