// Pure logic for the phone camera broadcast page
// (/broadcast/t/:slug/:id/court/:court): what we ask the browser for, what a
// failure means in words an operator can act on, and how big to draw the
// scoreboard on a screen that is nothing like a 1920x1080 canvas.
//
// Everything here is a function so the page component stays a dumb renderer
// and the parts that matter are unit-testable — jsdom will never open a real
// camera, so the contract has to be testable without one.

import { t } from "@/lib/t";

// ---------------------------------------------------------------------------
// What we ask for
// ---------------------------------------------------------------------------

/**
 * THE getUserMedia request for this page. Exported as a constant so there is
 * exactly one of it and a test can assert on it directly.
 *
 * **`audio: false` IS LOAD-BEARING — DO NOT ADD AUDIO HERE.**
 * The operator's next move after starting this page is YouTube's own
 * "Go live → Screen", and YouTube records the venue's sound through the
 * phone's microphone. A microphone is a contended resource: if this page holds
 * a mic track, the broadcast can come out silent or with the mic switching
 * between the two consumers mid-match, on a phone nobody will debug during a
 * game. We only need the picture, so we only ask for the picture. Someone will
 * eventually want to "also capture the crowd" here — that belongs in YouTube's
 * capture, not ours.
 *
 * `facingMode: "environment"` is the plain (ideal) form on purpose, NOT
 * `{ exact: "environment" }`: an exact constraint throws OverconstrainedError
 * on any device without a rear camera, including every laptop an organiser
 * might use to check the page before match day. The plain form asks for the
 * rear camera and quietly accepts the front one where that is all there is.
 *
 * The 1920x1080 hint is `ideal` for the same reason — it asks for a broadcast
 * frame and takes whatever the hardware actually offers.
 */
export const REAR_CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: "environment",
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

/** Why the camera is not running. Each one has different advice, and the
 * operator reading it is standing courtside minutes before a match. */
export type CameraFault =
  /** The user (or a site setting, or an MDM policy) said no. */
  | "denied"
  /** No camera on this device, or none that matches what we asked for. */
  | "not-found"
  /** A camera exists but something else already holds it. */
  | "in-use"
  /** This browser has no getUserMedia at all. */
  | "unsupported"
  /** Not an https:// page, so the browser will not even offer the camera. */
  | "insecure"
  /** Something we have no specific advice for. */
  | "unknown";

/**
 * Map a `getUserMedia` rejection onto one of the faults we have advice for.
 *
 * Browsers disagree on the names (the `PermissionDeniedError` /
 * `TrackStartError` spellings are legacy Chrome, and Safari has shipped
 * `AbortError` for a camera another app owns), so match on the name string
 * rather than on an error class.
 */
export function classifyCameraError(err: unknown): CameraFault {
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "not-found";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "in-use";
    // getUserMedia throws a plain TypeError when it does not understand the
    // request at all — an ancient browser, or one behind a policy that
    // stripped the API.
    case "TypeError":
      return "unsupported";
    default:
      return "unknown";
  }
}

export interface CameraGuidance {
  /** What happened, in one line. */
  title: string;
  /** What to do about it, in words that need no technical background. */
  hint: string;
  /** Whether tapping "Try again" can plausibly help. */
  retryable: boolean;
}

/** Plain-language advice per fault. No error codes, no "check the console". */
export function cameraGuidance(fault: CameraFault): CameraGuidance {
  switch (fault) {
    case "denied":
      return {
        title: t("The camera is blocked for this page."),
        hint: t(
          "Tap the padlock (or “AA”) next to the web address, turn Camera on, then tap Start camera again. On an iPhone you may also need Settings → Safari → Camera → Allow.",
        ),
        retryable: true,
      };
    case "not-found":
      return {
        title: t("No camera we can use on this device."),
        hint: t(
          "This page needs a device with a camera — open the link on the phone that will film the match, not on a desk computer.",
        ),
        retryable: true,
      };
    case "in-use":
      return {
        title: t("Another app is already using the camera."),
        hint: t(
          "Close every other camera app — the camera, a video call, any streaming app — then tap Try again. Only one app can hold the camera at a time. (The YouTube app is fine: “Go live → Screen” records the screen, not the camera.)",
        ),
        retryable: true,
      };
    case "unsupported":
      return {
        title: t("This browser cannot open the camera."),
        hint: t(
          "Use Chrome on Android or Safari on iPhone. If you opened this link inside another app (WhatsApp, Facebook, Instagram), its built-in browser is usually the problem — tap its menu and choose “Open in browser”.",
        ),
        retryable: false,
      };
    case "insecure":
      return {
        title: t("This page has to be opened over a secure (https) address."),
        hint: t(
          "Browsers only allow the camera on https:// pages. Open the link exactly as it was copied from the tournament's streaming page.",
        ),
        retryable: false,
      };
    default:
      return {
        title: t("The camera did not start."),
        hint: t(
          "Tap Try again. If it keeps failing, close the browser completely and reopen the link, or use the OBS route on a laptop instead.",
        ),
        retryable: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Drawing the board on a phone
// ---------------------------------------------------------------------------

/** The width the scoreboard's geometry is authored for (EBU R 95, 1920x1080).
 * See overlay.css — every panel size in it is an absolute pixel figure. */
export const AUTHORED_WIDTH = 1920;

/**
 * The `--ov-scale` for a phone screen.
 *
 * The board is drawn in absolute pixels for a 1920-wide canvas, so at scale 1
 * an 820 px scorebug would cover a whole phone in landscape. Scaling by
 * `viewportWidth / 1920` makes the graphic occupy the SAME fraction of the
 * picture it occupies in OBS — which is the point: the two routes have to
 * produce the same-looking broadcast. The capture is taken at the phone's
 * device pixel ratio, so a board that looks small in CSS pixels still reaches
 * YouTube at roughly the resolution OBS would have sent.
 *
 * `?scale=` then multiplies that, for an operator who wants it bigger. A
 * non-finite or zero width (a hidden tab, an odd embed) falls back to 1:1
 * rather than collapsing the graphic to nothing.
 */
export function broadcastScale(viewportWidth: number, userScale: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return userScale;
  return (viewportWidth / AUTHORED_WIDTH) * userScale;
}

/**
 * True when the phone is being held upright.
 *
 * A portrait broadcast wastes most of the frame on ceiling and floor and cuts
 * the far end of the court off, so we nudge — but we never block, because an
 * operator with a phone clamped to a portrait mount and a match starting is
 * better served by a bad angle than by no stream.
 */
export function isPortrait(width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  return height > width;
}
