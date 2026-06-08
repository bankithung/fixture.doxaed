import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Building2, Search } from "lucide-react";
import { formsApi, type DirectoryEntry } from "@/api/forms";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

function matches(entry: DirectoryEntry, key: string, value: string): boolean {
  if (!value) return true;
  const ev = entry.values[key];
  if (Array.isArray(ev)) return ev.map(String).includes(value);
  return String(ev ?? "") === value;
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

  if (dir.isLoading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <div className="h-40 animate-pulse rounded-xl border border-border bg-muted" />
      </div>
    );
  }
  if (dir.isError || !dir.data) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center">
        <Building2 aria-hidden="true" className="mx-auto h-10 w-10 text-muted-foreground/40" />
        <p className="mt-3 text-sm font-medium">{t("Directory not available")}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("This registration isn't open, or the link is invalid.")}
        </p>
      </div>
    );
  }

  const d = dir.data;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header>
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-primary">
          {d.tournament_name}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          {t("Registered institutions")}
        </h1>
        <p className="mt-1 font-tabular text-sm text-muted-foreground">
          {d.count} {t("registered")} · {d.form_title}
        </p>
      </header>

      {/* Filters — generated from the form's own fields. */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search by name or region…")}
            className="pl-9"
            aria-label={t("Search")}
          />
        </div>
        {d.filters.length ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {d.filters.map((f) => (
              <label key={f.key} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{f.label}</span>
                <Select
                  value={filters[f.key] ?? ""}
                  onChange={(v) => setFilters((s) => ({ ...s, [f.key]: v }))}
                  options={[
                    { value: "", label: t("All") },
                    ...f.options.map((o) => ({ value: o.value, label: o.label })),
                  ]}
                  aria-label={f.label}
                />
              </label>
            ))}
          </div>
        ) : null}
      </div>

      {/* Results */}
      {entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card py-12 text-center text-sm text-muted-foreground">
          {t("No institutions match your filters.")}
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((e, i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="font-medium">{e.name}</div>
              <div className="mt-0.5 text-xs capitalize text-muted-foreground">
                {t(e.kind)}
                {e.region ? ` · ${e.region}` : ""}
              </div>
              {Object.entries(e.values).length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {Object.values(e.values)
                    .flatMap((v) => (Array.isArray(v) ? v : [v]))
                    .filter((v) => v != null && v !== "")
                    .map((v, j) => (
                      <span
                        key={j}
                        className={cn(
                          "rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] font-medium text-muted-foreground",
                        )}
                      >
                        {String(v)}
                      </span>
                    ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
