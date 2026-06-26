import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Radio, UserCog } from "lucide-react";
import { tournamentsApi, type ControlRoomMatch } from "@/api/tournaments";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/button";
import { AssignDrawer } from "@/features/controlroom/AssignDrawer";
import { fmtDayLabel, fmtKickoff } from "@/features/controlroom/format";
import { useControlRoom } from "@/features/controlroom/useControlRoom";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";

const ROLE_ABBR: Record<string, string> = {
  referee: "Ref",
  assistant: "AR",
  fourth: "4th",
  umpire: "Ump",
  commissioner: "Comm",
};

type Filter = "all" | "needs_scorer" | "needs_official";

function CrewRow({
  match,
  tz,
  canAssign,
  onAssign,
}: {
  match: ControlRoomMatch;
  tz: string;
  canAssign: boolean;
  onAssign: () => void;
}): React.ReactElement {
  const officials = match.officials ?? [];
  return (
    <div
      data-testid={`crew-row-${match.id}`}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-sm sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="font-tabular text-sm font-semibold tabular-nums">
          {match.scheduled_at ? fmtKickoff(match.scheduled_at, tz) : t("TBD")}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {(match.home_team?.name ?? t("TBD")) +
              " v " +
              (match.away_team?.name ?? t("TBD"))}
          </p>
          <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            {match.leaf_label ? <span>{match.leaf_label}</span> : null}
            {match.venue ? (
              <span className="inline-flex items-center gap-0.5">
                <MapPin aria-hidden="true" className="h-3 w-3" />
                {match.venue}
              </span>
            ) : null}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {match.scorer ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
            <Radio aria-hidden="true" className="h-3 w-3" />
            {match.scorer.name}
          </span>
        ) : (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[0.6875rem] font-medium text-amber-700 dark:text-amber-400">
            {t("No scorer")}
          </span>
        )}
        {officials.map((o) => (
          <span
            key={o.id}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] text-muted-foreground"
          >
            <UserCog aria-hidden="true" className="h-3 w-3" />
            {o.name}
            <span className="text-muted-foreground/70">
              {ROLE_ABBR[o.role] ?? o.role}
            </span>
          </span>
        ))}
        {officials.length === 0 ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[0.6875rem] font-medium text-amber-700 dark:text-amber-400">
            {t("No official")}
          </span>
        ) : null}
        {canAssign ? (
          <Button
            size="sm"
            variant="outline"
            data-testid={`crew-assign-${match.id}`}
            onClick={onAssign}
          >
            <UserCog aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Assign")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Operations: Officials & assignments cockpit (ops 2026-06-26). The day's
 * matches with their crew (scorer + officials), a coverage summary, and
 * filters for what still needs a scorer or an official. Assign inline via the
 * shared AssignDrawer. Rides the control-room SSE loop, so coverage updates as
 * assignments land. Gated to schedule editors by the nav; the Assign action is
 * additionally permission-checked here (and on the server).
 */
export function CrewPage(): React.ReactElement {
  const { id = "" } = useParams();
  const { isMobile } = useBreakpoint();
  const [day, setDay] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [assignMatch, setAssignMatch] = useState<ControlRoomMatch | null>(null);

  const stageQ = useQuery({
    queryKey: qk.stage(id),
    queryFn: () => tournamentsApi.stage(id),
  });
  const canAssign =
    (stageQ.data?.can_manage ?? false) ||
    (stageQ.data?.modules ?? []).includes("tournament.schedule_editor");

  const { query } = useControlRoom(id, day);
  const data = query.data;
  const tz = data?.tournament.time_zone ?? "UTC";
  const selectedDay = day ?? data?.day ?? "";

  const all = useMemo(
    () => (data?.venues ?? []).flatMap((v) => v.matches),
    [data],
  );
  const withScorer = all.filter((m) => m.scorer).length;
  const withOfficial = all.filter((m) => (m.officials ?? []).length > 0).length;
  const filtered = all.filter((m) => {
    if (filter === "needs_scorer") return !m.scorer;
    if (filter === "needs_official") return (m.officials ?? []).length === 0;
    return true;
  });

  const header = (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10">
        <UserCog aria-hidden="true" className="h-5 w-5 text-primary" />
      </span>
      <div>
        <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {t("Operations")}
        </p>
        <h2 className="text-lg font-semibold tracking-tight">
          {t("Officials & assignments")}
        </h2>
      </div>
    </div>
  );

  if (query.isLoading) {
    return (
      <div className="flex w-full flex-col gap-5">
        {header}
        <div className="h-48 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }
  if (query.isError || !data || data.days.length === 0) {
    return (
      <div className="flex w-full flex-col gap-5">
        {header}
        <p className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          {t("Nothing is on the calendar yet.")}
        </p>
      </div>
    );
  }

  const FILTERS: { key: Filter; label: string }[] = [
    { key: "all", label: t("All") },
    { key: "needs_scorer", label: t("Needs scorer") },
    { key: "needs_official", label: t("Needs official") },
  ];

  return (
    <div className="flex w-full flex-col gap-5">
      {header}

      {/* Coverage */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border">
        <div className="flex flex-col bg-card p-4">
          <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {t("Scorer coverage")}
          </p>
          <p className="mt-1 font-tabular text-2xl font-semibold leading-none">
            {withScorer}
            <span className="text-muted-foreground">/{all.length}</span>
          </p>
        </div>
        <div className="flex flex-col bg-card p-4">
          <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {t("Official coverage")}
          </p>
          <p className="mt-1 font-tabular text-2xl font-semibold leading-none">
            {withOfficial}
            <span className="text-muted-foreground">/{all.length}</span>
          </p>
        </div>
      </div>

      {/* Day + filter */}
      <div className="flex flex-wrap items-center gap-2">
        {isMobile ? (
          <Select
            aria-label={t("Match day")}
            className="w-full"
            value={selectedDay}
            onChange={(v) => setDay(v)}
            options={data.days.map((d) => ({
              value: d.date,
              label: fmtDayLabel(d.date),
            }))}
          />
        ) : (
          <div role="group" aria-label={t("Match day")} className="flex flex-wrap gap-1.5">
            {data.days.map((d) => {
              const active = d.date === selectedDay;
              return (
                <button
                  key={d.date}
                  type="button"
                  data-testid={`crew-day-${d.date}`}
                  aria-pressed={active}
                  onClick={() => setDay(d.date)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-foreground hover:bg-accent",
                  )}
                >
                  {fmtDayLabel(d.date)}
                </button>
              );
            })}
          </div>
        )}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              data-testid={`crew-filter-${f.key}`}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter === f.key
                  ? "border-foreground/30 bg-secondary text-secondary-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-accent",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Rows */}
      {filtered.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          {t("Nothing matches this filter.")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((m) => (
            <CrewRow
              key={m.id}
              match={m}
              tz={tz}
              canAssign={canAssign}
              onAssign={() => setAssignMatch(m)}
            />
          ))}
        </div>
      )}

      {assignMatch ? (
        <AssignDrawer
          tournamentId={id}
          match={assignMatch}
          onClose={() => setAssignMatch(null)}
        />
      ) : null}
    </div>
  );
}
