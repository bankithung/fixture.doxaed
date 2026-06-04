import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for fixture.doxaed.com SPA E2E smoke tests.
 *
 * Tests run against running dev servers:
 *   - Django backend on http://localhost:8000
 *   - Vite dev server on http://localhost:5174 (falls back to 5173)
 *
 * Session cookies are shared per worker, so we keep workers=1 and disable
 * fully-parallel execution. This is fine for a 7-test smoke suite.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5174",
    trace: "on-first-retry",
    headless: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
