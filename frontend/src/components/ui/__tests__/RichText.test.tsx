import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { RichText } from "../RichText";

describe("RichText viewer", () => {
  it("renders sanitised formatted HTML and drops script", () => {
    const { container } = render(
      <RichText html="<b>Bold</b><script>alert(1)</script>" />,
    );
    expect(container.querySelector("b")?.textContent).toBe("Bold");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("alert(1)");
  });

  it("preserves newlines inside formatted (HTML) content", () => {
    const { container } = render(
      <RichText html={'<span style="color: red">line 1\nline 2</span>'} />,
    );
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain("whitespace-pre-wrap");
    expect(div.textContent).toBe("line 1\nline 2");
  });

  it("preserves newlines for plain-text (legacy) values", () => {
    const { container } = render(<RichText html={"line 1\nline 2"} />);
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain("whitespace-pre-wrap");
    expect(div.textContent).toBe("line 1\nline 2");
  });

  it("renders nothing for empty content", () => {
    const { container } = render(<RichText html="" />);
    expect(container.firstChild).toBeNull();
  });
});
