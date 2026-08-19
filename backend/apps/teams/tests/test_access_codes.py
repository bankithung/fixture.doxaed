"""Team-registration access codes: minting, reading them back, and the grace
window that makes reading them back safe on a running event.

Owner 2026-08-19: "here it should show the codes for all so that i can see and
copy too". Until now only an Argon2 hash was stored, so nobody — not even the
host — could answer a school phoning to ask what its code was. The code is now
kept a second time as ciphertext, readable only through a manager-gated
endpoint, while the hash stays the one thing verification reads.

The hard part is not the new column, it is the codes that already exist. Those
are hashes, and no design recovers them; the only way to show one is to mint a
new one. So minting keeps the code it replaces working for a week, which means
the host can make every code readable without locking out the school that is
typing the emailed one at that moment.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import check_password, identify_hasher
from django.core.cache import cache
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.forms.models import Form
from apps.teams.models import Institution
from apps.teams.services.access import (
    GRACE_DAYS,
    generate_code,
    issue_team_access_codes,
    read_team_code,
    set_team_code,
    verify_team_code,
)
from apps.tournaments.models import TournamentMembership
from apps.tournaments.services.create import create_tournament

User = get_user_model()
pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _clear_lockouts():
    """Lockout counters are cache-backed and leak between tests."""
    cache.clear()
    yield
    cache.clear()


def _user(email: str):
    u = User.objects.create_user(
        email=email, password="FixtureDemo2026!", is_active=True,
    )
    u.email_verified_at = timezone.now()
    u.save(update_fields=["email_verified_at"])
    return u


def _client(user):
    from rest_framework.test import APIClient

    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _setup(schools=("Grace Academy", "Christ School")):
    """A tournament with an OPEN team form and registered institutions."""
    admin = _user("admin@codes.test")
    t = create_tournament(user=admin, name="Dimapur Cup")
    form = Form.objects.create(
        organization=t.organization, tournament=t, title="Team registration",
        purpose="team_registration", stage="team_registration",
        schema={"sections": []}, status="open", opens_at=timezone.now(),
    )
    insts = [
        Institution.objects.create(
            organization=t.organization, tournament=t, name=name,
            slug=name.lower().replace(" ", "-").replace(".", ""),
            contact_email=f"{name.split()[0].lower()}@school.test",
        )
        for name in schools
    ]
    return admin, t, form, insts


# ------------------------------------------------------- storing the code
def test_a_minted_code_is_readable_back_and_still_hashed_for_auth():
    _admin, _t, _form, (inst, _other) = _setup()
    code = generate_code()
    set_team_code(inst, code)
    inst.refresh_from_db()

    # Verification still reads a slow salted hash, and the plaintext is not in it.
    assert identify_hasher(inst.team_code_hash) is not None
    assert code not in inst.team_code_hash
    assert check_password(code, inst.team_code_hash)
    # The readable copy is ciphertext, not the code sitting in a column.
    assert inst.team_code_enc and code not in inst.team_code_enc
    # And it reads back.
    assert read_team_code(inst) == code


def test_a_code_from_before_this_feature_reads_back_empty_not_wrong():
    """The 14 codes already issued are hashes. "Not readable" is the honest
    answer; inventing one would send a school a code that cannot work."""
    from django.contrib.auth.hashers import make_password

    _admin, _t, _form, (inst, _other) = _setup()
    inst.team_code_hash = make_password("ABCD2345")
    inst.save(update_fields=["team_code_hash"])
    assert read_team_code(inst) == ""
    # It is still a real code — it verifies, it just cannot be displayed.
    assert verify_team_code(inst, "ABCD2345") == (True, None)


# ------------------------------------------------------- the grace window
def test_the_code_a_mint_replaces_keeps_working():
    """This is what makes "show me every code" safe mid-event: the school
    holding the emailed code is not locked out the moment the host reveals."""
    _admin, _t, _form, (inst, _other) = _setup()
    set_team_code(inst, "OLDCODE1")
    set_team_code(inst, "NEWCODE2")
    inst.refresh_from_db()

    assert verify_team_code(inst, "NEWCODE2") == (True, None)
    assert verify_team_code(inst, "OLDCODE1") == (True, None)
    assert inst.team_code_prev_until > timezone.now() + timedelta(
        days=GRACE_DAYS - 1,
    )


def test_the_replaced_code_stops_working_once_the_window_closes():
    _admin, _t, _form, (inst, _other) = _setup()
    set_team_code(inst, "OLDCODE1")
    set_team_code(inst, "NEWCODE2")
    inst.team_code_prev_until = timezone.now() - timedelta(minutes=1)
    inst.save(update_fields=["team_code_prev_until"])

    assert verify_team_code(inst, "NEWCODE2") == (True, None)
    assert verify_team_code(inst, "OLDCODE1") == (False, "invalid_code")


def test_only_the_immediately_previous_code_is_graced():
    """Grace is one deep. Two mints in a row must not leave three live codes."""
    _admin, _t, _form, (inst, _other) = _setup()
    set_team_code(inst, "FIRSTAAA")
    set_team_code(inst, "SECONDBB")
    set_team_code(inst, "THIRDCCC")

    assert verify_team_code(inst, "THIRDCCC") == (True, None)
    assert verify_team_code(inst, "SECONDBB") == (True, None)
    assert verify_team_code(inst, "FIRSTAAA") == (False, "invalid_code")


def test_minting_clears_a_lockout_earned_on_the_old_code():
    """A school that mistyped its way into a lockout must be able to use the
    new code straight away. The lens pass flow already did this; we did not."""
    _admin, _t, _form, (inst, _other) = _setup()
    set_team_code(inst, "OLDCODE1", grace_days=0)
    for _ in range(5):
        verify_team_code(inst, "WRONGXXX")
    assert verify_team_code(inst, "OLDCODE1") == (False, "locked")

    set_team_code(inst, "NEWCODE2")
    assert verify_team_code(inst, "NEWCODE2") == (True, None)


# ------------------------------------------------------------ the endpoint
def test_a_manager_reads_every_code(mailoutbox):
    admin, t, form, _insts = _setup()
    issue_team_access_codes(tournament=t, form=form, actor=admin)
    res = _client(admin).get(f"/api/tournaments/{t.id}/team-codes/")

    assert res.status_code == 200, res.content
    rows = res.json()["codes"]
    assert len(rows) == 2
    assert all(r["readable"] and len(r["code"]) == 8 for r in rows)
    # Every code shown is the code that actually works.
    for row in rows:
        inst = Institution.objects.get(id=row["institution_id"])
        assert verify_team_code(inst, row["code"]) == (True, None)
    # And it matches what the school was emailed.
    assert len(mailoutbox) == 2
    bodies = " ".join(m.body for m in mailoutbox)
    assert all(r["code"] in bodies for r in rows)
    # Live credentials must not be cached anywhere on the way to the browser.
    assert "no-store" in res["Cache-Control"]


def test_a_code_that_predates_the_feature_is_reported_unreadable_not_absent():
    from django.contrib.auth.hashers import make_password

    admin, t, _form, (inst, _other) = _setup()
    inst.team_code_hash = make_password("ABCD2345")
    inst.save(update_fields=["team_code_hash"])
    row = next(
        r for r in _client(admin).get(
            f"/api/tournaments/{t.id}/team-codes/"
        ).json()["codes"]
        if r["institution_id"] == str(inst.id)
    )
    assert row["has_code"] is True
    assert row["readable"] is False
    assert row["code"] == ""


def test_reveal_mints_readable_codes_without_emailing_anyone(mailoutbox):
    """The host is about to read these out. A second email would tell a school
    its code changed when the one it holds still works."""
    from django.contrib.auth.hashers import make_password

    admin, t, _form, insts = _setup()
    for inst in insts:
        inst.team_code_hash = make_password("ABCD2345")
        inst.save(update_fields=["team_code_hash"])

    res = _client(admin).post(
        f"/api/tournaments/{t.id}/team-codes/", {"reveal": True}, format="json",
    )
    assert res.status_code == 200, res.content
    assert res.json()["minted"] == 2
    assert mailoutbox == []

    rows = _client(admin).get(f"/api/tournaments/{t.id}/team-codes/").json()["codes"]
    assert all(r["readable"] for r in rows)
    # The code each school already has keeps working through the grace window.
    for inst in insts:
        inst.refresh_from_db()
        assert verify_team_code(inst, "ABCD2345") == (True, None)
        assert rows[0]["grace_until"] is not None


def test_revealing_twice_does_not_churn_a_code_that_is_already_readable():
    admin, t, form, _insts = _setup()
    issue_team_access_codes(tournament=t, form=form, actor=admin)
    before = {
        r["institution_id"]: r["code"]
        for r in _client(admin).get(
            f"/api/tournaments/{t.id}/team-codes/"
        ).json()["codes"]
    }
    res = _client(admin).post(
        f"/api/tournaments/{t.id}/team-codes/", {"reveal": True}, format="json",
    )
    assert res.json()["minted"] == 0 and res.json()["skipped"] == 2
    after = {
        r["institution_id"]: r["code"]
        for r in _client(admin).get(
            f"/api/tournaments/{t.id}/team-codes/"
        ).json()["codes"]
    }
    assert after == before


def test_reveal_reaches_a_school_with_no_contact_email():
    """The school most likely to need a code read out over the phone is the one
    with no email on file. The mailing path skips it; revealing must not."""
    admin, t, _form, (inst, _other) = _setup()
    inst.contact_email = ""
    inst.save(update_fields=["contact_email"])
    _client(admin).post(
        f"/api/tournaments/{t.id}/team-codes/", {"reveal": True}, format="json",
    )
    inst.refresh_from_db()
    assert read_team_code(inst) != ""


# ------------------------------------------------------------- the gates
def test_the_code_list_is_manager_only_and_leaks_no_existence():
    admin, t, form, _insts = _setup()
    issue_team_access_codes(tournament=t, form=form, actor=admin)
    url = f"/api/tournaments/{t.id}/team-codes/"

    # A member of this tournament who is not a manager: 403, never the codes.
    scorer = _user("scorer@codes.test")
    TournamentMembership.objects.create(
        user=scorer, tournament=t, role="match_scorer", status="active",
    )
    assert _client(scorer).get(url).status_code == 403

    # Someone with no access at all: 404, no hint the tournament exists.
    assert _client(_user("outsider@codes.test")).get(url).status_code == 404

    # Anonymous.
    from rest_framework.test import APIClient

    assert APIClient().get(url).status_code in (401, 403)


def test_the_institutions_list_still_shows_only_whether_a_code_exists():
    """That endpoint is readable by any tournament member, so a code must never
    ride along on it."""
    admin, t, form, _insts = _setup()
    issue_team_access_codes(tournament=t, form=form, actor=admin)
    res = _client(admin).get(f"/api/tournaments/{t.id}/institutions/")
    body = res.content.decode()

    assert res.status_code == 200
    assert '"has_team_code":true' in body.replace(" ", "")
    for inst in Institution.objects.filter(tournament=t):
        code = read_team_code(inst)
        assert code and code not in body


def test_viewing_the_codes_is_audited_without_recording_one():
    """Audit rows are append-only at the DB level, so a code written there
    could never be redacted."""
    admin, t, form, _insts = _setup()
    issue_team_access_codes(tournament=t, form=form, actor=admin)
    _client(admin).get(f"/api/tournaments/{t.id}/team-codes/")

    row = AuditEvent.objects.filter(
        event_type="team_access_codes_viewed", target_id=t.id,
    ).first()
    assert row is not None
    assert row.payload_after["institutions"] == 2
    for inst in Institution.objects.filter(tournament=t):
        assert read_team_code(inst) not in str(row.payload_after)


def test_a_code_read_off_the_screen_opens_the_public_form():
    """The round trip that matters: what the host reads out is what the school
    types into the public page."""
    admin, t, form, _insts = _setup()
    issue_team_access_codes(tournament=t, form=form, actor=admin)
    row = _client(admin).get(
        f"/api/tournaments/{t.id}/team-codes/"
    ).json()["codes"][0]

    from rest_framework.test import APIClient

    res = APIClient().post(
        f"/api/forms/{form.id}/team-access/",
        {"institution_id": row["institution_id"], "code": row["code"],
         "event_id": str(uuid.uuid4())},
        format="json",
    )
    assert res.status_code == 200, res.content
    assert res.json().get("access_token")
