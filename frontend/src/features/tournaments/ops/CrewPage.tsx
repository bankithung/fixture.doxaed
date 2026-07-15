import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Radio, UserCog, Users } from "lucide-react";
import {
  tournamentsApi,
  type ControlRoomMatch,
  type ControlRoomVenue,
} from "@/api/tournaments";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/button";
import { AssignDrawer } from "@/features/controlroom/AssignDrawer";
import { BulkAssignDialog } from "./BulkAssignDialog";
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

/** A venue tab's slug (empty venue → "none") for testids + tab keys. */
function venueSlug(venue: string): string {
  return venue ? venue.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") : "none";
}

/** Whether a match still wants a scorer and/or an official. */
function isFullyStaffed(m: ControlRoomMatch): boolean {
  return Boolean(m.scorer) && (m.officials ?? []).length > 0;
}

function passesFilter(m: ControlRoomMatch, filter: Filter): boolean {
  if (filter === "needs_scorer") return !m.scorer;
  if (filter === "needs_official") return (m.officials ?? []).length === 0;
  return true;
}

/**
 * A single match line inside a court's band: kickoff, the matchup, its
 * competition leaf, then the crew (scorer + officials) or the gaps, and the
 * inline Assign action for editors. The court itself is the band header, so it
 * is intentionally not repeated on every row.
 */
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
      className="flex flex-col gap-2 px-4 py-2.5 transition-colors hover:bg-secondary/30 sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="w-11 shrink-0 font-tabular text-sm font-semibold tabular-nums text-muted-foreground">
          {match.scheduled_at ? fmtKickoff(match.scheduled_at, tz) : t("TBD")}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {(match.home_team?.name ?? t("TBD")) +
              " v " +
              (match.away_team?.name ?? t("TBD"))}
          </p>
          {match.leaf_label ? (
            <p className="truncate text-xs text-muted-foreground">
              {match.leaf_label}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 sm:pl-14">
        {match.scorer ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
            <Radio aria-hidden="true" className="h-3 w-3" />
            {match.scorer.name}
          </span>
        ) : (
          <span className="rounded-full bg-warning-muted px-2 py-0.5 text-[0.6875rem] font-medium text-warning">
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
          <span className="rounded-full bg-warning-muted px-2 py-0.5 text-[0.6875rem] font-medium text-warning">
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

/** A read-out cell in the coverage strip: label, count/total, a progress bar. */
function CoverageCell({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}): React.ReactElement {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const complete = total > 0 && value >= total;
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1.5 px-4 py-3">
      <span className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <p className="font-tabular text-2xl font-semibold leading-none">
        {value}
        <span className="text-base text-muted-foreground">/{total}</span>
        <span className="ml-2 align-middle text-xs font-medium text-muted-foreground">
          {pct}%
        </span>
      </p>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            complete ? "bg-success" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Operations: Officials & assignments cockpit (ops redesign 2026-07-15). The
 * day's crew work condensed into ONE board — a coverage strip, a day + gap
 * filter toolbar, and per-court bookmark tabs — instead of four stacked cards
 * and a single flat scroll of every court's matches. Assign inline via the
 * shared AssignDrawer. Rides the control-room SSE loop, so coverage and the tab
 * warning dots update as assignments land. Gated to schedule editors by the
 * nav; the Assign action is additionally permission-checked here (and on the
 * server).
 */
export function CrewPage(): React.ReactElement {
  const { id = "" } = useParams();
  const { isMobile } = useBreakpoint();
  const [day, setDay] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [venueTab, setVenueTab] = useState<string>("all");
  const [assignMatch, setAssignMatch] = useState<ControlRoomMatch | null>(null);
  const [bulk, setBulk] = useState<{
    scope: "court" | "category" | "sport";
    key?: string;
  } | null>(null);

  const stageQ = useQuery({
    queryKey: qk.stage(id),
    queryFn: () => tournamentsApi.stage(id),
  });
  const canManage = stageQ.data?.can_manage ?? false;
  const modules = stageQ.data?.modules ?? [];
  const canAssign = canManage || modules.includes("tournament.schedule_editor");
  // The dialog's role list gates on both seats independently.
  const canAssignOfficials = canManage || modules.includes("match.assign_officials");
  const canBulk = canManage || canAssignOfficials;

  const { query } = useControlRoom(id, day);
  const data = query.data;
  const tz = data?.tournament.time_zone ?? "UTC";
  const selectedDay = day ?? data?.day ?? "";

  // Courts fall out of the day's venue buckets, in kickoff order.
  const venues = useMemo<ControlRoomVenue[]>(
    () => (data?.venues ?? []).filter((v) => v.matches.length > 0),
    [data],
  );
  const all = useMemo(() => venues.flatMap((v) => v.matches), [venues]);
  const withScorer = all.filter((m) => m.scorer).length;
  const withOfficial = all.filter((m) => (m.officials ?? []).length > 0).length;

  // The active court tab, derived — a tab that no longer exists (day switch)
  // falls back to "all" without a state-reset effect.
  const activeVenue =
    venueTab !== "all" && venues.some((v) => v.venue === venueTab)
      ? venueTab
      : "all";

  const header = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="page-title">{t("Officials & assignments")}</h2>
      {all.length > 0 ? (
        <span className="font-tabular text-xs text-muted-foreground">
          {venues.length} {venues.length === 1 ? t("court") : t("courts")} ·{" "}
          {all.length} {t("matches")}
        </span>
      ) : null}
      {canBulk && all.length > 0 ? (
        <Button
          size="sm"
          variant="outline"
          data-testid="crew-bulk-open"
          className="ml-auto"
          onClick={() => setBulk({ scope: "court" })}
        >
          <Users aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Bulk assign")}
        </Button>
      ) : null}
    </div>
  );

  if (query.isLoading) {
    return (
      <div className="flex w-full flex-col gap-3">
        {header}
        <div className="h-48 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }
  if (query.isError || !data || data.days.length === 0) {
    return (
      <div className="flex w-full flex-col gap-3">
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

  const shownVenues =
    activeVenue === "all" ? venues : venues.filter((v) => v.venue === activeVenue);
  const shown = shownVenues
    .map((v) => ({ venue: v, rows: v.matches.filter((m) => passesFilter(m, filter)) }))
    .filter((g) => g.rows.length > 0);
  const shownCount = shown.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="flex w-full flex-col gap-3">
      {header}

      {/* ONE board: coverage, the day + gap toolbar, the court tabs and the
          matches are a single card, not four stacked ones. */}
      <section data-testid="crew-board" className="panel flex flex-col">
        {/* Coverage over the whole day. */}
        <div className="grid grid-cols-2 divide-x divide-border border-b border-border">
          <CoverageCell
            label={t("Scorer coverage")}
            value={withScorer}
            total={all.length}
          />
          <CoverageCell
            label={t("Official coverage")}
            value={withOfficial}
            total={all.length}
          />
        </div>

        {/* Day + gap filter. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
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
            <div
              role="group"
              aria-label={t("Match day")}
              className="inline-flex w-fit flex-wrap items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5"
            >
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
                      "inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {fmtDayLabel(d.date)}
                  </button>
                );
              })}
            </div>
          )}
          <div className="ml-auto inline-flex w-fit flex-wrap items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                data-testid={`crew-filter-${f.key}`}
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  "inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  filter === f.key
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Court bookmark tabs — jump straight to a court, warning dot = still
            has an unstaffed match. */}
        {venues.length > 0 ? (
          <div
            role="tablist"
            aria-label={t("Courts")}
            className="flex items-center gap-0.5 overflow-x-auto border-b border-border px-2"
          >
            <VenueTab
              testid="crew-venue-all"
              label={t("All courts")}
              count={all.length}
              hasGap={all.some((m) => !isFullyStaffed(m))}
              active={activeVenue === "all"}
              onClick={() => setVenueTab("all")}
            />
            {venues.map((v) => (
              <VenueTab
                key={venueSlug(v.venue)}
                testid={`crew-venue-${venueSlug(v.venue)}`}
                label={v.venue || t("No court")}
                count={v.matches.length}
                hasGap={v.matches.some((m) => !isFullyStaffed(m))}
                active={activeVenue === v.venue}
                onClick={() => setVenueTab(v.venue)}
              />
            ))}
          </div>
        ) : null}

        {/* The matches, banded by court. */}
        {shown.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            {t("Nothing matches this filter.")}
          </p>
        ) : (
          <div>
            {shown.map(({ venue: v, rows }) => {
              const staffed = v.matches.filter(isFullyStaffed).length;
              return (
                <div
                  key={venueSlug(v.venue)}
                  data-testid={`crew-venue-group-${venueSlug(v.venue)}`}
                >
                  <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5">
                    <MapPin
                      aria-hidden="true"
                      className="h-3.5 w-3.5 text-muted-foreground"
                    />
                    <h3 className="text-[13px] font-semibold">
                      {v.venue || t("No court")}
                    </h3>
                    <span className="font-tabular text-xs text-muted-foreground">
                      {rows.length}
                    </span>
                    <span
                      className={cn(
                        "ml-auto font-tabular text-xs",
                        staffed >= v.matches.length
                          ? "text-success"
                          : "text-muted-foreground",
                      )}
                    >
                      {staffed}/{v.matches.length} {t("staffed")}
                    </span>
                    {canBulk && v.venue ? (
                      <button
                        type="button"
                        data-testid={`crew-assign-court-${venueSlug(v.venue)}`}
                        onClick={() => setBulk({ scope: "court", key: v.venue })}
                        className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Users aria-hidden="true" className="h-3.5 w-3.5" />
                        {t("Assign court")}
                      </button>
                    ) : null}
                  </div>
                  <div className="divide-y divide-border">
                    {rows.map((m) => (
                      <CrewRow
                        key={m.id}
                        match={m}
                        tz={tz}
                        canAssign={canAssign}
                        onAssign={() => setAssignMatch(m)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {all.length > 0 ? (
          <div className="border-t border-border px-4 py-2 text-right">
            <span className="font-tabular text-xs text-muted-foreground">
              {shownCount === all.length
                ? `${all.length} ${t("matches")}`
                : `${shownCount} ${t("of")} ${all.length} ${t("matches")}`}
            </span>
          </div>
        ) : null}
      </section>

      {assignMatch ? (
        <AssignDrawer
          tournamentId={id}
          match={assignMatch}
          onClose={() => setAssignMatch(null)}
        />
      ) : null}

      {bulk ? (
        <BulkAssignDialog
          tournamentId={id}
          day={selectedDay}
          matches={all}
          canManage={canManage}
          canAssignOfficials={canAssignOfficials}
          initialScope={bulk.scope}
          initialKey={bulk.key}
          onClose={() => setBulk(null)}
        />
      ) : null}
    </div>
  );
}

/** A court bookmark tab: underline-active, a count pill, and a warning dot when
 * the court still has an unstaffed match. */
function VenueTab({
  testid,
  label,
  count,
  hasGap,
  active,
  onClick,
}: {
  testid: string;
  label: string;
  count: number;
  hasGap: boolean;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testid}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 py-px font-tabular text-[0.625rem]",
          active ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        {count}
      </span>
      {hasGap ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full bg-warning"
        />
      ) : null}
    </button>
  );
}
