import { Images } from "lucide-react";
import { t } from "@/lib/t";
import type { OrbitSchool } from "./SchoolOrbit";
import "./universe.css";

/**
 * The orbit, flattened for a thumb. Twelve schools cannot orbit inside a
 * 390px stage without collapsing into a pile of overlapping labels, so below
 * `lg` the planets line up on a scrollable rail instead — same bodies, same
 * one-tap zoom, no aiming at a moving target.
 */
export function PlanetRail({
  schools,
  total,
  focus,
  onFocus,
}: {
  schools: OrbitSchool[];
  total: number;
  /** "" = every school. */
  focus: string;
  onFocus: (school: string) => void;
}): React.ReactElement {
  return (
    <div
      data-testid="planet-rail"
      aria-label={t("Schools")}
      className="planet-rail flex gap-3 overflow-x-auto px-3 pb-3 pt-2"
    >
      <button
        type="button"
        data-testid="planet-rail-all"
        onClick={() => onFocus("")}
        className="flex w-14 shrink-0 flex-col items-center gap-1 focus-visible:outline-none"
      >
        <span
          data-selected={focus === "" ? "true" : undefined}
          className="planet-chip planet-chip--all"
        >
          <Images aria-hidden="true" className="h-5 w-5" />
        </span>
        <span className="w-full truncate text-center text-[0.625rem] font-medium text-white/80">
          {t("All")} {total}
        </span>
      </button>

      {schools.map((s) => (
        <button
          key={s.name}
          type="button"
          data-testid={`planet-chip-${s.name}`}
          onClick={() => onFocus(s.name)}
          className="flex w-14 shrink-0 flex-col items-center gap-1 focus-visible:outline-none"
        >
          <span
            data-selected={focus === s.name ? "true" : undefined}
            className="planet-chip"
          >
            <img src={s.cover} alt="" loading="lazy" decoding="async" />
          </span>
          <span className="w-full truncate text-center text-[0.625rem] font-medium text-white/80">
            {s.name}
          </span>
        </button>
      ))}
    </div>
  );
}
