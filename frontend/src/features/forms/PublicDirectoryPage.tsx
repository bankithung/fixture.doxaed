import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Building2, Search } from "lucide-react";
import { formsApi, type DirectoryEntry } from "@/api/forms";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Header cell — sticky to the top of the scroll container. */
const TH =
  "sticky top-0 z-20 border-b border-border bg-muted px-3 py-2.5 text-left align-bottom font-medium";
/** Body cell — bottom border + row-hover tint. */
const TD = "border-b border-border px-3 py-2.5 align-top group-hover:bg-accent/40";

function matches(entry: DirectoryEntry, key: string, value: string): boolean {
  if (!value) return true;
  const ev = entry.values[key];
  if (Array.isArray(ev)) return ev.map(String).includes(value);
  return String(ev ?? "") === value;
}

/** Map stored answer value(s) to their human labels; join multi-selects. */
function fmtCell(map: Map<string, string>, val: unknown): string {
  if (val == null || val === "") return "—";
  const arr = (Array.isArray(val) ? val : [val]).filter((v) => v != null && v !== "");
  if (!arr.length) return "—";
  return arr.map((v) => map.get(String(v)) ?? String(v)).join(", ");
}

export function PublicDirectoryPage(): React.ReactElement {
  const { formId = "" } = useParams();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");

  const dir = useQuery({
    queryKey: ["form-directory", formId],
    queryFn: () => formsApi.directory(formId),
    retry: false,
  });

  const entries = useMemo(() => {
    const all = dir.data?.entries ?? [];
    const q = search.trim().toLowerCase();
    return all.filter(
      (e) =>
        (!q || e.name.toLowerCase().includes(q) || (e.region ?? "").toLowerCase().includes(q)) &&
        Object.entries(filters).every(([k, v]) => matches(e, k, v)),
    );
  }, [dir.data, filters, search]);

  // Show the tournament name in the browser tab (the shared link's own preview
  // still needs server-side meta — see note in the PR).
  useEffect(() => {
    const name = dir.data?.tournament_name;
    if (name) document.title = `${name} · ${t("Registered institutions")}`;
  }, [dir.data]);

  if (dir.isLoading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="h-40 animate-pulse rounded-xl border border-border bg-muted" />
      </div>
    );
  }
  if (dir.isError || !dir.data) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-16 text-center">
        <Building2 aria-hidden="true" className="mx-auto h-10 w-10 text-muted-foreground/40" />
        <p className="mt-3 text-sm font-medium">{t("Directory not available")}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("This registration isn't open, or the link is invalid.")}
        </p>
      </div>
    );
  }

  const d = dir.data;
  // Dynamic columns + value→label maps, derived from the form's own fields.
  const columns = d.filters.map((f) => ({
    key: f.key,
    label: f.label,
    map: new Map(f.options.map((o) => [o.value, o.label])),
  }));
  const total = d.entries.length;
  const hasFilters = search.trim() !== "" || Object.values(filters).some(Boolean);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-8 sm:px-6">
      <header>
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-primary">
          {d.tournament_name}
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
          {t("Registered institutions")}
        </h1>
        <p className="mt-1 font-tabular text-sm text-muted-foreground">
          {d.count} {t("registered")} · {d.form_title}
        </p>
      </header>

      {/* Filters — dynamic: search + one compact Select per choice field. */}
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
            <span className="truncate text-[0.6875rem] font-medium text-muted-foreground" title={f.label}>
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
      </div>

      {/* Results — a proper, horizontally scrollable table (Institution pinned). */}
      {entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card py-12 text-center text-sm text-muted-foreground">
          {hasFilters
            ? t("No institutions match your filters.")
            : t("No institutions have registered yet.")}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {hasFilters ? (
            <p className="font-tabular text-xs text-muted-foreground">
              {entries.length === total ? total : `${entries.length}/${total}`} {t("shown")}
            </p>
          ) : null}
          <div className="max-h-[34rem] overflow-auto rounded-xl border border-border bg-card shadow-sm">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                  <th className={cn(TH, "sticky left-0 z-30 px-4")}>{t("Institution")}</th>
                  <th className={TH}>{t("Type")}</th>
                  <th className={TH}>{t("Region")}</th>
                  {columns.map((c) => (
                    <th key={c.key} className={TH} title={c.label}>
                      <span className="block max-w-[12rem] truncate">{c.label}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i} className="group">
                    <td
                      className="sticky left-0 z-10 border-b border-border bg-card px-4 py-2.5 align-top font-medium"
                      title={e.name}
                    >
                      <span className="block max-w-[14rem] truncate">{e.name}</span>
                    </td>
                    <td className={cn(TD, "capitalize text-muted-foreground")}>{t(e.kind)}</td>
                    <td className={cn(TD, "text-muted-foreground")}>{e.region || "—"}</td>
                    {columns.map((c) => {
                      const v = fmtCell(c.map, e.values[c.key]);
                      return (
                        <td key={c.key} className={cn(TD, "text-muted-foreground")} title={v}>
                          <span className="block max-w-[14rem] truncate">{v}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
