import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PublicLiveRedirect } from "../PublicLiveRedirect";

describe("PublicLiveRedirect", () => {
  it("redirects the legacy /live scoreboard URL to the Matches tab (schedule route)", () => {
    render(
      <MemoryRouter initialEntries={["/t/cup/t1/live"]}>
        <Routes>
          <Route path="/t/:slug/:id/live" element={<PublicLiveRedirect />} />
          <Route
            path="/t/:slug/:id/schedule"
            element={<div data-testid="matches-tab">cup t1</div>}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("matches-tab")).toBeInTheDocument();
  });
});
