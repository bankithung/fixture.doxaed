import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Clock,
  GitFork,
  Info,
  Layers,
  Lock,
  Medal,
  Repeat,
  Save,
  Shuffle,
  SlidersHorizontal,
  Target,
  Trophy,
  Users,
} from "lucide-react";
import {
  tournamentsApi,
  type DrawConfig,
  type DrawConfigLayer,
  type DrawStage,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { AskAiButton } from "@/features/assistant/AskAiButton";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import "@/components/ui/star-border.css";
import { LeafLabel } from "./LeafLabel";
import { ScoringControl } from "./ScoringControl";
import { scoringEqual, type Scoring } from "./scoring";
import { TiebreakerControl } from "./TiebreakerControl";
import { tiebreakersEqual } from "./tiebreakers";
import { StagesEditor } from "./StagesEditor";
import { STAGE_TYPE_LABELS, validateStages, type Stage } from "./stagesModel";

interface Comp {
  leafKey: string;
  label: string;
  sport: string;
}

/** Board-level (storage) formats with a plain one-line explanation and the
 * extra inputs each one needs. A subset of the detailed wizard's options,
 * chosen so the organiser can pick a game type for every category fast. */
const BOARD_FORMATS: { value: string; label: string; hint: string }[] = [
  {
    value: "knockout",
    label: "Knockout (single elimination)",
    hint: "Lose and you're out. Byes are added automatically when the number of teams isn't a power of two.",
  },
  {
    value: "groups_knockout",
    label: "Group stage to Knockout",
    hint: "Round-robin groups first (FIFA-style), then the top teams from each group advance into a knockout bracket.",
  },
  {
    value: "round_robin",
    label: "Round-robin (league)",
    hint: "Everyone plays everyone; the standings table decides the winner.",
  },
  {
    value: "swiss",
    label: "Swiss",
    hint: "A set number of rounds; each round pairs teams on similar records, never repeating a match.",
  },
  {
    value: "double_elim",
    label: "Double elimination",
    hint: "Lose once and you drop to a second bracket; lose twice and you're out.",
  },
];

/** Icon per board format, so the visual picker reads at a glance. */
const FORMAT_ICON: Record<string, typeof Trophy> = {
  knockout: Trophy,
  groups_knockout: Users,
  round_robin: Repeat,
  swiss: Shuffle,
  double_elim: GitFork,
};

const prettySport = (key: string): string =>
  key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");

/** A settings panel sub-card (Supabase dense recipe): titled header strip over a
 * padded body, used for each section of a sport card. */
function SubCard({
  icon: Icon,
  title,
  right,
  children,
}: {
  icon: typeof Trophy;
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="bento-card star-rim rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-[0.8125rem] font-semibold text-foreground">{title}</span>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

/** Mutually-exclusive structure mode: one single format, or a multi-stage plan.
 * "Multiple stages" keeps the historical `-stages-toggle` testid; a single click
 * enters stages mode and mounts the editor. */
function ModeSegmented({
  ariaLabel,
  multi,
  disabled,
  onFormat,
  onStages,
  formatTestId,
  stagesTestId,
}: {
  ariaLabel: string;
  multi: boolean;
  disabled?: boolean;
  onFormat: () => void;
  onStages: () => void;
  formatTestId: string;
  stagesTestId: string;
}): React.ReactElement {
  const seg = (active: boolean): string =>
    cn(
      "h-8 rounded-md px-3 text-xs font-medium transition-colors disabled:opacity-50",
      active
        ? "bg-card text-foreground shadow-sm"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-lg border border-border bg-muted/20 p-0.5"
    >
      <button
        type="button"
        role="radio"
        aria-checked={!multi}
        disabled={disabled}
        data-testid={formatTestId}
        onClick={onFormat}
        className={seg(!multi)}
      >
        {t("One format")}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={multi}
        disabled={disabled}
        data-testid={stagesTestId}
        onClick={onStages}
        className={seg(multi)}
      >
        {t("Multiple stages")}
      </button>
    </div>
  );
}

/**
 * "How each competition plays" — pick a game type (format) for every category
 * at once (owner ask 2026-06-25). One choice per sport sets the format for all
 * its categories via the `sport:<key>` draw-config layer ("all Table Tennis is
 * Knockout"); a category can override it underneath. Group stage to Knockout
 * exposes its group size + how many advance. Detailed seeding/legs/third-place
 * stay in each competition's own draw wizard.
 */
export function CompetitionFormatBoard({
  tournamentId,
  competitions,
  focusSport,
}: {
  tournamentId: string;
  competitions: Comp[];
  /** Sport key to scroll to + expand on arrival — the deep-link target when a
   * card's "Change format" sends the user here. Undefined = no focus. */
  focusSport?: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  // Staged layer writes keyed by layer ("sport:<k>" or a leaf key); empty = clean.
  const [staged, setStaged] = useState<Record<string, DrawConfigLayer>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [stagesOpen, setStagesOpen] = useState<Record<string, boolean>>({});
  // One sport shown at a time behind bookmark tabs (owner ask 2026-07-09);
  // null = the first sport until the user (or focusSport) picks one.
  const [activeSport, setActiveSport] = useState<string | null>(null);
  // Staged per-GAME scoring overrides, keyed by leaf (value = override; null =
  // clear back to the sport default). Saved via the settings PATCH (frozen
  // rules), not draw_config — scoring is participant-facing (invariant 7).
  const [stagedScoring, setStagedScoring] = useState<Record<string, Scoring | null>>({});

  // Arriving from a card's "Change format": select the targeted sport's tab,
  // open its per-category overrides and scroll the board into view.
  useEffect(() => {
    if (!focusSport) return;
    setActiveSport(focusSport);
    setOpen((o) => (o[focusSport] ? o : { ...o, [focusSport]: true }));
    const id = window.setTimeout(() => {
      document
        .querySelector(`[data-testid="format-sport-${focusSport}"]`)
        ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }, 0);
    return () => window.clearTimeout(id);
  }, [focusSport]);
  const [stagedTiebreakers, setStagedTiebreakers] = useState<Record<string, string[] | null>>({});
  const [amendReason, setAmendReason] = useState("");

  const dcQ = useQuery({
    queryKey: qk.drawConfig(tournamentId),
    queryFn: () => tournamentsApi.drawConfig(tournamentId),
  });
  const sportsQ = useQuery({
    queryKey: ["tournament-sports", tournamentId],
    queryFn: () => tournamentsApi.sports(tournamentId),
  });
  const settingsQ = useQuery({
    queryKey: ["tournament-settings", tournamentId],
    queryFn: () => tournamentsApi.settings(tournamentId),
  });

  const sportName = (key: string): string =>
    sportsQ.data?.sports.find((s) => s.key === key)?.name ?? prettySport(key);

  // Competitions grouped by sport, stable first-seen order.
  const sportsInOrder: string[] = [];
  const leavesBySport = new Map<string, Comp[]>();
  for (const c of competitions) {
    if (!leavesBySport.has(c.sport)) {
      leavesBySport.set(c.sport, []);
      sportsInOrder.push(c.sport);
    }
    leavesBySport.get(c.sport)!.push(c);
  }

  // The tab that is showing: the user's pick while it still exists, else the
  // deep-link target, else the first sport.
  const currentSport =
    activeSport && leavesBySport.has(activeSport)
      ? activeSport
      : focusSport && leavesBySport.has(focusSport)
        ? focusSport
        : sportsInOrder[0];

  const dc = dcQ.data;
  const defaults: DrawConfig | undefined = dc?.defaults;

  // Effective resolution mirrors the server's §2.1 layering with the sport
  // layer (defaults < "*" < sport:<k> < leaf), staged edits winning.
  const layerVal = (layerKey: string, key: keyof DrawConfig): unknown =>
    staged[layerKey]?.[key] ?? dc?.draw_config[layerKey]?.[key];

  const sportFormat = (sp: string): string =>
    (layerVal(`sport:${sp}`, "format") as string | undefined) ??
    (layerVal("*", "format") as string | undefined) ??
    defaults?.format ??
    "round_robin";

  const sportParam = (sp: string, key: keyof DrawConfig, fallback: number): number =>
    Number(
      layerVal(`sport:${sp}`, key) ??
        layerVal("*", key) ??
        defaults?.[key] ??
        fallback,
    );

  const boolParam = (sp: string, key: keyof DrawConfig, fallback: boolean): boolean =>
    Boolean(
      layerVal(`sport:${sp}`, key) ??
        layerVal("*", key) ??
        defaults?.[key] ??
        fallback,
    );

  /** A leaf's OWN format override (staged or stored), or "" when it inherits. */
  const leafOwnFormat = (leafKey: string): string =>
    (staged[leafKey]?.format ?? dc?.draw_config[leafKey]?.format ?? "") as string;

  // Per-category match length (owner ask 2026-06-27): a sport-level default
  // (`sport:<k>`) covers all its categories; a leaf can override; both blank =
  // the tournament default from Step 1 · Play times. Read each layer's OWN value
  // (0 = blank/inherit) so the input shows the override, not the merged value.
  const num = (v: unknown): number => Number(v ?? 0) || 0;
  const starDuration = num(
    staged["*"]?.match_duration_minutes ??
      dc?.draw_config["*"]?.match_duration_minutes,
  );
  const sportOwnDuration = (sp: string): number =>
    num(
      staged[`sport:${sp}`]?.match_duration_minutes ??
        dc?.draw_config[`sport:${sp}`]?.match_duration_minutes,
    );
  const leafOwnDuration = (leafKey: string): number =>
    num(
      staged[leafKey]?.match_duration_minutes ??
        dc?.draw_config[leafKey]?.match_duration_minutes,
    );
  /** Stage a duration; null clears the override (the PATCH carries it, so an
   * emptied field truly inherits again — unlike the sparse modal wizard). */
  const stageDuration = (layerKey: string, raw: string): void =>
    stage(layerKey, {
      match_duration_minutes: Number(raw) >= 1 ? Math.floor(Number(raw)) : null,
    });

  const stage = (layerKey: string, patch: DrawConfigLayer): void =>
    setStaged((s) => ({ ...s, [layerKey]: { ...s[layerKey], ...patch } }));

  const setSportFormat = (sp: string, fmt: string): void => {
    const patch: DrawConfigLayer = { format: fmt };
    if (fmt === "groups_knockout") {
      patch.group_size = sportParam(sp, "group_size", 4);
      patch.advance_per_group = sportParam(sp, "advance_per_group", 2);
      // FIFA-style balanced groups are the better default for a fresh choice.
      patch.balance_groups = true;
    }
    stage(`sport:${sp}`, patch);
  };

  // --- Per-game scoring (settings/rules.by_leaf) ---------------------------
  const settings = settingsQ.data;
  const byLeaf = settings?.rules.by_leaf ?? {};
  const scoringDefaults = settings?.scoring_defaults ?? {};
  const canManage = settings?.can_manage ?? true;
  const rulesFrozen = settings ? !settings.can_edit : false;

  const storedLeafScoring = (leafKey: string): Scoring | null =>
    (byLeaf[leafKey]?.scoring as Scoring | undefined) ?? null;
  const effLeafScoring = (leafKey: string): Scoring | null =>
    leafKey in stagedScoring ? stagedScoring[leafKey]! : storedLeafScoring(leafKey);
  const inheritedScoring = (sp: string): Scoring | null =>
    (scoringDefaults[sp] as Scoring | null | undefined) ?? null;

  const stageLeafScoring = (leafKey: string, s: Scoring | null): void =>
    setStagedScoring((m) => ({ ...m, [leafKey]: s }));
  // The sport-level control is a convenience: it stages the same scoring for
  // every game in the sport (rules has no sport layer — it's leaf-keyed).
  const stageSportScoring = (sp: string, s: Scoring | null): void =>
    setStagedScoring((m) => {
      const next = { ...m };
      for (const c of leavesBySport.get(sp)!) next[c.leafKey] = s;
      return next;
    });
  // Representative value for the sport control: the common override if every
  // game agrees, else null (mixed → show the inherited default).
  const sportScoringValue = (sp: string): Scoring | null => {
    const ls = leavesBySport.get(sp)!.map((c) => effLeafScoring(c.leafKey));
    const first = ls[0] ?? null;
    return ls.every((x) => scoringEqual(x, first)) ? first : null;
  };

  // --- Per-game tie-breakers (settings/rules.by_leaf[leaf].tiebreakers) -----
  const storedLeafTbs = (leafKey: string): string[] | null =>
    (byLeaf[leafKey]?.tiebreakers as string[] | undefined) ?? null;
  const effLeafTbs = (leafKey: string): string[] | null =>
    leafKey in stagedTiebreakers ? stagedTiebreakers[leafKey]! : storedLeafTbs(leafKey);
  const stageLeafTbs = (leafKey: string, tbs: string[] | null): void =>
    setStagedTiebreakers((m) => ({ ...m, [leafKey]: tbs }));
  const stageSportTbs = (sp: string, tbs: string[] | null): void =>
    setStagedTiebreakers((m) => {
      const next = { ...m };
      for (const c of leavesBySport.get(sp)!) next[c.leafKey] = tbs;
      return next;
    });
  const sportTbsValue = (sp: string): string[] | null => {
    const ls = leavesBySport.get(sp)!.map((c) => effLeafTbs(c.leafKey));
    const first = ls[0] ?? null;
    return ls.every((x) => tiebreakersEqual(x, first)) ? first : null;
  };

  // One settings PATCH carries every changed game's scoring + tiebreakers.
  const byLeafChanges = (): Record<string, { scoring?: Scoring | null; tiebreakers?: string[] | null }> => {
    const out: Record<string, { scoring?: Scoring | null; tiebreakers?: string[] | null }> = {};
    for (const [leafKey, s] of Object.entries(stagedScoring)) {
      if (!scoringEqual(s, storedLeafScoring(leafKey))) (out[leafKey] ??= {}).scoring = s;
    }
    for (const [leafKey, tbs] of Object.entries(stagedTiebreakers)) {
      if (!tiebreakersEqual(tbs, storedLeafTbs(leafKey))) (out[leafKey] ??= {}).tiebreakers = tbs;
    }
    return out;
  };
  const rulesDirty = Object.keys(byLeafChanges()).length > 0;
  const needsAmendReason = rulesDirty && rulesFrozen && !amendReason.trim();

  // --- Multi-stage plan (draw_config[<layer>].stages) ----------------------
  // A plan lives on any layer: "sport:<k>" (applies to all the sport's
  // categories) or a leaf key (one category overrides the sport plan).
  const layerStages = (key: string): Stage[] => {
    const raw = (staged[key]?.stages ?? dc?.draw_config[key]?.stages) as
      DrawStage[] | null | undefined;
    return Array.isArray(raw) ? raw.map((s) => ({ ...s, id: s.id ?? newEventId() })) : [];
  };
  const setLayerStages = (key: string, stages: Stage[]): void => stage(key, { stages });
  const sportStages = (sp: string): Stage[] => layerStages(`sport:${sp}`);
  const setSportStages = (sp: string, stages: Stage[]): void =>
    setLayerStages(`sport:${sp}`, stages);
  const stagesHaveErrors = sportsInOrder.some(
    (sp) =>
      Object.keys(validateStages(sportStages(sp))).length > 0 ||
      leavesBySport.get(sp)!.some(
        (c) => Object.keys(validateStages(layerStages(c.leafKey))).length > 0,
      ),
  );

  const dirty = Object.keys(staged).length > 0 || rulesDirty;

  /** A short, derived label for the card header: the stage pipeline (joined with
   * the plain word "then") when a plan exists, else the chosen single format. */
  const structureSummary = (sp: string): string => {
    const st = sportStages(sp);
    if (st.length > 0) {
      if (st.length <= 3) return st.map((s) => STAGE_TYPE_LABELS[s.type]).join(` ${t("then")} `);
      return `${t("Multiple stages")} (${st.length})`;
    }
    return t(BOARD_FORMATS.find((f) => f.value === sportFormat(sp))?.label ?? sportFormat(sp));
  };

  /** Does this sport have any staged (unsaved) layer/scoring/tie-breaker edit? */
  const sportDirty = (sp: string): boolean => {
    const leaves = leavesBySport.get(sp)!;
    if (`sport:${sp}` in staged) return true;
    if (leaves.some((c) => c.leafKey in staged)) return true;
    return leaves.some((c) => c.leafKey in stagedScoring || c.leafKey in stagedTiebreakers);
  };

  /** Does a leaf diverge from its sport (its own format/length/plan/rules)? */
  const leafDiverges = (c: Comp): boolean =>
    leafOwnFormat(c.leafKey) !== "" ||
    leafOwnDuration(c.leafKey) > 0 ||
    layerStages(c.leafKey).length > 0 ||
    effLeafScoring(c.leafKey) != null ||
    effLeafTbs(c.leafKey) != null;

  const save = useMutation({
    mutationFn: async () => {
      // One PATCH per changed layer; draw-config edits are governed by the
      // regenerate banner (invariant 10), not the rules freeze — no amend dance.
      for (const [leafKey, config] of Object.entries(staged)) {
        try {
          await tournamentsApi.updateDrawConfig(tournamentId, {
            leaf_key: leafKey,
            config,
            event_id: newEventId(),
          });
        } catch (e) {
          throw e instanceof ApiError ? e : new Error(String(e));
        }
      }
      // Scoring + tiebreakers ride the settings PATCH (frozen → amend + reason).
      const byLeafPatch = byLeafChanges();
      if (Object.keys(byLeafPatch).length > 0) {
        try {
          await tournamentsApi.updateSettings(tournamentId, {
            rules: { by_leaf: byLeafPatch },
            amend: rulesFrozen,
            reason: amendReason,
            event_id: newEventId(),
          });
        } catch (e) {
          throw e instanceof ApiError ? e : new Error(String(e));
        }
      }
    },
    onSuccess: () => {
      setStaged({});
      setStagedScoring({});
      setStagedTiebreakers({});
      setAmendReason("");
      invalidateTournament(qc, tournamentId);
      qc.invalidateQueries({ queryKey: ["tournament-settings", tournamentId] });
      toast.push({ kind: "success", title: t("Formats saved") });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not save the formats"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      }),
  });

  if (dcQ.isLoading) {
    return (
      <section className="w-full bento-card star-rim rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6">
        <div className="h-20 animate-pulse rounded-lg bg-muted/40" />
      </section>
    );
  }

  const formatOptions = BOARD_FORMATS.map((f) => ({ value: f.value, label: f.label }));

  return (
    <section
      id="format-board"
      className="w-full bento-card star-rim rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6"
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <Trophy aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">
              {t("How each competition plays")}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t(
                "Each sport has its own tab. Pick how it plays, it applies to every category; override one inside.",
              )}
            </p>
          </div>
        </div>
        <AskAiButton
          className="shrink-0"
          focus={{
            label: t("How each competition plays"),
            hint: "the 'How each competition plays' section: choosing a format (knockout, group stage -> knockout, or round-robin league) for each sport or category",
          }}
        />
      </header>

      <div className="mt-6 flex flex-col gap-5">
        {sportsInOrder.length === 0 ? (
          <div className="flex items-center gap-2.5 rounded-lg bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
            <Info
              aria-hidden="true"
              className="h-[18px] w-[18px] shrink-0 text-muted-foreground/70"
            />
            {t("Add competitions to this tournament to choose their formats.")}
          </div>
        ) : (
          <div className="flex flex-col">
            {/* Bookmark tabs — one folder tab per sport; the open tab fuses
                into its card below (owner ask 2026-07-09: one sport at a
                time instead of every sport stacked on the page). */}
            <div
              role="tablist"
              aria-label={t("Sports")}
              className="flex flex-wrap items-end gap-1 px-2"
            >
              {sportsInOrder.map((sp) => {
                const on = sp === currentSport;
                const n = leavesBySport.get(sp)!.length;
                return (
                  <button
                    key={sp}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    data-testid={`format-sport-tab-${sp}`}
                    onClick={() => setActiveSport(sp)}
                    className={cn(
                      "relative flex max-w-full items-center gap-2 rounded-t-lg border px-3.5 py-2 text-[0.8125rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on
                        ? "z-10 -mb-px border-border border-b-transparent bg-card text-foreground"
                        : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Medal
                      aria-hidden="true"
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        on ? "text-primary" : "text-muted-foreground/70",
                      )}
                    />
                    <span className="truncate">{sportName(sp)}</span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 font-tabular text-[0.6875rem] font-medium",
                        on
                          ? "bg-secondary text-secondary-foreground"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {n}
                    </span>
                    {sportDirty(sp) ? (
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
            {sportsInOrder
              .filter((sp) => sp === currentSport)
              .map((sp) => {
            const leaves = leavesBySport.get(sp)!;
            const fmt = sportFormat(sp);
            const isGroups = fmt === "groups_knockout";
            const expanded = open[sp] ?? false;
            const sportStagesArr = sportStages(sp);
            const hasStages = sportStagesArr.length > 0;
            const multi = (stagesOpen[sp] ?? false) || hasStages;
            const divergeCount = leaves.filter((c) => leafDiverges(c)).length;
            return (
              <div
                key={sp}
                data-testid={`format-sport-${sp}`}
                className="overflow-hidden bento-card star-rim rounded-lg border border-border bg-card"
              >
                {/* Card header — the open tab carries the sport's name, so the
                    header holds the derived structure summary + Ask AI. */}
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Medal aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
                    <h3 className="text-sm font-semibold">{sportName(sp)}</h3>
                    <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">
                      {structureSummary(sp)}
                    </span>
                  </div>
                  <AskAiButton
                    variant="icon"
                    focus={{
                      label: t(`${sportName(sp)} format`),
                      hint: `the format for the sport "${sportName(sp)}" (sport_key=${sp}) · should it be knockout, group stage -> knockout, or round-robin league`,
                    }}
                  />
                </div>

                <div className="flex flex-col gap-4 p-4">
                  {/* 1 · Structure — single format OR a multi-stage plan. */}
                  <SubCard icon={Layers} title={t("Structure")}>
                    <div className="flex flex-col gap-3">
                      <ModeSegmented
                        ariaLabel={`${t("How")} ${sportName(sp)} ${t("is structured")}`}
                        multi={multi}
                        disabled={!canManage}
                        formatTestId={`format-sport-${sp}-mode-format`}
                        stagesTestId={`format-sport-${sp}-stages-toggle`}
                        onFormat={() => {
                          setStagesOpen((o) => ({ ...o, [sp]: false }));
                          if (hasStages) setSportStages(sp, []);
                        }}
                        onStages={() => setStagesOpen((o) => ({ ...o, [sp]: true }))}
                      />
                      <p className="text-xs text-muted-foreground">
                        {multi
                          ? t("Stages run in order. The last stage decides the winner.")
                          : t("One format runs the same bracket for every team in this sport.")}
                      </p>
                      {hasStages ? (
                        <p className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                          <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          {t("Switching to one format clears the stages below.")}
                        </p>
                      ) : null}

                      {multi ? (
                        <StagesEditor
                          testId={`format-sport-${sp}-stages`}
                          stages={sportStagesArr}
                          disabled={!canManage}
                          onChange={(next) => setSportStages(sp, next)}
                        />
                      ) : (
                        <div className="flex flex-col gap-3">
                          <span className="text-[0.8125rem] font-medium text-foreground">
                            {leaves.length > 1 ? t("Format (all categories)") : t("Format")}
                          </span>
                          <div
                            role="radiogroup"
                            aria-label={`${t("Format for")} ${sportName(sp)}`}
                            className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
                          >
                            {BOARD_FORMATS.map((f) => {
                              const on = fmt === f.value;
                              const FIcon = FORMAT_ICON[f.value] ?? Trophy;
                              return (
                                <button
                                  key={f.value}
                                  type="button"
                                  role="radio"
                                  aria-checked={on}
                                  data-testid={`format-sport-${sp}-format-${f.value}`}
                                  onClick={() => setSportFormat(sp, f.value)}
                                  className={cn(
                                    "flex items-center gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    on
                                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                                      : "border-border bg-card hover:bg-muted/50",
                                  )}
                                >
                                  <FIcon
                                    aria-hidden="true"
                                    className={cn(
                                      "h-4 w-4 shrink-0",
                                      on ? "text-primary" : "text-muted-foreground",
                                    )}
                                  />
                                  <span className="text-[0.8125rem] font-semibold">
                                    {t(f.label)}
                                  </span>
                                  {on ? (
                                    <Check
                                      aria-hidden="true"
                                      className="ml-auto h-4 w-4 text-primary"
                                    />
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {t(BOARD_FORMATS.find((f) => f.value === fmt)?.hint ?? "")}
                          </p>

                          {isGroups ? (
                            <div className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
                              <div className="flex flex-wrap items-end gap-4">
                                <label className="flex flex-col gap-1.5">
                                  <span className="text-[0.8125rem] font-medium text-foreground">
                                    {t("Teams per group")}
                                  </span>
                                  <Input
                                    type="number"
                                    min={2}
                                    data-testid={`format-sport-${sp}-group-size`}
                                    className="h-9 w-24 font-tabular"
                                    value={sportParam(sp, "group_size", 4)}
                                    onChange={(e) =>
                                      stage(`sport:${sp}`, {
                                        group_size: Math.max(2, Number(e.target.value) || 2),
                                      })
                                    }
                                  />
                                </label>
                                <label className="flex flex-col gap-1.5">
                                  <span className="text-[0.8125rem] font-medium text-foreground">
                                    {t("Advance per group")}
                                  </span>
                                  <Input
                                    type="number"
                                    min={1}
                                    data-testid={`format-sport-${sp}-advance`}
                                    className="h-9 w-24 font-tabular"
                                    value={sportParam(sp, "advance_per_group", 2)}
                                    onChange={(e) =>
                                      stage(`sport:${sp}`, {
                                        advance_per_group: Math.max(1, Number(e.target.value) || 1),
                                      })
                                    }
                                  />
                                </label>
                                <label className="flex items-center gap-2 pb-2 text-sm text-foreground">
                                  <input
                                    type="checkbox"
                                    data-testid={`format-sport-${sp}-balance`}
                                    className="h-4 w-4 rounded border-input accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    checked={boolParam(sp, "balance_groups", true)}
                                    onChange={(e) =>
                                      stage(`sport:${sp}`, { balance_groups: e.target.checked })
                                    }
                                  />
                                  {t("Balance group sizes (FIFA-style)")}
                                </label>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {boolParam(sp, "balance_groups", true)
                                  ? t(
                                      "Teams per group is the target; groups come out even (for example 10 teams becomes 4, 3, 3), never one tiny leftover group.",
                                    )
                                  : t(
                                      "Teams are split into fixed groups of this size; the last group may be smaller.",
                                    )}
                              </p>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </SubCard>

                  {/* 2 · Match length — one neutral number. */}
                  <SubCard icon={Clock} title={t("Match length")}>
                    <div className="flex flex-col gap-1.5">
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[0.8125rem] font-medium text-foreground">
                          {t("Match length (minutes)")}
                        </span>
                        <Input
                          type="number"
                          min={1}
                          data-testid={`format-sport-${sp}-duration`}
                          className="h-9 w-32 font-tabular"
                          placeholder={starDuration ? String(starDuration) : t("Default")}
                          value={sportOwnDuration(sp) || ""}
                          aria-label={`${t("Match length for")} ${sportName(sp)}`}
                          onChange={(e) => stageDuration(`sport:${sp}`, e.target.value)}
                        />
                      </label>
                      <span className="text-xs text-muted-foreground">
                        {leaves.length > 1
                          ? t("applies to every category, override one below")
                          : t("leave blank to use the tournament default")}
                      </span>
                    </div>
                  </SubCard>

                  {/* 3 · Match rules — scoring + tie-breakers, lock-flagged together. */}
                  <SubCard
                    icon={Target}
                    title={t("Match rules")}
                    right={
                      rulesFrozen ? (
                        <span className="flex items-center gap-1 rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">
                          <Lock aria-hidden="true" className="h-3 w-3" />
                          {t("Changes notify teams")}
                        </span>
                      ) : undefined
                    }
                  >
                    <div className="flex flex-col gap-3">
                      <ScoringControl
                        testId={`format-sport-${sp}-scoring`}
                        label={leaves.length > 1 ? t("Scoring (all categories)") : t("Scoring")}
                        value={sportScoringValue(sp)}
                        inherited={inheritedScoring(sp)}
                        disabled={!canManage}
                        onChange={(s) => stageSportScoring(sp, s)}
                      />
                      <TiebreakerControl
                        testId={`format-sport-${sp}-tiebreakers`}
                        value={sportTbsValue(sp)}
                        scoring={sportScoringValue(sp) ?? inheritedScoring(sp)}
                        disabled={!canManage}
                        onChange={(tbs) => stageSportTbs(sp, tbs)}
                      />
                    </div>
                  </SubCard>

                  {/* 4 · Per-category overrides — the rare escape hatch, disclosed. */}
                  {leaves.length > 1 ? (
                    <div className="bento-card star-rim rounded-lg border border-border bg-card">
                      <button
                        type="button"
                        data-testid={`format-sport-${sp}-customize`}
                        aria-expanded={expanded}
                        onClick={() => setOpen((o) => ({ ...o, [sp]: !expanded }))}
                        className={cn(
                          "flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40",
                          expanded && "border-b border-border",
                        )}
                      >
                        <SlidersHorizontal aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
                        <span className="text-[0.8125rem] font-semibold text-foreground">
                          {t("Per-category overrides")}
                        </span>
                        {divergeCount > 0 ? (
                          <span className="rounded-full bg-primary/15 px-1.5 py-0.5 font-tabular text-[0.6875rem] font-semibold text-primary">
                            {divergeCount}
                          </span>
                        ) : null}
                        <ChevronDown
                          aria-hidden="true"
                          className={cn(
                            "ml-auto h-4 w-4 transition-transform",
                            expanded && "rotate-180",
                          )}
                        />
                      </button>
                      {expanded ? (
                        <div className="flex flex-col gap-3 p-4">
                          {leaves.map((c) => {
                            const own = leafOwnFormat(c.leafKey);
                            const okey = `leaf:${c.leafKey}`;
                            const leafStagesArr = layerStages(c.leafKey);
                            const leafMulti =
                              (stagesOpen[okey] ?? false) || leafStagesArr.length > 0;
                            const diverges = leafDiverges(c);
                            return (
                              <div
                                key={c.leafKey}
                                className={cn(
                                  "flex flex-col gap-3 rounded-lg border p-4",
                                  diverges
                                    ? "border-primary/40 bg-primary/5"
                                    : "border-border bg-muted/20",
                                )}
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <LeafLabel label={c.label} size="md" />
                                  {!diverges ? (
                                    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                                      {t("Inherits")} {sportName(sp)}
                                    </span>
                                  ) : null}
                                </div>

                                <ModeSegmented
                                  ariaLabel={`${t("How")} ${c.label} ${t("is structured")}`}
                                  multi={leafMulti}
                                  disabled={!canManage}
                                  formatTestId={`format-leaf-${c.leafKey}-mode-format`}
                                  stagesTestId={`format-leaf-${c.leafKey}-stages-toggle`}
                                  onFormat={() => {
                                    setStagesOpen((o) => ({ ...o, [okey]: false }));
                                    if (leafStagesArr.length > 0) setLayerStages(c.leafKey, []);
                                  }}
                                  onStages={() => setStagesOpen((o) => ({ ...o, [okey]: true }))}
                                />
                                {leafStagesArr.length > 0 ? (
                                  <p className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                                    <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                    {t("Switching to one format clears the stages below.")}
                                  </p>
                                ) : null}

                                {leafMulti ? (
                                  <StagesEditor
                                    testId={`format-leaf-${c.leafKey}-stages`}
                                    stages={leafStagesArr}
                                    disabled={!canManage}
                                    onChange={(next) => setLayerStages(c.leafKey, next)}
                                  />
                                ) : (
                                  <div
                                    className="w-56"
                                    data-testid={`format-leaf-${c.leafKey}-select`}
                                  >
                                    <Select
                                      value={own || fmt}
                                      onChange={(v) => stage(c.leafKey, { format: v })}
                                      options={formatOptions}
                                      aria-label={`${t("Format for")} ${c.label}`}
                                    />
                                  </div>
                                )}

                                <label className="flex flex-col gap-1.5">
                                  <span className="text-xs font-medium text-foreground">
                                    {t("Length")}
                                  </span>
                                  <Input
                                    type="number"
                                    min={1}
                                    data-testid={`format-leaf-${c.leafKey}-duration`}
                                    className="h-9 w-24 font-tabular"
                                    placeholder={
                                      sportOwnDuration(sp) || starDuration
                                        ? String(sportOwnDuration(sp) || starDuration)
                                        : t("Default")
                                    }
                                    value={leafOwnDuration(c.leafKey) || ""}
                                    aria-label={`${t("Match length for")} ${c.label}`}
                                    onChange={(e) => stageDuration(c.leafKey, e.target.value)}
                                  />
                                </label>

                                <ScoringControl
                                  testId={`format-leaf-${c.leafKey}-scoring`}
                                  value={effLeafScoring(c.leafKey)}
                                  inherited={inheritedScoring(sp)}
                                  disabled={!canManage}
                                  onChange={(s) => stageLeafScoring(c.leafKey, s)}
                                />
                                <TiebreakerControl
                                  testId={`format-leaf-${c.leafKey}-tiebreakers`}
                                  value={effLeafTbs(c.leafKey)}
                                  scoring={effLeafScoring(c.leafKey) ?? inheritedScoring(sp)}
                                  disabled={!canManage}
                                  onChange={(tbs) => stageLeafTbs(c.leafKey, tbs)}
                                />
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          </div>
        )}

        {sportsInOrder.length > 0 ? (
          <div className="flex flex-col gap-4 border-t border-border pt-6">
            {rulesDirty && rulesFrozen ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">
                  {t(
                    "Scoring and tie-breakers lock once registration opens. Give a reason to amend (teams are notified).",
                  )}
                </span>
                <Input
                  data-testid="scoring-amend-reason"
                  className="h-9 max-w-md"
                  placeholder={t("Reason for the change")}
                  value={amendReason}
                  onChange={(e) => setAmendReason(e.target.value)}
                />
              </label>
            ) : null}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {dirty
                  ? t("Unsaved changes.")
                  : t("All formats saved. Generate each draw from its card.")}
              </p>
              <Button
                size="sm"
                disabled={!dirty || save.isPending || needsAmendReason || stagesHaveErrors}
                data-testid="save-formats"
                onClick={() => save.mutate()}
              >
                <Save aria-hidden="true" className="h-4 w-4" />
                {save.isPending ? t("Saving…") : t("Save formats")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
