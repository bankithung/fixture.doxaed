import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Save, SlidersHorizontal } from "lucide-react";
import {
  tournamentsApi,
  type DrawConfig,
  type DrawConfigLayer,
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
    label: "Group stage → Knockout",
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
    hint: "A set number of rounds — each round pairs teams on similar records, never repeating a match.",
  },
  {
    value: "double_elim",
    label: "Double elimination",
    hint: "Lose once and you drop to a second bracket; lose twice and you're out.",
  },
];

const prettySport = (key: string): string =>
  key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");

/**
 * "How each competition plays" — pick a game type (format) for every category
 * at once (owner ask 2026-06-25). One choice per sport sets the format for all
 * its categories via the `sport:<key>` draw-config layer ("all Table Tennis is
 * Knockout"); a category can override it underneath. Group stage → Knockout
 * exposes its group size + how many advance. Detailed seeding/legs/third-place
 * stay in each competition's own draw wizard.
 */
export function CompetitionFormatBoard({
  tournamentId,
  competitions,
}: {
  tournamentId: string;
  competitions: Comp[];
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  // Staged layer writes keyed by layer ("sport:<k>" or a leaf key); empty = clean.
  const [staged, setStaged] = useState<Record<string, DrawConfigLayer>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const dcQ = useQuery({
    queryKey: qk.drawConfig(tournamentId),
    queryFn: () => tournamentsApi.drawConfig(tournamentId),
  });
  const sportsQ = useQuery({
    queryKey: ["tournament-sports", tournamentId],
    queryFn: () => tournamentsApi.sports(tournamentId),
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

  const dirty = Object.keys(staged).length > 0;

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
    },
    onSuccess: () => {
      setStaged({});
      invalidateTournament(qc, tournamentId);
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
      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="h-20 animate-pulse rounded-lg bg-muted/40" />
      </section>
    );
  }

  const formatOptions = BOARD_FORMATS.map((f) => ({ value: f.value, label: f.label }));

  return (
    <section
      id="format-board"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("How each competition plays")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "Pick a game type for each sport — it applies to every category. Open a sport to give one category a different format.",
            )}
          </p>
        </div>
        <AskAiButton
          className="mt-0.5"
          focus={{
            label: t("How each competition plays"),
            hint: "the 'How each competition plays' section: choosing a format (knockout, group stage -> knockout, or round-robin league) for each sport or category",
          }}
        />
      </div>

      <div className="flex flex-col gap-4 px-4 py-4">
        {sportsInOrder.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("Add competitions to this tournament to choose their formats.")}
          </p>
        ) : (
          sportsInOrder.map((sp) => {
            const leaves = leavesBySport.get(sp)!;
            const fmt = sportFormat(sp);
            const hint = BOARD_FORMATS.find((f) => f.value === fmt)?.hint;
            const isGroups = fmt === "groups_knockout";
            const expanded = open[sp] ?? false;
            return (
              <div
                key={sp}
                data-testid={`format-sport-${sp}`}
                className="rounded-lg border border-border bg-muted/10 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5">
                    <div className="flex flex-col">
                      <span className="text-sm font-semibold">{sportName(sp)}</span>
                      <span className="text-xs text-muted-foreground">
                        {leaves.length === 1
                          ? t("1 category")
                          : `${leaves.length} ${t("categories")}`}
                      </span>
                    </div>
                    <AskAiButton
                      variant="icon"
                      focus={{
                        label: t(`${sportName(sp)} format`),
                        hint: `the format for the sport "${sportName(sp)}" (sport_key=${sp}) — should it be knockout, group stage -> knockout, or round-robin league`,
                      }}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    {t("All categories play")}
                    <div className="w-64" data-testid={`format-sport-${sp}-select`}>
                      <Select
                        value={fmt}
                        onChange={(v) => setSportFormat(sp, v)}
                        options={formatOptions}
                        aria-label={`${t("Format for")} ${sportName(sp)}`}
                      />
                    </div>
                  </label>
                </div>

                {hint ? (
                  <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
                ) : null}

                {isGroups ? (
                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      {t("Teams per group")}
                      <Input
                        type="number"
                        min={2}
                        data-testid={`format-sport-${sp}-group-size`}
                        className="h-8 w-20 font-tabular"
                        value={sportParam(sp, "group_size", 4)}
                        onChange={(e) =>
                          stage(`sport:${sp}`, {
                            group_size: Math.max(2, Number(e.target.value) || 2),
                          })
                        }
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      {t("Advance per group")}
                      <Input
                        type="number"
                        min={1}
                        data-testid={`format-sport-${sp}-advance`}
                        className="h-8 w-20 font-tabular"
                        value={sportParam(sp, "advance_per_group", 2)}
                        onChange={(e) =>
                          stage(`sport:${sp}`, {
                            advance_per_group: Math.max(1, Number(e.target.value) || 1),
                          })
                        }
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        data-testid={`format-sport-${sp}-balance`}
                        className="h-4 w-4 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        checked={boolParam(sp, "balance_groups", true)}
                        onChange={(e) =>
                          stage(`sport:${sp}`, { balance_groups: e.target.checked })
                        }
                      />
                      {t("Balance group sizes (FIFA-style)")}
                    </label>
                  </div>
                ) : null}
                {isGroups ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {boolParam(sp, "balance_groups", true)
                      ? t(
                          "“Teams per group” is the target — groups come out even (e.g. 10 teams → 4, 3, 3), never one tiny leftover group.",
                        )
                      : t(
                          "Teams are split into fixed groups of this size; the last group may be smaller.",
                        )}
                  </p>
                ) : null}

                {leaves.length > 1 ? (
                  <div className="mt-3 border-t border-border/60 pt-2">
                    <button
                      type="button"
                      data-testid={`format-sport-${sp}-customize`}
                      aria-expanded={expanded}
                      onClick={() => setOpen((o) => ({ ...o, [sp]: !expanded }))}
                      className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
                      {t("Give a category a different format")}
                      <ChevronDown
                        aria-hidden="true"
                        className={cn(
                          "h-3.5 w-3.5 transition-transform",
                          expanded && "rotate-180",
                        )}
                      />
                    </button>
                    {expanded ? (
                      <div className="mt-2 flex flex-col gap-2">
                        {leaves.map((c) => {
                          const own = leafOwnFormat(c.leafKey);
                          const overridden = own !== "" && own !== fmt;
                          return (
                            <div
                              key={c.leafKey}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5"
                            >
                              <span className="text-sm">{c.label}</span>
                              <div className="flex items-center gap-2">
                                {!overridden ? (
                                  <span className="text-xs text-muted-foreground">
                                    {t("Same as")} {sportName(sp)}
                                  </span>
                                ) : null}
                                <div
                                  className="w-56"
                                  data-testid={`format-leaf-${c.leafKey}-select`}
                                >
                                  <Select
                                    value={own || fmt}
                                    onChange={(v) =>
                                      stage(c.leafKey, { format: v })
                                    }
                                    options={formatOptions}
                                    aria-label={`${t("Format for")} ${c.label}`}
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}

        {sportsInOrder.length > 0 ? (
          <div className="flex items-center justify-between border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">
              {dirty
                ? t("Unsaved format changes.")
                : t("All formats saved. Generate each draw from its card.")}
            </p>
            <Button
              size="sm"
              disabled={!dirty || save.isPending}
              data-testid="save-formats"
              onClick={() => save.mutate()}
            >
              <Save aria-hidden="true" className="h-3.5 w-3.5" />
              {save.isPending ? t("Saving…") : t("Save formats")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
