# Phase 1A demo credentials

Reference card for the demo accounts seeded by `scripts/seed_full_demo.py`
into the `doxaed` Organization. Re-run the seed at any time to reset
passwords / repair membership drift. From the `backend/` directory with
the venv activated:

```
python manage.py shell < scripts/seed_full_demo.py
```

All non-Super-admin demo accounts have:

- `is_active=True`
- `email_verified_at` set
- `last_active_org_id` pinned to `doxaed` (so the SPA bootstrap routes
  straight into the org dashboard after login)
- Exactly one active membership in `doxaed` matching the role below
- 2FA **not** enrolled (skipped for ease of testing; production would
  mandate it for the admin role)

## Accounts

| Role | Email | Password | Lands on | What they can test today |
|---|---|---|---|---|
| Super-admin | graceschooledu@gmail.com | DoxaEd33@ | `/sadmin/` | Custom Super-admin console — orgs, users, feedback, audit log, KPIs, all 13 SA verbs. Cross-org; no SPA membership. |
| Admin (org owner) | admin@doxaed.test | Admin123!@ | SPA `/orgs/doxaed/` | Full org settings, member directory, invite users, transfer ownership, module override matrix, audit log read. |
| Co-organizer | coorg@doxaed.test | Coorg123!@ | SPA `/orgs/doxaed/` | Member directory, audit log; **cannot** suspend/archive org or transfer ownership. |
| Game-coordinator | coord@doxaed.test | Coord123!@ | SPA `/orgs/doxaed/` | Member directory (read), audit log (own actions). Tournament tools land in Phase 1B. |
| Match-scorer | scorer@doxaed.test | Scorer123!@ | SPA `/orgs/doxaed/` | Placeholder dashboard. Live-scoring console activates in Phase 1B. |
| Referee | referee@doxaed.test | Referee123!@ | SPA `/orgs/doxaed/` | Placeholder dashboard. Referee console + match approvals activate in Phase 1B. |
| Team-manager | manager@doxaed.test | Manager123!@ | SPA `/orgs/doxaed/` | Placeholder dashboard. Team / player roster management activates in Phase 1B. |

## Login flow (SPA)

1. Any `GET` to a Django endpoint will set the `csrftoken` cookie.
2. `POST /api/accounts/auth/login/` with `{email, password}` and the
   `X-CSRFToken` header echoing the cookie.
3. `GET /api/accounts/me/` returns a shape including `is_superuser`,
   `memberships[]`, and `last_active_org_slug` so the SPA can route
   directly without a second round-trip.

## Org

| Field | Value |
|---|---|
| slug | `doxaed` |
| id | `019dea0c-8825-7101-b78a-5e84dc12fd64` |
| name | DoxaEd Sports |
| status | active |
| time_zone | Asia/Kolkata |
