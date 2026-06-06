import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBreakpoint } from "../useBreakpoint";

describe("useBreakpoint", () => {
  it("reports width, a breakpoint, and helpers", () => {
    const { result } = renderHook(() => useBreakpoint());
    expect(typeof result.current.width).toBe("number");
    expect(["xs", "sm", "md", "lg", "xl", "2xl"]).toContain(result.current.breakpoint);
    expect(typeof result.current.isMobile).toBe("boolean");
    expect(typeof result.current.isDesktop).toBe("boolean");
    expect(result.current.up("xs")).toBe(true);
  });
});
