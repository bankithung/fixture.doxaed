import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThemeStore } from "../themeStore";

function setMatchMedia(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe("themeStore", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    setMatchMedia(false);
  });

  it("setTheme('dark') adds the dark class and persists", () => {
    useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("fixture.theme")).toBe("dark");
  });

  it("setTheme('light') removes the dark class", () => {
    useThemeStore.getState().setTheme("dark");
    useThemeStore.getState().setTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("fixture.theme")).toBe("light");
  });

  it("system mode follows prefers-color-scheme: dark", () => {
    setMatchMedia(true);
    useThemeStore.getState().setTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
