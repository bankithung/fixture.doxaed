"""Pytest fixtures for sadmin tests."""
from __future__ import annotations

import pytest

from apps.sadmin.tests.factories import SuperAdminFactory, UserFactory


@pytest.fixture
def super_admin(db):
    return SuperAdminFactory(email="sa@example.com")


@pytest.fixture
def regular_user(db):
    return UserFactory(email="user@example.com", is_active=True)


@pytest.fixture
def authed_client_super_admin(client, super_admin):
    client.force_login(super_admin)
    return client


@pytest.fixture
def authed_client_regular(client, regular_user):
    client.force_login(regular_user)
    return client
