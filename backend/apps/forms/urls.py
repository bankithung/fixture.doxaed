from __future__ import annotations

from django.urls import path

from apps.forms.views import (
    CopyableFormsView,
    FieldTypesView,
    FormCloseView,
    FormCopyFromView,
    FormDetailView,
    FormDuplicateView,
    FormPublishView,
    FormResponseDetailView,
    FormResponsesView,
    FormSendStage2View,
    InstitutionLinksView,
    PublicFormView,
    PublicInstitutionDirectoryView,
    PublicUploadView,
)

# Mounted at /api/forms/
urlpatterns = [
    path("field-types/", FieldTypesView.as_view(), name="form-field-types"),
    path("copyable/", CopyableFormsView.as_view(), name="form-copyable"),
    # Public submission API (AllowAny, throttled).
    path("r/<str:token>/", PublicFormView.as_view(), name="form-public-token"),
    path("<uuid:form_id>/public/", PublicFormView.as_view(), name="form-public"),
    path("<uuid:form_id>/directory/", PublicInstitutionDirectoryView.as_view(),
         name="form-directory"),
    path("<uuid:form_id>/uploads/", PublicUploadView.as_view(), name="form-upload"),
    # Responses API (organizer-only).
    path("<uuid:form_id>/responses/", FormResponsesView.as_view(), name="form-responses"),
    path("<uuid:form_id>/responses/<uuid:response_id>/",
         FormResponseDetailView.as_view(), name="form-response-detail"),
    path("<uuid:form_id>:send-stage2/", FormSendStage2View.as_view(), name="form-send-stage2"),
    path("<uuid:form_id>:institution-links/", InstitutionLinksView.as_view(),
         name="form-institution-links"),
    # Builder API (organizer-only).
    path("<uuid:form_id>/", FormDetailView.as_view(), name="form-detail"),
    path("<uuid:form_id>:publish/", FormPublishView.as_view(), name="form-publish"),
    path("<uuid:form_id>:close/", FormCloseView.as_view(), name="form-close"),
    path("<uuid:form_id>:duplicate/", FormDuplicateView.as_view(), name="form-duplicate"),
    path("<uuid:form_id>:copy-from/", FormCopyFromView.as_view(), name="form-copy-from"),
]
