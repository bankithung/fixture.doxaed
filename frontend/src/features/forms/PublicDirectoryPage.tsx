import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  ChevronRight,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  formsApi,
  type DirectoryEntry,
  type DirectoryFilter,
} from "@/api/forms";
import { ApiError } from "@/types/api";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/button";
import { Centered, PublicShell } from "@/features/registration/PublicShell";
import { cn } from "@/lib/tailwind";
import { useBreakpoint } from "@/lib/useBreakpoint";
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
// Stats — computed entirely from the form's OWN filters + entries, so they
// adapt to whatever fields each form defines (nothing hardcoded).
// ---------------------------------------------------------------------------
interface DimStat {
  key: string;
  label: string;
  reported: number; // entries that answered this field
  total: number; // total selections (multi-choice counts each)
  max: number; // largest single-option count (for bar scale)
  items: { value: string; label: string; count: number }[];
}

function computeStats(
  filters: DirectoryFilter[],
  entries: DirectoryEntry[],
): DimStat[] {
  return filters.map((f) => {
    const counts = new Map<string, number>();
    let reported = 0;
    for (const e of entries) {
      const v = e.values[f.key];
      const arr = (Array.isArray(v) ? v : [v]).filter(
        (x) => x != null && x !== "",
      );
      if (arr.length) reported += 1;
      for (const x of arr)
        counts.set(String(x), (counts.get(String(x)) ?? 0) + 1);
    }
    const items = f.options
      .map((o) => ({ value: o.value, label: o.label, count: counts.get(o.value) ?? 0 }))
      .filter((i) => i.count > 0)
      .sort((a, b) => b.count - a.count);
    const total = items.reduce((s, i) => s + i.count, 0);
    return {
      key: f.key,
      label: f.label,
      reported,
      total,
      max: Math.max(1, ...items.map((i) => i.count)),
      items,
    };
  });
}

function DimensionCard({ stat }: { stat: DimStat }): React.ReactElement {
  const shown = stat.items.slice(0, 6);
  const more = stat.items.length - shown.length;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h3
          className="truncate text-sm font-medium text-foreground"
          title={stat.label}
        >
          {stat.label}
        </h3>
        <span className="shrink-0 font-tabular text-xs text-muted-foreground">
          {stat.reported} {t("replied")}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("No responses yet.")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((it) => (
            <li
              key={it.value}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="truncate text-muted-foreground" title={it.label}>
                {it.label}
              </span>
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-tabular text-xs font-medium text-foreground">
                {it.count}
              </span>
            </li>
          ))}
          {more > 0 ? (
            <li className="text-xs text-muted-foreground">
              +{more} {t("more")}
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// By competition (W2-E) — the structural view: every configured competition
// (sport → category → sub-category leaf) with the institutions entered in it.
// ---------------------------------------------------------------------------
interface SportGroup {
  sport: string;
  rows: { leafKey: string; label: string; institutions: string[] }[];
}

function groupBySport(
  competitions: { leaf_key: string; label: string; count: number }[],
  entries: DirectoryEntry[],
): SportGroup[] {
  const byLeaf = new Map<string, string[]>();
  for (const e of entries) {
    for (const c of e.competitions ?? []) {
      const list = byLeaf.get(c.leaf_key) ?? [];
      list.push(e.name);
      byLeaf.set(c.leaf_key, list);
    }
  }
  const groups = new Map<string, SportGroup>();
  for (const c of competitions) {
    const sport = c.label.split(" — ")[0];
    const within = c.label.includes(" — ")
      ? c.label.slice(sport.length + 3)
      : t("Open competition");
    const g = groups.get(sport) ?? { sport, rows: [] };
    g.rows.push({
      leafKey: c.leaf_key,
      label: within,
      institutions: byLeaf.get(c.leaf_key) ?? [],
    });
    groups.set(sport, g);
  }
  return [...groups.values()];
}

function CompetitionsSection({
  groups,
}: {
  groups: SportGroup[];
}): React.ReactElement {
  // Compact: one LINE per competition (owner 2026-06-10 — the per-row
  // "No entries yet." cards made 21 empty competitions a wall of noise);
  // institution chips appear only once a competition has entries.
  return (
    <section
      aria-label={t("Entries by competition")}
      className="grid gap-3 lg:grid-cols-2"
    >
      {groups.map((g) => (
        <div
          key={g.sport}
          className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4 shadow-sm"
        >
          <h3 className="text-sm font-semibold">{g.sport}</h3>
          <ul className="mt-1 flex flex-col divide-y divide-border/60">
            {g.rows.map((r) => (
              <li key={r.leafKey} className="flex flex-col gap-1 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "min-w-0 truncate text-sm",
                      r.institutions.length === 0 && "text-muted-foreground",
                    )}
                    title={r.label}
                  >
                    {r.label}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-md px-1.5 py-0.5 font-tabular text-xs font-medium",
                      r.institutions.length > 0
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground/60",
                    )}
                  >
                    {r.institutions.length}
                  </span>
                </div>
                {r.institutions.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {r.institutions.map((name) => (
                      <span
                        key={name}
                        className="rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Filter rail (W2) — Amazon-style side rail with a HIERARCHICAL competition
// tree (sport → category → sub-category, checkbox per level) instead of one
// flat dropdown stacking 100 options.
// ---------------------------------------------------------------------------
interface CompNode {
  key: string;
  label: string;
  count: number;
  children: CompNode[];
}

function buildCompTree(
  comps: { leaf_key: string; label: string; count: number }[],
): CompNode[] {
  const roots: CompNode[] = [];
  const index = new Map<string, CompNode>();
  for (const c of comps) {
    const segs = c.leaf_key.split(".");
    const labels = c.label.split(" — ");
    let path = "";
    let siblings = roots;
    for (let i = 0; i < segs.length; i += 1) {
      path = path ? `${path}.${segs[i]}` : segs[i];
      let node = index.get(path);
      if (!node) {
        node = {
          key: path,
          label: labels[Math.min(i, labels.length - 1)] ?? segs[i],
          count: 0,
          children: [],
        };
        index.set(path, node);
        siblings.push(node);
      }
      node.count += c.count;
      siblings = node.children;
    }
  }
  return roots;
}

/** True when an entry has any competition at or under the prefix. */
function entryMatchesPrefix(e: DirectoryEntry, prefix: string): boolean {
  return (e.competitions ?? []).some(
    (c) => c.leaf_key === prefix || c.leaf_key.startsWith(`${prefix}.`),
  );
}

function CompTreeRow({
  node,
  depth,
  selected,
  onToggle,
  expanded,
  onExpand,
}: {
  node: CompNode;
  depth: number;
  selected: Set<string>;
  onToggle: (key: string, on: boolean) => void;
  expanded: Set<string>;
  onExpand: (key: string, open: boolean) => void;
}): React.ReactElement {
  // Branches start COLLAPSED (Amazon-style) so a big catalog stays a short
  // list of sports; the chevron drills in level by level.
  const hasKids = node.children.length > 0;
  const isOpen = expanded.has(node.key);
  return (
    <>
      <div
        className="flex items-center gap-1 py-0.5 text-sm"
        style={{ paddingLeft: depth * 12 }}
      >
        {hasKids ? (
          <button
            type="button"
            aria-label={
              isOpen ? t(`Collapse ${node.label}`) : t(`Expand ${node.label}`)
            }
            aria-expanded={isOpen}
            onClick={() => onExpand(node.key, !isOpen)}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                isOpen && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" aria-hidden="true" />
        )}
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={selected.has(node.key)}
            onChange={(e) => onToggle(node.key, e.target.checked)}
            className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              depth === 0 ? "font-medium" : "text-muted-foreground",
            )}
            title={node.label}
          >
            {node.label}
          </span>
          <span className="shrink-0 font-tabular text-xs text-muted-foreground/70">
            {node.count}
          </span>
        </label>
      </div>
      {isOpen
        ? node.children.map((c) => (
            <CompTreeRow
              key={c.key}
              node={c}
              depth={depth + 1}
              selected={selected}
              onToggle={onToggle}
              expanded={expanded}
              onExpand={onExpand}
            />
          ))
        : null}
    </>
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
    return <span className="text-muted-foreground/40">—</span>;
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

/**
 * The one set of filter controls (search → competition tree → per-question
 * selects). Rendered twice: in the desktop right rail and inside the mobile
 * bottom-sheet — so both surfaces always stay in sync.
 */
function FilterPanel({
  search,
  onSearch,
  compTree,
  compSel,
  onToggleComp,
  expanded,
  onExpand,
  filters,
  values,
  onValue,
}: {
  search: string;
  onSearch: (v: string) => void;
  compTree: CompNode[];
  compSel: Set<string>;
  onToggleComp: (key: string, on: boolean) => void;
  expanded: Set<string>;
  onExpand: (key: string, open: boolean) => void;
  filters: DirectoryFilter[];
  values: Record<string, string>;
  onValue: (key: string, v: string) => void;
}): React.ReactElement {
  return (
    <>
      <label className="relative block">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t("Search name or region…")}
          className="h-9 pl-9"
          aria-label={t("Search")}
        />
      </label>

      {compTree.length > 0 ? (
        <div className="flex flex-col gap-0.5 border-t border-border pt-3">
          <button
            type="button"
            aria-expanded={!expanded.has("__comp_closed")}
            onClick={() => onExpand("__comp_closed", !expanded.has("__comp_closed"))}
            className="mb-1.5 flex items-center justify-between text-left text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground"
          >
            {t("Competitions")}
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                !expanded.has("__comp_closed") && "rotate-90",
              )}
            />
          </button>
          {!expanded.has("__comp_closed")
            ? compTree.map((n) => (
                <CompTreeRow
                  key={n.key}
                  node={n}
                  depth={0}
                  selected={compSel}
                  onToggle={onToggleComp}
                  expanded={expanded}
                  onExpand={onExpand}
                />
              ))
            : null}
        </div>
      ) : null}

      {filters.map((f) => (
        <label
          key={f.key}
          className="flex flex-col gap-1 border-t border-border pt-3"
        >
          <span
            className="truncate text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
            title={f.label}
          >
            {f.label}
          </span>
          <Select
            size="sm"
            value={values[f.key] ?? ""}
            onChange={(v) => onValue(f.key, v)}
            options={[{ value: "", label: t("All") }, ...f.options]}
            aria-label={f.label}
          />
        </label>
      ))}
    </>
  );
}

function EmptyState({ message }: { message: string }): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card py-14 text-center">
      <Building2
        aria-hidden="true"
        className="h-8 w-8 text-muted-foreground/40"
      />
      <p className="text-sm text-muted-foreground">{message}</p>
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
  // competitions report above the table buried the actual list).
  const [view, setView] = useState<"table" | "competitions" | "stats">(
    "table",
  );
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
          [...compSel].some((p) => entryMatchesPrefix(e, p))) &&
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

  // Every view honours the active filters (owner 2026-06-10: the rail only
  // affecting the Directory table read as broken on the other tabs).
  const stats = useMemo(
    () => computeStats(dir.data?.filters ?? [], entries),
    [dir.data, entries],
  );
  const sportGroups = useMemo(() => {
    const all = dir.data?.competitions ?? [];
    const visible =
      compSel.size === 0
        ? all
        : all.filter((c) =>
            [...compSel].some(
              (p) => c.leaf_key === p || c.leaf_key.startsWith(`${p}.`),
            ),
          );
    const groups = groupBySport(visible, entries);
    if (!hasFilters) return groups; // unfiltered → the full structure, zeros included
    return groups
      .map((g) => ({ ...g, rows: g.rows.filter((r) => r.institutions.length > 0) }))
      .filter((g) => g.rows.length > 0);
  }, [dir.data, entries, compSel, hasFilters]);
  const compTree = useMemo(
    () => buildCompTree(dir.data?.competitions ?? []),
    [dir.data],
  );

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
  const tabsVisible = hasCompetitions || (stats.length > 0 && total > 0);
  const activeFilterCount =
    (search.trim() !== "" ? 1 : 0) +
    compSel.size +
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
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        {/* Header — compact on phones: the count collapses into an inline
            pill next to the title instead of a second stacked card. */}
        <header className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-primary">
              {d.tournament_name}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                {t("Registered institutions")}
              </h1>
              <span
                aria-label={`${total} ${
                  total === 1
                    ? t("institution registered")
                    : t("institutions registered")
                }`}
                className="inline-flex shrink-0 items-center rounded-full bg-primary/10 px-2.5 py-0.5 font-tabular text-sm font-semibold text-primary sm:hidden"
              >
                {total}
              </span>
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground" title={d.form_title}>
              {d.form_title}
            </p>
          </div>
          <div className="hidden shrink-0 items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-2.5 sm:flex">
            <Building2 aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
            <div className="leading-tight">
              <div className="font-tabular text-2xl font-semibold tracking-tight text-primary">
                {total}
              </div>
              <div className="text-xs text-muted-foreground">
                {total === 1
                  ? t("institution registered")
                  : t("institutions registered")}
              </div>
            </div>
          </div>
        </header>

        {/* Content + the Amazon-style filter rail (right on desktop). */}
        <div className="flex flex-col gap-6 lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-6">

        {/* Toolbar — view tabs + (on phones) the Filters button that opens
            the bottom-sheet. Sticky below lg so filters stay reachable
            mid-scroll; on desktop the rail is always visible, so it's static. */}
        <div
          className={cn(
            "sticky top-0 z-30 -mx-4 flex items-center justify-between gap-2 bg-card/80 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:static lg:z-auto lg:mx-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none",
            !tabsVisible && "lg:hidden",
          )}
        >
          {tabsVisible ? (
            <div
              className="inline-flex w-fit rounded-lg border border-border bg-muted/50 p-0.5 text-sm"
              role="tablist"
              aria-label={t("View")}
            >
              {(
                [
                  ["table", t("Directory")],
                  ...(hasCompetitions
                    ? ([["competitions", t("Competitions")]] as const)
                    : []),
                  ...(stats.length > 0 && total > 0
                    ? ([["stats", t("Breakdown")]] as const)
                    : []),
                ] as readonly (readonly [string, string])[]
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v as typeof view)}
                  className={cn(
                    "rounded-md px-3 py-1 font-medium transition-colors",
                    view === v
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <span aria-hidden="true" />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFilterSheet(true)}
            className="shrink-0 lg:hidden"
          >
            <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
            {t("Filters")}
            {activeFilterCount > 0 ? (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 font-tabular text-[0.6875rem] font-semibold leading-none text-primary-foreground">
                {activeFilterCount}
              </span>
            ) : null}
          </Button>
        </div>

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

        {/* Dynamic stats — one distribution card per form dimension. */}
        {view === "stats" && stats.length > 0 && total > 0 ? (
          entries.length === 0 && hasFilters ? (
            <EmptyState message={t("No institutions match your filters.")} />
          ) : (
            <section aria-label={t("Registration breakdown")}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {stats.map((s) => (
                  <DimensionCard key={s.key} stat={s} />
                ))}
              </div>
            </section>
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
                <li
                  key={i}
                  className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 shadow-sm"
                >
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
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="max-h-[34rem] overflow-auto rounded-xl border border-border bg-card shadow-sm">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                  <th className="sticky left-0 top-0 z-30 border-b border-border bg-muted px-4 py-2.5 font-medium">
                    {t("Institution")}
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
                      <span className="block max-w-[14rem] truncate">{e.name}</span>
                    </td>
                    {showType ? (
                      <td className="border-b border-border px-3 py-2.5 align-top capitalize text-muted-foreground group-hover:bg-accent/40">
                        {t(e.kind)}
                      </td>
                    ) : null}
                    {showRegion ? (
                      <td className="border-b border-border px-3 py-2.5 align-top text-muted-foreground group-hover:bg-accent/40">
                        {e.region || "—"}
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
                        <span className="text-muted-foreground/40">—</span>
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

        {/* Filter rail — desktop only. On phones the SAME panel opens from
            the toolbar's Filters button as a bottom-sheet (the rail used to
            render after the list, i.e. uselessly at the bottom of the page). */}
        <aside
          aria-label={t("Filters")}
          className="hidden w-full shrink-0 flex-col gap-4 lg:order-last lg:flex lg:w-72"
        >
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t("Filters")}</h2>
              {hasFilters ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="h-7 px-2"
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Clear")}
                </Button>
              ) : null}
            </div>
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
        </aside>
        </div>

        {/* Mobile filter bottom-sheet — same controls as the rail. */}
        <Dialog
          open={filterSheet}
          onOpenChange={setFilterSheet}
          ariaLabel={t("Filters")}
          variant="sheet"
        >
          <DialogHeader className="pb-3">
            <div className="flex items-center justify-between">
              <DialogTitle>{t("Filters")}</DialogTitle>
              {hasFilters ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="h-7 px-2"
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Clear all")}
                </Button>
              ) : null}
            </div>
          </DialogHeader>
          <div className="flex flex-col gap-3">
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
          <Button
            className="mt-4 w-full"
            onClick={() => setFilterSheet(false)}
          >
            {t("Show")} {entries.length}{" "}
            {entries.length === 1 ? t("institution") : t("institutions")}
          </Button>
        </Dialog>

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
                    c.label.split(" — ")[0],
                    compModal.competitions.filter(
                      (x) => x.label.split(" — ")[0] === c.label.split(" — ")[0],
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
                          {c.label.includes(" — ")
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
