import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoleBadge, ROLE_KEYS } from "../RoleBadge";

describe("RoleBadge", () => {
  it("renders each known role with its label", () => {
    for (const r of ROLE_KEYS) {
      const { unmount } = render(<RoleBadge role={r} />);
      const el = screen.getByTestId(`role-badge-${r}`);
      expect(el.getAttribute("data-role")).toBe(r);
      expect(el.getAttribute("data-owner")).toBe("false");
      expect(el.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      unmount();
    }
  });

  it("applies the gold owner treatment when role=owner", () => {
    render(<RoleBadge role="owner" />);
    const el = screen.getByTestId("role-badge-owner");
    expect(el.getAttribute("data-owner")).toBe("true");
    // amber ring class is the canonical owner palette marker
    expect(el.className).toMatch(/ring-amber-400/);
  });

  it("applies the owner treatment when isOwner is forced", () => {
    render(<RoleBadge role="admin" isOwner />);
    const el = screen.getByTestId("role-badge-admin");
    expect(el.getAttribute("data-owner")).toBe("true");
    expect(el.className).toMatch(/ring-amber-400/);
  });

  it("falls back to a neutral chip with prettified label for unknown roles", () => {
    render(<RoleBadge role="future_role" />);
    const el = screen.getByTestId("role-badge-future_role");
    expect(el.textContent).toContain("Future Role");
  });

  it("uses distinct base palette per known role", () => {
    const { rerender } = render(<RoleBadge role="admin" />);
    const adminClasses = screen.getByTestId("role-badge-admin").className;
    rerender(<RoleBadge role="referee" />);
    const refereeClasses = screen.getByTestId("role-badge-referee").className;
    expect(adminClasses).not.toBe(refereeClasses);
    // Tokens only (owner rule): semantic ramps, no Tailwind palette.
    expect(adminClasses).toMatch(/primary/);
    expect(refereeClasses).toMatch(/destructive/);
  });
});
