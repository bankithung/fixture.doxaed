import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import {
  tournamentsApi,
  type PublicScheduleMatch,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/Select";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const LIVE_STATUSES = new Set(["live", "half_time", "extra_time", "penalties"]);
const FINAL_STATUSES = new Set(["completed", "walkover"]);

function statusMeta(status: string): { label: string; cls: string; live: boolean } {
  if (LIVE_STATUSES.has(status)) {
    return {
      label: status === "half_time" ? "Half time" : "Live",
      cls: "bg-primary/15 text-primary",
      live: true,
    };
  }
  if (FINAL_STATUSES.has(status)) {
    return {
      label: status === "walkover" ? "Walkover" : "Full time",
      cls: "bg-accent text-accent-foreground",
      live: false,
    };
  }
  if (status === "postponed" || status === "abandoned") {
    return {
      label: status,
      cls: "bg-warning-muted text-warning-foreground",
      live: false,
    };
  }
  return {
    label: status.replace(/_/g, " "),
    cls: "bg-secondary text-secondary-foreground",
    live: false,
  };
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** Kick-off in the TOURNAMENT's wall clock (invariant 14 — the schedule of a
 * physical event reads in event-local time, matching the `day` grouping). */
function fmtKickoff(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

function StatusPill({ status }: { status: string }): React.ReactElement {
  const sm = statusMeta(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium capitalize",
        sm.cls,
      )}
    >
      {sm.live ? (
        <span className="relative flex h-2 w-2" data-testid="live-pulse">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
      ) : null}
      {t(sm.label)}
    </span>
  );
}

function MatchCard({
  match,
  timeZone,
}: {
  match: PublicScheduleMatch;
  timeZone: string;
}): React.ReactElement {
  const done = FINAL_STATUSES.has(match.status) || LIVE_STATUSES.has(match.status);
  return (
    <li
      data-testid={`public-match-${match.id}`}
      className="flex flex-col gap-1.5 border-t border-border px-4 py-3 first:border-t-0"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-tabular font-semibold text-foreground">
          {fmtKickoff(match.scheduled_at, timeZone)}
        </span>
        {match.venue ? <span>{match.venue}</span> : null}
        {match.leaf_label ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[0.6875rem]">
            {match.leaf_label}
          </span>
        ) : null}
        {match.group_label ? <span>{match.group_label}</span> : null}
        <span className="ml-auto">
          <StatusPill status={match.status} />
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
        <span className="truncate text-right font-medium">
          {match.home?.name ?? t("TBD")}
        </span>
        <span
          className={cn(
            "px-1 text-center font-tabular",
            done ? "font-semibold" : "text-xs text-muted-foreground",
          )}
        >
          {done
            ? `${match.home_score ?? 0} – ${match.away_score ?? 0}`
            : t("vs")}
        </span>
        <span className="truncate font-medium">
          {match.away?.name ?? t("TBD")}
        </span>
      </div>
    </li>
  );
}

function stageLabel(m: PublicScheduleMatch): string {
  if (m.group_label) return m.group_label;
  if (m.stage === "knockout") return `${t("R")}${m.round_no}`;
  return m.stage;
}

/**
 * Print-only order-of-play for ONE chosen day (increment L): grouped by
 * venue then kick-off time, one page per venue (`break-after-page`), plain
 * B&W tables (index.css forces a white sheet under `@media print`). Hidden
 * on screen; the screen content is `print:hidden` in turn.
 */
function PrintSheet({
  day,
  matches,
  tournamentName,
  timeZone,
}: {
  day: string;
  matches: PublicScheduleMatch[];
  tournamentName: string;
  timeZone: string;
}): React.ReactElement | null {
  const venues = useMemo(() => {
    const by = new Map<string, PublicScheduleMatch[]>();
    const ordered = [...matches].sort((a, b) =>
      (a.scheduled_at ?? "") < (b.scheduled_at ?? "") ? -1 : 1,
    );
    for (const m of ordered) {
      const v = m.venue || t("Unassigned venue");
      if (!by.has(v)) by.set(v, []);
      by.get(v)!.push(m);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [matches]);

  if (venues.length === 0) return null;
  return (
    <div data-testid="print-sheet" className="hidden print:block">
      {venues.map(([venue, ms]) => (
        <section
          key={venue}
          data-testid={`print-venue-${venue}`}
          className="break-after-page pb-6 last:break-after-auto"
        >
          <h1 className="text-lg font-bold">
            {tournamentName} — {t("Order of play")}
          </h1>
          <p className="pb-3 text-sm">
            {fmtDay(day)} · {venue}
          </p>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {[t("Time"), t("Match"), t("Competition"), t("Stage")].map(
                  (h) => (
                    <th
                      key={h}
                      className="border-b-2 border-border py-1 pr-3 text-left font-semibold"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {ms.map((m) => (
                <tr key={m.id}>
                  <td className="border-b border-border py-1 pr-3 font-tabular">
                    {fmtKickoff(m.scheduled_at, timeZone)}
                  </td>
                  <td className="border-b border-border py-1 pr-3">
                    {m.home?.name ?? t("TBD")} {t("vs")}{" "}
                    {m.away?.name ?? t("TBD")}
                  </td>
                  <td className="border-b border-border py-1 pr-3">
                    {m.leaf_label}
                  </td>
                  <td className="border-b border-border py-1">
                    {stageLabel(m)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

/**
 * Public, read-only tournament schedule (trust layer, increment H): grouped
 * by day, auto-refreshing every 60s, mobile-first and rendered in its own
 * minimal chrome (no app sidebar — it lives outside the authenticated shell,
 * like the /m/ live viewer). A day picker + Print button render a per-venue
 * order-of-play through the print stylesheet (increment L).
 */
export function PublicSchedulePage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const query = useQuery({
    queryKey: ["public-schedule", slug, id],
    queryFn: () => tournamentsApi.publicSchedule(slug, id),
    refetchInterval: 60_000,
  });

  const tz = query.data?.tournament.time_zone ?? "UTC";
  const [printDay, setPrintDay] = useState("");

  const { days, unscheduled } = useMemo(() => {
    const byDay = new Map<string, PublicScheduleMatch[]>();
    const loose: PublicScheduleMatch[] = [];
    for (const m of query.data?.matches ?? []) {
      if (!m.day) {
        loose.push(m);
        continue;
      }
      if (!byDay.has(m.day)) byDay.set(m.day, []);
      byDay.get(m.day)!.push(m);
    }
    return {
      days: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      unscheduled: loose,
    };
  }, [query.data]);

  /** Day the print sheet renders: picked, else the first scheduled day. */
  const effectivePrintDay = printDay || days[0]?.[0] || "";
  const printMatches =
    days.find(([d]) => d === effectivePrintDay)?.[1] ?? [];

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center gap-2 border-b border-border bg-card px-4 print:hidden sm:px-6">
        <Link
          to={routes.landing()}
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            F
          </span>
          {t("Fixture")}
        </Link>
        <span className="ml-2 truncate text-sm text-muted-foreground">
          {query.data?.tournament.name ?? t("Schedule")}
        </span>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
        {query.isLoading ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="h-36 animate-pulse rounded-xl border border-border bg-card"
              />
            ))}
          </div>
        ) : query.isError || !query.data ? (
          <p
            role="alert"
            className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground"
          >
            {t("This schedule is not available.")}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 print:hidden">
              <h1 className="text-xl font-semibold tracking-tight">
                {query.data.tournament.name}
              </h1>
              <span className="font-tabular text-xs text-muted-foreground">
                {query.data.matches.length} {t("matches")} ·{" "}
                {t("updates automatically")}
              </span>
            </div>

            {days.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 print:hidden">
                <span className="text-xs text-muted-foreground">
                  {t("Order of play")}
                </span>
                <Select
                  size="sm"
                  className="w-48"
                  aria-label={t("Day to print")}
                  value={effectivePrintDay}
                  onChange={setPrintDay}
                  options={days.map(([d]) => ({ value: d, label: fmtDay(d) }))}
                />
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="print-button"
                  onClick={() => window.print()}
                >
                  <Printer aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Print")}
                </Button>
              </div>
            ) : null}

            {days.length === 0 && unscheduled.length === 0 ? (
              <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
                {t("No matches have been scheduled yet — check back soon.")}
              </p>
            ) : null}

            <div className="flex flex-col gap-4 print:hidden">
            {days.map(([day, ms]) => (
              <section
                key={day}
                data-testid={`public-day-${day}`}
                className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
              >
                <h2 className="border-b border-border bg-muted/40 px-4 py-2.5 text-sm font-semibold">
                  {fmtDay(day)}
                  <span className="ml-2 font-tabular text-xs font-normal text-muted-foreground">
                    {ms.length} {ms.length === 1 ? t("match") : t("matches")}
                  </span>
                </h2>
                <ul>
                  {ms.map((m) => (
                    <MatchCard key={m.id} match={m} timeZone={tz} />
                  ))}
                </ul>
              </section>
            ))}

            {unscheduled.length ? (
              <section
                data-testid="public-unscheduled"
                className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
              >
                <h2 className="border-b border-border bg-muted/40 px-4 py-2.5 text-sm font-semibold">
                  {t("Awaiting a slot")}
                </h2>
                <ul>
                  {unscheduled.map((m) => (
                    <MatchCard key={m.id} match={m} timeZone={tz} />
                  ))}
                </ul>
              </section>
            ) : null}
            </div>

            {effectivePrintDay ? (
              <PrintSheet
                day={effectivePrintDay}
                matches={printMatches}
                tournamentName={query.data.tournament.name}
                timeZone={tz}
              />
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
