import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
import {
  broadcastScale,
  cameraGuidance,
  classifyCameraError,
  isPortrait,
  REAR_CAMERA_CONSTRAINTS,
  type CameraFault,
} from "./cameraState";
import { useCourtBoard } from "./useCourtBoard";
import "./overlay.css";
import "./camera.css";

/**
 * Phone camera + live scoreboard — `/broadcast/t/:slug/:id/court/:court`.
 *
 * The no-laptop route to a stream with the score burned in. The operator opens
 * this URL on the phone that will film the match, taps Start camera, goes full
 * screen, and then uses the YouTube app's own **Go live → Screen** to broadcast
 * whatever the phone is showing. The phone becomes the compositor: rear camera
 * underneath, the SAME scoreboard OBS would draw on top, and YouTube captures
 * the result. No OBS, no third-party app, no server-side video work.
 *
 * The board and its feed are `OverlayBoard` + `useCourtBoard`, shared verbatim
 * with the OBS overlay: the six states, the serve indicator, the freshness
 * ladder and the cold-start cache all behave identically here, because they
 * are literally the same code.
 *
 * WHAT IS DIFFERENT FROM THE OBS OVERLAY, and why:
 *
 *  - **This page has real UI.** Before it goes live a human has to press a
 *    button, and when something fails a human has to read what to do. So the
 *    controls are proper accessible controls with focus rings — the overlay's
 *    WCAG exemption applies only to the board subtree, which is `aria-hidden`
 *    here exactly as it is there.
 *  - **The controls disappear once the camera is running** (and come back on a
 *    tap), because from that moment every pixel on this screen is going out to
 *    the public.
 *  - **The board is scaled to the phone.** Its geometry is authored in absolute
 *    pixels for a 1920-wide canvas; see `broadcastScale`.
 *
 * Query options match the overlay where they make sense: `?scale=` (multiplies
 * the phone-fitted scale), `?side=left|right` and `?server=away`.
 */
export function CameraBroadcastPage(): React.ReactElement {
  const { slug = "", id = "", court = "" } = useParams();
  const [params] = useSearchParams();
  const userScale = parseScale(params.get("scale"));
  const side = parseSide(params.get("side"));
  const firstServer = parseFirstServer(params.get("server"));

  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Same page-level reset + no-index/no-referrer hardening the overlay uses,
  // under this page's own attribute (it wants a BLACK page, not a transparent
  // one — there is no compositor behind it to show through to).
  useBroadcastPageChrome("data-camera-broadcast");

  const board = useCourtBoard({ slug, id, court, firstServer });
  const camera = useRearCamera(videoRef);
  const fullscreen = useFullscreen(rootRef);
  const viewport = useViewport();

  // The screen must not sleep while the phone IS the broadcast — see the hook.
  useWakeLock(camera.status === "live");

  const controls = useAutoHidingControls(camera.status === "live");

  const { courtLabel } = board;
  useEffect(() => {
    document.title = `${courtLabel} · ${t("Camera")}`;
  }, [courtLabel]);

  const anchor = boardAnchor(side, board.family);
  const scale = broadcastScale(viewport.width, userScale);
  const portrait = isPortrait(viewport.width, viewport.height);
  const live = camera.status === "live";

  return (
    <div
      ref={rootRef}
      data-testid="camera-root"
      data-state={camera.status}
      data-controls={controls.shown ? "shown" : "hidden"}
      className="cam"
      // Anywhere on the picture brings the controls back. `onPointerDown`
      // rather than `onClick` so the tap that reveals them does not also have
      // to travel to a button that was invisible when the finger landed.
      onPointerDown={controls.reveal}
    >
      {/* The picture. `muted` + `playsInline` are what let iOS start it at all;
          muting costs nothing because we never asked for an audio track. It is
          hidden from assistive tech — it is footage, not content. */}
      <video
        ref={videoRef}
        data-testid="camera-video"
        className="cam__video"
        autoPlay
        playsInline
        muted
        aria-hidden="true"
      />

      {/* The scoreboard, drawn by the same component the OBS overlay mounts.
          Hidden from assistive technology for the same reason it is there: it
          is a video graphic, not UI. */}
      <div
        aria-hidden="true"
        data-testid="camera-board"
        data-board-state={board.kind}
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

      {/* Landscape is the right shape for a broadcast, but a nudge is all this
          is — it never blocks, and it is hidden while the controls are (i.e.
          while the picture is going out) so it cannot end up in the stream. */}
      {portrait && controls.shown ? (
        <p data-testid="camera-portrait-nudge" className="cam__nudge">
          {t("Turn the phone sideways — a match looks far better wide.")}
        </p>
      ) : null}

      {live ? null : (
        <div className="cam__scrim">
          <div className="cam__card" data-testid="camera-card">
            {camera.status === "error" ? (
              <CameraFailure
                fault={camera.fault}
                onRetry={() => void camera.start()}
              />
            ) : (
              <StartPanel
                courtLabel={courtLabel}
                tournamentName={board.tournamentName}
                starting={camera.status === "starting"}
                onStart={() => void camera.start()}
              />
            )}
          </div>
        </div>
      )}

      {live && controls.shown ? (
        <div className="cam__bar" data-testid="camera-controls">
          <button
            type="button"
            data-testid="camera-fullscreen"
            className="cam__btn"
            onClick={() => void fullscreen.toggle()}
          >
            {fullscreen.active ? t("Leave full screen") : t("Full screen")}
          </button>
          <button
            type="button"
            data-testid="camera-stop"
            className="cam__btn cam__btn--quiet"
            onClick={camera.stop}
          >
            {t("Stop camera")}
          </button>
          <p className="cam__barHint">
            {fullscreen.refused
              ? t(
                  "This browser would not go full screen. Capture anyway — the address bar will be in the picture — or use the browser's own full-screen option.",
                )
              : t(
                  "These controls hide themselves. Tap the picture to bring them back.",
                )}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/** The pre-flight screen. Everything the operator has to do, in order, on one
 * screen — this page gets opened minutes before a match by someone who is not
 * technical and will not read a manual. */
function StartPanel({
  courtLabel,
  tournamentName,
  starting,
  onStart,
}: {
  courtLabel: string;
  tournamentName: string;
  starting: boolean;
  onStart: () => void;
}): React.ReactElement {
  return (
    <>
      <p className="cam__eyebrow">{tournamentName || t("Live broadcast")}</p>
      <h1 className="cam__title">{courtLabel}</h1>
      <p className="cam__lede">
        {t(
          "This page puts the live score on top of your phone's camera. Broadcast this screen with the YouTube app and the score goes out with the picture.",
        )}
      </p>
      <button
        type="button"
        data-testid="camera-start"
        className="cam__btn cam__btn--primary"
        disabled={starting}
        onClick={onStart}
      >
        {starting ? t("Starting…") : t("Start camera")}
      </button>
      <ol className="cam__steps">
        <li>{t("Tap Start camera and allow the camera when asked.")}</li>
        <li>{t("Tap Full screen, and hold the phone sideways.")}</li>
        <li>
          {t(
            "Open the YouTube app → Create → Go live → Screen, and pick this browser.",
          )}
        </li>
        <li>
          {t(
            "Copy the YouTube watch link and paste it into this court's box on the tournament's streaming page, so spectators get a Watch live button.",
          )}
        </li>
      </ol>
      <p className="cam__note">
        {t(
          "The microphone is left alone on purpose — YouTube records the sound of the venue itself.",
        )}
      </p>
    </>
  );
}

/** A failure, named and answered. `role="alert"` because the operator may well
 * be looking at the phone from arm's length on a tripod when it appears. */
function CameraFailure({
  fault,
  onRetry,
}: {
  fault: CameraFault;
  onRetry: () => void;
}): React.ReactElement {
  const guidance = cameraGuidance(fault);
  return (
    <div role="alert" data-testid="camera-error" data-fault={fault}>
      <h1 className="cam__title cam__title--error">{guidance.title}</h1>
      <p className="cam__lede">{guidance.hint}</p>
      {guidance.retryable ? (
        <button
          type="button"
          data-testid="camera-retry"
          className="cam__btn cam__btn--primary"
          onClick={onRetry}
        >
          {t("Try again")}
        </button>
      ) : null}
      <p className="cam__note">
        {t(
          "The score itself is fine — spectators can still read it on the tournament's public page while you sort this out.",
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

type CameraStatus = "idle" | "starting" | "live" | "error";

interface RearCamera {
  status: CameraStatus;
  fault: CameraFault;
  start: () => Promise<void>;
  stop: () => void;
}

/**
 * The rear camera, as a state machine with named failures.
 *
 * `getUserMedia` needs BOTH a user gesture and a secure context, so `start` is
 * only ever called from a button. It is deliberately the only thing in this
 * file that touches `navigator.mediaDevices`.
 */
function useRearCamera(
  videoRef: React.RefObject<HTMLVideoElement | null>,
): RearCamera {
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [fault, setFault] = useState<CameraFault>("unknown");
  const streamRef = useRef<MediaStream | null>(null);

  const release = useCallback((): void => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    const video = videoRef.current;
    if (video) video.srcObject = null;
  }, [videoRef]);

  const start = useCallback(async (): Promise<void> => {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      // A browser only publishes `mediaDevices` in a SECURE context, so an
      // absent API on an http:// page is virtually always the address and not
      // the browser's age. Distinguish the two, because the fixes are
      // completely different and neither is guessable.
      setFault(window.isSecureContext === false ? "insecure" : "unsupported");
      setStatus("error");
      return;
    }
    setStatus("starting");
    try {
      // See REAR_CAMERA_CONSTRAINTS — video only, and audio:false is load
      // bearing (it keeps the microphone free for YouTube).
      const stream = await media.getUserMedia(REAR_CAMERA_CONSTRAINTS);
      release();
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        // The element is muted, so autoplay is normally allowed; a refusal is
        // still not fatal (the operator's tap will start it), so swallow it.
        void video.play?.()?.catch(() => {});
      }
      // The OS can take the camera away later — an incoming call, another app
      // grabbing it. That ends the track, and a broadcast showing a frozen
      // last frame with no explanation is the worst possible outcome.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setFault("in-use");
        setStatus("error");
      });
      setStatus("live");
    } catch (err) {
      setFault(classifyCameraError(err));
      setStatus("error");
    }
  }, [release, videoRef]);

  const stop = useCallback((): void => {
    release();
    setStatus("idle");
  }, [release]);

  // Hand the camera back when the page goes away: a held camera keeps the
  // phone's privacy light on and locks out the next app that wants it.
  useEffect(() => release, [release]);

  return { status, fault, start, stop };
}

// ---------------------------------------------------------------------------
// Screen, viewport, controls
// ---------------------------------------------------------------------------

interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

/**
 * Keep the screen on while the phone is the broadcast.
 *
 * A phone left alone on a tripod dims and then sleeps on its own display
 * timeout, and a sleeping screen is a BLACK STREAM — the capture keeps running
 * and nobody in the venue notices for ten minutes. The Wake Lock API is the
 * only way to say "not while this is on air".
 *
 * The re-acquire on visibility change is not optional: the spec releases a
 * screen wake lock whenever the document becomes hidden and never restores it,
 * and this page is *guaranteed* to be hidden at least once — the operator
 * switches to the YouTube app to start the broadcast. Without this, the lock
 * would be gone by the time it actually mattered.
 *
 * Unsupported (or refused, e.g. on low battery) degrades silently: there is
 * nothing an operator could do about it and a warning would only be one more
 * thing on screen to burn into the picture.
 */
function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const api = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
    if (!api) return undefined;

    let disposed = false;
    let sentinel: WakeLockSentinelLike | null = null;

    const acquire = async (): Promise<void> => {
      if (disposed || sentinel) return;
      try {
        const held = await api.request("screen");
        if (disposed) {
          void held.release();
          return;
        }
        sentinel = held;
        held.addEventListener("release", () => {
          sentinel = null;
        });
      } catch {
        // Denied by the platform. Nothing to say and nothing to retry.
      }
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release();
      sentinel = null;
    };
  }, [active]);
}

interface FullscreenControl {
  active: boolean;
  /** True once a request has been refused — iPhone Safari has no element
   * fullscreen at all, and any browser may say no. */
  refused: boolean;
  toggle: () => Promise<void>;
}

/** Fullscreen on a tap, so the address bar is not part of the captured
 * picture. Every failure is survivable: the operator still gets a stream, just
 * with browser chrome in the frame, so a refusal is reported as a hint rather
 * than an error. */
function useFullscreen(
  ref: React.RefObject<HTMLElement | null>,
): FullscreenControl {
  const [active, setActive] = useState(false);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    const sync = (): void => setActive(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggle = useCallback(async (): Promise<void> => {
    const el = ref.current;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (!el || typeof el.requestFullscreen !== "function") {
        setRefused(true);
        return;
      }
      await el.requestFullscreen({ navigationUI: "hide" });
      setRefused(false);
    } catch {
      setRefused(true);
    }
  }, [ref]);

  return { active, refused, toggle };
}

interface Viewport {
  width: number;
  height: number;
}

// One cached snapshot object: `useSyncExternalStore` compares by identity, so
// a fresh object per read would loop forever.
let viewportSnapshot: Viewport = { width: 0, height: 0 };

function readViewport(): Viewport {
  const width = typeof window === "undefined" ? 0 : window.innerWidth;
  const height = typeof window === "undefined" ? 0 : window.innerHeight;
  if (width !== viewportSnapshot.width || height !== viewportSnapshot.height) {
    viewportSnapshot = { width, height };
  }
  return viewportSnapshot;
}

function subscribeViewport(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("resize", onChange, { passive: true });
  window.addEventListener("orientationchange", onChange, { passive: true });
  return () => {
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
  };
}

/** Viewport size, reactive. Both readings matter here: width sets how big the
 * board is drawn, height tells us the phone is upright. */
function useViewport(): Viewport {
  return useSyncExternalStore(subscribeViewport, readViewport, readViewport);
}

/** How long the on-air controls stay up before they get out of the picture. */
const CONTROLS_HIDE_MS = 5_000;

/**
 * The controls are visible whenever the page is NOT on air, and for a few
 * seconds after each tap once it is. Anything permanently on screen would be
 * burned into a public broadcast.
 *
 * `shownAt` is a counter, not a clock: it exists only to re-arm the hide timer
 * on every reveal. Going on or off air is handled during render (React's
 * documented "storing information from previous renders" pattern, used by the
 * board's out-of-order guard too) so the controls are never hidden for a frame
 * at the moment the camera stops and the operator needs them back.
 */
function useAutoHidingControls(live: boolean): {
  shown: boolean;
  reveal: () => void;
} {
  const [state, setState] = useState({ live, hidden: false, shownAt: 0 });
  if (state.live !== live) {
    setState({ live, hidden: false, shownAt: state.shownAt + 1 });
  }
  const hidden = state.live === live && state.hidden;

  useEffect(() => {
    if (!live) return undefined;
    const id = window.setTimeout(
      () => setState((s) => ({ ...s, hidden: true })),
      CONTROLS_HIDE_MS,
    );
    return () => window.clearTimeout(id);
  }, [live, state.shownAt]);

  // Every tap re-arms the timer, including a tap that lands on a control: the
  // operator is plainly still working, so do not take the buttons away.
  const reveal = useCallback((): void => {
    setState((s) => ({ ...s, hidden: false, shownAt: s.shownAt + 1 }));
  }, []);

  return { shown: !hidden, reveal };
}
