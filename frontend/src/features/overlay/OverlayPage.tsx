import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBroadcastPageChrome } from "./broadcastChrome";
import { Board } from "./OverlayBoard";
import {
  boardAnchor,
  parseFirstServer,
  parseScale,
  parseSide,
} from "./overlayState";
import { useCourtBoard } from "./useCourtBoard";
import "./overlay.css";

/**
 * OBS broadcast scoreboard overlay — `/overlay/t/:slug/:id/court/:court`.
 *
 * A URL an operator pastes ONCE into an OBS Browser Source per court and
 * never touches again. It follows whatever match is live on that court and
 * renders a scorebug that gets composited over the camera feed and burned
 * into the stream. Public, unauthenticated, outside the app shell.
 *
 * This file is now only the OBS *framing* — the transparent page, the meta
 * hardening and the anchor. The board itself is `OverlayBoard` and its live
 * feed is `useCourtBoard`, both shared with the phone camera page
 * (`CameraBroadcastPage`) so the two surfaces cannot drift apart.
 *
 * No outbound links exist on this page, by design: a link is a `Referer` leak
 * vector and there is nothing here to navigate to anyway.
 *
 * a11y NOTE FOR A LATER REVIEWER — do not "fix" this:
 * WCAG does not apply to this page and it is exempt on purpose. There is no
 * interactive element, no focus order, no keyboard path and no human reading
 * this DOM: the only consumer is a headless Chromium that screenshots the
 * page into a video frame. The root is `aria-hidden`, the cursor is hidden,
 * focus rings and text selection are suppressed, and colours are fixed
 * broadcast literals rather than theme tokens (see overlay.css). Adding ARIA
 * roles, focus styling or theme awareness here would only add ways for the
 * graphic to change unexpectedly mid-stream.
 *
 * Query params: `?scale=1.25` (canvas multiplier; 1280x720 is 0.667),
 * `?side=left|right` (anchor corner) and `?server=away` (which side opened
 * the match, for the rules-derived serve indicator).
 */
export function OverlayPage(): React.ReactElement {
  const { slug = "", id = "", court = "" } = useParams();
  const [params] = useSearchParams();
  const scale = parseScale(params.get("scale"));
  const side = parseSide(params.get("side"));
  const firstServer = parseFirstServer(params.get("server"));

  // The whole page is a broadcast graphic: strip the app's opaque body
  // background (and any focus/selection/cursor chrome) while it is mounted,
  // and put every one of those rules back on unmount so the SPA is unharmed.
  useBroadcastPageChrome("data-obs-overlay");

  const board = useCourtBoard({ slug, id, court, firstServer });

  const { courtLabel } = board;
  useEffect(() => {
    document.title = `${courtLabel} · ${t("Overlay")}`;
  }, [courtLabel]);

  const anchor = boardAnchor(side, board.family);

  return (
    <div
      // See the a11y note on the component: this subtree is deliberately
      // hidden from assistive technology — it is a video graphic, not UI.
      aria-hidden="true"
      data-testid="overlay-root"
      data-state={board.kind}
      data-family={board.family}
      data-feed={board.feed}
      className={cn(
        "ov",
        anchor === "right" && "ov--right",
        anchor === "center" && "ov--center",
      )}
      style={{ "--ov-scale": String(scale) } as React.CSSProperties}
    >
      <div className="ov-stack">
        <Board {...board} />
      </div>
    </div>
  );
}
