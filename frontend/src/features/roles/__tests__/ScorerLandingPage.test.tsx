import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ScorerLandingPage } from "../ScorerLandingPage";

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/o/:orgSlug/scoring" element={<ScorerLandingPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ScorerLandingPage", () => {
  it("renders hero copy and Phase 1B preview tiles", () => {
    renderAt("/o/acme/scoring");
    expect(
      screen.getByRole("heading", { level: 1, name: /welcome, match scorer/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/scoring console activates/i),
    ).toBeInTheDocument();
    // 4 preview tiles per spec.
    const tiles = screen.getAllByTestId("preview-tile");
    expect(tiles).toHaveLength(4);
    expect(screen.getByText(/live scorebox/i)).toBeInTheDocument();
    expect(screen.getByText(/set-piece logger/i)).toBeInTheDocument();
    expect(screen.getByText(/substitution tracker/i)).toBeInTheDocument();
    expect(screen.getByText(/timeline export/i)).toBeInTheDocument();
  });

  it("links the today-actions to /me, /me/notifications, and surfaces feedback", () => {
    renderAt("/o/acme/scoring");
    expect(
      screen.getByRole("link", { name: /view profile/i }),
    ).toHaveAttribute("href", "/me");
    expect(
      screen.getByRole("link", { name: /update notification preferences/i }),
    ).toHaveAttribute("href", "/me/notifications");
    // ScorerLandingPage doesn't pass `onSendFeedback`, so the shell renders
    // a Link to the dashboard with `?feedback=1` (the dashboard auto-opens
    // the feedback modal). Replaces the previous always-disabled <button>.
    expect(
      screen.getByRole("link", { name: /send feedback/i }),
    ).toHaveAttribute("href", "/o/acme/dashboard?feedback=1");
  });
});
