import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TeamManagerLandingPage } from "../TeamManagerLandingPage";

describe("TeamManagerLandingPage", () => {
  it("renders hero + an open-tournaments CTA and no coming-soon tiles", () => {
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
      screen.getByRole("link", { name: /open your tournaments/i }),
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId("preview-tile")).toHaveLength(0);
  });
});
