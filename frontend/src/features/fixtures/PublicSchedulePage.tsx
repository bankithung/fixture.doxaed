import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  tournamentsApi,
  type PublicScheduleMatch,
} from "@/api/tournaments";
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
export function fmtKickoff(iso: string | null, timeZone: string): string {
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

/**
 * Public, read-only tournament schedule (trust layer, increment H): grouped
 * by day, auto-refreshing every 60s, mobile-first and rendered in its own
 * minimal chrome (no app sidebar — it lives outside the authenticated shell,
 * like the /m/ live viewer).
 */
export function PublicSchedulePage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const query = useQuery({
    queryKey: ["public-schedule", slug, id],
    queryFn: () => tournamentsApi.publicSchedule(slug, id),
    refetchInterval: 60_000,
  });

  const tz = query.data?.tournament.time_zone ?? "UTC";

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

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center gap-2 border-b border-border bg-card px-4 sm:px-6">
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
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-xl font-semibold tracking-tight">
                {query.data.tournament.name}
              </h1>
              <span className="font-tabular text-xs text-muted-foreground">
                {query.data.matches.length} {t("matches")} ·{" "}
                {t("updates automatically")}
              </span>
            </div>

            {days.length === 0 && unscheduled.length === 0 ? (
              <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
                {t("No matches have been scheduled yet — check back soon.")}
              </p>
            ) : null}

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
          </>
        )}
      </main>
    </div>
  );
}
