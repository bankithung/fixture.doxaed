import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarRange,
  GitBranch,
  GitMerge,
  Layers,
  ListChecks,
  Pencil,
  Save,
  Shuffle,
  Wand2,
} from "lucide-react";
import {
  tournamentsApi,
  type DrawConfig,
  type DrawConfigLayer,
  type DrawConfigResponse,
  type TeamRow,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { SeedListEditor, type SeedTeam } from "./SeedListEditor";

/** UI-level format. League and Groups both store `format: "round_robin"` —
 * a league is simply one group holding every team. */
type UiFormat =
  | "league"
  | "groups"
  | "knockout"
  | "groups_knockout"
  | "swiss"
  | "double_elim";

const FORMATS: {
  key: UiFormat;
  label: string;
  hint: string;
  icon: typeof Wand2;
}[] = [
  {
    key: "league",
    label: "League",
    hint: "Everyone plays everyone — a single table decides it.",
    icon: ListChecks,
  },
  {
    key: "groups",
    label: "Groups",
    hint: "Round-robin inside groups of N — standings per group.",
    icon: Layers,
  },
  {
    key: "knockout",
    label: "Knockout",
    hint: "Single elimination. Byes are added automatically.",
    icon: GitBranch,
  },
  {
    key: "groups_knockout",
    label: "Groups → Knockout",
    hint: "Group stage now; the top N of each group advance to a bracket.",
    icon: Wand2,
  },
  {
    key: "swiss",
    label: "Swiss",
    hint: "A fixed number of rounds — each round pairs similar records, never repeating a pairing.",
    icon: Shuffle,
  },
  {
    key: "double_elim",
    label: "Double elimination",
    hint: "Lose once and drop to the losers bracket; lose twice and you're out.",
    icon: GitMerge,
  },
];

const SEEDING_OPTIONS = [
  { value: "registration", label: "Registration order" },
  { value: "random", label: "Random draw (replayable)" },
  { value: "snake", label: "Snake — spread by seed" },
  { value: "seeded", label: "Seeded — strict seed order" },
];

/** Groups→knockout bracket-pool order (increment O). */
const KNOCKOUT_SEEDING_OPTIONS = [
  { value: "cross", label: "Cross-group — A1 vs B2" },
  { value: "overall", label: "Overall record — best vs worst" },
];

/** The backend's auto round count when swiss_rounds is unset: ceil(log2 n),
 * capped at n-1 — shown as the suggested default (tenet 1). */
function suggestedSwissRounds(teamCount: number): number {
  if (teamCount < 2) return 1;
  return Math.min(
    Math.max(1, Math.ceil(Math.log2(teamCount))),
    teamCount - 1,
  );
}

/** Client-side mirror of the §2.1 layering, for PREFILL only (the server
 * resolves the real effective config at generation time). */
function effectiveFor(dc: DrawConfigResponse, leafKey: string): DrawConfig {
  const out = { ...dc.defaults };
  for (const layer of [dc.draw_config["*"], leafKey ? dc.draw_config[leafKey] : undefined]) {
    if (layer) Object.assign(out, layer);
  }
  return out;
}

function bySeed(teams: TeamRow[]): SeedTeam[] {
  return [...teams]
    .sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || a.name.localeCompare(b.name))
    .map((tm) => ({ id: tm.id, name: tm.name }));
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

interface Form {
  ui: UiFormat;
  groupSize: number;
  advance: number;
  /** Best next-placed cross-group qualifiers (groups→knockout). */
  bestThirds: number;
  twoLegs: boolean;
  seeding: string;
  /** Groups→knockout bracket pool order: "cross" | "overall". */
  knockoutSeeding: string;
  thirdPlace: boolean;
  /** Consolation plate over round-1 losers (knockout family). */
  plate: boolean;
  /** Swiss round count. */
  swissRounds: number;
  order: SeedTeam[];
}

/**
 * Per-competition format wizard (redesign §6 screen 3; evolves the old
 * GenerateDrawWizard). Asks ONLY the per-competition questions — format,
 * group size, advance-per-group, legs, seeding (with a SeedListEditor for
 * `seeded`), third place — and shows the asked-once globals read-only in the
 * header with an Edit link (tenet 1: never re-ask what is known).
 *
 * "Save format" persists `draw_config[leaf]` via the draw-config PATCH
 * WITHOUT generating; "Save & generate draw" then generates from the stored
 * config (bare `{leaf_key}` body — §4.5). Mount conditionally so each opening
 * reseeds from the stored layers.
 */
export function CompetitionFormatWizard({
  tournamentId,
  open,
  onClose,
  leafKey,
  leafLabel,
  teams,
  onGenerated,
  onPreview,
  onEditGlobals,
}: {
  tournamentId: string;
  open: boolean;
  onClose: () => void;
  /** "" = the legacy/uncategorized bucket (stores on the `"*"` layer). */
  leafKey: string;
  leafLabel: string;
  /** Registered teams in this competition (count + seed-editor prefill). */
  teams: TeamRow[];
  /** Called after a successful generation — chain the schedule wizard here. */
  onGenerated: (opts: { leafKey: string; label: string }) => void;
  /** Dry-run path (redesign §6 screen 5): when set, the primary CTA becomes
   * "Preview & generate" — save the format, then hand off to the full-page
   * preview instead of generating directly. */
  onPreview?: (opts: { leafKey: string; label: string }) => void;
  /** Reopen the GlobalSetupWizard (the header's Edit link). */
  onEditGlobals?: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const teamCount = teams.length;
  const [form, setForm] = useState<Form | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]): void =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

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

  // Seed ONCE from the stored layers (guarded render-phase adjustment; the
  // wizard is mounted conditionally so reopening reseeds).
  if (form === null && drawConfig.data) {
    const stored = {
      ...(drawConfig.data.draw_config["*"] ?? {}),
      ...(leafKey ? (drawConfig.data.draw_config[leafKey] ?? {}) : {}),
    };
    const eff = effectiveFor(drawConfig.data, leafKey);
    const hasStored = stored.format !== undefined || stored.group_size !== undefined;
    const ui: UiFormat =
      eff.format === "knockout"
        ? "knockout"
        : eff.format === "groups_knockout"
          ? "groups_knockout"
          : eff.format === "swiss"
            ? "swiss"
            : eff.format === "double_elim"
              ? "double_elim"
              : !hasStored || teamCount < 2 || eff.group_size >= teamCount
                ? "league"
                : "groups";
    setForm({
      ui,
      groupSize: Math.max(2, eff.group_size),
      advance: Math.max(1, eff.advance_per_group),
      bestThirds: Math.max(0, eff.advance_best_thirds ?? 0),
      twoLegs: eff.legs === 2,
      seeding: eff.seeding,
      knockoutSeeding: eff.knockout_seeding ?? "cross",
      thirdPlace: Boolean(eff.third_place),
      plate: Boolean(eff.plate),
      swissRounds: eff.swiss_rounds ?? suggestedSwissRounds(teamCount),
      order: bySeed(teams),
    });
  }

  const f = form;
  const needsGroups = f?.ui === "groups" || f?.ui === "groups_knockout";
  // Third place + plate apply to the single-elim knockout family only —
  // double elimination ignores both (the losers bracket IS the consolation
  // path and its final decides 3rd, increment Q).
  const isKnockoutish = f?.ui === "knockout" || f?.ui === "groups_knockout";
  /** Legs only make sense for the round-robin family. */
  const hasLegs =
    f?.ui === "league" || f?.ui === "groups" || f?.ui === "groups_knockout";
  const groupCount = f
    ? Math.max(1, Math.ceil(Math.max(1, teamCount) / Math.max(2, f.groupSize)))
    : 1;
  const advanceInvalid =
    f?.ui === "groups_knockout" && f.advance >= Math.max(2, f.groupSize);

  /** The sparse layer "Save format" persists (always self-consistent so the
   * server's advance_per_group < group_size validation holds — §9 A8). */
  const buildConfig = (): DrawConfigLayer => {
    if (!f) return {};
    const cfg: DrawConfigLayer = { seeding: f.seeding };
    if (f.ui === "knockout") {
      cfg.format = "knockout";
      cfg.third_place = f.thirdPlace;
      cfg.plate = f.plate;
      return cfg;
    }
    if (f.ui === "double_elim") {
      // third_place/plate deliberately NOT stored — the losers bracket is
      // the consolation path and its final decides 3rd (increment Q).
      cfg.format = "double_elim";
      return cfg;
    }
    if (f.ui === "swiss") {
      cfg.format = "swiss";
      cfg.swiss_rounds = Math.max(1, f.swissRounds);
      return cfg;
    }
    const gs = f.ui === "league" ? Math.max(2, teamCount) : Math.max(2, f.groupSize);
    cfg.format = f.ui === "groups_knockout" ? "groups_knockout" : "round_robin";
    cfg.group_size = gs;
    cfg.advance_per_group =
      f.ui === "groups_knockout" ? f.advance : Math.max(1, Math.min(f.advance, gs - 1));
    cfg.legs = f.twoLegs ? 2 : 1;
    if (f.ui === "groups_knockout") {
      cfg.third_place = f.thirdPlace;
      cfg.plate = f.plate;
      cfg.advance_best_thirds = Math.max(0, f.bestThirds);
      cfg.knockout_seeding = f.knockoutSeeding;
    }
    return cfg;
  };

  const persist = async (): Promise<void> => {
    await tournamentsApi.updateDrawConfig(tournamentId, {
      leaf_key: leafKey || "*",
      config: buildConfig(),
      event_id: newEventId(),
    });
    if (f?.seeding === "seeded" && f.order.length > 0) {
      await tournamentsApi.setTeamSeeds(tournamentId, {
        leaf_key: leafKey,
        seeds: f.order.map((tm, i) => ({ team_id: tm.id, seed: i + 1 })),
        event_id: newEventId(),
      });
    }
  };

  const saveFormat = useMutation({
    mutationFn: persist,
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({
        kind: "success",
        title: t("Format saved"),
        description: t("No draw generated yet — run it whenever you're ready."),
      });
      onClose();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not save the format"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      }),
  });

  /** Dry-run handoff: persist the format, then open the full-page preview —
   * generation/scheduling happen there on Accept (§5.2, nothing persists
   * before that). */
  const saveAndPreview = useMutation({
    mutationFn: persist,
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      onClose();
      onPreview?.({ leafKey, label: leafLabel });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not save the format"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      }),
  });

  const saveAndGenerate = useMutation({
    mutationFn: async () => {
      await persist();
      // Bare body — the just-saved draw config governs the run (§4.5).
      return tournamentsApi.generateFixtures(tournamentId, {
        leafKey: leafKey || undefined,
      });
    },
    onSuccess: (data) => {
      invalidateTournament(qc, tournamentId);
      toast.push({
        kind: "success",
        title: t(`Draw generated — ${data.generated} matches`),
        description:
          f?.ui === "groups_knockout"
            ? t('Group stage created. Once groups finish, use "Advance to knockout".')
            : f?.ui === "swiss"
              ? t('Round 1 drawn. Once every match finishes, use "Generate next round".')
              : undefined,
      });
      onClose();
      onGenerated({ leafKey, label: leafLabel });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not generate the draw"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      }),
  });

  const busy =
    saveFormat.isPending || saveAndGenerate.isPending || saveAndPreview.isPending;
  const cal = drawConfig.data?.draw_config["*"]?.calendar;
  const venueCount = venues.data?.venues.length ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      variant="sheet"
      ariaLabel={t("Competition format")}
    >
      <DialogHeader>
        <DialogTitle>
          {leafLabel ? t(`Format — ${leafLabel}`) : t("Competition format")}
        </DialogTitle>
        <DialogDescription>
          {t(
            `${teamCount} registered teams. Pick a format — every competition can use a different one.`,
          )}
        </DialogDescription>
      </DialogHeader>

      {/* Asked-once globals: read-only context, never re-asked (tenet 1). */}
      <div
        data-testid="globals-strip"
        className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      >
        <CalendarRange aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="font-tabular">
          {cal?.date_start && cal?.date_end
            ? `${fmtDay(cal.date_start)} – ${fmtDay(cal.date_end)}`
            : t("Dates not set")}
        </span>
        <span aria-hidden="true">·</span>
        <span className="font-tabular">
          {venueCount} {venueCount === 1 ? t("venue") : t("venues")}
        </span>
        <span aria-hidden="true">·</span>
        <span>{t("From global setup")}</span>
        {onEditGlobals ? (
          <button
            type="button"
            data-testid="edit-globals"
            onClick={onEditGlobals}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-accent"
          >
            <Pencil aria-hidden="true" className="h-3 w-3" />
            {t("Edit")}
          </button>
        ) : null}
      </div>

      {f === null ? (
        <div className="h-48 animate-pulse rounded-lg bg-muted/40" aria-busy="true" />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2" role="radiogroup" aria-label={t("Draw format")}>
            {FORMATS.map((fmt) => (
              <button
                key={fmt.key}
                type="button"
                role="radio"
                aria-checked={f.ui === fmt.key}
                data-testid={`format-${fmt.key}`}
                onClick={() => set("ui", fmt.key)}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  f.ui === fmt.key
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent/40",
                )}
              >
                <fmt.icon
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0",
                    f.ui === fmt.key ? "text-primary" : "text-muted-foreground",
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t(fmt.label)}</span>
                  <span className="block text-xs text-muted-foreground">{t(fmt.hint)}</span>
                </span>
              </button>
            ))}
          </div>

          {needsGroups ? (
            <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border bg-muted/30 p-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">{t("Teams per group")}</span>
                <Input
                  type="number"
                  min={2}
                  max={Math.max(2, teamCount)}
                  value={f.groupSize}
                  data-testid="group-size"
                  onChange={(e) => set("groupSize", Number(e.target.value) || 2)}
                  className="h-9 w-24"
                />
              </label>
              {f.ui === "groups_knockout" ? (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium">{t("Advance per group")}</span>
                    <Input
                      type="number"
                      min={1}
                      max={8}
                      value={f.advance}
                      data-testid="advance-per-group"
                      onChange={(e) => set("advance", Number(e.target.value) || 1)}
                      className="h-9 w-24"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium">
                      {t("Best next-placed qualifiers")}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      max={16}
                      value={f.bestThirds}
                      data-testid="best-thirds"
                      title={t("Top next-placed teams across all groups that also advance (e.g. best thirds)")}
                      onChange={(e) =>
                        set("bestThirds", Math.max(0, Number(e.target.value) || 0))
                      }
                      className="h-9 w-24"
                    />
                  </label>
                  <label className="flex min-w-44 flex-col gap-1">
                    <span className="text-xs font-medium">{t("Bracket seeding")}</span>
                    <Select
                      aria-label={t("Bracket seeding")}
                      value={f.knockoutSeeding}
                      onChange={(v) => set("knockoutSeeding", v)}
                      options={KNOCKOUT_SEEDING_OPTIONS.map((o) => ({
                        ...o,
                        label: t(o.label),
                      }))}
                      size="sm"
                    />
                  </label>
                </>
              ) : null}
              <p className="pb-1.5 text-xs text-muted-foreground">
                {t(`→ ${groupCount} ${groupCount === 1 ? "group" : "groups"}`)}
                {f.ui === "groups_knockout"
                  ? " · " +
                    t('stored — "Advance to knockout" prefills this, it never re-asks')
                  : null}
              </p>
              {advanceInvalid ? (
                <p className="w-full text-xs text-destructive">
                  {t("Advance per group must be smaller than the group size.")}
                </p>
              ) : null}
            </div>
          ) : null}

          {f.ui === "swiss" ? (
            <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border bg-muted/30 p-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">{t("Rounds")}</span>
                <Input
                  type="number"
                  min={1}
                  max={Math.max(1, teamCount - 1)}
                  value={f.swissRounds}
                  data-testid="swiss-rounds"
                  onChange={(e) =>
                    set("swissRounds", Math.max(1, Number(e.target.value) || 1))
                  }
                  className="h-9 w-24"
                />
              </label>
              <p className="pb-1.5 text-xs text-muted-foreground">
                {t(
                  `Suggested: ${suggestedSwissRounds(teamCount)} for ${teamCount} teams. Round 1 is drawn now; later rounds pair from the standings as results land.`,
                )}
              </p>
            </div>
          ) : null}

          {hasLegs ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={f.twoLegs}
                data-testid="two-legs"
                onChange={(e) => set("twoLegs", e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              {t("Two legs — every pairing plays home & away (double round-robin)")}
            </label>
          ) : null}

          {isKnockoutish ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={f.thirdPlace}
                  data-testid="third-place"
                  onChange={(e) => set("thirdPlace", e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
                {t("Third-place playoff (semifinal losers)")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={f.plate}
                  data-testid="plate"
                  onChange={(e) => set("plate", e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
                {t("Consolation plate — first-round losers play their own bracket")}
              </label>
            </>
          ) : null}

          <div className="flex flex-col gap-1">
            <label
              className="text-xs font-medium"
              htmlFor="seeding-method"
            >
              {t("Seeding method")}
            </label>
            <Select
              id="seeding-method"
              aria-label={t("Seeding method")}
              value={f.seeding}
              onChange={(v) => set("seeding", v)}
              options={SEEDING_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
              className="max-w-xs"
            />
          </div>

          {f.seeding === "seeded" ? (
            teamCount > 0 ? (
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
                <span className="text-xs font-medium">
                  {t("Seed order (1 = top seed) — move rows with the arrows or arrow keys")}
                </span>
                <SeedListEditor teams={f.order} onChange={(next) => set("order", next)} />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("No registered teams yet — seeds can be set once teams register.")}
              </p>
            )
          ) : null}
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || f === null || advanceInvalid}
          data-testid="save-format"
          onClick={() => saveFormat.mutate()}
        >
          <Save aria-hidden="true" className="h-4 w-4" />
          {saveFormat.isPending ? t("Saving…") : t("Save format")}
        </Button>
        {onPreview ? (
          <Button
            type="button"
            disabled={busy || f === null || advanceInvalid || teamCount < 2}
            data-testid="confirm-preview"
            onClick={() => saveAndPreview.mutate()}
          >
            <Wand2 aria-hidden="true" className="h-4 w-4" />
            {saveAndPreview.isPending ? t("Saving…") : t("Preview & generate")}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={busy || f === null || advanceInvalid || teamCount < 2}
            data-testid="confirm-generate"
            onClick={() => saveAndGenerate.mutate()}
          >
            <Wand2 aria-hidden="true" className="h-4 w-4" />
            {saveAndGenerate.isPending ? t("Generating…") : t("Save & generate draw")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
