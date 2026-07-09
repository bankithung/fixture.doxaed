import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  ClipboardList,
  SlidersHorizontal,
  Trophy,
} from "lucide-react";
import { formsApi, type DirectoryEntry } from "@/api/forms";
import { ApiError } from "@/types/api";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StaggeredDrawer } from "@/components/ui/StaggeredDrawer";
import { StarBorder } from "@/components/ui/StarBorder";
import { Centered, PublicShell } from "@/features/registration/PublicShell";
import { RangePills } from "@/features/dashboard/RangePills";
import {
  buildCompTree,
  compLeafKeys,
  FilterPanel,
  matchesCompPrefix,
} from "./FilterPanel";
import { cn } from "@/lib/tailwind";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { BentoGrid } from "@/features/dashboard/BentoCard";
import { t } from "@/lib/t";

function matches(entry: DirectoryEntry, key: string, value: string): boolean {
  if (!value) return true;
  const ev = entry.values[key];
  if (Array.isArray(ev)) return ev.map(String).includes(value);
  return String(ev ?? "") === value;
}

/** A value (or values) for one entry, as the option labels to display. */
function valueLabels(map: Map<string, string>, val: unknown): string[] {
  const arr = (Array.isArray(val) ? val : [val]).filter(
    (v) => v != null && v !== "",
  );
  return arr.map((v) => map.get(String(v)) ?? String(v));
}

// ---------------------------------------------------------------------------
// By competition (W2-E) — the structural view: every configured competition
// (sport → category → sub-category leaf) with the institutions entered in it.
// ---------------------------------------------------------------------------
interface SportGroup {
  sport: string;
  rows: { leafKey: string; label: string; count: number }[];
}

/** Group EVERY configured competition by its sport, carrying the server-side
 *  registration count. This is a full structural report (owner 2026-06-16:
 *  show all games + categories, including zeros) — independent of the filter
 *  rail, which drives the directory table instead. */
function groupBySport(
  competitions: { leaf_key: string; label: string; count: number }[],
): SportGroup[] {
  const groups = new Map<string, SportGroup>();
  for (const c of competitions) {
    const sport = c.label.split(/\s+[\u00b7\u2014]\s+/)[0];
    const within = c.label.includes(" · ")
      ? c.label.slice(sport.length + 3)
      : t("Open competition");
    const g = groups.get(sport) ?? { sport, rows: [] };
    g.rows.push({ leafKey: c.leaf_key, label: within, count: c.count });
    groups.set(sport, g);
  }
  return [...groups.values()];
}

function CompetitionsSection({
  groups,
}: {
  groups: SportGroup[];
}): React.ReactElement {
  // One LINE per competition: the category + how many registered. Every
  // configured competition shows (zeros included, owner 2026-06-16) so the
  // report is the full sport → category structure with counts only.
  return (
    <section
      aria-label={t("Entries by competition")}
      className="grid gap-3 lg:grid-cols-2"
    >
      {groups.map((g, gi) => (
        <StarBorder key={g.sport} speed={`${6 + gi}s`}>
        <div className="bento-card flex h-full flex-col gap-1 rounded-xl border border-border bg-card p-4 shadow-sm">
          <h3 className="text-sm font-semibold">{g.sport}</h3>
          <ul className="mt-1 flex flex-col divide-y divide-border/60">
            {g.rows.map((r) => (
              <li
                key={r.leafKey}
                className="flex items-center justify-between gap-2 py-1.5"
              >
                <span
                  className={cn(
                    "min-w-0 truncate text-sm",
                    r.count === 0 && "text-muted-foreground",
                  )}
                  title={r.label}
                >
                  {r.label}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-md px-1.5 py-0.5 font-tabular text-xs font-medium",
                    r.count > 0
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground/60",
                  )}
                >
                  {r.count}
                </span>
              </li>
            ))}
          </ul>
        </div>
        </StarBorder>
      ))}
    </section>
  );
}

/** Multi-value answers render as compact chips; single values as text. */
function Cell({
  map,
  val,
}: {
  map: Map<string, string>;
  val: unknown;
}): React.ReactElement {
  const labels = valueLabels(map, val);
  if (labels.length === 0)
    return <span className="text-muted-foreground/40">·</span>;
  if (labels.length === 1)
    return <span className="text-muted-foreground">{labels[0]}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((l, i) => (
        <span
          key={i}
          className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {l}
        </span>
      ))}
    </div>
  );
}

function EmptyState({
  message,
  action,
}: {
  message: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-4 py-14 text-center">
      <Building2
        aria-hidden="true"
        className="h-8 w-8 text-muted-foreground/40"
      />
      <p className="text-sm text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}

export function PublicDirectoryPage(): React.ReactElement {
  const { formId = "" } = useParams();
  const [filters, setFilters] = useState<Record<string, string>>({});
  // Hierarchical competition selection (W2): a set of selected tree
  // prefixes — picking "Sepak Takraw" matches everything under it, picking
  // "u-17 — male" matches only that branch. Union across selections.
  const [compSel, setCompSel] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  // One view at a time, the DIRECTORY first (owner 2026-06-10: stacking the
  // competitions report above the table buried the actual list). The former
  // "Breakdown" stats tab is gone — it duplicated the Competitions view
  // (owner 2026-06-10).
  const [view, setView] = useState<"table" | "competitions">("table");
  // Filter-tree expansion — sports start collapsed so the rail stays short.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // "View all competitions" modal for one institution's full entry list.
  const [compModal, setCompModal] = useState<DirectoryEntry | null>(null);
  // Mobile filter bottom-sheet (the rail is desktop-only; on phones the
  // filters live behind a "Filters" button in the toolbar).
  const [filterSheet, setFilterSheet] = useState(false);
  const { isMobile } = useBreakpoint();

  const dir = useQuery({
    queryKey: ["form-directory", formId],
    queryFn: () => formsApi.directory(formId),
    // Retry transient errors (e.g. a brief deploy restart); real 404s fail fast.
    retry: (count, err) =>
      count < 2 && !(err instanceof ApiError && err.status === 404),
  });

  const entries = useMemo(() => {
    const all = dir.data?.entries ?? [];
    const q = search.trim().toLowerCase();
    return all.filter(
      (e) =>
        (!q ||
          e.name.toLowerCase().includes(q) ||
          (e.region ?? "").toLowerCase().includes(q)) &&
        (compSel.size === 0 ||
          [...compSel].some((p) => matchesCompPrefix(e.competitions ?? [], p))) &&
        Object.entries(filters).every(([k, v]) => matches(e, k, v)),
    );
  }, [dir.data, filters, search, compSel]);

  useEffect(() => {
    const name = dir.data?.tournament_name;
    if (name) document.title = `${name} · ${t("Registered institutions")}`;
  }, [dir.data]);

  const hasFilters =
    search.trim() !== "" ||
    compSel.size > 0 ||
    Object.values(filters).some(Boolean);

  // The Competitions report always shows the full sport → category structure
  // with the registration count per leaf (owner 2026-06-16: "show all games
  // too even if they are 0"). It's a stable report; the filter rail drives the
  // directory table, not this.
  const sportGroups = useMemo(
    () => groupBySport(dir.data?.competitions ?? []),
    [dir.data],
  );
  const compTree = useMemo(
    () => buildCompTree(dir.data?.competitions ?? []),
    [dir.data],
  );

  // Headline KPIs — distinct institutions registered per MAIN game (top-level
  // sport, never sub-categories), from ALL entries (filters don't move the
  // headline). Catalog order; zero-entry games still show.
  const gameStats = useMemo(() => {
    const sports = new Map<string, string>();
    for (const c of dir.data?.competitions ?? []) {
      const key = c.leaf_key.split(".")[0];
      if (!sports.has(key)) sports.set(key, c.label.split(/\s+[\u00b7\u2014]\s+/)[0]);
    }
    const byGame = new Map<string, Set<string>>();
    for (const e of dir.data?.entries ?? []) {
      for (const c of e.competitions ?? []) {
        const key = c.leaf_key.split(".")[0];
        let set = byGame.get(key);
        if (!set) {
          set = new Set();
          byGame.set(key, set);
        }
        set.add(e.name);
      }
    }
    // The chip always LEADS with the sport's name — two chips both reading
    // "institute registered" said nothing (owner 2026-07-05). A custom stat
    // label from the form builder rides along as the chip's tooltip.
    const custom = (dir.data?.kpi_labels ?? {}) as Record<string, string>;
    return [...sports].map(([key, name]) => ({
      key,
      name,
      label: (custom[key] ?? "").trim(),
      count: byGame.get(key)?.size ?? 0,
    }));
  }, [dir.data]);

  if (dir.isLoading) {
    return (
      <PublicShell wide>
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          <div className="h-7 w-56 animate-pulse rounded bg-muted" />
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-24 animate-pulse rounded-xl border border-border bg-card"
              />
            ))}
          </div>
          <div className="mt-6 h-72 animate-pulse rounded-xl border border-border bg-card" />
        </div>
      </PublicShell>
    );
  }
  if (dir.isError || !dir.data) {
    return (
      <PublicShell wide>
        <Centered>
          <Building2
            aria-hidden="true"
            className="mx-auto h-10 w-10 text-muted-foreground/40"
          />
          <p className="mt-3 text-sm font-medium">
            {t("Directory not available")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("This registration isn't open, or the link is invalid.")}
          </p>
        </Centered>
      </PublicShell>
    );
  }

  const d = dir.data;
  const columns = d.filters.map((f) => ({
    key: f.key,
    label: f.label,
    map: new Map(f.options.map((o) => [o.value, o.label])),
  }));
  const total = d.entries.length;
  // Region/Type are fixed institution attributes, not form questions — only
  // show their columns when the data actually carries them (owner
  // 2026-06-10: a permanently empty Region column confused readers).
  const showRegion = d.entries.some((e) => (e.region ?? "").trim() !== "");
  const showType =
    new Set(d.entries.map((e) => e.kind).filter(Boolean)).size > 1;
  // The Competitions tab stays visible from the CONFIGURED catalog, not the
  // filtered groups — otherwise a strict filter would make the tab vanish.
  const hasCompetitions = (d.competitions ?? []).length > 0;
  const tabsVisible = hasCompetitions;
  // Count each partially/fully selected competition GROUP as one filter (not
  // each underlying leaf), so picking a whole sport reads as "1", not "7".
  const compFilterCount = compTree.reduce(
    (n, root) => n + (compLeafKeys(root).some((l) => compSel.has(l)) ? 1 : 0),
    0,
  );
  const activeFilterCount =
    (search.trim() !== "" ? 1 : 0) +
    compFilterCount +
    Object.values(filters).filter(Boolean).length;
  const clearFilters = (): void => {
    setSearch("");
    setCompSel(new Set());
    setFilters({});
  };
  const toggleComp = (key: string, on: boolean): void =>
    setCompSel((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const toggleExpand = (key: string, open: boolean): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <PublicShell wide tournamentName={d.tournament_name}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pb-24 pt-6 sm:px-6 lg:pb-8">
        {/* Page header: the tournament leads; the register CTA lives in the
            panel toolbar beside Filters. */}
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-primary">
              {t("Registered institutions")}
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
              {d.tournament_name}
            </h1>
            <p className="mt-1 truncate text-sm text-muted-foreground" title={d.form_title}>
              {d.form_title}
            </p>
          </div>
        </header>

        {/* ONE panel (owner 2026-07-05): toolbar with the total + view tabs,
            a slim per-game stats strip, then the content beside the filter
            rail — wrapped in the StarBorder orbit. */}
        <BentoGrid>
        <StarBorder>
        <section className="bento-card panel" aria-label={t("Registered institutions")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <Building2 aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
            <h2 className="text-sm font-semibold">{t("Registered institutions")}</h2>
            <span
              className="flex items-baseline gap-1 pl-1"
              data-testid="registered-count"
            >
              <span className="font-tabular text-base font-semibold leading-none">
                {total}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("registered")}
              </span>
            </span>
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              {tabsVisible ? (
                /* PillNav re-cut (RangePills): gsap hover circle, token colors. */
                <RangePills
                  label={t("View")}
                  options={[
                    { value: "table", label: t("Directory") },
                    { value: "competitions", label: t("Competitions") },
                  ]}
                  value={view}
                  onChange={(v) => setView(v as typeof view)}
                />
              ) : null}
              {/* Register CTA sits beside Filters; short label on phones so the
                  toolbar row never overflows. */}
              {d.form_open ? (
                <Link
                  to={`/f/${formId}`}
                  aria-label={t("Register your institution")}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <ClipboardList aria-hidden="true" className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t("Register your institution")}</span>
                  <span className="sm:hidden">{t("Register")}</span>
                </Link>
              ) : null}
              {/* Filters open the same right drawer as the admin pages. */}
              <Button
                variant="outline"
                size="sm"
                className="hidden lg:inline-flex"
                data-testid="open-directory-filters"
                onClick={() => setFilterSheet(true)}
                aria-haspopup="dialog"
              >
                <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
                {t("Filters")}
                {activeFilterCount > 0 ? (
                  <span className="rounded-full bg-primary px-1.5 py-px font-tabular text-[10px] font-semibold text-primary-foreground">
                    {activeFilterCount}
                  </span>
                ) : null}
              </Button>
            </div>
          </div>

          {/* Per-game strip (admins can switch to total-only). */}
          {(d.kpi_mode ?? "games") === "games" && gameStats.length > 0 ? (
            <section
              aria-label={t("Registration summary")}
              className="flex flex-wrap gap-x-4 gap-y-1.5 border-b border-border px-3 py-2"
            >
              {gameStats.map((g) => (
                <span
                  key={g.key}
                  title={g.label || undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 text-xs text-muted-foreground",
                    g.count === 0 && "opacity-60",
                  )}
                >
                  <Trophy aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                  {g.name}
                  <span className="font-tabular text-sm font-semibold text-foreground">
                    {g.count}
                  </span>
                </span>
              ))}
            </section>
          ) : null}

          <div className="flex flex-col gap-4 p-3">

        {/* Result count — applies to whichever view is active. */}
        {hasFilters ? (
          <p className="-mb-2 font-tabular text-xs text-muted-foreground">
            {entries.length === total
              ? `${total} ${t("shown")}`
              : `${entries.length} ${t("of")} ${total} ${t("shown")}`}
          </p>
        ) : null}

        {/* Entries by competition — the sport → category structural view
            (built from the FILTERED entries, pruned to the selection). */}
        {view === "competitions" ? (
          sportGroups.length > 0 ? (
            <CompetitionsSection groups={sportGroups} />
          ) : (
            <EmptyState
              message={
                hasFilters
                  ? t("No institutions match your filters.")
                  : t("No competitions configured yet.")
              }
            />
          )
        ) : null}

        {view === "table" ? (
          <>
        {entries.length === 0 ? (
          <EmptyState
            message={
              hasFilters
                ? t("No institutions match your filters.")
                : t("No institutions have registered yet.")
            }
            action={
              !hasFilters && d.form_open ? (
                <Link
                  to={`/f/${formId}`}
                  className="mt-1 inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ClipboardList aria-hidden="true" className="h-4 w-4" />
                  {t("Be the first to register")}
                </Link>
              ) : null
            }
          />
        ) : isMobile ? (
          /* Phones: stacked cards (the wide table is unreadable at 360px). */
          <ul className="flex flex-col gap-3">
            {entries.map((e, i) => {
              const answered = columns
                .map((c) => ({
                  key: c.key,
                  label: c.label,
                  labels: valueLabels(c.map, e.values[c.key]),
                }))
                .filter((a) => a.labels.length > 0);
              const comps = e.competitions ?? [];
              return (
                <StarBorder as="li" key={i}>
                <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 shadow-sm">
                  <div className="flex min-w-0 items-center gap-2.5">
                    {e.logo ? (
                      <img
                        src={e.logo}
                        alt=""
                        className="h-9 w-9 shrink-0 rounded-md object-cover"
                      />
                    ) : null}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold" title={e.name}>
                        {e.name}
                      </p>
                      {(showType && e.kind) || (showRegion && e.region) ? (
                        <p className="mt-0.5 text-xs capitalize text-muted-foreground">
                          {[
                            showType && e.kind ? t(e.kind) : null,
                            showRegion && e.region ? e.region : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {comps.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1">
                      {comps.slice(0, 3).map((c) => (
                        <span
                          key={c.leaf_key}
                          className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                        >
                          {c.label}
                        </span>
                      ))}
                      {comps.length > 3 ? (
                        <button
                          type="button"
                          onClick={() => setCompModal(e)}
                          className="rounded-md px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {t("View all")} ({comps.length})
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {answered.length > 0 ? (
                    <dl className="flex flex-col gap-1 border-t border-border/60 pt-2">
                      {answered.map((a) => (
                        <div
                          key={a.key}
                          className="flex items-baseline justify-between gap-3 text-xs"
                        >
                          <dt
                            className="shrink-0 truncate text-muted-foreground"
                            title={a.label}
                          >
                            {a.label}
                          </dt>
                          <dd className="min-w-0 text-right">
                            {a.labels.join(", ")}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </div>
                </StarBorder>
              );
            })}
          </ul>
        ) : (
          <div className="max-h-[34rem] overflow-auto rounded-xl border border-border bg-card shadow-sm">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                  <th className="sticky left-0 top-0 z-30 border-b border-border bg-muted px-4 py-2.5 font-medium">
                    {t(d.name_label ?? "Institution")}
                  </th>
                  {showType ? (
                    <th className="sticky top-0 z-20 border-b border-border bg-muted px-3 py-2.5 font-medium">
                      {t("Type")}
                    </th>
                  ) : null}
                  {showRegion ? (
                    <th className="sticky top-0 z-20 border-b border-border bg-muted px-3 py-2.5 font-medium">
                      {t("Region")}
                    </th>
                  ) : null}
                  <th className="sticky top-0 z-20 border-b border-border bg-muted px-3 py-2.5 font-medium">
                    {t("Competitions")}
                  </th>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      className="sticky top-0 z-20 border-b border-border bg-muted px-3 py-2.5 font-medium"
                      title={c.label}
                    >
                      <span className="block max-w-[12rem] truncate">{c.label}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i} className="group">
                    <td
                      className="sticky left-0 z-10 border-b border-border bg-card px-4 py-2.5 align-top font-medium group-hover:bg-accent/40"
                      title={e.name}
                    >
                      <span className="flex items-center gap-2">
                        {e.logo ? (
                          <img
                            src={e.logo}
                            alt=""
                            className="h-6 w-6 shrink-0 rounded object-cover"
                          />
                        ) : null}
                        <span className="block min-w-[8rem] max-w-[13rem] whitespace-normal break-words leading-snug sm:max-w-[24rem]">
                          {e.name}
                        </span>
                      </span>
                    </td>
                    {showType ? (
                      <td className="border-b border-border px-3 py-2.5 align-top capitalize text-muted-foreground group-hover:bg-accent/40">
                        {t(e.kind)}
                      </td>
                    ) : null}
                    {showRegion ? (
                      <td className="border-b border-border px-3 py-2.5 align-top text-muted-foreground group-hover:bg-accent/40">
                        {e.region || "·"}
                      </td>
                    ) : null}
                    <td className="border-b border-border px-3 py-2.5 align-top group-hover:bg-accent/40">
                      {(e.competitions ?? []).length ? (
                        <div className="flex max-w-[20rem] flex-wrap items-center gap-1">
                          {e.competitions.slice(0, 2).map((c) => (
                            <span
                              key={c.leaf_key}
                              className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                            >
                              {c.label}
                            </span>
                          ))}
                          {e.competitions.length > 2 ? (
                            <button
                              type="button"
                              onClick={() => setCompModal(e)}
                              className="rounded-md px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {t("View all")} ({e.competitions.length})
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-muted-foreground/40">·</span>
                      )}
                    </td>
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className="border-b border-border px-3 py-2.5 align-top group-hover:bg-accent/40"
                      >
                        <div className="max-w-[16rem]">
                          <Cell map={c.map} val={e.values[c.key]} />
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
          </>
        ) : null}
          </div>
        </section>
        </StarBorder>
        </BentoGrid>

        {/* Floating Filters pill (phones/tablets) — always on-screen at the
            bottom edge, opens the bottom-sheet. The desktop rail replaces it
            at lg. */}
        <Button
          onClick={() => setFilterSheet(true)}
          className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-full px-5 shadow-lg lg:hidden"
        >
          <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
          {t("Filters")}
          {activeFilterCount > 0 ? (
            <span className="-mr-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-foreground/25 px-1.5 font-tabular text-[0.6875rem] font-semibold leading-none">
              {activeFilterCount}
            </span>
          ) : null}
        </Button>

        {/* Filters — the same right-side StaggeredMenu drawer as the admin
            pages, at every breakpoint (rail and bottom-sheet retired). */}
        <StaggeredDrawer
          open={filterSheet}
          onClose={() => setFilterSheet(false)}
          title={t("Filters")}
          testId="directory-filter-drawer"
        >
          <div className="sdrawer-itemwrap">
            <div className="sdrawer-item">
              <FilterPanel
                search={search}
                onSearch={setSearch}
                compTree={compTree}
                compSel={compSel}
                onToggleComp={toggleComp}
                expanded={expanded}
                onExpand={toggleExpand}
                filters={d.filters}
                values={filters}
                onValue={(key, v) => setFilters((s) => ({ ...s, [key]: v }))}
              />
            </div>
          </div>
          <div className="sdrawer-itemwrap mt-auto">
            <div className="sdrawer-item flex items-center gap-2 border-t border-border pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!hasFilters}
                onClick={clearFilters}
              >
                {t("Clear all")}
              </Button>
              <Button
                type="button"
                size="sm"
                className="ml-auto"
                onClick={() => setFilterSheet(false)}
              >
                {t("Show")} {entries.length}{" "}
                {entries.length === 1 ? t("institution") : t("institutions")}
              </Button>
            </div>
          </div>
        </StaggeredDrawer>

        {/* One institution's full competition list, grouped by sport. */}
        <Dialog
          open={compModal !== null}
          onOpenChange={(o) => {
            if (!o) setCompModal(null);
          }}
          ariaLabel={t("All competitions")}
        >
          {compModal ? (
            <>
              <DialogHeader>
                <DialogTitle>{compModal.name}</DialogTitle>
                <DialogDescription>
                  {compModal.competitions.length}{" "}
                  {compModal.competitions.length === 1
                    ? t("competition entered")
                    : t("competitions entered")}
                </DialogDescription>
              </DialogHeader>
              <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
                {[...new Map(
                  compModal.competitions.map((c) => [
                    c.label.split(/\s+[\u00b7\u2014]\s+/)[0],
                    compModal.competitions.filter(
                      (x) => x.label.split(/\s+[\u00b7\u2014]\s+/)[0] === c.label.split(/\s+[\u00b7\u2014]\s+/)[0],
                    ),
                  ]),
                ).entries()].map(([sport, comps]) => (
                  <div key={sport} className="flex flex-col gap-1.5">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {sport}
                    </h3>
                    <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
                      {comps.map((c) => (
                        <li key={c.leaf_key} className="px-3 py-1.5 text-sm">
                          {c.label.includes(" · ")
                            ? c.label.slice(sport.length + 3)
                            : t("Open competition")}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => setCompModal(null)}>
                  {t("Close")}
                </Button>
              </div>
            </>
          ) : null}
        </Dialog>
      </div>
    </PublicShell>
  );
}
