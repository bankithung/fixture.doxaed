import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RefereeLandingPage } from "../RefereeLandingPage";

describe("RefereeLandingPage", () => {
  it("renders hero copy and 4 referee preview tiles", () => {
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
      screen.getByText(/referee console activates in phase 1b/i),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("preview-tile")).toHaveLength(4);
    expect(screen.getByText(/lineup confirmation/i)).toBeInTheDocument();
    expect(screen.getByText(/match clock control/i)).toBeInTheDocument();
    expect(screen.getByText(/card \/ foul logger/i)).toBeInTheDocument();
    expect(
      screen.getByText(/match-incident reports/i),
    ).toBeInTheDocument();
  });
});
