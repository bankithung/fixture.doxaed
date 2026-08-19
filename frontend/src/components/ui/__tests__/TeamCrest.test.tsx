import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TeamCrest, crestInitials } from "../TeamCrest";

/**
 * The badge that appears beside a team name on every fixture surface. Two rules
 * carry the whole component: most teams have no crest, and an upload can go
 * away — neither may leave a hole in a fixture row.
 */

describe("crestInitials", () => {
  it("skips the words every school name is padded with", () => {
    expect(crestInitials("St. Mary's Higher Secondary School")).toBe("SM");
    expect(crestInitials("Grace Academy")).toBe("GA");
  });

  it("still answers when a name is nothing but padding", () => {
    expect(crestInitials("The School")).toBe("TS");
  });

  it("takes one initial from a one-word name, and none from nothing", () => {
    expect(crestInitials("Eagles")).toBe("E");
    expect(crestInitials("")).toBe("");
  });
});

describe("TeamCrest", () => {
  it("shows the badge when there is one", () => {
    render(<TeamCrest src="/api/forms/uploads/abc/?t=x" name="Grace Academy" />);
    expect(screen.getByTestId("team-crest")).toHaveAttribute(
      "src",
      "/api/forms/uploads/abc/?t=x",
    );
  });

  it("falls back to initials when the team has none", () => {
    render(<TeamCrest src="" name="Grace Academy" />);
    expect(screen.getByTestId("team-crest-fallback")).toHaveTextContent("GA");
    expect(screen.queryByTestId("team-crest")).toBeNull();
  });

  it("falls back when the image fails to load, rather than showing a broken icon", () => {
    render(<TeamCrest src="/gone.png" name="Grace Academy" />);
    fireEvent.error(screen.getByTestId("team-crest"));
    expect(screen.getByTestId("team-crest-fallback")).toHaveTextContent("GA");
  });

  it("is decorative: the team name beside it is what a screen reader reads", () => {
    const { container } = render(
      <TeamCrest src="/api/forms/uploads/abc/?t=x" name="Grace Academy" />,
    );
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("aria-hidden", "true");
  });
});
