import { TeamCrest } from "@/components/ui/TeamCrest";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { MedalCount } from "./MedalChip";

/**
 * The points standing, as bars.
 *
 * The tally below already lists every number; what a column of numbers cannot
 * show is DISTANCE — that the leader is two schools clear, or that the top four
 * are level. That is the whole job of this chart, so it carries one measure in
 * one hue and nothing else: colouring bars by rank would encode the ordering
 * twice, and stacking them by medal would repeat the columns beside them.
 *
 * Every bar is directly labelled with its points and its medals, so nothing
 * here is hover-only — a chart whose numbers live in a tooltip is unreadable on
 * the phone most of this audience holds.
 */
export function PointsChart({
  bars,
  places,
  labelOf,
}: {
  bars: {
    id: string;
    name: string;
    crest: string;
    points: number;
    medals: Record<string, number>;
    share: number;
  }[];
  places: number[];
  labelOf: (place: number) => string;
}): React.ReactElement | null {
  if (!bars.length) return null;
  return (
    <figure
      className="flex flex-col gap-2"
      data-testid="points-chart"
      aria-label={t("Points by school")}
    >
      <ol className="flex flex-col gap-1.5">
        {bars.map((bar, i) => (
          <li key={bar.id} className="flex items-center gap-2 sm:gap-3">
            <span className="w-5 shrink-0 text-right font-tabular text-xs text-muted-foreground">
              {i + 1}
            </span>
            <span className="flex w-28 min-w-28 items-center gap-1.5 sm:w-52 sm:min-w-52">
              <TeamCrest src={bar.crest} name={bar.name} size="sm" />
              <span className="truncate text-xs font-medium" title={bar.name}>
                {bar.name}
              </span>
            </span>
            <span className="relative flex h-5 min-w-0 flex-1 items-center">
              <span
                aria-hidden="true"
                className={cn(
                  "h-4 rounded-r bg-chart-1 transition-[width] duration-500",
                  bar.share >= 0.999 && "rounded-r",
                )}
                style={{ width: `${Math.max(2, bar.share * 100)}%` }}
              />
              <span className="ml-2 font-tabular text-xs font-semibold">
                {bar.points}
                <span className="sr-only"> {t("points")}</span>
              </span>
            </span>
            <span className="hidden shrink-0 items-center gap-2 sm:flex">
              {places.map((p) => (
                <MedalCount
                  key={p}
                  place={p}
                  count={bar.medals[String(p)] ?? 0}
                  label={labelOf(p)}
                />
              ))}
            </span>
          </li>
        ))}
      </ol>
      <figcaption className="text-xs text-muted-foreground">
        {t("Points from every competition decided so far.")}
      </figcaption>
    </figure>
  );
}
