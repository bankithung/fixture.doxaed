import { expect, type Page } from "@playwright/test";

/**
 * Shared E2E helpers for the role-smoke suite.
 *
 * loginAs() walks through the real LoginPage UI rather than calling the API
 * directly — that's the whole point of these tests: we want to catch
 * frontend/backend contract drift on the actual auth flow.
 */

/** Demo accounts seeded by the A4 demo seed agent. */
export const accounts = {
  superAdmin: {
    email: "graceschooledu@gmail.com",
    password: "DoxaEd33@",
  },
  admin: { email: "admin@doxaed.test", password: "Admin123!@" },
  coorganizer: { email: "coorg@doxaed.test", password: "Coorg123!@" },
  coordinator: { email: "coord@doxaed.test", password: "Coord123!@" },
  scorer: { email: "scorer@doxaed.test", password: "Scorer123!@" },
  referee: { email: "referee@doxaed.test", password: "Referee123!@" },
  manager: { email: "manager@doxaed.test", password: "Manager123!@" },
} as const;

/**
 * Visit /login, fill the credential form, submit, and wait for the SPA to
 * navigate away. Throws if the login button never enables, the form
 * surfaces an error, or we never leave /login.
 */
export async function loginAs(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    }),
    page.click('button[type=submit]:has-text("Sign in")'),
  ]);
}

/** Tiny assertion helper; keeps test bodies readable. */
export async function expectVisible(
  page: Page,
  selector: string,
): Promise<void> {
  await expect(page.locator(selector)).toBeVisible();
}
