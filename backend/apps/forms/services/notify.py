"""Registrant-facing lifecycle emails for form submissions (H6).

The no-account school previously got exactly ONE email ever (its access
code): no submission receipt, no accept/reject notice (finding N6). These
helpers resolve the school's contact address (promoted respondent_email,
else the selected institution's contact) and send branded, audited emails.
All senders are called from ``transaction.on_commit`` — best-effort, never
raising into the write path.
"""
from __future__ import annotations

import logging

from django.conf import settings as django_settings

logger = logging.getLogger(__name__)


def _base_url() -> str:
    return getattr(django_settings, "PUBLIC_BASE_URL", "https://fixture.doxaed.com")


def resolve_contact(form, resp) -> tuple[str, str]:
    """(email, display_name) for the school behind a response. The promoted
    respondent_email wins (stage-1 forms collect it directly); the team form
    identifies the school by the bound institution picker instead."""
    email = (resp.respondent_email or "").strip()
    name = resp.respondent_name or resp.title or ""
    bindings = (form.settings or {}).get("bindings") or {}
    inst_key = bindings.get("institution_id")
    inst_id = (resp.answers or {}).get(inst_key) if inst_key else None
    if inst_id:
        from apps.teams.models import Institution

        inst = Institution.objects.filter(
            id=inst_id, tournament=form.tournament, deleted_at__isnull=True
        ).first()
        if inst is not None:
            name = inst.name or name
            if not email:
                email = (inst.contact_email or "").strip()
    return email, name


def _team_lines(form, resp) -> list[str]:
    """Human summary of what was submitted, per competition group."""
    lines: list[str] = []
    bindings = (form.settings or {}).get("bindings") or {}
    for cg in bindings.get("category_groups") or []:
        rows = (resp.answers or {}).get(cg.get("group")) or []
        if isinstance(rows, list) and rows:
            label = cg.get("label") or cg.get("category") or "Teams"
            n = len(rows)
            lines.append(f"{label}: {n} team{'s' if n != 1 else ''}")
    return lines


def send_submission_receipt(form, resp) -> bool:
    from apps.notifications.services.mailer import send_school_email

    email, name = resolve_contact(form, resp)
    if not email:
        return False
    tournament = form.tournament
    return send_school_email(
        kind="submission_receipt",
        to=email,
        subject=f"Registration received · {tournament.name}",
        template="team_submission_receipt",
        context={
            "school_name": name,
            "tournament_name": tournament.name,
            "form_title": form.title,
            "reference": str(resp.id)[:8].upper(),
            "team_lines": _team_lines(form, resp),
            "form_url": f"{_base_url()}/f/{form.id}",
            "schedule_url": (
                f"{_base_url()}/t/{tournament.slug}/{tournament.id}/schedule"
                if tournament.slug else ""
            ),
        },
        target_type="form_response",
        target_id=resp.id,
        organization_id=form.organization_id,
        tournament_id=form.tournament_id,
    )


def send_status_notice(form, resp) -> bool:
    from apps.notifications.services.mailer import send_school_email

    email, name = resolve_contact(form, resp)
    if not email:
        return False
    tournament = form.tournament
    return send_school_email(
        kind="registration_status",
        to=email,
        subject=f"Registration {resp.status} · {tournament.name}",
        template="registration_status",
        context={
            "school_name": name,
            "tournament_name": tournament.name,
            "form_title": form.title,
            "status": resp.status,
            "reference": str(resp.id)[:8].upper(),
            "form_url": f"{_base_url()}/f/{form.id}",
        },
        target_type="form_response",
        target_id=resp.id,
        organization_id=form.organization_id,
        tournament_id=form.tournament_id,
    )
