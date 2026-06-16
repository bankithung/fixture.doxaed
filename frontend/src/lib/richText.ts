/**
 * Tiny, dependency-free rich-text sanitiser for the small amount of formatted
 * HTML the instructions editor produces (bold / italic / underline / colour /
 * size / lists / line breaks).
 *
 * Safety model: we parse the untrusted string with `DOMParser`, which neither
 * executes scripts nor loads resources — the parsed tree is inert until *we*
 * read from it. We then keep ONLY an allowlist of formatting tags and a filtered
 * set of inline-style declarations, dropping everything else, before the result
 * is ever handed to `dangerouslySetInnerHTML`. No `<script>`, `<img>`, `<a>`,
 * event handlers, `url(...)`, `@import` or `javascript:` survive.
 */

const ALLOWED_TAGS = new Set([
  "B", "STRONG", "I", "EM", "U", "S", "BR", "P", "DIV",
  "SPAN", "UL", "OL", "LI", "FONT",
]);

/** Disallowed tags whose CONTENT is code/markup, not readable prose — these are
 *  removed wholesale rather than unwrapped to their text. */
const DROP_WITH_CONTENT = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT", "TEMPLATE",
  "SVG", "MATH", "LINK", "META", "TITLE", "HEAD", "FORM", "INPUT", "BUTTON",
  "TEXTAREA", "SELECT", "OPTION",
]);

const ALLOWED_STYLE_PROPS = new Set([
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "font-style",
  "text-decoration",
  "text-align",
]);

/** A CSS value is unsafe if it can reach out (url/import) or smuggle markup. */
function unsafeCssValue(value: string): boolean {
  const v = value.toLowerCase();
  return (
    v.includes("url(") ||
    v.includes("expression") ||
    v.includes("javascript") ||
    v.includes("@import") ||
    v.includes("/*") ||
    v.includes("<")
  );
}

/** Keep only allowlisted, value-safe style declarations. */
function safeStyle(style: string): string {
  return style
    .split(";")
    .map((decl) => decl.trim())
    .filter(Boolean)
    .map((decl) => {
      const i = decl.indexOf(":");
      if (i < 0) return null;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim();
      if (!ALLOWED_STYLE_PROPS.has(prop) || !val || unsafeCssValue(val)) return null;
      return `${prop}: ${val}`;
    })
    .filter((d): d is string => d !== null)
    .join("; ");
}

/** Whether a `<font color=…>` value is a plain, safe colour token. */
function isSafeColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (unsafeCssValue(v)) return false;
  return (
    /^#[0-9a-f]{3,8}$/.test(v) ||
    /^(rgb|rgba|hsl|hsla)\([\d%.,\s/]+\)$/.test(v) ||
    /^[a-z]+$/.test(v)
  );
}

/** Strip everything except the formatting allowlist; returns safe HTML. */
export function sanitizeRichText(html: string): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");

  const clean = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue; // text nodes are kept
      const el = child as HTMLElement;
      if (!ALLOWED_TAGS.has(el.tagName)) {
        if (DROP_WITH_CONTENT.has(el.tagName)) {
          el.remove(); // script/style/etc. — drop element AND its content
        } else {
          // Other unknown tags (a, img, h1, table…): keep the readable text.
          el.replaceWith(doc.createTextNode(el.textContent ?? ""));
        }
        continue;
      }
      // Re-build the attribute set from scratch: only a filtered style, plus
      // size/colour on the legacy <font> tag some browsers emit for sizing.
      const styleVal = el.getAttribute("style");
      const fontSize = el.tagName === "FONT" ? el.getAttribute("size") : null;
      const fontColor = el.tagName === "FONT" ? el.getAttribute("color") : null;
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      if (styleVal) {
        const safe = safeStyle(styleVal);
        if (safe) el.setAttribute("style", safe);
      }
      if (fontSize && /^[1-7]$/.test(fontSize)) el.setAttribute("size", fontSize);
      if (fontColor && isSafeColor(fontColor)) el.setAttribute("color", fontColor);
      clean(el);
    }
  };

  clean(doc.body);
  return doc.body.innerHTML;
}

/** True when a string carries HTML markup (vs. a plain-text legacy value). */
export function isLikelyHtml(value: string): boolean {
  return /<[a-z][\s\S]*?>/i.test(value);
}
