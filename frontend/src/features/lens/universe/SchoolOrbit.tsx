import { useLayoutEffect, useMemo, useRef } from "react";
import { Images } from "lucide-react";
import { t } from "@/lib/t";
import { planOrbit } from "./geometry";
import "./universe.css";

/**
 * Stage one of the album: one planet per school, orbiting the whole album.
 * Sizing is by photo count — a school that shot the event hard is a bigger
 * body — and picking one zooms the camera into its photo sphere.
 *
 * Everything here is CSS keyframes on the compositor. JS measures the stage
 * once (and on resize) to write three custom properties; there is no rAF loop
 * and no re-render while the system turns.
 */

export interface OrbitSchool {
  name: string;
  count: number;
  /** Thumbnail that stands for the school — its award shot where it has one. */
  cover: string;
}

export function SchoolOrbit({
  schools,
  total,
  onPick,
  onPickAll,
  zooming = false,
  still = false,
}: {
  schools: OrbitSchool[];
  /** Photos in the whole album — the number on the sun. */
  total: number;
  onPick: (school: string) => void;
  onPickAll: () => void;
  /** True for the beat between a pick and the sphere taking over. */
  zooming?: boolean;
  /** Parks the whole system — the stage's pause switch. */
  still?: boolean;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const slots = useMemo(() => planOrbit(schools.length), [schools.length]);
  const busiest = useMemo(
    () => schools.reduce((m, s) => Math.max(m, s.count), 1),
    [schools],
  );

  // Planet scale and ring radius both come from the measured stage: the outer
  // ring has to clear its own planets' width, or the system clips.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (): void => {
      const w = el.clientWidth || 900;
      const h = el.clientHeight || 520;
      const flat = 0.42;
      const pMax = Math.round(Math.min(104, Math.max(44, Math.min(w, h) * 0.16)));
      const pMin = Math.round(pMax * 0.62);
      // 0.94 is the outermost ring's radius fraction, so solve for the unit
      // that leaves half a planet plus a label inside the stage on both axes.
      const byWidth = (w / 2 - pMax / 2 - 12) / 0.94;
      const byHeight = (h / 2 - pMax / 2 - 26) / (0.94 * flat);
      const unit = Math.max(64, Math.min(byWidth, byHeight));
      el.style.setProperty("--orbit-unit", `${Math.round(unit)}px`);
      el.style.setProperty("--p-max", `${pMax}px`);
      el.style.setProperty("--p-min", `${pMin}px`);
      el.style.setProperty("--sun", `${Math.round(pMax * 1.18)}px`);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-testid="album-orbit"
      data-zooming={zooming ? "true" : undefined}
      data-still={still ? "true" : undefined}
      className="orbit"
    >
      <div className="orbit__plane" aria-hidden="true">
        {[...new Set(slots.map((s) => s.radius))].map((r) => (
          <div
            key={r}
            className="orbit__track"
            style={{ "--r": r } as React.CSSProperties}
          />
        ))}
      </div>

      <button
        type="button"
        data-testid="orbit-sun"
        className="orbit__sun"
        onClick={onPickAll}
      >
        <Images aria-hidden="true" className="h-5 w-5" />
        <span className="font-tabular text-xs font-semibold leading-none">
          {total}
        </span>
        <span className="text-[0.5625rem] font-medium uppercase tracking-[0.14em] opacity-80">
          {t("All")}
        </span>
      </button>

      <div className="orbit__plane">
        {slots.map((slot, i) => {
          const school = schools[i];
          if (!school) return null;
          const weight = school.count / busiest;
          return (
            <div
              key={school.name}
              className="orbit__lane"
              style={
                {
                  "--angle": `${slot.angle}deg`,
                  "--r": slot.radius,
                  "--period": `${slot.period}s`,
                } as React.CSSProperties
              }
            >
              <div className="orbit__lap">
                <div className="orbit__arm">
                  <div className="orbit__unlap">
                    <div
                      className="orbit__shell"
                      style={
                        {
                          "--size": `calc(var(--p-min) + (var(--p-max) - var(--p-min)) * ${weight.toFixed(3)})`,
                        } as React.CSSProperties
                      }
                    >
                      <button
                        type="button"
                        data-testid={`orbit-planet-${school.name}`}
                        className="orbit__planet"
                        onClick={() => onPick(school.name)}
                      >
                        <img
                          src={school.cover}
                          alt=""
                          draggable={false}
                          loading="lazy"
                          decoding="async"
                        />
                      </button>
                      <span className="orbit__label text-[0.6875rem] font-medium leading-tight">
                        {school.name}
                        <span className="ml-1 font-tabular opacity-60">
                          {school.count}
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
