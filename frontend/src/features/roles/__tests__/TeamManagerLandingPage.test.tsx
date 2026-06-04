import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TeamManagerLandingPage } from "../TeamManagerLandingPage";

describe("TeamManagerLandingPage", () => {
  it("renders hero copy and 4 team-manager preview tiles", () => {
    render(
      <MemoryRouter initialEntries={["/o/acme/team"]}>
        <Routes>
          <Route path="/o/:orgSlug/team" element={<TeamManagerLandingPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: /welcome, team manager/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/team console activates in phase 1b/i),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("preview-tile")).toHaveLength(4);
    expect(screen.getByText(/roster management/i)).toBeInTheDocument();
    expect(screen.getByText(/player registration/i)).toBeInTheDocument();
    expect(screen.getByText(/lineup submission/i)).toBeInTheDocument();
    expect(screen.getByText(/suspension tracking/i)).toBeInTheDocument();
  });
});
