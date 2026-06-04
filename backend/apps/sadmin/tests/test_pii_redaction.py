"""PII redaction tests (v1Users.md B.11)."""
from __future__ import annotations

import pytest

from apps.sadmin.services.feedback import redact_body, redact_email
from apps.sadmin.tests.factories import SuperAdminFactory, UserFactory


@pytest.mark.django_db
def test_redact_email_for_non_superuser():
    u = UserFactory()
    assert redact_email("alice@example.com", u) == "a***@example.com"


@pytest.mark.django_db
def test_redact_email_for_superuser_passes_through():
    sa = SuperAdminFactory()
    assert redact_email("alice@example.com", sa) == "alice@example.com"


def test_redact_email_handles_none_and_empty():
    assert redact_email(None, None) == ""
    assert redact_email("", None) == ""


def test_redact_body_strips_emails():
    body = "Email me at hello@example.com please"
    out = redact_body(body)
    assert "hello@example.com" not in out
    assert "[REDACTED]" in out


def test_redact_body_strips_password_marker():
    out = redact_body("password=hunter2 is leaked")
    assert "hunter2" not in out
    assert "[REDACTED]" in out


def test_redact_body_strips_long_hex_token():
    body = "token=" + "a" * 64
    out = redact_body(body)
    # 32+ hex chars are redacted
    assert "a" * 64 not in out
