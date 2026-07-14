import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { ScheduleChangesPanel } from "@/features/fixtures/ScheduleChangesPanel";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/** One number of the audit summary. */
function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "warning";
}): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1 px-5 py-3.5">
      <p className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p
        className={
          tone === "warning"
            ? "font-tabular text-2xl font-semibold leading-none text-warning"
            : "font-tabular text-2xl font-semibold leading-none"
        }
      >
        {value}
      </p>
    </div>
  );
}

/**
 * The full schedule change history (audit feed) as its own page: the Today
 * board's tab shows the latest 20; this is where "View all" lands, with the
 * summary band, the competition and kind filters, and paging.
 */
export function ChangeHistoryPage(): React.ReactElement {
  const { id = "" } = useParams();
  // Competitions for the filter come from the same control-room payload the
  // Today page uses (cached when arriving from there).
  const cr = useQuery({
    queryKey: qk.controlRoom(id),
    queryFn: () => tournamentsApi.controlRoom(id),
  });
  const competitions = useMemo(() => {
    const by = new Map<string, string>();
    for (const v of cr.data?.venues ?? []) {
      for (const m of v.matches) {
        if (m.leaf_key && !by.has(m.leaf_key)) by.set(m.leaf_key, m.leaf_label);
      }
    }
    return [...by.entries()].map(([leafKey, label]) => ({
      leafKey,
      label: label || leafKey,
    }));
  }, [cr.data]);

  // A cheap summary of the whole feed, independent of the panel's own paging:
  // how much has moved, how much of it slipped, and who has been touching it.
  const all = useQuery({
    queryKey: [...qk.scheduleChanges(id), "summary"],
    queryFn: () => tournamentsApi.scheduleChanges(id, { limit: 500 }),
  });
  const summary = useMemo(() => {
    const rows = all.data?.results ?? [];
    const moved = rows.filter((e) => Boolean(e.old?.scheduled_at)).length;
    const delayed = rows.filter(
      (e) => e.kind === "delayed" || e.kind === "day_shifted",
    ).length;
    const people = new Set(
      rows.map((e) => e.actor?.email).filter(Boolean) as string[],
    ).size;
    const last = rows[0]?.changed_at ?? null;
    return { total: rows.length, moved, delayed, people, last };
  }, [all.data]);

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link
          to={routes.tournamentControl(id)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Today")}
        </Link>
        <h2 className="page-title">{t("Change history")}</h2>
        <span className="text-xs text-muted-foreground">
          {t("Who changed each time or venue, and why.")}
        </span>
        {summary.last ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {t("Last change")}{" "}
            <span className="font-tabular text-foreground">
              {new Date(summary.last).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </span>
        ) : null}
      </div>

      <div
        data-testid="changes-summary"
        className="panel grid grid-cols-2 divide-border max-lg:divide-y lg:grid-cols-4 lg:divide-x"
      >
        <Stat label={t("Changes")} value={summary.total} />
        <Stat label={t("Matches moved")} value={summary.moved} />
        <Stat
          label={t("Delayed or shifted")}
          value={summary.delayed}
          tone={summary.delayed > 0 ? "warning" : undefined}
        />
        <Stat label={t("People")} value={summary.people} />
      </div>

      <ScheduleChangesPanel tournamentId={id} competitions={competitions} />
    </div>
  );
}
