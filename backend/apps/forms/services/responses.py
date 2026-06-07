"""Idempotent form submission.

``submit_response`` validates answers against the form schema (branching-aware,
via ``validate_answers``), promotes role-tagged answers onto indexed columns
(email/phone/name/title), claims any pre-uploaded files, bumps the form's
``response_count`` (and the share-link's ``submission_count``), and audits — all
atomically. Replays on a client ``event_id`` return the existing row (invariant
#3) rather than creating a duplicate.
"""
from __future__ import annotations

from django.db import transaction
from django.db.models import F

from apps.audit.models import ActorRole
from apps.forms.constants import ResponseStatus
from apps.forms.models import Form, FormFileUpload, FormResponse
from apps.forms.services.validation import promote, validate_answers


def submit_response(
    *, form: Form, answers: dict, event_id=None, share_link=None,
    upload_refs=None, request=None,
) -> FormResponse:
    """Create (or replay) a FormResponse for ``form``.

    ``answers`` is the raw submission; ``upload_refs`` maps a field key to an
    ``upload_ref`` UUID returned by the upload endpoint. Raises ``AnswerError``
    (subclass of ValueError) on invalid input — the caller maps it to a 400.
    """
    if event_id is not None:
        prior = FormResponse.objects.filter(form=form, event_id=event_id).first()
        if prior is not None:
            return prior

    clean = validate_answers(form.schema, answers)  # raises AnswerError on invalid
    roles = promote(form.schema, clean)

    with transaction.atomic():
        resp = FormResponse.objects.create(
            form=form,
            organization=form.organization,
            tournament=form.tournament,
            answers=clean,
            form_version=form.version,
            respondent_email=roles.get("email", "")[:254],
            respondent_phone=roles.get("phone", "")[:32],
            respondent_name=roles.get("name", "")[:200],
            title=roles.get("title", "")[:200],
            status=ResponseStatus.SUBMITTED,
            event_id=event_id,
            submitted_via=share_link,
        )
        if upload_refs:
            FormFileUpload.objects.filter(
                form=form,
                upload_ref__in=list(upload_refs.values()),
                response__isnull=True,
            ).update(response=resp)
        Form.objects.filter(pk=form.pk).update(response_count=F("response_count") + 1)
        if share_link is not None:
            type(share_link).objects.filter(pk=share_link.pk).update(
                submission_count=F("submission_count") + 1
            )
        # Import locally to emit inside the atomic block (audit shares the txn).
        from apps.audit.services import emit_audit

        emit_audit(
            actor_user=None,
            actor_role=ActorRole.SYSTEM,
            event_type="form_response_submitted",
            target_type="form",
            target_id=form.id,
            organization_id=form.organization_id,
            idempotency_key=event_id,
            payload_after={"title": resp.title},
            request=request,
        )
    return resp
