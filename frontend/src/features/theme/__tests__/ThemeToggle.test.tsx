import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "../ThemeToggle";
import { useThemeStore } from "../themeStore";

describe("ThemeToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    useThemeStore.setState({ theme: "light", resolved: "light" });
  });

  it("has an accessible name and cycles the theme on click", async () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAccessibleName(/theme/i);

    await userEvent.click(btn); // light -> dark
    expect(useThemeStore.getState().theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
