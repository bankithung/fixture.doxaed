import { describe, expect, it } from "vitest";
import {
  AUTHORED_WIDTH,
  broadcastScale,
  cameraGuidance,
  classifyCameraError,
  isPortrait,
  REAR_CAMERA_CONSTRAINTS,
  type CameraFault,
} from "../cameraState";

/** A DOMException-shaped rejection, which is what getUserMedia actually
 * throws. Only `name` is load-bearing. */
function mediaError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

describe("REAR_CAMERA_CONSTRAINTS — what we ask the phone for", () => {
  it("NEVER asks for audio: the microphone belongs to YouTube", () => {
    // This is the assertion that protects the broadcast's sound. If this page
    // holds a mic track, the YouTube app's own capture contends with it and
    // the stream can go out silent.
    expect(REAR_CAMERA_CONSTRAINTS.audio).toBe(false);
  });

  it("asks for the REAR camera, and not with an exact constraint", () => {
    const video = REAR_CAMERA_CONSTRAINTS.video as MediaTrackConstraints;
    expect(video.facingMode).toBe("environment");
    // `{ exact: "environment" }` would throw OverconstrainedError on every
    // device without a rear camera — including the laptop an organiser checks
    // the page on the day before.
    expect(typeof video.facingMode).toBe("string");
  });

  it("asks for a broadcast frame as a hint, never as a requirement", () => {
    const video = REAR_CAMERA_CONSTRAINTS.video as MediaTrackConstraints;
    expect(video.width).toEqual({ ideal: 1920 });
    expect(video.height).toEqual({ ideal: 1080 });
  });
});

describe("classifyCameraError", () => {
  it.each([
    ["NotAllowedError", "denied"],
    ["PermissionDeniedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "not-found"],
    ["DevicesNotFoundError", "not-found"],
    ["OverconstrainedError", "not-found"],
    ["NotReadableError", "in-use"],
    ["TrackStartError", "in-use"],
    ["AbortError", "in-use"],
    ["TypeError", "unsupported"],
  ])("maps %s to %s", (name, fault) => {
    expect(classifyCameraError(mediaError(name))).toBe(fault);
  });

  it("falls back to a fault with generic advice rather than throwing", () => {
    expect(classifyCameraError(mediaError("WhoKnowsError"))).toBe("unknown");
    expect(classifyCameraError(undefined)).toBe("unknown");
    expect(classifyCameraError("a string")).toBe("unknown");
    expect(classifyCameraError({})).toBe("unknown");
  });
});

describe("cameraGuidance", () => {
  const FAULTS: CameraFault[] = [
    "denied",
    "not-found",
    "in-use",
    "unsupported",
    "insecure",
    "unknown",
  ];

  it("gives every fault a plain-language line and something to do", () => {
    for (const fault of FAULTS) {
      const g = cameraGuidance(fault);
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.hint.length).toBeGreaterThan(0);
      // No error codes, no jargon: the reader is a volunteer courtside.
      expect(g.title).not.toMatch(/Error|getUserMedia|console/);
    }
  });

  it("does not offer a retry for the two faults a retry cannot fix", () => {
    expect(cameraGuidance("unsupported").retryable).toBe(false);
    expect(cameraGuidance("insecure").retryable).toBe(false);
    expect(cameraGuidance("denied").retryable).toBe(true);
    expect(cameraGuidance("in-use").retryable).toBe(true);
  });

  it("names the actual fix for the two most common failures", () => {
    expect(cameraGuidance("denied").hint).toMatch(/padlock|Settings/);
    expect(cameraGuidance("in-use").hint).toMatch(/Close/);
    // The YouTube app itself is NOT the culprit — screen capture is not the
    // camera — and saying so saves a wrong diagnosis mid-tournament.
    expect(cameraGuidance("in-use").hint).toMatch(/Go live → Screen/);
    expect(cameraGuidance("insecure").hint).toMatch(/https/);
  });
});

describe("broadcastScale", () => {
  it("draws the board at the same FRACTION of the picture OBS gives it", () => {
    // A phone in landscape is ~850 CSS px wide, not 1920: at scale 1 the
    // 820px scorebug would cover the whole screen.
    expect(broadcastScale(AUTHORED_WIDTH, 1)).toBe(1);
    expect(broadcastScale(960, 1)).toBe(0.5);
    expect(broadcastScale(844, 1)).toBeCloseTo(0.4396, 4);
  });

  it("lets ?scale= multiply it, for an operator who wants it bigger", () => {
    expect(broadcastScale(960, 2)).toBe(1);
    expect(broadcastScale(1920, 0.5)).toBe(0.5);
  });

  it("falls back to 1:1 rather than collapsing when the width is unusable", () => {
    expect(broadcastScale(0, 1)).toBe(1);
    expect(broadcastScale(Number.NaN, 1.5)).toBe(1.5);
    expect(broadcastScale(-10, 1)).toBe(1);
  });
});

describe("isPortrait", () => {
  it("is true only when the phone is taller than it is wide", () => {
    expect(isPortrait(390, 844)).toBe(true);
    expect(isPortrait(844, 390)).toBe(false);
    // A square viewport is not worth nagging about.
    expect(isPortrait(500, 500)).toBe(false);
  });

  it("says nothing when there is no viewport to measure", () => {
    expect(isPortrait(0, 0)).toBe(false);
  });
});
