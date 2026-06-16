import { describe, expect, it } from "vitest";
import { isLikelyHtml, sanitizeRichText } from "../richText";

describe("sanitizeRichText — keeps safe formatting", () => {
  it("keeps bold/italic/underline and safe inline colour + size", () => {
    const out = sanitizeRichText(
      '<b>b</b><i>i</i><u>u</u>' +
        '<span style="color: #dc2626; font-size: large">red</span>',
    );
    expect(out).toContain("<b>b</b>");
    expect(out).toContain("<i>i</i>");
    expect(out).toContain("<u>u</u>");
    expect(out.toLowerCase()).toContain("color: #dc2626");
    expect(out.toLowerCase()).toContain("font-size: large");
  });

  it("keeps line breaks, paragraphs and lists", () => {
    const out = sanitizeRichText("<div>a</div><p>b</p><br><ul><li>x</li></ul>");
    expect(out).toContain("<br>");
    expect(out).toContain("<li>x</li>");
    expect(out).toMatch(/<(div|p)>/);
  });

  it("keeps a legacy <font size> emitted for sizing", () => {
    const out = sanitizeRichText('<font size="5">big</font>');
    expect(out).toContain('size="5"');
    expect(out).toContain("big");
  });
});

describe("sanitizeRichText — strips dangerous content", () => {
  it("removes <script> entirely (content included)", () => {
    const out = sanitizeRichText("Hello<script>alert(1)</script> world");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("Hello");
    expect(out).toContain("world");
  });

  it("strips event-handler attributes but keeps the tag", () => {
    const out = sanitizeRichText('<b onclick="alert(1)">x</b>');
    expect(out).not.toContain("onclick");
    expect(out).toContain("<b>x</b>");
  });

  it("drops <img onerror> and <iframe>", () => {
    expect(sanitizeRichText('<img src=x onerror="alert(1)">')).not.toContain(
      "onerror",
    );
    expect(sanitizeRichText('<img src=x onerror="alert(1)">')).not.toContain(
      "<img",
    );
    expect(sanitizeRichText('<iframe src="javascript:alert(1)"></iframe>')).not.toContain(
      "iframe",
    );
  });

  it("strips url()/expression()/javascript: from inline styles", () => {
    const out = sanitizeRichText(
      '<span style="color: red; background: url(javascript:alert(1)); ' +
        'width: expression(alert(1))">x</span>',
    );
    expect(out.toLowerCase()).toContain("color: red");
    expect(out.toLowerCase()).not.toContain("url(");
    expect(out.toLowerCase()).not.toContain("expression");
    expect(out.toLowerCase()).not.toContain("javascript");
  });

  it("drops disallowed style properties (e.g. position) but keeps allowed ones", () => {
    const out = sanitizeRichText(
      '<span style="position: fixed; color: blue">x</span>',
    );
    expect(out.toLowerCase()).not.toContain("position");
    expect(out.toLowerCase()).toContain("color: blue");
  });

  it("unwraps links to plain text (no href)", () => {
    const out = sanitizeRichText('<a href="https://evil.test">click</a>');
    expect(out).not.toContain("href");
    expect(out).not.toContain("<a");
    expect(out).toContain("click");
  });
});

describe("isLikelyHtml", () => {
  it("detects markup vs plain text", () => {
    expect(isLikelyHtml("<b>x</b>")).toBe(true);
    expect(isLikelyHtml("Bring your documents by Friday.")).toBe(false);
  });
});
