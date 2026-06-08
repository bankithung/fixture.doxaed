import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Calendar, Check, ListChecks, MapPin, Sparkles } from "lucide-react";
import { tournamentsApi, type ScheduleResultDTO } from "@/api/tournaments";
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
import { invalidateTournament } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

type Form = {
  date_start: string;
  date_end: string;
  daily_start: string;
  daily_end: string;
  slot_minutes: number;
  venues: string; // comma/newline separated
  rest_minutes: number;
  max_per_team_per_day: number;
};

const STEPS = [
  { key: "calendar", label: "Calendar", icon: Calendar },
  { key: "venues", label: "Venues & timing", icon: MapPin },
  { key: "rules", label: "Rules", icon: ListChecks },
  { key: "review", label: "Review & generate", icon: Sparkles },
] as const;

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

export function ScheduleWizard({
  tournamentId,
  open,
  onClose,
}: {
  tournamentId: string;
  open: boolean;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<ScheduleResultDTO | null>(null);
  const [form, setForm] = useState<Form>({
    date_start: "",
    date_end: "",
    daily_start: "09:00",
    daily_end: "18:00",
    slot_minutes: 90,
    venues: "",
    rest_minutes: 60,
    max_per_team_per_day: 1,
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]): void =>
    setForm((f) => ({ ...f, [k]: v }));

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
      }),
    onSuccess: (r) => {
      setResult(r);
      invalidateTournament(qc, tournamentId);
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not schedule"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : t("Try again."),
      }),
  });

  const close = (): void => {
    setStep(0);
    setResult(null);
    onClose();
  };

  const canProceed =
    step !== 0 || (form.date_start !== "" && form.date_end !== "");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      ariaLabel={t("Fixture generation wizard")}
    >
      <DialogHeader>
        <DialogTitle>{t("Generate & schedule fixtures")}</DialogTitle>
        <DialogDescription>
          {t(
            "Set your constraints — the engine assigns every match a time and venue, honouring rest, venue and per-day limits.",
          )}
        </DialogDescription>
      </DialogHeader>

      {/* step rail */}
      <ol className="flex items-center gap-1 text-xs">
        {STEPS.map((s, i) => (
          <li key={s.key} className="flex flex-1 items-center gap-1.5">
            <span
              className={cn(
                "grid h-6 w-6 shrink-0 place-items-center rounded-full",
                i < step || result
                  ? "bg-primary text-primary-foreground"
                  : i === step
                    ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {i < step || result ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <span
              className={cn(
                "hidden truncate sm:block",
                i === step && !result ? "font-medium" : "text-muted-foreground",
              )}
            >
              {t(s.label)}
            </span>
          </li>
        ))}
      </ol>

      <div className="min-h-[12rem] py-1">
        {result ? (
          <div className="flex flex-col gap-3">
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg border p-3",
                result.unscheduled.length
                  ? "border-amber-500/40 bg-amber-500/10"
                  : "border-primary/40 bg-primary/[0.06]",
              )}
            >
              <Check className="h-5 w-5 text-primary" />
              <div>
                <p className="text-sm font-semibold">
                  {result.scheduled} {t("matches scheduled")}
                  {result.unscheduled.length
                    ? ` · ${result.unscheduled.length} ${t("unscheduled")}`
                    : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("Schedule quality")}: {Math.round(result.soft_score * 100)}%
                </p>
              </div>
            </div>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {result.explanation.map((e, i) => (
                <li key={i}>• {e}</li>
              ))}
            </ul>
          </div>
        ) : step === 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("First match day")}>
              <Input type="date" value={form.date_start}
                onChange={(e) => set("date_start", e.target.value)} />
            </Field>
            <Field label={t("Last match day")}>
              <Input type="date" value={form.date_end}
                onChange={(e) => set("date_end", e.target.value)} />
            </Field>
            <Field label={t("Earliest kickoff")}>
              <Input type="time" value={form.daily_start}
                onChange={(e) => set("daily_start", e.target.value)} />
            </Field>
            <Field label={t("Latest kickoff")}>
              <Input type="time" value={form.daily_end}
                onChange={(e) => set("daily_end", e.target.value)} />
            </Field>
          </div>
        ) : step === 1 ? (
          <div className="flex flex-col gap-3">
            <Field
              label={t("Venues / grounds")}
              hint={t("One per line (or comma-separated). More venues = more parallel matches.")}
            >
              <textarea
                rows={3}
                value={form.venues}
                onChange={(e) => set("venues", e.target.value)}
                placeholder={t("Main Ground\nSecondary Pitch")}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </Field>
            <Field label={t("Match length (minutes, incl. turnaround)")}>
              <Input type="number" min={10} value={form.slot_minutes}
                onChange={(e) => set("slot_minutes", Number(e.target.value))} />
            </Field>
          </div>
        ) : step === 2 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t("Minimum rest between a team's matches (minutes)")}
              hint={t("A team won't be scheduled again within this gap.")}
            >
              <Input type="number" min={0} value={form.rest_minutes}
                onChange={(e) => set("rest_minutes", Number(e.target.value))} />
            </Field>
            <Field label={t("Max matches per team per day")}>
              <Input type="number" min={1} value={form.max_per_team_per_day}
                onChange={(e) => set("max_per_team_per_day", Number(e.target.value))} />
            </Field>
          </div>
        ) : (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">{t("Dates")}</dt>
              <dd>{form.date_start || "—"} → {form.date_end || form.date_start || "—"}</dd></div>
            <div><dt className="text-muted-foreground">{t("Daily window")}</dt>
              <dd>{form.daily_start}–{form.daily_end}</dd></div>
            <div><dt className="text-muted-foreground">{t("Venues")}</dt>
              <dd>{form.venues.split(/[\n,]/).filter((v) => v.trim()).length || t("Main Ground")}</dd></div>
            <div><dt className="text-muted-foreground">{t("Match length")}</dt>
              <dd>{form.slot_minutes} min</dd></div>
            <div><dt className="text-muted-foreground">{t("Rest")}</dt>
              <dd>{form.rest_minutes} min</dd></div>
            <div><dt className="text-muted-foreground">{t("Max/team/day")}</dt>
              <dd>{form.max_per_team_per_day}</dd></div>
          </dl>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={close}>
          {result ? t("Done") : t("Cancel")}
        </Button>
        {!result ? (
          <div className="flex gap-2">
            {step > 0 ? (
              <Button variant="outline" onClick={() => setStep((s) => s - 1)}>
                {t("Back")}
              </Button>
            ) : null}
            {step < STEPS.length - 1 ? (
              <Button disabled={!canProceed} onClick={() => setStep((s) => s + 1)}>
                {t("Next")}
              </Button>
            ) : (
              <Button disabled={run.isPending} onClick={() => run.mutate()}>
                <Sparkles className="h-4 w-4" />
                {run.isPending ? t("Generating…") : t("Generate")}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
