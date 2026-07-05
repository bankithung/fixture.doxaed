import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Radio, Trophy } from "lucide-react";
import { api } from "@/api/client";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

interface DirectoryRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  season: string;
  starts_at: string | null;
  ends_at: string | null;
  sports: string[];
  live_now: boolean;
}

function fmtRange(a: string | null, b: string | null): string {
  if (!a) return "";
  const opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short" };
  const from = new Date(a).toLocaleDateString([], opts);
  if (!b || a === b) return from;
  return `${from} to ${new Date(b).toLocaleDateString([], opts)}`;
}

/** Public tournament directory — how a cold visitor finds live sport. */
export function ExplorePage(): React.ReactElement {
  const q = useQuery({
    queryKey: ["explore"],
    queryFn: () =>
      api.get<{ tournaments: DirectoryRow[] }>("/api/public/tournaments/"),
    staleTime: 60_000,
  });
  useEffect(() => {
    document.title = t("Explore tournaments · Fixture");
  }, []);

  const rows = q.data?.tournaments ?? [];
  const live = rows.filter((r) => r.live_now);
  const rest = rows.filter((r) => !r.live_now);

  return (
    <div className="min-h-screen text-foreground">
      <header className="flex h-14 items-center gap-3 border-b border-border bg-card px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <Trophy aria-hidden="true" className="h-5 w-5 text-primary" />
          {t("Fixture")}
        </Link>
        <span className="text-sm text-muted-foreground">{t("Explore")}</span>
        <span className="ml-auto">
          <ThemeToggle />
        </span>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {t("Tournaments")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("Follow live scores, schedules, standings and brackets.")}
          </p>
        </div>

        {q.isLoading ? (
          <div className="h-40 animate-pulse rounded-xl border border-border bg-card" />
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-card px-5 py-8 text-center text-sm text-muted-foreground">
            {t("No public tournaments right now. Check back soon.")}
          </p>
        ) : (
          <>
            {live.length > 0 ? (
              <section className="flex flex-col gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                  </span>
                  {t("Live now")}
                </h2>
                <ul className="flex flex-col gap-2">
                  {live.map((r) => (
                    <DirectoryCard key={r.id} row={r} />
                  ))}
                </ul>
              </section>
            ) : null}
            <section className="flex flex-col gap-2">
              {live.length > 0 ? (
                <h2 className="text-sm font-semibold text-muted-foreground">
                  {t("All tournaments")}
                </h2>
              ) : null}
              <ul className="flex flex-col gap-2">
                {rest.map((r) => (
                  <DirectoryCard key={r.id} row={r} />
                ))}
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function DirectoryCard({ row }: { row: DirectoryRow }): React.ReactElement {
  return (
    <li>
      <Link
        to={routes.publicSchedule(row.slug, row.id)}
        className={cn(
          "flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm transition-colors hover:bg-accent",
          row.live_now && "border-primary/40",
        )}
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10">
          {row.live_now ? (
            <Radio aria-hidden="true" className="h-5 w-5 text-primary" />
          ) : (
            <Trophy aria-hidden="true" className="h-5 w-5 text-primary" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{row.name}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {row.starts_at ? (
              <span className="inline-flex items-center gap-1">
                <CalendarDays aria-hidden="true" className="h-3 w-3" />
                {fmtRange(row.starts_at, row.ends_at)}
              </span>
            ) : null}
            {row.sports.filter(Boolean).slice(0, 3).map((s) => (
              <span key={s} className="rounded-md bg-muted px-1.5 py-0.5">
                {s}
              </span>
            ))}
          </span>
        </span>
        {row.live_now ? (
          <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary">
            {t("Live")}
          </span>
        ) : null}
      </Link>
    </li>
  );
}
