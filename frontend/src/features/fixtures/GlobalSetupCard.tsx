import { useQuery } from "@tanstack/react-query";
import { Pencil, Settings2 } from "lucide-react";
import { tournamentsApi, type ConstraintRecord } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { qk } from "@/lib/queryKeys";
import { t } from "@/lib/t";
import { SETUP_STEP } from "./setupSteps";

function isAll(c: ConstraintRecord): boolean {
  return !c.scope || c.scope === "all";
}

/**
 * Slim one-line summary strip of the asked-ONCE globals (staged-funnel hub,
 * increment V): each value the GlobalSetupWizard captured renders as a chip
 * that reopens the wizard at its step — never re-asking, always editable.
 * The hub only shows this once the stage gate (dates + venues) is satisfied.
 */
export function GlobalSetupCard({
  tournamentId,
  canManage,
  onEdit,
}: {
  tournamentId: string;
  canManage: boolean;
  /** Open the GlobalSetupWizard at this step. */
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

  const rows: { label: string; value: string; step: number }[] = [
    {
      label: t("Dates"),
      value: cal?.date_start
        ? `${cal.date_start} → ${cal.date_end ?? cal.date_start}`
        : t("Not set"),
      step: SETUP_STEP.calendar,
    },
    {
      label: t("Blackouts / reserves / ceremonies"),
      value: `${blackouts} · ${reserves} · ${ceremonies}`,
      step: SETUP_STEP.calendar,
    },
    {
      label: t("Venues"),
      value: pool.length
        ? `${pool.length} ${t("venues")}${units > pool.length ? ` · ${units} ${t("courts")}` : ""}`
        : t("None yet"),
      step: SETUP_STEP.venues,
    },
    {
      label: t("Daily window"),
      value: cal?.daily_start
        ? `${cal.daily_start}–${cal.daily_end ?? ""} · ${cal.slot_minutes ?? 90} ${t("min slots")}`
        : t("Not set"),
      step: SETUP_STEP.defaults,
    },
    {
      label: t("Rest & caps"),
      value:
        rest != null || maxPerDay != null
          ? `${String(rest ?? "—")} ${t("min rest")} · ${t("max")} ${String(maxPerDay ?? "—")}/${t("day")}`
          : t("Defaults"),
      step: SETUP_STEP.defaults,
    },
    {
      label: t("Sunday mornings"),
      value: church ? t("Blocked until 13:00") : t("Open"),
      step: SETUP_STEP.defaults,
    },
  ];

  const chipCls =
    "inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs";

  return (
    <section
      data-testid="global-setup-strip"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-border bg-card px-4 py-2.5 shadow-sm"
    >
      <Settings2
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-muted-foreground"
      />
      <h3 className="text-sm font-semibold">{t("Global setup")}</h3>
      {loading ? (
        <div
          className="h-5 w-48 animate-pulse rounded-full bg-muted/40"
          aria-busy="true"
        />
      ) : (
        rows.map((r) =>
          canManage ? (
            <button
              key={r.label}
              type="button"
              aria-label={t(`Edit ${r.label}`)}
              title={t(`Edit ${r.label}`)}
              className={`${chipCls} text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground`}
              onClick={() => onEdit(r.step)}
            >
              <span className="font-medium">{r.label}</span>
              <span className="truncate font-tabular text-foreground">
                {r.value}
              </span>
            </button>
          ) : (
            <span key={r.label} className={`${chipCls} text-muted-foreground`}>
              <span className="font-medium">{r.label}</span>
              <span className="truncate font-tabular text-foreground">
                {r.value}
              </span>
            </span>
          ),
        )
      )}
      {canManage ? (
        <Button
          size="sm"
          variant={unset ? "default" : "outline"}
          className="ml-auto"
          data-testid="global-setup-edit"
          onClick={() => onEdit(0)}
        >
          <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
          {unset ? t("Set up") : t("Edit")}
        </Button>
      ) : null}
    </section>
  );
}
