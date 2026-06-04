import { test, expect } from "@playwright/test";
import { accounts, loginAs } from "./fixtures";

/**
 * Role-aware smoke tests — one per demo account.
 *
 * These tests log in via the real UI and assert the user lands somewhere
 * sensible. They exist to catch frontend/backend contract drift (missing
 * endpoints, broken redirects, wrong URL shapes) that vitest unit tests
 * miss because they don't talk to the real backend.
 *
 * Some assertions depend on Wave 2 frontend work (B2 / B5 / B6) that hasn't
 * shipped yet — those checks are guarded with `test.fixme` and a TODO note.
 */

test.describe("role smoke", () => {
  test("Super-admin signs into the /sadmin/ console", async ({ page }) => {
    // The super-admin console is a separate Django+HTMX app at
    // sadmin.fixture.doxaed.com (in dev, served at /sadmin/ on the backend).
    // It does NOT use the SPA login. We test the sadmin login form directly.
    await page.goto("http://localhost:8000/sadmin/login/");
    await page.fill("input[name=email]", accounts.superAdmin.email);
    await page.fill("input[name=password]", accounts.superAdmin.password);
    await page.click("button[type=submit]");
    await expect(page).toHaveURL(/\/sadmin\//);
    await expect(page.getByText(/Dashboard|KPI|Feedback/i).first()).toBeVisible();
  });

  test("Admin lands on org dashboard with Members + Permissions nav", async ({
    page,
  }) => {
    await loginAs(page, accounts.admin.email, accounts.admin.password);
    await expect(page).toHaveURL(/\/o\/doxaed\/dashboard/);
    // AppShell nav exposes Members + Permissions when an org is active.
    await expect(
      page.getByRole("link", { name: /Members/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Permissions/i }).first(),
    ).toBeVisible();
  });

  test("Co-organizer lands on dashboard, sees Members nav", async ({ page }) => {
    await loginAs(page, accounts.coorganizer.email, accounts.coorganizer.password);
    await expect(page).toHaveURL(/\/o\/doxaed\/dashboard/);
    await expect(
      page.getByRole("link", { name: /Members/i }).first(),
    ).toBeVisible();

    // TODO(B5/B6): the spec says co-organizer should NOT see "Permissions",
    // but AppShell currently renders Members + Permissions for everyone with
    // an active org slug. Module-aware nav filtering hasn't shipped yet.
    test.fixme(
      true,
      "Permissions nav should be hidden for co-organizer once module-aware nav lands.",
    );
    await expect(
      page.getByRole("link", { name: /Permissions/i }),
    ).not.toBeVisible();
  });

  test("Game-coordinator lands on dashboard", async ({ page }) => {
    await loginAs(page, accounts.coordinator.email, accounts.coordinator.password);
    await expect(page).toHaveURL(/\/o\/doxaed/);

    // TODO(B5/B6): coord should not see a "Settings" link. Settings UI doesn't
    // exist yet (route placeholder only), so we can't meaningfully assert it.
    test.fixme(
      true,
      "Settings card visibility — Settings page not yet implemented.",
    );
    await expect(
      page.getByRole("link", { name: /Settings/i }),
    ).not.toBeVisible();
  });

  test("Match-scorer lands on a scoring placeholder", async ({ page }) => {
    await loginAs(page, accounts.scorer.email, accounts.scorer.password);
    await expect(page).toHaveURL(/\/o\/doxaed/);

    // TODO(B5): scorer-specific landing copy ("scoring console activates in
    // Phase 1B") hasn't shipped — currently lands on the generic dashboard.
    test.fixme(
      true,
      "Scorer landing copy not yet shipped (Phase 1B placeholder pending).",
    );
    await expect(
      page.getByText(/scoring console activates|Phase 1B/i),
    ).toBeVisible();
  });

  test("Referee lands on a referee placeholder", async ({ page }) => {
    await loginAs(page, accounts.referee.email, accounts.referee.password);
    await expect(page).toHaveURL(/\/o\/doxaed/);

    // TODO(B5): referee placeholder copy not yet shipped.
    test.fixme(
      true,
      "Referee landing copy not yet shipped (Phase 1B placeholder pending).",
    );
    await expect(
      page.getByText(/referee console|Phase 1B/i),
    ).toBeVisible();
  });

  test("Team-manager lands on a team placeholder", async ({ page }) => {
    await loginAs(page, accounts.manager.email, accounts.manager.password);
    await expect(page).toHaveURL(/\/o\/doxaed/);

    // TODO(B5): manager placeholder copy not yet shipped.
    test.fixme(
      true,
      "Manager landing copy not yet shipped (Phase 1B placeholder pending).",
    );
    await expect(
      page.getByText(/team console|Phase 1B/i),
    ).toBeVisible();
  });

  test("Sign out returns to login", async ({ page }) => {
    await loginAs(page, accounts.admin.email, accounts.admin.password);
    await expect(page).toHaveURL(/\/o\/doxaed\/dashboard/);
    await page.click("button:has-text('Sign out')");
    await expect(page).toHaveURL(/\/login/);
  });
});
