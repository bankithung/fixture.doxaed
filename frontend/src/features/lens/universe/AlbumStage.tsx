import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Move3d, Pause, Play } from "lucide-react";
import { motionOff } from "@/features/landing/motionGate";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { t } from "@/lib/t";
import { DomeGallery, type DomeItem } from "./DomeGallery";
import { PlanetRail } from "./PlanetRail";
import { SchoolOrbit, type OrbitSchool } from "./SchoolOrbit";
import "./universe.css";

/**
 * The album's two-stage stage: a school orbit you zoom out of, and the photo
 * sphere you zoom into. Owns the camera (which stage is showing, and the warp
 * between them) and the spin switch; the page above it owns the filters and
 * the lightbox, so prev/next in the lightbox always walks the same list the
 * sphere is showing.
 */

export function AlbumStage({
  photos,
  schools,
  total,
  focus,
  onFocus,
  onOpen,
  paused = false,
}: {
  /** Already filtered by the page — this is exactly what the sphere shows. */
  photos: DomeItem[];
  schools: OrbitSchool[];
  /** Photos in the unfiltered album (the number on the sun). */
  total: number;
  /** "" = every school (orbit view), a school name = that school's sphere. */
  focus: string | null;
  /** null asks for the orbit; a string focuses one school ("" = all photos). */
  onFocus: (focus: string | null) => void;
  onOpen: (key: string) => void;
  /** True while a lightbox covers the stage. */
  paused?: boolean;
}): React.ReactElement {
  const [warp, setWarp] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(true);

  // The warp is a beat of animation, not state the page should know about:
  // commit the focus change when the system has rushed past the camera.
  useEffect(() => {
    if (warp === null) return;
    const to = warp;
    const id = window.setTimeout(() => {
      setWarp(null);
      onFocus(to);
    }, 380);
    return () => window.clearTimeout(id);
  }, [warp, onFocus]);

  const pick = useCallback(
    (school: string) => {
      if (motionOff()) {
        onFocus(school);
        return;
      }
      setWarp(school);
    },
    [onFocus],
  );

  // Below `lg` the orbit becomes a rail (see PlanetRail): the sphere is the
  // thing worth the screen on a phone, and the schools reach the thumb better
  // in a line than on three cramped rings.
  const screen = useBreakpoint();
  const rail = !screen.up("lg");
  const inDome = rail || focus !== null;
  const label = focus ? focus : t("Every school");

  return (
    <div
      data-testid="album-stage"
      className="universe relative h-[62vh] min-h-[22rem] w-full sm:h-[66vh] sm:max-h-[42rem]"
    >
      <div aria-hidden="true" className="universe__stars" />

      {inDome ? (
        <DomeGallery
          items={photos}
          onOpen={onOpen}
          spin={spinning && !paused}
          // A phone can afford to crop the ball for bigger photos; a tablet has
          // the room to show it whole.
          fit={screen.isMobile ? 1.12 : 1}
        />
      ) : (
        <SchoolOrbit
          schools={schools}
          total={total}
          onPick={pick}
          onPickAll={() => pick("")}
          zooming={warp !== null}
          still={!spinning || paused}
        />
      )}

      {/* Stage chrome. Sits above the 3D layers, and each control governs the
          thing it sits next to. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start gap-2 p-3 sm:p-4">
        {inDome && !rail && schools.length > 1 ? (
          <button
            type="button"
            data-testid="dome-back"
            onClick={() => onFocus(null)}
            className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 text-xs font-medium text-white backdrop-blur transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
            {t("All schools")}
          </button>
        ) : null}

        <div className="min-w-0 flex-1 text-right">
          <p
            data-testid="stage-focus"
            className="truncate text-sm font-semibold text-white drop-shadow"
          >
            {inDome ? label : t("Pick a school")}
          </p>
          <p className="font-tabular text-[0.6875rem] text-white/70">
            {inDome
              ? `${photos.length} ${photos.length === 1 ? t("photo") : t("photos")}`
              : `${schools.length} ${t("schools")} · ${total} ${t("photos")}`}
          </p>
        </div>

        <button
          type="button"
          data-testid="stage-spin-toggle"
          aria-pressed={spinning}
          onClick={() => setSpinning((s) => !s)}
          className="pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          {spinning ? (
            <Pause aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Play aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          <span className="sr-only">
            {spinning ? t("Stop the rotation") : t("Start the rotation")}
          </span>
        </button>
      </div>

      {/* Footer: the hint, and on small screens the school rail under it. */}
      <div className="universe__footer absolute inset-x-0 bottom-0 z-10">
        <p className="pointer-events-none flex items-center justify-center gap-1.5 px-3 pb-2 pt-3 text-[0.6875rem] text-white/65">
          <Move3d aria-hidden="true" className="h-3.5 w-3.5" />
          {inDome
            ? t("Drag to spin in any direction · tap a photo to open it")
            : t("Tap a school to fly into its photos")}
        </p>
        {rail && schools.length > 1 ? (
          <PlanetRail
            schools={schools}
            total={total}
            focus={focus ?? ""}
            onFocus={onFocus}
          />
        ) : null}
      </div>
    </div>
  );
}
