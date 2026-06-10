"""Public access tokens for a form (generalizes ``teams.RegistrationLink``).

A share link is a sha256-hashed, opaque token granting public submission access
to a single form, optionally bound to a prefilled entity, with an expiry and a
submission cap. Mirrors ``apps/teams/services/registration.py``'s token pattern:
only the hash is stored, the plaintext is returned once at creation time.
"""
from __future__ import annotations

import hashlib
import secrets

from django.utils import timezone

from apps.forms.models import Form, FormShareLink


def _hash(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def create_share_link(
    *, form: Form, created_by=None, label: str = "", expires_at=None,
    max_submissions=None, bound_entity=None, prefill=None,
):
    """Create a shareable link for ``form``. Returns ``(link, plaintext_token)``."""
    token = secrets.token_urlsafe(24)
    link = FormShareLink.objects.create(
        organization=form.organization,
        form=form,
        token_hash=_hash(token),
        label=(label or "")[:120],
        expires_at=expires_at,
        max_submissions=max_submissions,
        bound_entity=bound_entity or {},
        prefill=prefill or {},
        created_by=created_by,
    )
    return link, token


def institution_prefill(form, inst) -> tuple[dict, str]:
    """Prefill map + display label for an institution, keyed by THIS form's own
    binding field keys (``form.settings['bindings']``) — never hardcoded names.
    Forms are admin-built and never identical, so we only prefill the roles the
    form actually declares a binding for; unmapped roles are silently skipped."""
    bindings = (form.settings or {}).get("bindings", {})
    pf: dict = {bindings.get("institution_id", "institution_id"): str(inst.id)}
    for role, attr in (
        ("contact_name", "contact_name"),
        ("contact_email", "contact_email"),
        ("contact_phone", "contact_phone"),
    ):
        key = bindings.get(role)
        val = getattr(inst, attr, None)
        if key and val:
            pf[key] = val
    return pf, inst.name


def mint_institution_links(*, form, created_by=None):
    """Mint a bound, prefilled share link per eligible institution of the team
    form's tournament. Eligible = every registered institution (excludes
    withdrawn/rejected). Idempotent: an institution that already has an active
    bound link on this form is skipped, so re-running only mints for newcomers.
    Returns ``[{institution_id, name, minted, token?}]`` — the plaintext token is
    present ONLY for links minted in this call (tokens are hashed at rest)."""
    from apps.teams.models import Institution

    insts = (
        Institution.objects.filter(tournament=form.tournament, deleted_at__isnull=True)
        .exclude(status__in=["withdrawn", "rejected"])
        .order_by("name")
    )
    already_bound = {
        (link.bound_entity or {}).get("institution_id")
        for link in FormShareLink.objects.filter(form=form, is_active=True)
    }
    out: list[dict] = []
    for inst in insts:
        iid = str(inst.id)
        if iid in already_bound:
            out.append({"institution_id": iid, "name": inst.name, "minted": False})
            continue
        prefill, label = institution_prefill(form, inst)
        _link, token = create_share_link(
            form=form, created_by=created_by, label=label,
            bound_entity={"institution_id": iid}, prefill=prefill,
        )
        out.append(
            {"institution_id": iid, "name": inst.name, "minted": True, "token": token}
        )
    return out


def resolve_share_link(token_plaintext: str):
    """Resolve an active, non-expired, under-cap link by plaintext token, or None."""
    if not token_plaintext:
        return None
    link = (
        FormShareLink.objects.filter(
            token_hash=_hash(token_plaintext),
            is_active=True,
            form__deleted_at__isnull=True,
        )
        .select_related("form", "form__tournament", "form__organization")
        .first()
    )
    if link is None:
        return None
    if link.expires_at is not None and link.expires_at <= timezone.now():
        return None
    if (
        link.max_submissions is not None
        and link.submission_count >= link.max_submissions
    ):
        return None
    return link
