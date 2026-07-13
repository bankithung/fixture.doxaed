import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  Check,
  ChevronRight,
  Info,
  Lightbulb,
  Plus,
  Sparkles,
} from "lucide-react";
import {
  tournamentsApi,
  type ConstraintDraft,
  type ConstraintRecord,
  type VenueRecord,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input, type InputProps } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import "@/components/ui/star-border.css";
import { BlackoutDatesField } from "./BlackoutDatesField";
import { CeremonyField, type CeremonyValue } from "./CeremonyField";
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
  /** How breaks are set: one window for every venue, or per-venue rows. */
  break_mode: "overall" | "per_venue";
  /** Overall daily break (all venues), every day; empty = none. */
  daily_break_from: string;
  daily_break_to: string;
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
  // Start-grid step + fallback when a competition sets no length of its own.
  // Match LENGTHS are now set per competition on the format step; this is just
  // the scheduling granularity, so a fine default keeps schedules tight.
  slot_minutes: 30,
  rest_minutes: 60,
  max_per_day: 1,
  sunday_church: true,
  break_mode: "overall",
  daily_break_from: "",
  daily_break_to: "",
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
    sports: v.sports ?? [],
    break_from: v.breaks?.[0]?.from ?? "",
    break_to: v.breaks?.[0]?.to ?? "",
  };
}

function draftWindows(d: VenueDraft): { from: string; to: string }[] {
  return d.from && d.to ? [{ from: d.from, to: d.to }] : [];
}

function draftBreaks(d: VenueDraft): { from: string; to: string }[] {
  return d.break_from && d.break_to
    ? [{ from: d.break_from, to: d.break_to }]
    : [];
}

/** "2026-06-12" → "Jun 12" — the review reads in words, not ISO. */
function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** The four sub-steps of the When & Where wizard — display titles + the
 * one-liners shown in the left rail and the header. Indices map 1:1 to the
 * form's `step` (Dates / Venues / Play times / Check & save). */
const WIZARD_STEPS = [
  {
    key: "calendar",
    title: "When & Where",
    sub: "Dates and key days",
    subtitle: "Set your date range and any key days.",
  },
  {
    key: "venues",
    title: "Venues",
    sub: "Add competition venues",
    subtitle: "Add your match venues and any breaks.",
  },
  {
    key: "defaults",
    title: "Play Times",
    sub: "Set daily play times",
    subtitle: "Set daily play times and team limits.",
  },
  {
    key: "review",
    title: "Check & Save",
    sub: "Review and finish",
    subtitle: "Review and save. You can change it any time.",
  },
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
      <span className="text-[0.8125rem] font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** A bordered content card — the reference's `.panel`. Supabase-style: a slim
 * section surface; an optional header (title + description) sits above a divided
 * body so each step reads as a settings card, not a chunky box. */
function Panel({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <section className={cn("bento-card star-rim rounded-lg border border-border bg-card", className)}>
      {title ? (
        <header className="border-b border-border px-4 py-3 sm:px-5">
          <h3 className="text-sm font-semibold">{t(title)}</h3>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{t(description)}</p>
          ) : null}
        </header>
      ) : null}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

/** A native date/time input dressed as the reference's "control" box: a tall
 * bordered field with a leading icon (the native picker indicator sits at the
 * right; `color-scheme` keeps it legible in dark mode). */
function ControlInput({
  icon,
  className,
  ...props
}: { icon: React.ReactNode } & InputProps): React.ReactElement {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
        {icon}
      </span>
      <Input
        {...props}
        className={cn("h-9 pl-9 dark:[color-scheme:dark]", className)}
      />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <div>
      <dt className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
        {k}
      </dt>
      <dd className="mt-0.5 font-tabular text-foreground">{v}</dd>
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
 * Renders INLINE as the hub's page body (owner feedback: part of the full
 * page, not a modal) — heading + reassurance line, the numbered step rail,
 * the current step's fields at full width, Cancel/Back + Next/Save at the
 * bottom. Mount it CONDITIONALLY (`{setup ? <GlobalSetupWizard … /> : null}`)
 * so each opening starts at `initialStep` with a fresh seed from the stored
 * data.
 */
export function GlobalSetupWizard({
  tournamentId,
  onClose,
  onSaved,
  initialStep = 0,
}: {
  tournamentId: string;
  /** Return to the hub view (Cancel, and — if `onSaved` is absent — after save). */
  onClose: () => void;
  /** Called after a successful save instead of `onClose`, so the hub can route
   * to the next journey step (Clashes & sessions) rather than just closing. */
  onSaved?: () => void;
  /** Deep-link target (a GlobalSetupCard pencil / readiness fix action). */
  initialStep?: number;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState(initialStep);
  // Signature of the server data we last seeded from; `dirtyRef` flips on the
  // first user edit. Together they let us re-seed when the data changes while
  // the form is still pristine (see the reconcile block below).
  const [seededSig, setSeededSig] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const set = <K extends keyof Form>(k: K, v: Form[K]): void => {
    setDirty(true);
    setForm((f) => ({ ...f, [k]: v }));
  };
  // Switching break mode clears the OTHER side so the two never coexist (the
  // engine would otherwise apply both) — a true overall-OR-per-venue choice.
  const setBreakMode = (mode: Form["break_mode"]): void => {
    setDirty(true);
    setForm((f) =>
      mode === "overall"
        ? {
            ...f,
            break_mode: mode,
            venues: f.venues.map((v) => ({ ...v, break_from: "", break_to: "" })),
          }
        : { ...f, break_mode: mode, daily_break_from: "", daily_break_to: "" },
    );
  };

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
  const sportsQ = useQuery({
    queryKey: ["tournament-sports", tournamentId],
    queryFn: () => tournamentsApi.sports(tournamentId),
  });
  const sportOptions = sportsQ.data?.sports ?? [];

  // Reconcile the form with the stored sources whenever they change AND the
  // user hasn't edited yet (pristine): seeds on first load and ALSO absorbs
  // changes made elsewhere — e.g. the AI assistant setting dates/venues behind
  // an open wizard — instead of going stale until remount. The first user edit
  // flips `dirtyRef`, after which we never clobber their in-progress changes.
  if (drawConfig.data && venues.data && settings.data) {
    const cal = drawConfig.data.draw_config["*"]?.calendar ?? null;
    const records = settings.data.constraints ?? [];
    const sig = JSON.stringify([cal, records, venues.data.venues]);
    if (sig !== seededSig && !dirty) {
      const one = (type: string): ConstraintRecord | undefined =>
        records.find((c) => c.type === type && isAll(c));
      const ceremonies = records.filter(
        (c) => c.type === "ceremony_block" && isAll(c),
      );
      // Both the Sunday-church block and the overall daily break are
      // recurring_blackout_window @ scope "all"; tell them apart by label
      // (legacy church records have no label but carry days:["sun"]).
      const church = records.find(
        (c) =>
          c.type === "recurring_blackout_window" &&
          isAll(c) &&
          (c.params?.label === "sunday_church" ||
            (Array.isArray(c.params?.days) &&
              (c.params.days as string[]).includes("sun"))),
      );
      const dailyBreak = records.find(
        (c) =>
          c.type === "recurring_blackout_window" &&
          isAll(c) &&
          c.params?.label === "daily_break",
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
        slot_minutes: Number(cal?.slot_minutes ?? 30),
        rest_minutes: Number(one("min_rest_minutes")?.params.minutes ?? 60),
        max_per_day: Number(
          one("max_matches_per_team_per_day")?.params.count ?? 1,
        ),
        // Default ON (Nagaland Sunday-morning church) until the wizard has been
        // saved once; after that the stored record is the truth.
        sunday_church: church !== undefined || cal === null,
        break_mode: venues.data.venues.some((v) => (v.breaks?.length ?? 0) > 0)
          ? "per_venue"
          : "overall",
        daily_break_from: String(dailyBreak?.params.from ?? ""),
        daily_break_to: String(dailyBreak?.params.to ?? ""),
      });
      setSeededSig(sig);
    }
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
          sports: d.sports,
          breaks: draftBreaks(d),
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
          JSON.stringify(prev.windows ?? []) !== JSON.stringify(body.windows) ||
          JSON.stringify(prev.sports ?? []) !== JSON.stringify(body.sports) ||
          JSON.stringify(prev.breaks ?? []) !== JSON.stringify(body.breaks);
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
          params: { days: ["sun"], from: "00:00", to: "13:00",
            label: "sunday_church" } });
      }
      if (
        form.break_mode === "overall" &&
        form.daily_break_from &&
        form.daily_break_to
      ) {
        // Overall daily break — every day (empty `days`), all venues. Only in
        // overall mode: in per_venue mode any stored daily_break record stays
        // filtered out above, so the two break kinds never coexist.
        next.push({ type: "recurring_blackout_window", scope: "all",
          params: { days: [], from: form.daily_break_from,
            to: form.daily_break_to, label: "daily_break" } });
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
      toast.push({ kind: "success", title: t("Step 1 saved") });
      (onSaved ?? onClose)();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not save. Try again."),
        description:
          e instanceof ApiError ? (e.payload.detail ?? "") : undefined,
      }),
  });

  const loading =
    drawConfig.isLoading || venues.isLoading || settings.isLoading;
  const canProceed =
    step !== 0 || (form.date_start !== "" && form.date_end !== "");

  const cur = WIZARD_STEPS[step] ?? WIZARD_STEPS[0];
  const isLast = step === WIZARD_STEPS.length - 1;
  const datesSet = form.date_start !== "" && form.date_end !== "";

  /** The header / footer primary action (single set — Next while stepping,
   * Save on the last step). Kept in one place so it stays unambiguous. */
  const primaryAction = isLast ? (
    <Button
      disabled={save.isPending || loading}
      data-testid="save-global-setup"
      onClick={() => save.mutate()}
    >
      <Sparkles aria-hidden="true" className="h-4 w-4" />
      {save.isPending ? t("Saving…") : t("Save")}
    </Button>
  ) : (
    <Button
      disabled={!canProceed || loading}
      onClick={() => setStep((s) => s + 1)}
    >
      {t("Next")}
      <ChevronRight aria-hidden="true" className="h-4 w-4" />
    </Button>
  );

  return (
    <section
      aria-label={t("Step 1 · When & where")}
      data-testid="global-setup-inline"
      className="w-full bento-card star-rim rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6"
    >
      {/* Header — eyebrow + title + subtitle. The actions (Cancel / Next / Save)
          live in the footer beside the Tip, so they're within reach right after
          the user finishes entering details and scrolls down. */}
      <header className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t(`Step ${step + 1} of 4`)}
        </p>
        <h1 className="mt-1 text-lg font-semibold tracking-tight sm:text-xl">
          {t(cur.title)}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(cur.subtitle)}
        </p>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[200px_1fr] lg:gap-8">
        {/* Left rail — the four sub-steps + a reassurance card. */}
        <aside>
          <ol className="flex flex-col">
            {WIZARD_STEPS.map((s, i) => {
              const isActive = i === step;
              const done = i < step;
              // Can't jump past the Dates gate until both match days are set.
              const locked = i > 0 && step === 0 && !datesSet;
              const clickable = !isActive && !locked;
              const last = i === WIZARD_STEPS.length - 1;
              return (
                <li key={s.key} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <button
                      type="button"
                      aria-current={isActive ? "step" : undefined}
                      disabled={!clickable}
                      onClick={() => clickable && setStep(i)}
                      className={cn(
                        "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-semibold transition-colors",
                        isActive
                          ? "border-primary text-primary"
                          : done
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input text-muted-foreground",
                        clickable && "cursor-pointer hover:border-primary/60",
                      )}
                    >
                      {done ? (
                        <Check aria-hidden="true" className="h-3.5 w-3.5" />
                      ) : (
                        <span className="font-tabular">{i + 1}</span>
                      )}
                    </button>
                    {!last ? (
                      <span className="my-1 min-h-[20px] w-0 flex-1 border-l border-dashed border-border" />
                    ) : null}
                  </div>
                  <button
                    type="button"
                    disabled={!clickable}
                    onClick={() => clickable && setStep(i)}
                    className={cn("pb-5 text-left", clickable && "cursor-pointer")}
                  >
                    <div
                      className={cn(
                        "text-[0.8125rem] font-medium leading-tight",
                        isActive ? "text-primary" : "text-foreground",
                      )}
                    >
                      {t(s.title)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t(s.sub)}
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="mt-1 hidden rounded-lg border border-border bg-muted/30 p-3 lg:block">
            <div className="flex items-center gap-2">
              <CalendarDays
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-primary"
              />
              <h4 className="text-xs font-semibold">
                {t("Your schedule, your control")}
              </h4>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t("Come back anytime to adjust dates, venues or times.")}
            </p>
          </div>
        </aside>

        {/* Right — the current sub-step's content. */}
        <div className="min-w-0" aria-busy={loading}>
          {loading ? (
            <div className="h-64 animate-pulse rounded-xl bg-muted/40" />
          ) : step === 0 ? (
            <div className="flex flex-col gap-4">
              <Panel
                title="Tournament dates"
                description="First and last match day, plus any days to skip or keep spare."
              >
                {/* Match window — the two dates everything else is built from. */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("First match day")}>
                    <ControlInput
                      icon={<CalendarDays className="h-4 w-4" />}
                      type="date"
                      value={form.date_start}
                      max={form.date_end || undefined}
                      onChange={(e) => set("date_start", e.target.value)}
                    />
                  </Field>
                  <Field label={t("Last match day")}>
                    <ControlInput
                      icon={<CalendarDays className="h-4 w-4" />}
                      type="date"
                      value={form.date_end}
                      min={form.date_start || undefined}
                      onChange={(e) => set("date_end", e.target.value)}
                    />
                  </Field>
                </div>
                {!form.date_start || !form.date_end ? (
                  /* Why the Next button is disabled — never leave it a mystery. */
                  <p className="mt-2.5 text-xs text-muted-foreground">
                    {t("Pick the first and last match days to continue.")}
                  </p>
                ) : null}

                <hr className="my-5 border-border" />

                {/* Calendar exceptions — days the schedule avoids or holds. */}
                <div className="grid gap-5 sm:grid-cols-2">
                  <BlackoutDatesField
                    label={t("Days off")}
                    hint={t("No matches on these days (exams, holidays).")}
                    value={form.blackouts}
                    onChange={(v) => set("blackouts", v)}
                    testId="blackouts"
                  />
                  <BlackoutDatesField
                    label={t("Spare days")}
                    hint={t("Buffer days. If rain washes out a day, matches move here.")}
                    value={form.reserves}
                    onChange={(v) => set("reserves", v)}
                    testId="reserves"
                  />
                </div>
              </Panel>

              {/* Ceremonies — own panels with a coloured icon; dates auto-fill. */}
              <CeremonyField
                label={t("Opening ceremony")}
                tone="opening"
                value={form.opening}
                onChange={(v) => set("opening", v)}
                testId="opening"
                defaultDate={form.date_start}
              />
              <CeremonyField
                label={t("Closing ceremony")}
                tone="closing"
                value={form.closing}
                onChange={(v) => set("closing", v)}
                testId="closing"
                defaultDate={form.date_end}
              >
                <div className="mt-4 flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  <Info
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-muted-foreground/70"
                  />
                  {t("No matches run during a ceremony.")}
                </div>
              </CeremonyField>
            </div>
          ) : step === 1 ? (
            <Panel
              title="Venues"
              description="A venue with 4 courts runs 4 matches at once."
            >
              <div className="flex flex-col gap-3">
            {sportOptions.length > 1 ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  "Use “Used by” to reserve a venue for one sport.",
                )}
              </p>
            ) : null}

            {/* Break timings — overall OR per-venue (owner ask 2026-06-27). No
                match is scheduled during a break; the engine cuts it from the
                slot grid. */}
            <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("Break timings")}
                </span>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "No matches during breaks.",
                  )}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:gap-5">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="break-mode"
                    data-testid="break-mode-overall"
                    checked={form.break_mode === "overall"}
                    onChange={() => setBreakMode("overall")}
                    className="h-4 w-4 border-input text-primary"
                  />
                  {t("One break for all venues")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="break-mode"
                    data-testid="break-mode-per-venue"
                    checked={form.break_mode === "per_venue"}
                    onChange={() => setBreakMode("per_venue")}
                    className="h-4 w-4 border-input text-primary"
                  />
                  {t("A different break per venue")}
                </label>
              </div>
              {form.break_mode === "overall" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("Break starts at")}>
                    <Input
                      type="time"
                      className="h-9"
                      value={form.daily_break_from}
                      aria-label={t("Daily break starts at")}
                      onChange={(e) => set("daily_break_from", e.target.value)}
                    />
                  </Field>
                  <Field label={t("Break ends at")}>
                    <Input
                      type="time"
                      className="h-9"
                      value={form.daily_break_to}
                      aria-label={t("Daily break ends at")}
                      onChange={(e) => set("daily_break_to", e.target.value)}
                    />
                  </Field>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("Set each venue's break in its row below.")}
                </p>
              )}
            </div>

            {form.venues.map((v, i) => (
              <VenueRow
                key={v.id ?? `new-${i}`}
                value={v}
                index={i}
                sportOptions={sportOptions}
                showBreak={form.break_mode === "per_venue"}
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
                  {
                    name: "", venue_type: "ground", count: 1, from: "", to: "",
                    sports: [], break_from: "", break_to: "",
                  },
                ])
              }
            >
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Add venue")}
            </Button>
              </div>
            </Panel>
          ) : step === 2 ? (
            <Panel
              title="Play times"
              description="Daily play window, rest between matches and per-day limits."
            >
              <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("First match of the day starts at")}>
                <Input
                  type="time"
                  className="h-9"
                  value={form.daily_start}
                  onChange={(e) => set("daily_start", e.target.value)}
                />
              </Field>
              <Field label={t("Last match must start by")}>
                <Input
                  type="time"
                  className="h-9"
                  value={form.daily_end}
                  onChange={(e) => set("daily_end", e.target.value)}
                />
              </Field>
            </div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("Pace")}
            </h4>
            <p className="-mt-1 text-xs text-muted-foreground">
              {t(
                "Match length is set per competition on the “How each competition plays” step.",
              )}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={t("Shortest break between a team's matches (minutes)")}
              >
                <Input
                  type="number"
                  min={0}
                  className="h-9"
                  value={form.rest_minutes}
                  onChange={(e) => set("rest_minutes", Number(e.target.value))}
                />
              </Field>
              <Field label={t("Most matches a team plays in one day")}>
                <Input
                  type="number"
                  min={1}
                  className="h-9"
                  value={form.max_per_day}
                  onChange={(e) => set("max_per_day", Number(e.target.value))}
                />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Break timings are set on the Venues step.")}
            </p>
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
            </Panel>
          ) : (
            <Panel
              title="Check & save"
              description="Review below, then save. Change it any time."
            >
              <dl className="grid gap-x-8 gap-y-4 text-xs sm:grid-cols-2">
            <Row
              k={t("Dates")}
              v={`${form.date_start ? fmtDay(form.date_start) : t("not set")} ${t("to")} ${form.date_end ? fmtDay(form.date_end) : t("not set")}`}
            />
            <Row
              k={t("Play times")}
              v={t(`${form.daily_start} to ${form.daily_end}`)}
            />
            <Row
              k={t("Venues")}
              v={String(form.venues.filter((v) => v.name.trim()).length)}
            />
            <Row
              k={t("Break time")}
              v={
                form.break_mode === "overall" &&
                form.daily_break_from &&
                form.daily_break_to
                  ? t(
                      `${form.daily_break_from} to ${form.daily_break_to}, all venues`,
                    )
                  : form.break_mode === "per_venue" &&
                      form.venues.some((v) => v.break_from && v.break_to)
                    ? t(
                        `per venue (${form.venues.filter((v) => v.break_from && v.break_to).length})`,
                      )
                    : t("none")
              }
            />
            <Row
              k={t("Breaks")}
              v={t(
                `${form.rest_minutes} min between matches, max ${form.max_per_day} per day`,
              )}
            />
            <Row k={t("Days off")} v={String(form.blackouts.length)} />
            <Row k={t("Spare days")} v={String(form.reserves.length)} />
            <Row
              k={t("Ceremonies")}
              v={
                [
                  form.opening?.date ? t("opening") : null,
                  form.closing?.date ? t("closing") : null,
                ]
                  .filter(Boolean)
                  .join(", ") || t("none")
              }
            />
            <Row
              k={t("Sunday mornings")}
              v={form.sunday_church ? t("Free until 13:00") : t("Open")}
            />
              </dl>
            </Panel>
          )}
        </div>
      </div>

      {/* Footer — a reassurance tip alongside the step actions (Back / Cancel /
          Next / Save), kept on one row so the controls are right where the user
          lands after scrolling through the step's fields. */}
      <div className="mt-7 flex flex-col gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
          <Lightbulb
            aria-hidden="true"
            className="h-5 w-5 shrink-0 text-primary"
          />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-primary">{t("Tip")}</div>
            <div className="text-xs text-muted-foreground">
              {t("Revisit these settings any time.")}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-3">
          {step > 0 ? (
            <Button variant="outline" onClick={() => setStep((s) => s - 1)}>
              {t("Back")}
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          {primaryAction}
        </div>
      </div>
    </section>
  );
}
