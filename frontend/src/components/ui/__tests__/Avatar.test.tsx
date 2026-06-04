import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Avatar, colourForEmail, initialsFor } from "../Avatar";

describe("Avatar", () => {
  it("renders initials from full name when provided", () => {
    render(<Avatar email="alice@example.com" name="Alice Wonderland" />);
    const avatar = screen.getByTestId("avatar");
    expect(avatar.textContent).toBe("AW");
    expect(avatar.getAttribute("aria-label")).toBe("Alice Wonderland");
  });

  it("falls back to email local-part when no name is given", () => {
    render(<Avatar email="bob@example.com" />);
    const avatar = screen.getByTestId("avatar");
    // local-part "bob" -> first + last char -> "BB"
    expect(avatar.textContent).toBe("BB");
    expect(avatar.getAttribute("aria-label")).toBe("bob@example.com");
  });

  it("disambiguates similar email local-parts (DEFECT-K)", () => {
    // Both used to collapse to "CO" with the legacy first-two-chars rule.
    expect(initialsFor(undefined, "coord@doxaed.test")).toBe("CD");
    expect(initialsFor(undefined, "coorg@doxaed.test")).toBe("CG");
  });

  it("uses a deterministic palette colour per email", () => {
    const a = colourForEmail("alice@example.com");
    const b = colourForEmail("alice@example.com");
    const c = colourForEmail("zelda@example.com");
    expect(a).toBe(b);
    expect(typeof a).toBe("string");
    expect(a.startsWith("hsl(")).toBe(true);
    // not strictly required to differ but extremely likely; assert format only
    expect(c.startsWith("hsl(")).toBe(true);
  });

  it("derives initials with handles separators (._-)", () => {
    expect(initialsFor("john.doe", "j@x")).toBe("JD");
    expect(initialsFor("jane_q_public", "j@x")).toBe("JP");
    expect(initialsFor("solo", "j@x")).toBe("SO");
    expect(initialsFor(undefined, "x@y")).toBe("X");
  });

  it("uses first + last char of single-segment email local-part", () => {
    // Disambiguation rule for similar local-parts.
    expect(initialsFor(undefined, "alex@x")).toBe("AX");
    expect(initialsFor(undefined, "alan@x")).toBe("AN");
  });

  it("treats first-char + last-char of multi-word names as initials", () => {
    expect(initialsFor("Coordinator User", "c@x")).toBe("CU");
    expect(initialsFor("Admin User", "a@x")).toBe("AU");
  });
});
