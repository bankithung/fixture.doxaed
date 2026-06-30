import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Pencil } from "lucide-react";
import { tournamentsApi, type ConstraintRecord } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { AskAiButton } from "@/features/assistant/AskAiButton";
import { qk } from "@/lib/queryKeys";
import { t } from "@/lib/t";
import { SETUP_STEP } from "./setupSteps";

function isAll(c: ConstraintRecord): boolean {
  return !c.scope || c.scope === "all";
}

/** "2026-06-12" → "Jun 12" — chips read in words, not ISO. */
function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * The Step 1 receipt (clarity rebuild §4.1/§7.4): a slim strip of everything
 * the Step 1 wizard captured, each value a chip that reopens the wizard at
 * its step — never re-asking, always editable. Zero/unset chips are hidden;
 * Dates, Venues and Play times always show. The hub only renders this once
 * the stage gate (dates + venues) is satisfied.
 */
export function GlobalSetupCard({
  tournamentId,
  canManage,
  onEdit,
}: {
  tournamentId: string;
  canManage: boolean;
  /** Open the Step 1 wizard at this step. */
  onEdit: (step: number) => void;
}): React.ReactElement {
  const drawConfig = useQuery({
    queryKey: qk.drawConfig(tournamentId),
    queryFn: () => tournamentsApi.drawConfig(tournamentId),
  });
  const venues = useQuery({
    queryKey: qk.venues(tournamentId),
    queryFn: () => tournamentsApi.venues(tournamentId),
  });
  const settings = useQuery({
    queryKey: qk.settings(tournamentId),
    queryFn: () => tournamentsApi.settings(tournamentId),
  });

  const loading =
    drawConfig.isLoading || venues.isLoading || settings.isLoading;
  const cal = drawConfig.data?.draw_config["*"]?.calendar ?? null;
  const records = settings.data?.constraints ?? [];
  const one = (type: string): ConstraintRecord | undefined =>
    records.find((c) => c.type === type && isAll(c));
  const ceremonies = records.filter(
    (c) => c.type === "ceremony_block" && isAll(c),
  ).length;
  const church = one("recurring_blackout_window");
  const pool = venues.data?.venues ?? [];
  const units = pool.reduce((acc, v) => acc + (v.count ?? 1), 0);
  const blackouts =
    ((one("blackout_dates")?.params.dates as string[]) ?? []).length;
  const reserves =
    ((one("reserve_days")?.params.dates as string[]) ?? []).length;
  const rest = one("min_rest_minutes")?.params.minutes;
  const maxPerDay = one("max_matches_per_team_per_day")?.params.count;
  const unset = !cal?.date_start;

  /** Chips per §7.4 — zero/unset extras are hidden; the three core chips
   * (Dates, Venues, Play times) always render. */
  const rows: { key: string; value: string; step: number }[] = [
    {
      key: "dates",
      value: cal?.date_start
        ? t(
            `Dates ${fmtDay(String(cal.date_start))} to ${fmtDay(String(cal.date_end ?? cal.date_start))}`,
          )
        : t("Dates not set"),
      step: SETUP_STEP.calendar,
    },
    ...(blackouts > 0
      ? [{ key: "days-off", value: t(`Days off ${blackouts}`), step: SETUP_STEP.calendar }]
      : []),
    ...(reserves > 0
      ? [{ key: "spare-days", value: t(`Spare days ${reserves}`), step: SETUP_STEP.calendar }]
      : []),
    ...(ceremonies > 0
      ? [{ key: "ceremonies", value: t(`Ceremonies ${ceremonies}`), step: SETUP_STEP.calendar }]
      : []),
    {
      key: "venues",
      value: pool.length
        ? t(`Venues ${pool.length}`) +
          (units > pool.length ? ` · ${units} ${t("courts")}` : "")
        : t("No venues yet"),
      step: SETUP_STEP.venues,
    },
    {
      key: "play-times",
      value: cal?.daily_start
        ? t(
            `Play times ${cal.daily_start} to ${cal.daily_end ?? ""}, ${cal.slot_minutes ?? 90} min per match`,
          )
        : t("Play times not set"),
      step: SETUP_STEP.defaults,
    },
    ...(rest != null || maxPerDay != null
      ? [
          {
            key: "breaks",
            value: t(
              `Breaks ${String(rest ?? "-")} min between matches, max ${String(maxPerDay ?? "-")} per day`,
            ),
            step: SETUP_STEP.defaults,
          },
        ]
      : []),
    ...(church
      ? [
          {
            key: "sunday",
            value: t("Sunday mornings free until 13:00"),
            step: SETUP_STEP.defaults,
          },
        ]
      : []),
  ];

  const chipBase =
    "inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium";

  return (
    <section
      data-testid="global-setup-strip"
      className="overflow-hidden rounded-lg border border-border bg-card shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <CalendarDays aria-hidden="true" className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight">
            {t("Step 1 · When & where")}
          </h3>
          <p className="truncate text-xs text-muted-foreground">
            {t("Your match days, venues, play times and breaks. Edit any time.")}
          </p>
        </div>
        {canManage ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <AskAiButton
              focus={{
                label: t("When & where"),
                hint: "the 'When & where' section: match days, daily play times, venues and courts, breaks, and ceremonies",
              }}
            />
            <Button
              size="sm"
              variant={unset ? "default" : "outline"}
              data-testid="global-setup-edit"
              onClick={() => onEdit(0)}
            >
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
              {unset ? t("Start Step 1") : t("Edit")}
            </Button>
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="px-4 py-3">
          <div
            className="h-6 w-56 animate-pulse rounded-full bg-muted/40"
            aria-busy="true"
          />
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5 px-4 py-3">
          {rows.map((r) =>
            canManage ? (
              <button
                key={r.key}
                type="button"
                aria-label={t(`Edit: ${r.value}`)}
                title={t("Edit in Step 1")}
                data-testid={`setup-chip-${r.key}`}
                className={`${chipBase} bg-muted text-foreground transition-colors hover:bg-accent hover:text-accent-foreground`}
                onClick={() => onEdit(r.step)}
              >
                <span className="truncate font-tabular">{r.value}</span>
              </button>
            ) : (
              <span
                key={r.key}
                data-testid={`setup-chip-${r.key}`}
                className={`${chipBase} bg-muted/50 text-muted-foreground`}
              >
                <span className="truncate font-tabular">{r.value}</span>
              </span>
            ),
          )}
        </div>
      )}
    </section>
  );
}
