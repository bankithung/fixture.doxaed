import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NotFoundPage } from "../NotFoundPage";

describe("NotFoundPage", () => {
  it("renders 404 message and Back home CTA", () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: /404. Page not found/i }),
    ).toBeInTheDocument();
    const backLink = screen.getByRole("link", { name: /back home/i });
    expect(backLink).toBeInTheDocument();
    expect(backLink.getAttribute("href")).toBe("/");
  });

  it("includes a sign-in link", () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    const signIn = screen.getByRole("link", { name: /sign in instead/i });
    expect(signIn.getAttribute("href")).toBe("/login");
  });
});
