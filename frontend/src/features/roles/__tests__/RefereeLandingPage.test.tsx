import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RefereeLandingPage } from "../RefereeLandingPage";

describe("RefereeLandingPage", () => {
  it("renders hero + an open-tournaments CTA and no coming-soon tiles", () => {
    render(
      <MemoryRouter initialEntries={["/o/acme/referee"]}>
        <Routes>
          <Route path="/o/:orgSlug/referee" element={<RefereeLandingPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: /welcome, referee/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /open your tournaments/i }),
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId("preview-tile")).toHaveLength(0);
  });
});
