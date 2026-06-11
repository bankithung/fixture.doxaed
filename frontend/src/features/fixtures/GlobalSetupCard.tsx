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
 * Always-visible summary of the asked-ONCE globals (redesign §6 screen 1):
 * a dl grid of what the GlobalSetupWizard captured, with a per-row pencil
 * that reopens the wizard at that step — never re-asking, always editable.
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

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Settings2 aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t("Global setup")}</h3>
          <span className="text-xs text-muted-foreground">
            {t("asked once — applies to every competition")}
          </span>
        </div>
        {canManage ? (
          <Button
            size="sm"
            variant={unset ? "default" : "outline"}
            data-testid="global-setup-edit"
            onClick={() => onEdit(0)}
          >
            {unset ? t("Set up") : t("Edit")}
          </Button>
        ) : null}
      </div>
      {loading ? (
        <div className="mt-3 h-16 animate-pulse rounded-lg bg-muted/40" aria-busy="true" />
      ) : (
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <div key={r.label} className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">{r.label}</dt>
                <dd className="truncate font-tabular">{r.value}</dd>
              </div>
              {canManage ? (
                <button
                  type="button"
                  aria-label={t(`Edit ${r.label}`)}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={() => onEdit(r.step)}
                >
                  <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
