import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Sparkles } from "lucide-react";
import {
  tournamentsApi,
  type ConstraintDraft,
  type ConstraintRecord,
  type VenueRecord,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StepRail } from "@/components/ui/StepRail";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { t } from "@/lib/t";
import { BlackoutDatesField } from "./BlackoutDatesField";
import { CeremonyField, type CeremonyValue } from "./CeremonyField";
import { GLOBAL_SETUP_STEPS } from "./setupSteps";
import { VenueRow, type VenueDraft } from "./VenueRow";

/** Constraint types the wizard OWNS at `scope:"all"` — its save replaces
 * exactly these records and preserves everything else (scoped records,
 * builder-added types). */
const MANAGED_TYPES = new Set([
  "blackout_dates",
  "reserve_days",
  "recurring_blackout_window",
  "ceremony_block",
  "min_rest_minutes",
  "max_matches_per_team_per_day",
]);

interface Form {
  date_start: string;
  date_end: string;
  blackouts: string[];
  reserves: string[];
  opening: CeremonyValue | null;
  closing: CeremonyValue | null;
  venues: VenueDraft[];
  daily_start: string;
  daily_end: string;
  slot_minutes: number;
  rest_minutes: number;
  max_per_day: number;
  sunday_church: boolean;
}

const EMPTY_FORM: Form = {
  date_start: "",
  date_end: "",
  blackouts: [],
  reserves: [],
  opening: null,
  closing: null,
  venues: [],
  daily_start: "09:00",
  daily_end: "18:00",
  slot_minutes: 90,
  rest_minutes: 60,
  max_per_day: 1,
  sunday_church: true,
};

function isAll(c: ConstraintRecord): boolean {
  return !c.scope || c.scope === "all";
}

function ceremonyFrom(c: ConstraintRecord | undefined): CeremonyValue | null {
  if (!c) return null;
  const p = c.params;
  return {
    date: String(p.date ?? ""),
    from: String(p.from ?? "09:00"),
    to: String(p.to ?? "10:00"),
  };
}

function venueDraft(v: VenueRecord): VenueDraft {
  return {
    id: v.id,
    name: v.name,
    venue_type: v.venue_type,
    count: v.count ?? 1,
    from: v.windows?.[0]?.from ?? "",
    to: v.windows?.[0]?.to ?? "",
  };
}

function draftWindows(d: VenueDraft): { from: string; to: string }[] {
  return d.from && d.to ? [{ from: d.from, to: d.to }] : [];
}

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

function Row({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <div>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-tabular">{v}</dd>
    </div>
  );
}

/**
 * The asked-ONCE global setup (redesign §6 screen 2): calendar + blackouts +
 * ceremonies + reserve days, the venue pool (type/hours/count via the Venue
 * CRUD API), and scheduling defaults. Persists across three channels —
 * constraint records via the settings PATCH, venues via the venues API, and
 * the calendar into `draw_config["*"].calendar` — then never asks again:
 * every later wizard reads these as prefilled, edit-only context.
 *
 * Mount it CONDITIONALLY (`{setup ? <GlobalSetupWizard … /> : null}`) so each
 * opening starts at `initialStep` with a fresh seed from the stored data.
 */
export function GlobalSetupWizard({
  tournamentId,
  open,
  onClose,
  initialStep = 0,
}: {
  tournamentId: string;
  open: boolean;
  onClose: () => void;
  /** Deep-link target (a GlobalSetupCard pencil / readiness fix action). */
  initialStep?: number;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState(initialStep);
  const [seeded, setSeeded] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
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

  // Seed the form ONCE from the three stored sources (guarded render-phase
  // adjustment — mount the wizard conditionally so reopening reseeds).
  if (!seeded && drawConfig.data && venues.data && settings.data) {
    const cal = drawConfig.data.draw_config["*"]?.calendar ?? null;
    const records = settings.data.constraints ?? [];
    const one = (type: string): ConstraintRecord | undefined =>
      records.find((c) => c.type === type && isAll(c));
    const ceremonies = records.filter(
      (c) => c.type === "ceremony_block" && isAll(c),
    );
    const church = records.find(
      (c) => c.type === "recurring_blackout_window" && isAll(c),
    );
    setForm({
      date_start: String(cal?.date_start ?? ""),
      date_end: String(cal?.date_end ?? ""),
      blackouts: (one("blackout_dates")?.params.dates as string[]) ?? [],
      reserves: (one("reserve_days")?.params.dates as string[]) ?? [],
      opening: ceremonyFrom(
        ceremonies.find((c) => c.params.label === "opening") ?? ceremonies[0],
      ),
      closing: ceremonyFrom(
        ceremonies.find((c) => c.params.label === "closing") ?? ceremonies[1],
      ),
      venues: venues.data.venues.map(venueDraft),
      daily_start: String(cal?.daily_start ?? "09:00"),
      daily_end: String(cal?.daily_end ?? "18:00"),
      slot_minutes: Number(cal?.slot_minutes ?? 90),
      rest_minutes: Number(one("min_rest_minutes")?.params.minutes ?? 60),
      max_per_day: Number(
        one("max_matches_per_team_per_day")?.params.count ?? 1,
      ),
      // Default ON (Nagaland Sunday-morning church) until the wizard has been
      // saved once; after that the stored record is the truth.
      sunday_church: church !== undefined || cal === null,
    });
    setSeeded(true);
  }

  const save = useMutation({
    mutationFn: async () => {
      // 1) Venue pool diff → the Venue CRUD API (§2.3).
      const stored = venues.data?.venues ?? [];
      const drafts = form.venues.filter((d) => d.name.trim());
      for (const d of drafts) {
        const body = {
          name: d.name.trim(),
          venue_type: d.venue_type,
          windows: draftWindows(d),
          count: d.count,
        };
        if (!d.id) {
          await tournamentsApi.createVenue(tournamentId, body);
          continue;
        }
        const prev = stored.find((v) => v.id === d.id);
        const changed =
          !prev ||
          prev.name !== body.name ||
          prev.venue_type !== body.venue_type ||
          (prev.count ?? 1) !== body.count ||
          JSON.stringify(prev.windows ?? []) !== JSON.stringify(body.windows);
        if (changed) await tournamentsApi.updateVenue(tournamentId, d.id, body);
      }
      for (const v of stored) {
        if (!drafts.some((d) => d.id === v.id)) {
          await tournamentsApi.deleteVenue(tournamentId, v.id);
        }
      }

      // 2) Wizard-owned constraint records → settings PATCH; everything the
      // wizard does not manage (scoped records, other types) is preserved.
      const records = settings.data?.constraints ?? [];
      const next: ConstraintDraft[] = records.filter(
        (c) => !(MANAGED_TYPES.has(c.type) && isAll(c)),
      );
      if (form.blackouts.length) {
        next.push({ type: "blackout_dates", scope: "all",
          params: { dates: form.blackouts } });
      }
      if (form.reserves.length) {
        next.push({ type: "reserve_days", scope: "all",
          params: { dates: form.reserves } });
      }
      if (form.sunday_church) {
        next.push({ type: "recurring_blackout_window", scope: "all",
          params: { days: ["sun"], from: "00:00", to: "13:00" } });
      }
      if (form.rest_minutes > 0) {
        next.push({ type: "min_rest_minutes", scope: "all",
          params: { minutes: Number(form.rest_minutes) } });
      }
      if (form.max_per_day > 0) {
        next.push({ type: "max_matches_per_team_per_day", scope: "all",
          params: { count: Number(form.max_per_day) } });
      }
      for (const [label, c] of [
        ["opening", form.opening],
        ["closing", form.closing],
      ] as const) {
        if (c?.date) {
          next.push({ type: "ceremony_block", scope: "all",
            params: { date: c.date, from: c.from, to: c.to, venues: null, label } });
        }
      }
      const body = { constraints: next, event_id: newEventId() };
      try {
        await tournamentsApi.updateSettings(tournamentId, body);
      } catch (e) {
        // Constraints share the rules-freeze gate (invariant 7); scheduling
        // constraints are organizer process data, so amend with a reason.
        if (
          e instanceof ApiError &&
          e.status === 409 &&
          e.payload.detail === "rules_frozen"
        ) {
          await tournamentsApi.updateSettings(tournamentId, {
            ...body,
            amend: true,
            reason: t("Fixture global setup: scheduling constraints updated"),
          });
        } else {
          throw e;
        }
      }

      // 3) Calendar → draw_config["*"].calendar (§5.1 "wizard-saved dates").
      await tournamentsApi.updateDrawConfig(tournamentId, {
        leaf_key: "*",
        config: {
          calendar: {
            date_start: form.date_start || null,
            date_end: form.date_end || null,
            daily_start: form.daily_start || null,
            daily_end: form.daily_end || null,
            slot_minutes: Number(form.slot_minutes) || null,
          },
        },
        event_id: newEventId(),
      });
    },
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({ kind: "success", title: t("Global setup saved") });
      onClose();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not save the global setup"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? "") : t("Try again."),
      }),
  });

  const loading =
    drawConfig.isLoading || venues.isLoading || settings.isLoading;
  const canProceed =
    step !== 0 || (form.date_start !== "" && form.date_end !== "");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      variant="sheet"
      ariaLabel={t("Global setup")}
    >
      <DialogHeader>
        <DialogTitle>{t("Global setup")}</DialogTitle>
        <DialogDescription>
          {t(
            "Asked once, edited forever — calendar, venues and defaults apply to every competition's draw and schedule.",
          )}
        </DialogDescription>
      </DialogHeader>

      <StepRail steps={GLOBAL_SETUP_STEPS} current={step} />

      <div className="min-h-[14rem] py-2" aria-busy={loading}>
        {loading ? (
          <div className="h-40 animate-pulse rounded-lg bg-muted/40" />
        ) : step === 0 ? (
          <div className="flex flex-col gap-4">
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
            </div>
            <BlackoutDatesField
              label={t("Blackout dates")}
              hint={t("Exams, holidays — no matches on these days.")}
              value={form.blackouts}
              onChange={(v) => set("blackouts", v)}
              testId="blackouts"
            />
            <BlackoutDatesField
              label={t("Reserve days")}
              hint={t("Kept free at generation as rain/repair buffer days.")}
              value={form.reserves}
              onChange={(v) => set("reserves", v)}
              testId="reserves"
            />
            <CeremonyField
              label={t("Opening ceremony")}
              value={form.opening}
              onChange={(v) => set("opening", v)}
              testId="opening"
            />
            <CeremonyField
              label={t("Closing ceremony")}
              value={form.closing}
              onChange={(v) => set("closing", v)}
              testId="closing"
            />
          </div>
        ) : step === 1 ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              {t(
                "Your venue pool — shared by every competition. A hall with 4 tables runs 4 matches in parallel.",
              )}
            </p>
            {form.venues.map((v, i) => (
              <VenueRow
                key={v.id ?? `new-${i}`}
                value={v}
                index={i}
                onChange={(nv) =>
                  set("venues", form.venues.map((x, j) => (j === i ? nv : x)))
                }
                onRemove={() =>
                  set("venues", form.venues.filter((_, j) => j !== i))
                }
              />
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              data-testid="add-venue"
              onClick={() =>
                set("venues", [
                  ...form.venues,
                  { name: "", venue_type: "ground", count: 1, from: "", to: "" },
                ])
              }
            >
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Add venue")}
            </Button>
          </div>
        ) : step === 2 ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("Earliest kickoff")}>
                <Input
                  type="time"
                  value={form.daily_start}
                  onChange={(e) => set("daily_start", e.target.value)}
                />
              </Field>
              <Field label={t("Latest kickoff")}>
                <Input
                  type="time"
                  value={form.daily_end}
                  onChange={(e) => set("daily_end", e.target.value)}
                />
              </Field>
              <Field label={t("Match length (minutes, incl. turnaround)")}>
                <Input
                  type="number"
                  min={10}
                  value={form.slot_minutes}
                  onChange={(e) => set("slot_minutes", Number(e.target.value))}
                />
              </Field>
              <Field
                label={t("Minimum rest between a team's matches (minutes)")}
              >
                <Input
                  type="number"
                  min={0}
                  value={form.rest_minutes}
                  onChange={(e) => set("rest_minutes", Number(e.target.value))}
                />
              </Field>
              <Field label={t("Max matches per team per day")}>
                <Input
                  type="number"
                  min={1}
                  value={form.max_per_day}
                  onChange={(e) => set("max_per_day", Number(e.target.value))}
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.sunday_church}
                data-testid="sunday-church"
                onChange={(e) => set("sunday_church", e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              {t("Keep Sunday mornings free (no matches before 13:00)")}
            </label>
          </div>
        ) : (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Row
              k={t("Dates")}
              v={`${form.date_start || "—"} → ${form.date_end || "—"}`}
            />
            <Row
              k={t("Daily window")}
              v={`${form.daily_start}–${form.daily_end} · ${form.slot_minutes} ${t("min slots")}`}
            />
            <Row
              k={t("Venues")}
              v={String(form.venues.filter((v) => v.name.trim()).length)}
            />
            <Row
              k={t("Rest & caps")}
              v={`${form.rest_minutes} ${t("min rest")} · ${t("max")} ${form.max_per_day}/${t("day")}`}
            />
            <Row
              k={t("Blackouts / reserves")}
              v={`${form.blackouts.length} / ${form.reserves.length}`}
            />
            <Row
              k={t("Ceremonies")}
              v={
                [
                  form.opening?.date ? t("opening") : null,
                  form.closing?.date ? t("closing") : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || t("none")
              }
            />
            <Row
              k={t("Sunday mornings")}
              v={form.sunday_church ? t("Blocked until 13:00") : t("Open")}
            />
          </dl>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <div className="flex gap-2">
          {step > 0 ? (
            <Button variant="outline" onClick={() => setStep((s) => s - 1)}>
              {t("Back")}
            </Button>
          ) : null}
          {step < GLOBAL_SETUP_STEPS.length - 1 ? (
            <Button
              disabled={!canProceed || loading}
              onClick={() => setStep((s) => s + 1)}
            >
              {t("Next")}
            </Button>
          ) : (
            <Button
              disabled={save.isPending || loading}
              data-testid="save-global-setup"
              onClick={() => save.mutate()}
            >
              <Sparkles aria-hidden="true" className="h-4 w-4" />
              {save.isPending ? t("Saving…") : t("Save global setup")}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
