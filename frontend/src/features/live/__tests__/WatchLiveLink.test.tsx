import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WatchLiveLink } from "../WatchLiveLink";

const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("WatchLiveLink", () => {
  it("renders nothing when no URL resolved", () => {
    const { container } = render(<WatchLiveLink url={null} />);
    expect(container).toBeEmptyDOMElement();
    // Undefined is the same statement (an older payload with no field).
    render(<WatchLiveLink url={undefined} />);
    expect(screen.queryByTestId("watch-live")).not.toBeInTheDocument();
  });

  it("renders nothing for an empty string, never a dead button", () => {
    const { container } = render(<WatchLiveLink url="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is a real link that opens YouTube in a new tab, safely", () => {
    render(<WatchLiveLink url={URL} />);
    const link = screen.getByTestId("watch-live");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", URL);
    expect(link).toHaveAttribute("target", "_blank");
    // noopener keeps the opened tab off window.opener; noreferrer with it.
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("Watch live");
  });

  it("takes an accessible name when the context needs one", () => {
    render(<WatchLiveLink url={URL} label="Watch Court 2 live" />);
    expect(
      screen.getByRole("link", { name: "Watch Court 2 live" }),
    ).toBeInTheDocument();
  });
});
