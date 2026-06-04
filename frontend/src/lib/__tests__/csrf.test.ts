import { describe, expect, it } from "vitest";
import { getCsrfToken } from "../csrf";

function setCookie(value: string): void {
  document.cookie = value;
}
function clearAll(): void {
  document.cookie.split(";").forEach((c) => {
    const eq = c.indexOf("=");
    const name = (eq > -1 ? c.slice(0, eq) : c).trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  });
}

describe("getCsrfToken", () => {
  it("returns null when no csrftoken cookie is present", () => {
    clearAll();
    expect(getCsrfToken()).toBeNull();
  });

  it("returns the token when csrftoken cookie is set", () => {
    clearAll();
    setCookie("csrftoken=abc123");
    expect(getCsrfToken()).toBe("abc123");
  });

  it("isolates csrftoken from other cookies before/after", () => {
    clearAll();
    setCookie("sessionid=foo");
    setCookie("csrftoken=tok-42");
    setCookie("other=bar");
    expect(getCsrfToken()).toBe("tok-42");
  });

  it("decodes URL-encoded cookie values", () => {
    clearAll();
    setCookie("csrftoken=ab%2Bcd%3D");
    expect(getCsrfToken()).toBe("ab+cd=");
  });

  it("returns null when csrftoken is similar but not exact match", () => {
    clearAll();
    setCookie("XCSRFToken=nope");
    setCookie("csrftoken_alt=nope2");
    expect(getCsrfToken()).toBeNull();
  });
});
