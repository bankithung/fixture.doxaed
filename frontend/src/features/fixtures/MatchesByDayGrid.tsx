import { useMemo } from "react";
import type { PreviewMatch } from "@/api/tournaments";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { sideName } from "./sideName";

/** Token-only accent palette — one left-border colour per competition so
 * multi-sport days stay scannable (no hardcoded hex, design system rule). */
const LEAF_ACCENTS = [
  "border-l-primary",
  "border-l-info",
  "border-l-success",
  "border-l-warning",
  "border-l-destructive",
] as const;

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtTime(iso: string): string {
  // Preview times are tournament-local wall clock (invariant 14) — show the
  // wall-clock value verbatim, never viewer-TZ shifted.
  return iso.slice(11, 16);
}

function Chip({
  match,
  accent,
  teamNames,
}: {
  match: PreviewMatch;
  accent: string;
  teamNames: ReadonlyMap<string, string>;
}): React.ReactElement {
  return (
    <div
      data-testid={`chip-${match.ref}`}
      className={cn(
        "flex flex-col gap-0.5 rounded-lg border border-border border-l-2 bg-card px-2.5 py-1.5 shadow-sm",
        accent,
      )}
    >
      <span className="font-tabular text-[0.6875rem] text-muted-foreground">
        {match.scheduled_at ? fmtTime(match.scheduled_at) : "—"}
        {match.group_label ? ` · ${match.group_label}` : ""}
        {match.round_no ? (
          <> · {t("R")}{match.round_no}</>
        ) : null}
      </span>
      <span className="truncate text-sm">
        <span className="font-medium">{sideName(match.home, teamNames)}</span>
        <span className="text-muted-foreground"> {t("vs")} </span>
        <span className="font-medium">{sideName(match.away, teamNames)}</span>
      </span>
    </div>
  );
}

/**
 * The dry-run preview's days × venues grid (redesign §6 screen 5): one band
 * per day, one column per venue used that day, competition-coloured chips.
 * Stacks into a flat time-ordered list on mobile (useBreakpoint).
 */
export function MatchesByDayGrid({
  matches,
  teamNames,
}: {
  matches: PreviewMatch[];
  /** team_id → display name (the preview carries ids only). */
  teamNames: ReadonlyMap<string, string>;
}): React.ReactElement {
  const { isMobile } = useBreakpoint();

  const { days, accentOf } = useMemo(() => {
    const scheduled = matches
      .filter((m) => m.scheduled_at)
      .sort((a, b) => (a.scheduled_at! < b.scheduled_at! ? -1 : 1));
    const byDay = new Map<string, Map<string, PreviewMatch[]>>();
    const accents = new Map<string, string>();
    for (const m of scheduled) {
      if (!accents.has(m.leaf_key)) {
        accents.set(m.leaf_key, LEAF_ACCENTS[accents.size % LEAF_ACCENTS.length]);
      }
      const day = m.scheduled_at!.slice(0, 10);
      const venue = m.venue || t("Unassigned venue");
      if (!byDay.has(day)) byDay.set(day, new Map());
      const venues = byDay.get(day)!;
      if (!venues.has(venue)) venues.set(venue, []);
      venues.get(venue)!.push(m);
    }
    return {
      days: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      accentOf: (leaf: string) => accents.get(leaf) ?? LEAF_ACCENTS[0],
    };
  }, [matches]);

  if (days.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("No matches were scheduled in this preview.")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {days.map(([day, venues]) => (
        <section
          key={day}
          data-testid={`day-${day}`}
          className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
        >
          <h3 className="border-b border-border bg-muted/40 px-4 py-2 text-sm font-semibold">
            {fmtDay(day)}
            <span className="ml-2 font-tabular text-xs font-normal text-muted-foreground">
              {[...venues.values()].reduce((n, ms) => n + ms.length, 0)}{" "}
              {t("matches")}
            </span>
          </h3>
          {isMobile ? (
            <div className="flex flex-col gap-2 px-3 py-3">
              {[...venues.entries()].flatMap(([venue, ms]) =>
                ms.map((m) => (
                  <div key={m.ref} className="flex flex-col gap-0.5">
                    <Chip match={m} accent={accentOf(m.leaf_key)} teamNames={teamNames} />
                    <span className="px-1 text-[0.6875rem] text-muted-foreground">
                      {venue}
                    </span>
                  </div>
                )),
              )}
            </div>
          ) : (
            <div
              className="grid gap-3 px-4 py-3"
              style={{
                gridTemplateColumns: `repeat(${Math.min(venues.size, 4)}, minmax(0, 1fr))`,
              }}
            >
              {[...venues.entries()].map(([venue, ms]) => (
                <div key={venue} className="flex min-w-0 flex-col gap-1.5">
                  <h4 className="truncate text-xs font-medium text-muted-foreground">
                    {venue}
                  </h4>
                  {ms.map((m) => (
                    <Chip
                      key={m.ref}
                      match={m}
                      accent={accentOf(m.leaf_key)}
                      teamNames={teamNames}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
