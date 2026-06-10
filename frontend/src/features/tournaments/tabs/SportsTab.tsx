import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  FileText,
  Plus,
  Search,
  SlidersHorizontal,
  Trophy,
  X,
} from "lucide-react";
import {
  tournamentsApi,
  type SportNode,
  type TournamentSport,
} from "@/api/tournaments";
import { formsApi } from "@/api/forms";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Coerce server data to the recursive node shape, tolerating the legacy
 * 2-level `{name, subcategories}` and plain-string forms. Server-minted node
 * `key`s are preserved — they are the stable identity registered teams hang
 * off, so renames must round-trip them. */
function normNodes(raw: unknown): SportNode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((n): SportNode | null => {
      if (typeof n === "string") return n.trim() ? { name: n.trim() } : null;
      if (typeof n !== "object" || n === null) return null;
      const o = n as Record<string, unknown>;
      const name = String(o.name ?? "").trim();
      if (!name) return null;
      const children = Array.isArray(o.children)
        ? normNodes(o.children)
        : Array.isArray(o.subcategories)
          ? normNodes(o.subcategories)
          : [];
      return {
        ...(typeof o.key === "string" && o.key ? { key: o.key } : {}),
        name,
        children,
      };
    })
    .filter((n): n is SportNode => n !== null);
}

function sportNodes(s: TournamentSport): SportNode[] {
  return normNodes(s.nodes ?? s.categories ?? []);
}

/** Every competition (leaf path) under a node list — "U15 — Girls — 5v5". */
function leafLabels(nodes: SportNode[], prefix: string[] = []): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const path = [...prefix, n.name];
    if (n.children?.length) out.push(...leafLabels(n.children, path));
    else out.push(path.join(" — "));
  }
  return out;
}

/** Immutable node-tree ops addressed by index path. */
function withChildAdded(
  nodes: SportNode[],
  path: number[],
  name: string,
): SportNode[] {
  if (path.length === 0) return [...nodes, { name }];
  const [head, ...rest] = path;
  return nodes.map((n, i) =>
    i === head
      ? { ...n, children: withChildAdded(n.children ?? [], rest, name) }
      : n,
  );
}

function withNodeRemoved(nodes: SportNode[], path: number[]): SportNode[] {
  if (path.length === 1) return nodes.filter((_n, i) => i !== path[0]);
  const [head, ...rest] = path;
  return nodes.map((n, i) =>
    i === head ? { ...n, children: withNodeRemoved(n.children ?? [], rest) } : n,
  );
}

function slugKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * SETUP step — choose the sport(s) this tournament runs and build each one's
 * category tree (any depth: U15 → Girls → 5v5). Every LEAF of the tree is one
 * competition: it appears on the auto-generated registration form, teams
 * register into it, and it gets its own draw. Auto-saves; per-sport match
 * settings (duration, venue type) feed the scheduler.
 */
export function SportsTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  // One in-flight "add node" draft at a time, keyed by `${sportKey}:${path}`.
  const [addDraft, setAddDraft] = useState<{ key: string; value: string }>({
    key: "",
    value: "",
  });
  const [showSettings, setShowSettings] = useState(false);
  // Two-step sub-flow: pick sports → configure each one (focused, via tabs).
  const [step, setStep] = useState<"pick" | "configure">("pick");
  const [activeKey, setActiveKey] = useState<string>("");

  const catalog = useQuery({
    queryKey: ["sports-catalog"],
    queryFn: () => tournamentsApi.sportsCatalog(),
    staleTime: 60 * 60 * 1000,
  });
  const chosen = useQuery({
    queryKey: ["tournament-sports", id],
    queryFn: () => tournamentsApi.sports(id),
    enabled: Boolean(id),
  });
  const forms = useQuery({
    queryKey: ["forms", id],
    queryFn: () => formsApi.list(id),
    enabled: Boolean(id),
  });
  const stage = useQuery({
    queryKey: ["tournament-stage", id],
    queryFn: () => tournamentsApi.stage(id),
    enabled: Boolean(id),
  });
  const orgForm =
    (forms.data ?? []).find((f) => f.stage === "org_registration") ??
    (forms.data ?? []).find((f) => f.purpose === "organization_registration");

  const selected = useMemo<TournamentSport[]>(
    () =>
      (chosen.data?.sports ?? []).map((s) => ({ ...s, nodes: sportNodes(s) })),
    [chosen.data],
  );
  const selectedKeys = useMemo(
    () => new Set(selected.map((s) => s.key)),
    [selected],
  );

  const save = useMutation({
    mutationFn: (next: TournamentSport[]) => tournamentsApi.setSports(id, next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tournament-sports", id] });
      qc.invalidateQueries({ queryKey: ["tournament", id] });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title:
          e instanceof ApiError && e.payload.detail === "not_tournament_manager"
            ? t("Only managers can change sports")
            : t("Could not save sports"),
      }),
  });

  // Generate the institution form (reusing an existing one) AND move the
  // tournament from SETUP into the institute-registration stage, so the form
  // becomes that stage's registration form — the proper end-to-end flow.
  const generate = useMutation({
    mutationFn: async () => {
      const form = orgForm ?? (await formsApi.generateInstitutionForm(id));
      if (stage.data?.stage === "setup") {
        await tournamentsApi.transitionStage(id, {
          to_stage: "org_registration",
          ack_warnings: true,
          event_id: newEventId(),
        });
      }
      return form;
    },
    onSuccess: () => {
      invalidateTournament(qc, id);
      qc.invalidateQueries({ queryKey: ["forms", id] });
      toast.push({
        kind: "success",
        title: t("Registration is set up — review and open it"),
      });
      navigate(routes.tournamentInstitutions(id));
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not start registration"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      }),
  });

  const add = (sport: TournamentSport): void => {
    if (selectedKeys.has(sport.key)) return;
    save.mutate([...selected, sport]);
  };
  const remove = (key: string): void =>
    save.mutate(selected.filter((s) => s.key !== key));
  const updateSport = (key: string, patch: Partial<TournamentSport>): void =>
    save.mutate(selected.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const addNode = (sportKey: string, path: number[], raw: string): void => {
    const name = raw.trim();
    const sport = selected.find((s) => s.key === sportKey);
    if (!name || !sport) return;
    updateSport(sportKey, {
      nodes: withChildAdded(sport.nodes ?? [], path, name),
    });
    setAddDraft({ key: "", value: "" });
  };
  const removeNode = (sportKey: string, path: number[]): void => {
    const sport = selected.find((s) => s.key === sportKey);
    if (!sport) return;
    updateSport(sportKey, { nodes: withNodeRemoved(sport.nodes ?? [], path) });
  };

  const q = search.trim().toLowerCase();
  const matches = useMemo(() => {
    const all = catalog.data ?? [];
    return all
      .filter(
        (c) =>
          !selectedKeys.has(c.code) &&
          (!q ||
            c.name.toLowerCase().includes(q) ||
            c.category.toLowerCase().includes(q)),
      )
      .slice(0, 24);
  }, [catalog.data, q, selectedKeys]);

  const customName = search.trim();
  const customExists =
    !!customName &&
    [...(catalog.data ?? []).map((c) => c.name), ...selected.map((s) => s.name)]
      .map((n) => n.toLowerCase())
      .includes(customName.toLowerCase());

  const effectiveStep = selected.length === 0 ? "pick" : step;
  const activeSport = selected.find((s) => s.key === activeKey) ?? selected[0];
  const activeLeaves = activeSport ? leafLabels(activeSport.nodes ?? []) : [];

  const stepChip = (active: boolean): string =>
    cn(
      "rounded-full px-2 py-0.5",
      active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
    );

  /** One node row + its children, recursively. */
  const renderNode = (
    sport: TournamentSport,
    node: SportNode,
    path: number[],
    depth: number,
  ): React.ReactElement => {
    const draftKey = `${sport.key}:${path.join(".")}`;
    const adding = addDraft.key === draftKey;
    return (
      <li key={node.key ?? `${path.join(".")}-${node.name}`} className="min-w-0">
        <div className="group flex items-center gap-1.5 rounded-md py-1 pl-2 pr-1 hover:bg-accent/60">
          {depth > 0 ? (
            <CornerDownRight
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
            />
          ) : null}
          <span
            className={cn(
              "min-w-0 truncate text-sm",
              node.children?.length ? "font-medium" : "",
            )}
            title={node.name}
          >
            {node.name}
          </span>
          {!node.children?.length ? (
            <span className="rounded bg-primary/10 px-1.5 text-[0.625rem] font-medium uppercase tracking-wide text-primary">
              {t("competition")}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              onClick={() =>
                setAddDraft(
                  adding ? { key: "", value: "" } : { key: draftKey, value: "" },
                )
              }
              aria-label={t(`Add a level under ${node.name}`)}
              className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus aria-hidden="true" className="h-3 w-3" />
              {t("level")}
            </button>
            <button
              type="button"
              onClick={() => removeNode(sport.key, path)}
              aria-label={t(`Remove ${node.name}`)}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
        {(node.children?.length || adding) ? (
          <ul className="ml-3 border-l border-border pl-2">
            {(node.children ?? []).map((c, i) =>
              renderNode(sport, c, [...path, i], depth + 1),
            )}
            {adding ? (
              <li>
                <form
                  className="flex items-center gap-1.5 py-1 pl-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addNode(sport.key, path, addDraft.value);
                  }}
                >
                  <Input
                    autoFocus
                    value={addDraft.value}
                    onChange={(e) =>
                      setAddDraft((d) => ({ ...d, value: e.target.value }))
                    }
                    onBlur={() => {
                      if (!addDraft.value.trim()) setAddDraft({ key: "", value: "" });
                    }}
                    placeholder={t("e.g. Girls, 5v5, Doubles")}
                    className="h-7 w-44 text-sm"
                    aria-label={t(`New level under ${node.name}`)}
                  />
                  <Button type="submit" variant="outline" size="sm" className="h-7">
                    {t("Add")}
                  </Button>
                </form>
              </li>
            ) : null}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex w-full flex-col gap-6">
      {/* Header + step indicator */}
      <div className="min-w-0">
        <h2 className="text-lg font-semibold">{t("Sports")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {effectiveStep === "pick"
            ? t("Pick the sport(s) this tournament runs — you'll set up each one's categories next.")
            : t("Build each sport's category tree. Every last level is one competition with its own entries and fixtures.")}
        </p>
        <div className="mt-2 flex items-center gap-1.5 text-xs font-medium">
          <span className={stepChip(effectiveStep === "pick")}>
            1 · {t("Choose sports")}
          </span>
          <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground/40" />
          <span className={stepChip(effectiveStep === "configure")}>
            2 · {t("Categories")}
          </span>
        </div>
      </div>

      {effectiveStep === "pick" ? (
        <>
          {/* Selected — compact chips (no per-sport detail here). */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">
              {t("Selected")}{" "}
              <span className="font-tabular text-muted-foreground">
                ({selected.length})
              </span>
            </h3>
            {selected.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
                {t("No sports yet. Add at least one below.")}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {selected.map((s) => {
                  const leaves = leafLabels(s.nodes ?? []).length;
                  return (
                    <li
                      key={s.key}
                      data-testid={`sport-${s.key}`}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card py-1 pl-3 pr-1.5 text-sm shadow-sm"
                    >
                      <Trophy aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                      <span className="font-medium">{s.name}</span>
                      {(s.nodes ?? []).length ? (
                        <span className="font-tabular text-xs text-muted-foreground">
                          · {leaves} {t("comp")}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => remove(s.key)}
                        aria-label={t(`Remove ${s.name}`)}
                        className="ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Add from catalog / custom */}
          <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
            <h3 className="text-sm font-semibold">{t("Add a sport")}</h3>
            <label className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("Search sports (e.g. football, sepak takraw)…")}
                className="h-9 pl-9"
                aria-label={t("Search sports")}
              />
            </label>

            {customName && !customExists ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => {
                  add({ key: slugKey(customName), name: customName, custom: true });
                  setSearch("");
                }}
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                {t(`Add “${customName}”`)}
              </Button>
            ) : null}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {matches.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => add({ key: c.code, name: c.name, custom: false })}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  <Plus aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{c.name}</span>
                    <span className="block truncate text-xs capitalize text-muted-foreground">
                      {c.category}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {catalog.isLoading ? (
              <p className="text-sm text-muted-foreground">{t("Loading sports…")}</p>
            ) : matches.length === 0 && !customName ? (
              <p className="text-sm text-muted-foreground">
                {t("Start typing to find a sport, or type a custom name.")}
              </p>
            ) : null}
          </section>

          {selected.length > 0 ? (
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => {
                  setActiveKey(selected[0].key);
                  setStep("configure");
                }}
              >
                {t("Next: set up categories")}
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setStep("pick")}
            className="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Back to choosing sports")}
          </button>

          {/* Sport tabs — configure one sport at a time. */}
          <div role="tablist" aria-label={t("Sports")} className="flex flex-wrap gap-2">
            {selected.map((s) => {
              const count = leafLabels(s.nodes ?? []).length;
              const isActive = activeSport?.key === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveKey(s.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <Trophy aria-hidden="true" className="h-3.5 w-3.5" />
                  {s.name}
                  {(s.nodes ?? []).length ? (
                    <span className="font-tabular opacity-70">({count})</span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* Active sport's category tree (recursive, any depth). */}
          {activeSport ? (
            <section
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm"
              data-testid={`sport-${activeSport.key}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Trophy aria-hidden="true" className="h-4 w-4 text-primary" />
                  <span className="font-medium">{activeSport.name}</span>
                  {activeSport.custom ? (
                    <span className="rounded bg-muted px-1.5 text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                      {t("custom")}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => remove(activeSport.key)}
                  className="text-xs font-medium text-muted-foreground transition-colors hover:text-destructive"
                >
                  {t("Remove sport")}
                </button>
              </div>

              <div className="flex flex-col gap-2.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("Categories")}
                  </span>
                  <span className="text-[0.6875rem] text-muted-foreground/70">
                    {t("nest levels as deep as you need — age, gender, format")}
                  </span>
                </div>
                {(activeSport.nodes ?? []).length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-center text-sm text-muted-foreground">
                    {t("No categories yet — the whole sport is one competition. Add levels below (e.g. U-15 → Girls → 5v5).")}
                  </p>
                ) : (
                  <ul className="rounded-lg border border-border px-1 py-1.5">
                    {(activeSport.nodes ?? []).map((n, i) =>
                      renderNode(activeSport, n, [i], 0),
                    )}
                  </ul>
                )}
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addNode(
                      activeSport.key,
                      [],
                      addDraft.key === `${activeSport.key}:root` ? addDraft.value : "",
                    );
                  }}
                >
                  <Input
                    value={
                      addDraft.key === `${activeSport.key}:root` ? addDraft.value : ""
                    }
                    onChange={(e) =>
                      setAddDraft({ key: `${activeSport.key}:root`, value: e.target.value })
                    }
                    placeholder={t("Add a category (e.g. U-14, Singles)")}
                    className="h-8 max-w-xs text-sm"
                    aria-label={t(`Add a category to ${activeSport.name}`)}
                  />
                  <Button type="submit" variant="outline" size="sm">
                    <Plus aria-hidden="true" className="h-4 w-4" />
                    {t("Add category")}
                  </Button>
                </form>

                {/* Competitions preview — what registration + fixtures will see. */}
                {activeLeaves.length > 0 ? (
                  <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("Competitions")}{" "}
                      <span className="font-tabular">({activeLeaves.length})</span>
                      <span className="ml-1 font-normal text-muted-foreground/70">
                        {t("— each gets its own entries and fixtures")}
                      </span>
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {activeLeaves.map((label) => (
                        <span
                          key={label}
                          className="rounded-full bg-muted px-2.5 py-0.5 text-xs"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Match settings — feeds the scheduler (duration, venue type). */}
              <div className="border-t border-border pt-3">
                <button
                  type="button"
                  onClick={() => setShowSettings((v) => !v)}
                  aria-expanded={showSettings}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Match settings")}
                  <span className="font-normal text-muted-foreground/70">
                    {activeSport.scheduling?.duration_minutes
                      ? t(`${activeSport.scheduling.duration_minutes} min / match`)
                      : t("(defaults from the sport profile)")}
                  </span>
                </button>
                {showSettings ? (
                  <div className="mt-2.5 grid max-w-md grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                      {t("Match duration (minutes)")}
                      <Input
                        inputMode="numeric"
                        defaultValue={activeSport.scheduling?.duration_minutes ?? ""}
                        onBlur={(e) => {
                          const v = parseInt(e.target.value, 10);
                          updateSport(activeSport.key, {
                            scheduling: {
                              ...(activeSport.scheduling ?? {}),
                              duration_minutes:
                                Number.isFinite(v) && v > 0 ? v : undefined,
                            },
                          });
                        }}
                        placeholder={t("e.g. 90")}
                        className="h-8 font-tabular"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                      {t("Venue type")}
                      <Input
                        defaultValue={activeSport.scheduling?.venue_type ?? ""}
                        onBlur={(e) =>
                          updateSport(activeSport.key, {
                            scheduling: {
                              ...(activeSport.scheduling ?? {}),
                              venue_type: e.target.value.trim() || undefined,
                            },
                          })
                        }
                        placeholder={t("e.g. ground, indoor_court")}
                        className="h-8"
                      />
                    </label>
                    <p className="col-span-2 text-[0.6875rem] leading-relaxed text-muted-foreground/80">
                      {t("Fixtures only land on venues of a matching type, and the calendar reserves this much time per match. Leave blank to use the sport's standard values.")}
                    </p>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Generate the form AND move into the institute-registration stage. */}
          <section className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">
                {orgForm
                  ? t("Continue to institute registration")
                  : t("Generate form & start registration")}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(
                  "Builds the registration form from these sports + categories and moves the tournament into the institute-registration stage. You can review and edit it before opening.",
                )}
              </p>
            </div>
            <Button
              type="button"
              disabled={generate.isPending}
              onClick={() => generate.mutate()}
              data-testid="generate-institution-form"
              className="shrink-0"
            >
              <FileText aria-hidden="true" className="h-4 w-4" />
              {generate.isPending
                ? t("Setting up…")
                : orgForm
                  ? t("Continue to registration")
                  : t("Generate & start registration")}
            </Button>
          </section>
        </>
      )}
    </div>
  );
}
