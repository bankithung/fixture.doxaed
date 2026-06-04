import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Wipe cookies between tests so CSRF reads stay deterministic.
  if (typeof document !== "undefined") {
    document.cookie.split(";").forEach((c) => {
      const eq = c.indexOf("=");
      const name = (eq > -1 ? c.slice(0, eq) : c).trim();
      if (name) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      }
    });
  }
});

beforeEach(() => {
  // jsdom does not implement crypto.randomUUID before some versions;
  // pin it for deterministic test IDs.
  if (typeof crypto !== "undefined" && !("randomUUID" in crypto)) {
    Object.defineProperty(crypto, "randomUUID", {
      value: () => "00000000-0000-0000-0000-000000000000",
      configurable: true,
    });
  }
});
