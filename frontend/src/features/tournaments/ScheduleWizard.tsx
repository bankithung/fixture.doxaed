import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import {
  tournamentsApi,
  type ConstraintRecord,
  type ScheduleResultDTO,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

type Form = {
  date_start: string;
  date_end: string;
  daily_start: string;
  daily_end: string;
  slot_minutes: number;
  venues: string; // comma/newline separated; empty = the saved venue pool
  rest_minutes: number;
  max_per_team_per_day: number;
  auto_reflow: boolean;
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <div>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-tabular">{v}</dd>
    </div>
  );
}

function isAll(c: ConstraintRecord): boolean {
  return !c.scope || c.scope === "all";
}

/** "2026-06-12" → "Jun 12" — the confirm reads in words, not ISO. */
function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * Re-run the schedule (clarity rebuild §4.6): a single confirm screen,
 * PREFILLED from the stored Step 1 answers (`draw_config["*"].calendar`, the
 * venue pool, the rest/per-day constraint records) — never re-asking what
 * Step 1 already knows. The rare override lives behind an "Adjust before
 * running" disclosure exposing every field. Mount conditionally so each
 * opening reseeds from the stored data.
 */
export function ScheduleWizard({
  tournamentId,
  open,
  onClose,
  leafKey,
  leafLabel,
}: {
  tournamentId: string;
  open: boolean;
  onClose: () => void;
  /** Schedule ONE competition around everything else's bookings. */
  leafKey?: string;
  leafLabel?: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [result, setResult] = useState<ScheduleResultDTO | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const [form, setForm] = useState<Form>({
    date_start: "",
    date_end: "",
    daily_start: "09:00",
    daily_end: "18:00",
    slot_minutes: 90,
    venues: "",
    rest_minutes: 60,
    max_per_team_per_day: 1,
    auto_reflow: false,
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]): void =>
    setForm((f) => ({ ...f, [k]: v }));

  const drawConfig = useQuery({
    queryKey: qk.drawConfig(tournamentId),
    queryFn: () => tournamentsApi.drawConfig(tournamentId),
    enabled: open,
  });
  const venues = useQuery({
    queryKey: qk.venues(tournamentId),
    queryFn: () => tournamentsApi.venues(tournamentId),
    enabled: open,
  });
  const settings = useQuery({
    queryKey: qk.settings(tournamentId),
    queryFn: () => tournamentsApi.settings(tournamentId),
    enabled: open,
  });

  // Seed ONCE from the stored Step 1 answers (guarded render-phase
  // adjustment — the wizard is mounted conditionally so reopening reseeds).
  if (!seeded && drawConfig.data && settings.data) {
    const cal = drawConfig.data.draw_config["*"]?.calendar ?? null;
    const records = settings.data.constraints ?? [];
    const one = (type: string): ConstraintRecord | undefined =>
      records.find((c) => c.type === type && isAll(c));
    setForm({
      date_start: String(cal?.date_start ?? ""),
      date_end: String(cal?.date_end ?? cal?.date_start ?? ""),
      daily_start: String(cal?.daily_start ?? "09:00"),
      daily_end: String(cal?.daily_end ?? "18:00"),
      slot_minutes: Number(cal?.slot_minutes ?? 90),
      venues: "",
      rest_minutes: Number(one("min_rest_minutes")?.params.minutes ?? 60),
      max_per_team_per_day: Number(
        one("max_matches_per_team_per_day")?.params.count ?? 1,
      ),
      auto_reflow: Boolean(settings.data.scheduling_config?.auto_reflow),
    });
    setSeeded(true);
  }

  const run = useMutation({
    mutationFn: () =>
      tournamentsApi.scheduleFixtures(tournamentId, {
        date_start: form.date_start,
        date_end: form.date_end || form.date_start,
        daily_start: form.daily_start,
        daily_end: form.daily_end,
        slot_minutes: Number(form.slot_minutes),
        venues: form.venues
          .split(/[\n,]/)
          .map((v) => v.trim())
          .filter(Boolean),
        rest_minutes: Number(form.rest_minutes),
        max_per_team_per_day: Number(form.max_per_team_per_day),
        auto_reflow: form.auto_reflow,
        ...(leafKey ? { leaf_key: leafKey } : {}),
      }),
    onSuccess: (r) => {
      setResult(r);
      invalidateTournament(qc, tournamentId);
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not re-run the schedule"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : t("Try again."),
      }),
  });

  const close = (): void => {
    setResult(null);
    onClose();
  };

  const loading =
    drawConfig.isLoading || venues.isLoading || settings.isLoading;
  const customVenues = form.venues
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
  const venueCount = customVenues.length || (venues.data?.venues.length ?? 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      ariaLabel={t("Re-run the schedule")}
    >
      <DialogHeader>
        <DialogTitle>
          {leafLabel
            ? t(`Re-run the schedule · ${leafLabel}`)
            : t("Re-run the schedule")}
        </DialogTitle>
        <DialogDescription>
          {t(
            "Every unlocked match gets a fresh time and venue using your Step 1 answers. Locked matches stay where they are.",
          )}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-[10rem] py-1" aria-busy={loading}>
        {result ? (
          <div className="flex flex-col gap-3">
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg border p-3",
                result.unscheduled.length
                  ? "border-warning/40 bg-warning-muted"
                  : "border-success/40 bg-success-muted",
              )}
            >
              <Check aria-hidden="true" className="h-5 w-5 text-success" />
              <div>
                <p className="text-sm font-semibold">
                  {result.scheduled} {t("matches scheduled")}
                  {result.unscheduled.length
                    ? ` · ${result.unscheduled.length} ${t("still need a time")}`
                    : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("Schedule quality")}: {Math.round(result.soft_score * 100)}%
                </p>
                {result.unscheduled.length ? (
                  /* Never strand the user on a partial result — say the fix. */
                  <p className="text-xs text-muted-foreground">
                    {t("Add another day or venue in Step 1, then run this again.")}
                  </p>
                ) : null}
              </div>
            </div>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {result.explanation.map((e, i) => (
                <li key={i}>• {e}</li>
              ))}
            </ul>
          </div>
        ) : loading ? (
          <div className="h-32 animate-pulse rounded-lg bg-muted/40" />
        ) : (
          <div className="flex flex-col gap-3">
            {/* The Step 1 receipt this run will use. */}
            <dl
              data-testid="rerun-summary"
              className="grid gap-2 rounded-lg border border-border bg-muted/20 p-3 text-sm sm:grid-cols-2"
            >
              <SummaryRow
                k={t("Dates")}
                v={`${form.date_start ? fmtDay(form.date_start) : t("not set")} ${t("to")} ${
                  form.date_end || form.date_start
                    ? fmtDay(form.date_end || form.date_start)
                    : t("not set")
                }`}
              />
              <SummaryRow
                k={t("Play times")}
                v={t(
                  `${form.daily_start} to ${form.daily_end}, ${form.slot_minutes} min per match`,
                )}
              />
              <SummaryRow k={t("Venues")} v={String(venueCount)} />
              <SummaryRow
                k={t("Breaks")}
                v={t(
                  `${form.rest_minutes} min between matches, max ${form.max_per_team_per_day} per day`,
                )}
              />
            </dl>

            <div className="overflow-hidden rounded-lg border border-border">
              <button
                type="button"
                data-testid="adjust-before-running"
                aria-expanded={adjustOpen}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
                onClick={() => setAdjustOpen((o) => !o)}
              >
                <span className="text-sm font-medium">
                  {t("Adjust before running")}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                    adjustOpen && "rotate-180",
                  )}
                />
              </button>
              {adjustOpen ? (
                <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("First match day")}>
                      <Input
                        type="date"
                        value={form.date_start}
                        onChange={(e) => set("date_start", e.target.value)}
                      />
                    </Field>
                    <Field label={t("Last match day")}>
                      <Input
                        type="date"
                        value={form.date_end}
                        onChange={(e) => set("date_end", e.target.value)}
                      />
                    </Field>
                    <Field label={t("First match of the day starts at")}>
                      <Input
                        type="time"
                        value={form.daily_start}
                        onChange={(e) => set("daily_start", e.target.value)}
                      />
                    </Field>
                    <Field label={t("Last match must start by")}>
                      <Input
                        type="time"
                        value={form.daily_end}
                        onChange={(e) => set("daily_end", e.target.value)}
                      />
                    </Field>
                    <Field label={t("Minutes per match (including changeover)")}>
                      <Input
                        type="number"
                        min={10}
                        value={form.slot_minutes}
                        onChange={(e) => set("slot_minutes", Number(e.target.value))}
                      />
                    </Field>
                    <Field
                      label={t("Shortest break between a team's matches (minutes)")}
                    >
                      <Input
                        type="number"
                        min={0}
                        value={form.rest_minutes}
                        onChange={(e) => set("rest_minutes", Number(e.target.value))}
                      />
                    </Field>
                    <Field label={t("Most matches a team plays in one day")}>
                      <Input
                        type="number"
                        min={1}
                        value={form.max_per_team_per_day}
                        onChange={(e) =>
                          set("max_per_team_per_day", Number(e.target.value))
                        }
                      />
                    </Field>
                  </div>
                  <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
                    <input
                      type="checkbox"
                      data-testid="auto-reflow-toggle"
                      checked={form.auto_reflow}
                      onChange={(e) => set("auto_reflow", e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">
                        {t("Auto-adjust later times when a match runs early or late")}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t(
                          "As each match finishes, the later matches on the same court shift to follow the real end time — only when it breaks no rule. You can still move any match by hand.",
                        )}
                      </span>
                    </span>
                  </label>
                  <Field
                    label={t("Venues")}
                    hint={t("One per line (or comma-separated). Leave empty to use your saved venues with their availability windows.")}
                  >
                    <textarea
                      rows={3}
                      value={form.venues}
                      onChange={(e) => set("venues", e.target.value)}
                      className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={close}>
          {result ? t("Done") : t("Cancel")}
        </Button>
        {!result ? (
          <Button
            disabled={run.isPending || loading || form.date_start === ""}
            data-testid="rerun-schedule-submit"
            onClick={() => run.mutate()}
          >
            <Sparkles aria-hidden="true" className="h-4 w-4" />
            {run.isPending ? t("Running…") : t("Re-run schedule")}
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
