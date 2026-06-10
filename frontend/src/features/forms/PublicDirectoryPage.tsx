import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Building2, Search, X } from "lucide-react";
import {
  formsApi,
  type DirectoryEntry,
  type DirectoryFilter,
} from "@/api/forms";
import { ApiError } from "@/types/api";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/button";
import { Centered, PublicShell } from "@/features/registration/PublicShell";
import { cn } from "@/lib/tailwind";
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
          <ul className="mt-1 flex flex-col divide-y divide-border">
            {g.rows.map((r) => (
              <li key={r.leafKey} className="flex flex-col gap-1.5 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm" title={r.label}>
                    {r.label}
                  </span>
                  <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-tabular text-xs font-medium">
                    {r.institutions.length}{" "}
                    {r.institutions.length === 1
                      ? t("institution")
                      : t("institutions")}
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
                ) : (
                  <p className="text-xs text-muted-foreground/70">
                    {t("No entries yet.")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
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

export function PublicDirectoryPage(): React.ReactElement {
  const { formId = "" } = useParams();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  // What the viewer wants to see: competitions, the breakdown, the list, or both.
  const [view, setView] = useState<"both" | "competitions" | "stats" | "table">(
    "both",
  );

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
        Object.entries(filters).every(([k, v]) => matches(e, k, v)),
    );
  }, [dir.data, filters, search]);

  useEffect(() => {
    const name = dir.data?.tournament_name;
    if (name) document.title = `${name} · ${t("Registered institutions")}`;
  }, [dir.data]);

  const stats = useMemo(
    () => computeStats(dir.data?.filters ?? [], dir.data?.entries ?? []),
    [dir.data],
  );
  const sportGroups = useMemo(
    () => groupBySport(dir.data?.competitions ?? [], dir.data?.entries ?? []),
    [dir.data],
  );

  if (dir.isLoading) {
    return (
      <PublicShell>
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
      <PublicShell>
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
  const hasFilters = search.trim() !== "" || Object.values(filters).some(Boolean);
  const clearFilters = (): void => {
    setSearch("");
    setFilters({});
  };

  return (
    <PublicShell tournamentName={d.tournament_name}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-primary">
              {d.tournament_name}
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
              {t("Registered institutions")}
            </h1>
            <p className="mt-1 truncate text-sm text-muted-foreground" title={d.form_title}>
              {d.form_title}
            </p>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-2.5">
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

        {/* View toggle — competitions, the breakdown, the list, or both. */}
        {stats.length > 0 || sportGroups.length > 0 ? (
          <div
            className="inline-flex w-fit rounded-lg border border-border bg-muted/50 p-0.5 text-sm"
            role="tablist"
            aria-label={t("View")}
          >
            {(
              [
                ["both", t("Both")],
                ["competitions", t("Competitions")],
                ["stats", t("Breakdown")],
                ["table", t("Directory")],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
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
        ) : null}

        {/* Entries by competition — the sport → category structural view. */}
        {(view === "both" || view === "competitions") && sportGroups.length > 0 ? (
          <CompetitionsSection groups={sportGroups} />
        ) : null}

        {/* Dynamic stats — one distribution card per form dimension. */}
        {(view === "both" || view === "stats") && stats.length > 0 ? (
          <section aria-label={t("Registration breakdown")}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {stats.map((s) => (
                <DimensionCard key={s.key} stat={s} />
              ))}
            </div>
          </section>
        ) : null}

        {view === "both" || view === "table" ? (
          <>
        {/* Filters */}
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
          <label className="relative min-w-[12rem] flex-1 sm:max-w-sm">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("Search by name or region…")}
              className="h-9 pl-9"
              aria-label={t("Search")}
            />
          </label>
          {d.filters.map((f) => (
            <label key={f.key} className="flex w-44 min-w-0 flex-col gap-1">
              <span
                className="truncate text-[0.6875rem] font-medium text-muted-foreground"
                title={f.label}
              >
                {f.label}
              </span>
              <Select
                size="sm"
                value={filters[f.key] ?? ""}
                onChange={(v) => setFilters((s) => ({ ...s, [f.key]: v }))}
                options={[{ value: "", label: t("All") }, ...f.options]}
                aria-label={f.label}
              />
            </label>
          ))}
          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="h-9 shrink-0"
            >
              <X aria-hidden="true" className="h-4 w-4" />
              {t("Clear")}
            </Button>
          ) : null}
        </div>

        {/* Results */}
        {hasFilters ? (
          <p className="-mb-2 font-tabular text-xs text-muted-foreground">
            {entries.length === total
              ? `${total} ${t("shown")}`
              : `${entries.length} ${t("of")} ${total} ${t("shown")}`}
          </p>
        ) : null}

        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card py-14 text-center">
            <Building2
              aria-hidden="true"
              className="h-8 w-8 text-muted-foreground/40"
            />
            <p className="text-sm text-muted-foreground">
              {hasFilters
                ? t("No institutions match your filters.")
                : t("No institutions have registered yet.")}
            </p>
          </div>
        ) : (
          <div className="max-h-[34rem] overflow-auto rounded-xl border border-border bg-card shadow-sm">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                  <th className="sticky left-0 top-0 z-30 border-b border-border bg-muted px-4 py-2.5 font-medium">
                    {t("Institution")}
                  </th>
                  <th className="sticky top-0 z-20 border-b border-border bg-muted px-3 py-2.5 font-medium">
                    {t("Type")}
                  </th>
                  <th className="sticky top-0 z-20 border-b border-border bg-muted px-3 py-2.5 font-medium">
                    {t("Region")}
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
                    <td className="border-b border-border px-3 py-2.5 align-top capitalize text-muted-foreground group-hover:bg-accent/40">
                      {t(e.kind)}
                    </td>
                    <td className="border-b border-border px-3 py-2.5 align-top text-muted-foreground group-hover:bg-accent/40">
                      {e.region || "—"}
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
    </PublicShell>
  );
}
