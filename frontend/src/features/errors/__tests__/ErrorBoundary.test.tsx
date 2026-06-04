import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";

function Boom({ message }: { message: string }): React.ReactElement {
  throw new Error(message);
}

describe("ErrorBoundary", () => {
  // Silence the expected console.error noise in tests that intentionally throw.
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it("renders children when no error is thrown", () => {
    render(
      <ErrorBoundary>
        <div data-testid="ok">hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("ok")).toBeInTheDocument();
  });

  it("renders the ErrorPage when a child throws during render", () => {
    render(
      <ErrorBoundary>
        <Boom message="kaboom" />
      </ErrorBoundary>,
    );
    // ErrorPage uses role="alert" and shows a "Something went wrong" title.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    // The thrown message is surfaced inside the collapsible <details>.
    expect(screen.getByText(/kaboom/)).toBeInTheDocument();
  });

  it("uses the optional `fallback` render-prop when provided", () => {
    render(
      <ErrorBoundary
        fallback={(err) => <div data-testid="custom">{err.message}</div>}
      >
        <Boom message="custom-fallback" />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("custom").textContent).toBe(
      "custom-fallback",
    );
  });

  it("logs caught errors via console.error", () => {
    render(
      <ErrorBoundary>
        <Boom message="please log me" />
      </ErrorBoundary>,
    );
    expect(spy).toHaveBeenCalled();
    const messages = spy.mock.calls.flat().map(String).join(" ");
    expect(messages).toMatch(/please log me/);
  });
});
