import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Medal, Plus, Trash2, Wand2 } from "lucide-react";
import { ApiError } from "@/types/api";
import { tournamentsApi, type AwardsConfig } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { leafMatchesPrefix, resolveInclude } from "./resultsMatrix";

/**
 * Settings > Results: the points a placing is worth and the champions the meet
 * awards.
 *
 * Every number the public tally prints is authored here, and NOTHING about it
 * is baked in: 5/3/2 is a default, not a rule; a ladder can score the top six;
 * and "the U-14 boys champion" is a list of competitions the host names, not a
 * word this code understands.
 *
 * It is editable for the life of the tournament — awards config sits outside
 * the invariant-7 rules freeze on purpose, because a ladder decides a trophy
 * rather than a result and hosts settle these on the morning of the meet.
 */
export function AwardsSettingsCard({
  tournamentId,
  canManage,
}: {
  tournamentId: string;
  canManage: boolean;
}): React.ReactElement | null {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["awards", tournamentId],
    queryFn: () => tournamentsApi.awards(tournamentId),
  });

  const [draft, setDraft] = useState<AwardsConfig | null>(null);
  useEffect(() => {
    if (q.data && draft === null) setDraft(q.data.awards);
  }, [q.data, draft]);

  const leafKeys = useMemo(
    () => (q.data?.competitions ?? []).map((c) => c.leaf_key),
    [q.data],
  );

  const save = useMutation({
    mutationFn: (next: AwardsConfig) =>
      tournamentsApi.saveAwards(tournamentId, next),
    onSuccess: (data) => {
      setDraft(data.awards);
      qc.invalidateQueries({ queryKey: ["awards", tournamentId] });
      qc.invalidateQueries({ queryKey: ["public-results"] });
      toast.push({ kind: "success", title: t("Results setup saved") });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not save the results setup"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  if (q.isLoading || !draft) {
    return (
      <div className="h-40 animate-pulse rounded-xl border border-border bg-card" />
    );
  }

  const patch = (next: Partial<AwardsConfig>): void =>
    setDraft({ ...draft, ...next });

  const setLadderRow = (
    i: number,
    field: "points" | "label",
    value: string,
  ): void => {
    const ladder = draft.ladder.map((row, j) =>
      j === i
        ? {
            ...row,
            [field]: field === "points" ? Number(value) || 0 : value,
          }
        : row,
    );
    patch({ ladder });
  };

  const addPlace = (): void => {
    const next = Math.max(0, ...draft.ladder.map((l) => l.place)) + 1;
    patch({
      ladder: [...draft.ladder, { place: next, points: 1, label: "" }],
    });
  };

  const toggleLeaf = (gi: number, leafKey: string): void => {
    const g = draft.groups[gi];
    if (!g) return;
    const current = resolveInclude(g.include, leafKeys);
    const has = current.includes(leafKey);
    const next = has
      ? current.filter((k) => k !== leafKey)
      : [...current, leafKey];
    // Everything ticked means "all of it", which is what an empty list says —
    // and an empty list keeps covering a category added later.
    const include = next.length === leafKeys.length ? [] : next;
    patch({
      groups: draft.groups.map((row, j) => (j === gi ? { ...row, include } : row)),
    });
  };

  /** Sports a frozen include list covers NONE of. "Overall" quietly losing a
   * whole sport is the failure this catches: the list was written from the
   * competitions that existed the day it was saved (owner 2026-08-25). */
  const missingSports = (include: string[]): string[] => {
    const covered = new Set(
      resolveInclude(include, leafKeys).map((k) => k.split(".")[0]),
    );
    const all = new Map<string, string>();
    for (const c of q.data?.competitions ?? []) all.set(c.sport_key, c.sport_name);
    return [...all.entries()]
      .filter(([key]) => !covered.has(key))
      .map(([, name]) => name);
  };

  const moveGroup = (gi: number, by: number): void => {
    const groups = [...draft.groups];
    const target = gi + by;
    if (target < 0 || target >= groups.length) return;
    const [row] = groups.splice(gi, 1);
    groups.splice(target, 0, row!);
    patch({ groups });
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data?.awards);

  return (
    <section
      data-testid="awards-settings"
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <header className="flex flex-wrap items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-medal-1-muted">
          <Medal aria-hidden="true" className="h-5 w-5 text-medal-1" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("Results & medal tally")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("What a placing is worth, and the champions this meet awards.")}
          </p>
        </div>
        {canManage ? (
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDraft(q.data?.awards ?? draft)}
              disabled={!dirty || save.isPending}
            >
              {t("Reset")}
            </Button>
            <Button
              size="sm"
              onClick={() => save.mutate(draft)}
              disabled={!dirty || save.isPending}
              data-testid="awards-save"
            >
              {save.isPending ? t("Saving") : t("Save")}
            </Button>
          </div>
        ) : null}
      </header>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={!canManage}
          onChange={(e) => patch({ enabled: e.target.checked })}
          data-testid="awards-enabled"
          className="h-4 w-4 rounded border-border accent-primary"
        />
        {t("Publish a medal tally for this tournament")}
      </label>

      {/* ------------------------------------------------------- the ladder */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("Points per placing")}
          </h4>
          <span className="text-[0.6875rem] text-muted-foreground">
            {t("A place with no row here scores nothing.")}
          </span>
        </div>
        <ul className="flex flex-col gap-2">
          {draft.ladder.map((row, i) => (
            <li key={row.place} className="flex items-center gap-2">
              <span className="w-16 shrink-0 font-tabular text-xs text-muted-foreground">
                {t("Place")} {row.place}
              </span>
              <Input
                value={row.label}
                disabled={!canManage}
                onChange={(e) => setLadderRow(i, "label", e.target.value)}
                aria-label={`${t("Name for place")} ${row.place}`}
                placeholder={t("Gold")}
                className="h-9 w-32"
                data-testid={`ladder-label-${row.place}`}
              />
              <Input
                type="number"
                min={0}
                value={String(row.points)}
                disabled={!canManage}
                onChange={(e) => setLadderRow(i, "points", e.target.value)}
                aria-label={`${t("Points for place")} ${row.place}`}
                className="h-9 w-24 font-tabular"
                data-testid={`ladder-points-${row.place}`}
              />
              <span className="text-xs text-muted-foreground">{t("points")}</span>
              {canManage ? (
                <button
                  type="button"
                  onClick={() =>
                    patch({ ladder: draft.ladder.filter((_, j) => j !== i) })
                  }
                  aria-label={`${t("Remove place")} ${row.place}`}
                  className="ml-auto rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" onClick={addPlace}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t("Add a place")}
            </Button>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {t("When a draw has no third-place playoff")}
              <Select
                size="sm"
                value={draft.bronze}
                onChange={(v) => patch({ bronze: v })}
                aria-label={t("Third place without a playoff")}
                className="w-56"
                options={[
                  {
                    value: "shared",
                    label: t("Both losing semi-finalists take third"),
                  },
                  { value: "none", label: t("No third place is awarded") },
                ]}
              />
            </label>
          </div>
        ) : null}
      </div>

      {/* ------------------------------------------------------- the groups */}
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("Category champions")}
          </h4>
          <span className="text-[0.6875rem] text-muted-foreground">
            {t("Each group names one champion across the competitions in it.")}
          </span>
          {canManage ? (
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                data-testid="awards-suggest"
                onClick={() =>
                  patch({ groups: q.data?.suggested_groups ?? draft.groups })
                }
              >
                <Wand2 className="mr-1.5 h-4 w-4" />
                {t("Suggest from categories")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  patch({
                    groups: [
                      ...draft.groups,
                      {
                        key: "",
                        label: t("New group"),
                        include: [],
                        decide: "points",
                      },
                    ],
                  })
                }
              >
                <Plus className="mr-1.5 h-4 w-4" />
                {t("Add a group")}
              </Button>
            </div>
          ) : null}
        </div>

        {draft.groups.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {t("No champions are awarded yet.")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {draft.groups.map((g, gi) => {
              const covered = resolveInclude(g.include, leafKeys);
              return (
                <li
                  key={`${g.key}-${gi}`}
                  data-testid={`awards-group-${gi}`}
                  className="flex flex-col gap-2 rounded-lg border border-border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={g.label}
                      disabled={!canManage}
                      onChange={(e) =>
                        patch({
                          groups: draft.groups.map((row, j) =>
                            j === gi ? { ...row, label: e.target.value } : row,
                          ),
                        })
                      }
                      aria-label={t("Group name")}
                      className="h-9 w-56"
                    />
                    <Select
                      size="sm"
                      value={g.decide}
                      onChange={(v) =>
                        patch({
                          groups: draft.groups.map((row, j) =>
                            j === gi
                              ? { ...row, decide: v as "points" | "golds" }
                              : row,
                          ),
                        })
                      }
                      aria-label={t("How the champion is decided")}
                      className="w-44"
                      options={[
                        { value: "points", label: t("Most points") },
                        { value: "golds", label: t("Most golds") },
                      ]}
                    />
                    <label className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={g.include.length === 0}
                        disabled={!canManage}
                        data-testid={`awards-group-all-${gi}`}
                        onChange={(e) =>
                          patch({
                            groups: draft.groups.map((row, j) =>
                              j === gi
                                ? {
                                    ...row,
                                    include: e.target.checked
                                      ? []
                                      : [...leafKeys],
                                  }
                                : row,
                            ),
                          })
                        }
                        className="h-3.5 w-3.5 rounded border-border accent-primary"
                      />
                      {t("Every competition")}
                    </label>
                    <span className="font-tabular text-xs text-muted-foreground">
                      {covered.length}{" "}
                      {covered.length === 1
                        ? t("competition")
                        : t("competitions")}
                    </span>
                    {canManage ? (
                      <span className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => moveGroup(gi, -1)}
                          aria-label={t("Move up")}
                          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <ChevronUp className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveGroup(gi, 1)}
                          aria-label={t("Move down")}
                          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            patch({
                              groups: draft.groups.filter((_, j) => j !== gi),
                            })
                          }
                          aria-label={t("Remove group")}
                          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </span>
                    ) : null}
                  </div>
                  {g.include.length > 0 && missingSports(g.include).length ? (
                    <p
                      data-testid={`awards-group-warn-${gi}`}
                      className="rounded-md bg-warning-muted px-2 py-1 text-[0.6875rem] text-warning"
                    >
                      {t("This group leaves out every")}{" "}
                      {missingSports(g.include).join(", ")}{" "}
                      {t("competition. A competition added later stays out too.")}
                    </p>
                  ) : null}
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      {t("Competitions in this group")}
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                      {(q.data?.competitions ?? []).map((c) => {
                        const on = g.include.length
                          ? g.include.some((p) =>
                              leafMatchesPrefix(p, c.leaf_key),
                            )
                          : true;
                        return (
                          <label
                            key={c.leaf_key}
                            className={cn(
                              "flex items-center gap-1.5",
                              !on && "text-muted-foreground",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={!canManage}
                              onChange={() => toggleLeaf(gi, c.leaf_key)}
                              className="h-3.5 w-3.5 rounded border-border accent-primary"
                            />
                            {c.sport_name} · {c.label}
                          </label>
                        );
                      })}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
