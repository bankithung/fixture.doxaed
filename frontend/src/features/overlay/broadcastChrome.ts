import { useEffect } from "react";

/**
 * The chrome every broadcast surface needs, shared by the OBS overlay and the
 * phone camera page.
 *
 * Both are pages whose pixels end up inside somebody's public video, so both
 * want the same two things: a page-level attribute the stylesheet hangs its
 * reset on, and headers that keep the URL out of search results and out of
 * other sites' referrer logs. The response headers themselves belong in nginx
 * (see docs/obs-overlay.md); these meta tags are the in-page half.
 */

/** Append a `<meta name=… content=…>` and hand it back so a caller can remove
 * it again — the SPA outlives this page and must be left unharmed. */
export function metaTag(name: string, content: string): HTMLMetaElement {
  const el = document.createElement("meta");
  el.setAttribute("name", name);
  el.setAttribute("content", content);
  document.head.appendChild(el);
  return el;
}

/**
 * Mark `<html>` with `attribute` (the stylesheet's hook for the broadcast
 * reset) and add the referrer/robots meta tags, undoing all of it on unmount.
 */
export function useBroadcastPageChrome(attribute: string): void {
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute(attribute, "");
    const metas = [
      metaTag("referrer", "no-referrer"),
      metaTag("robots", "noindex, nofollow"),
    ];
    return () => {
      html.removeAttribute(attribute);
      for (const m of metas) m.remove();
    };
  }, [attribute]);
}
