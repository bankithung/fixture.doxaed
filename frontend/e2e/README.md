# E2E smoke tests

Playwright suite that logs in via the real SPA UI and walks each demo role
through their landing flow. The goal is to catch frontend/backend contract
drift (missing endpoints, broken redirects, wrong URL shapes) that the
vitest unit tests cannot, because vitest never talks to the real backend.

## Prerequisites

1. **Backend running** at `http://localhost:8000`
   ```pwsh
   cd ..\..\backend
   python manage.py runserver 8000
   ```
2. **Frontend dev server running** at `http://localhost:5174`
   (or `5173` — adjust `playwright.config.ts` `baseURL` if so)
   ```pwsh
   cd ..
   npm run dev
   ```
3. **Demo seed has been run** — the A4 demo seed agent populates the seven
   accounts in the table below. Verify by hitting
   `GET http://localhost:8000/api/accounts/me/` after logging in as one of
   them; you should see `memberships[]` populated.

## How to run

```pwsh
cd C:\Users\Asus\Desktop\fixture.doxaed.com\frontend
npm run test:e2e            # headless (CI-style)
npm run test:e2e:headed     # watch the browser drive itself
```

The HTML report is written to `playwright-report/`; open
`playwright-report/index.html` in a browser to see traces of failed runs.

## Demo accounts

| Role             | Email                       | Password    |
| ---------------- | --------------------------- | ----------- |
| Super-admin      | graceschooledu@gmail.com    | DoxaEd33@   |
| Admin (owner)    | admin@doxaed.test           | Admin123!@  |
| Co-organizer     | coorg@doxaed.test           | Coorg123!@  |
| Game-coordinator | coord@doxaed.test           | Coord123!@  |
| Match-scorer     | scorer@doxaed.test          | Scorer123!@ |
| Referee          | referee@doxaed.test         | Referee123!@|
| Team-manager     | manager@doxaed.test         | Manager123!@|

## Layout

```
e2e/
├── fixtures.ts          # loginAs() + accounts table + assertion helpers
├── role-smoke.spec.ts   # 7 role-aware smoke tests + sign-out test
└── README.md
```

## Adding new tests

1. Add the file as `e2e/<feature>.spec.ts`.
2. Import helpers from `./fixtures` rather than re-implementing login.
3. Prefer `page.getByRole(...)` / `page.getByText(...)` over CSS selectors;
   they're robust against Tailwind class churn.
4. If a test depends on an unshipped feature, wrap it with
   `test.fixme(true, "TODO(<wave>): explain why")` so the suite stays green
   while documenting the deferral.

## Known deferrals

Several role-smoke assertions are currently `test.fixme`'d because they
depend on Wave 2 frontend work that hasn't merged yet:

- **Co-organizer hides Permissions nav** — module-aware nav filtering (B6).
- **Game-coordinator hides Settings card** — Settings page not yet built.
- **Scorer / Referee / Team-manager placeholders** — role-aware landing
  copy ("Phase 1B / coming soon") hasn't shipped (B5).

Remove the `test.fixme(...)` line when the relevant page lands.
