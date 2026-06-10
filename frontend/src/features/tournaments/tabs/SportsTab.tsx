import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  FileText,
  Plus,
  Search,
  Trash2,
  Trophy,
  X,
} from "lucide-react";
import {
  tournamentsApi,
  type SportCategory,
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

/** Coerce categories to the 2-level shape, tolerating legacy plain-string data. */
function normCats(raw: unknown): SportCategory[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) =>
      typeof c === "string"
        ? { name: c, subcategories: [] }
        : {
            name: String((c as SportCategory)?.name ?? ""),
            subcategories: Array.isArray((c as SportCategory)?.subcategories)
              ? (c as SportCategory).subcategories.map(String)
              : [],
          },
    )
    .filter((c) => c.name);
}

function slugKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * SETUP step — choose the sport(s) this tournament runs and the categories for
 * each (e.g. U-14 Boys). The selection + categories drive the auto-generated
 * registration forms and, later, the per-sport fixtures/constraints. Auto-saves.
 */
export function SportsTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [catDraft, setCatDraft] = useState<Record<string, string>>({});
  // Subcategory drafts keyed by `${sportKey}::${categoryName}`.
  const [subDraft, setSubDraft] = useState<Record<string, string>>({});
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
      (chosen.data?.sports ?? []).map((s) => ({
        ...s,
        categories: normCats(s.categories),
      })),
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
  const addCategory = (key: string, raw: string): void => {
    const name = raw.trim();
    const sport = selected.find((s) => s.key === key);
    if (!name || !sport) return;
    if ((sport.categories ?? []).some((c) => c.name === name)) return;
    updateSport(key, {
      categories: [...(sport.categories ?? []), { name, subcategories: [] }],
    });
    setCatDraft((d) => ({ ...d, [key]: "" }));
  };
  const removeCategory = (key: string, name: string): void => {
    const sport = selected.find((s) => s.key === key);
    updateSport(key, {
      categories: (sport?.categories ?? []).filter((c) => c.name !== name),
    });
  };
  const addSubcategory = (key: string, catName: string, raw: string): void => {
    const sub = raw.trim();
    const sport = selected.find((s) => s.key === key);
    if (!sub || !sport) return;
    updateSport(key, {
      categories: (sport.categories ?? []).map((c) =>
        c.name === catName && !c.subcategories.includes(sub)
          ? { ...c, subcategories: [...c.subcategories, sub] }
          : c,
      ),
    });
    setSubDraft((d) => ({ ...d, [`${key}::${catName}`]: "" }));
  };
  const removeSubcategory = (key: string, catName: string, sub: string): void => {
    const sport = selected.find((s) => s.key === key);
    updateSport(key, {
      categories: (sport?.categories ?? []).map((c) =>
        c.name === catName
          ? { ...c, subcategories: c.subcategories.filter((x) => x !== sub) }
          : c,
      ),
    });
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

  const stepChip = (active: boolean): string =>
    cn(
      "rounded-full px-2 py-0.5",
      active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
    );

  return (
    <div className="flex w-full flex-col gap-6">
      {/* Header + step indicator */}
      <div className="min-w-0">
        <h2 className="text-lg font-semibold">{t("Sports")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {effectiveStep === "pick"
            ? t("Pick the sport(s) this tournament runs — you'll set up each one's categories next.")
            : t("Set up the categories and subcategories for each sport, one at a time.")}
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
                {selected.map((s) => (
                  <li
                    key={s.key}
                    data-testid={`sport-${s.key}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card py-1 pl-3 pr-1.5 text-sm shadow-sm"
                  >
                    <Trophy aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                    <span className="font-medium">{s.name}</span>
                    {(s.categories ?? []).length ? (
                      <span className="font-tabular text-xs text-muted-foreground">
                        · {(s.categories ?? []).length} {t("cat")}
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
                ))}
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
              const count = (s.categories ?? []).length;
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
                  {count ? (
                    <span className="font-tabular opacity-70">({count})</span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* Active sport's categories → subcategories. */}
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
                    {t("category → subcategories")}
                  </span>
                </div>
                {(activeSport.categories ?? []).length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-center text-sm text-muted-foreground">
                    {t("No categories yet — add one below (e.g. Singles, U-14).")}
                  </p>
                ) : (
                  <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                    {(activeSport.categories ?? []).map((c) => (
                      <div
                        key={c.name}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
                      >
                        <span
                          className="w-24 shrink-0 truncate text-sm font-medium"
                          title={c.name}
                        >
                          {c.name}
                        </span>
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                          {c.subcategories.map((sub) => (
                            <span
                              key={sub}
                              className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pl-2.5 pr-1 text-xs"
                            >
                              {sub}
                              <button
                                type="button"
                                onClick={() =>
                                  removeSubcategory(activeSport.key, c.name, sub)
                                }
                                aria-label={t(`Remove ${sub}`)}
                                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <X aria-hidden="true" className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                          <form
                            className="contents"
                            onSubmit={(e) => {
                              e.preventDefault();
                              addSubcategory(
                                activeSport.key,
                                c.name,
                                subDraft[`${activeSport.key}::${c.name}`] ?? "",
                              );
                            }}
                          >
                            <Input
                              value={subDraft[`${activeSport.key}::${c.name}`] ?? ""}
                              onChange={(e) =>
                                setSubDraft((d) => ({
                                  ...d,
                                  [`${activeSport.key}::${c.name}`]: e.target.value,
                                }))
                              }
                              placeholder={t("+ subcategory")}
                              className="h-7 w-32 text-sm"
                              aria-label={t(`Add a subcategory to ${c.name}`)}
                            />
                          </form>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeCategory(activeSport.key, c.name)}
                          aria-label={t(`Remove category ${c.name}`)}
                          className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addCategory(activeSport.key, catDraft[activeSport.key] ?? "");
                  }}
                >
                  <Input
                    value={catDraft[activeSport.key] ?? ""}
                    onChange={(e) =>
                      setCatDraft((d) => ({
                        ...d,
                        [activeSport.key]: e.target.value,
                      }))
                    }
                    placeholder={t("Add a category (e.g. Singles, U-14)")}
                    className="h-8 max-w-xs text-sm"
                    aria-label={t(`Add a category to ${activeSport.name}`)}
                  />
                  <Button type="submit" variant="outline" size="sm">
                    <Plus aria-hidden="true" className="h-4 w-4" />
                    {t("Add category")}
                  </Button>
                </form>
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
