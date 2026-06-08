import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Check,
  ExternalLink,
  Eye,
  Link2,
  Pencil,
  Plus,
  Search,
  Send,
  X,
} from "lucide-react";
import { institutionsApi, type Institution } from "@/api/institutions";
import { formsApi } from "@/api/forms";
import { tournamentsApi } from "@/api/tournaments";
import type { Field } from "@/features/forms/types";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { invalidateTournament } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { CreateFormDialog } from "../CreateFormDialog";
import { EmptyState } from "./shared";

const ORG_PURPOSE = "organization_registration";
const ORG_STAGE = "org_registration";
const CHOICE = new Set(["single_choice", "multi_choice", "dropdown"]);
const NAME_KEYS = new Set(["institution_name", "name", "title"]);

/** Human-readable cell: map option values to their labels; join multi-selects. */
function fmtAnswer(field: Field, val: unknown): string {
  if (val == null || val === "") return "—";
  const arr = Array.isArray(val) ? val : [val];
  if (field.options?.length) {
    const labels = new Map(field.options.map((o) => [o.value, o.label]));
    return arr.map((v) => labels.get(String(v)) ?? String(v)).join(", ");
  }
  return arr.map(String).join(", ");
}

export function InstitutionsTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");

  const forms = useQuery({ queryKey: ["forms", id], queryFn: () => formsApi.list(id) });
  const list = useQuery({ queryKey: ["t-institutions", id], queryFn: () => institutionsApi.list(id) });
  const stage = useQuery({ queryKey: ["tournament-stage", id], queryFn: () => tournamentsApi.stage(id) });
  const canManage = stage.data?.can_manage ?? false;

  const orgForm =
    (forms.data ?? []).find((f) => f.stage === ORG_STAGE) ??
    (forms.data ?? []).find((f) => f.purpose === ORG_PURPOSE);

  const publish = useMutation({
    mutationFn: () => formsApi.publish(orgForm!.id),
    onSuccess: () => {
      invalidateTournament(qc, id);
      toast.push({ kind: "success", title: t("Registration form is open") });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not open the form"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  const publicUrl = orgForm ? `${window.location.origin}/f/${orgForm.id}` : "";
  const directoryUrl = orgForm ? `${window.location.origin}/f/${orgForm.id}/directory` : "";
  const copy = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.push({ kind: "success", title: t("Link copied") });
    } catch {
      toast.push({ kind: "error", title: t("Could not copy"), description: url });
    }
  };

  // Columns + filters are derived from the registration form's own fields.
  const fieldDefs = useMemo<Field[]>(() => {
    const bindings = (orgForm?.settings as { bindings?: Record<string, string> } | undefined)?.bindings ?? {};
    const nameKey = bindings.institution_name;
    const out: Field[] = [];
    for (const s of orgForm?.schema?.sections ?? []) {
      for (const f of s.fields ?? []) {
        if (f.type === "section_text" || f.type === "group") continue;
        if (f.key === nameKey || NAME_KEYS.has(f.key)) continue; // shown as Name
        out.push(f);
      }
    }
    return out;
  }, [orgForm]);
  const choiceFields = fieldDefs.filter((f) => CHOICE.has(f.type));

  const items = list.data ?? [];
  const isOpen = orgForm?.status === "open";
  const q = search.trim().toLowerCase();
  const filteredItems = items.filter((i) => {
    if (q && !i.name.toLowerCase().includes(q) && !(i.region ?? "").toLowerCase().includes(q))
      return false;
    return Object.entries(filters).every(([k, val]) => {
      if (!val) return true;
      const ev = i.answers[k];
      return Array.isArray(ev) ? ev.map(String).includes(val) : String(ev ?? "") === val;
    });
  });
  const hasActiveFilters = q !== "" || Object.values(filters).some(Boolean);
  const clearFilters = (): void => {
    setFilters({});
    setSearch("");
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold">{t("Institution registration")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("One form to register schools — share it, or add them yourself.")}
        </p>
      </div>

      {/* Form-management card (the single registration mechanism). */}
      {canManage ? (
        !orgForm ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card py-10 text-center">
            <Building2 aria-hidden="true" className="h-8 w-8 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium">{t("Create the registration form first")}</p>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {t("Add your questions, then share the form or add schools yourself.")}
              </p>
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("Create registration form")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{orgForm.title}</span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[0.6875rem] font-medium capitalize",
                      isOpen ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {t(orgForm.status)}
                  </span>
                </div>
                <p className="mt-0.5 font-tabular text-xs text-muted-foreground">
                  {orgForm.response_count} {t("submissions")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => navigate(routes.tournamentFormBuilder(id, orgForm.id))}>
                  <Pencil aria-hidden="true" className="h-4 w-4" />
                  {t("Edit form")}
                </Button>
                {!isOpen ? (
                  <Button size="sm" onClick={() => publish.mutate()} disabled={publish.isPending}>
                    <Send aria-hidden="true" className="h-4 w-4" />
                    {t("Open registration")}
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => void copy(publicUrl)}>
                      {copied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Link2 aria-hidden="true" className="h-4 w-4" />}
                      {t("Share link")}
                    </Button>
                    <Button size="sm" onClick={() => navigate(`/f/${orgForm.id}`)}>
                      <Plus aria-hidden="true" className="h-4 w-4" />
                      {t("Add institute")}
                    </Button>
                  </>
                )}
              </div>
            </div>
            {isOpen ? (
              <a href={directoryUrl} target="_blank" rel="noreferrer"
                className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary hover:underline">
                <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                {t("View public directory")}
                <ExternalLink aria-hidden="true" className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        )
      ) : null}

      {/* Registered institutions — flexible table driven by the form's fields. */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{t("Registered institutions")}</h3>
          <span className="font-tabular text-xs text-muted-foreground">
            {filteredItems.length === items.length ? items.length : `${filteredItems.length}/${items.length}`}
          </span>
        </div>

        {/* Filters — dynamic: search + one compact Select per choice field. */}
        {items.length > 0 ? (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-muted/20 p-2.5">
            <label className="relative min-w-[11rem] flex-1 sm:max-w-xs">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder={t("Search name or region…")} className="h-9 pl-9" aria-label={t("Search")} />
            </label>
            {choiceFields.map((f) => (
              <label key={f.key} className="flex w-40 min-w-0 flex-col gap-1">
                <span className="truncate text-[0.6875rem] font-medium text-muted-foreground" title={f.label}>
                  {f.label}
                </span>
                <Select
                  size="sm"
                  value={filters[f.key] ?? ""}
                  onChange={(v) => setFilters((s) => ({ ...s, [f.key]: v }))}
                  options={[{ value: "", label: t("All") }, ...(f.options ?? [])]}
                  aria-label={f.label}
                />
              </label>
            ))}
            {hasActiveFilters ? (
              <Button size="sm" variant="ghost" className="h-9 text-muted-foreground" onClick={clearFilters}>
                <X aria-hidden="true" className="h-4 w-4" />
                {t("Clear")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {list.isLoading ? (
          <div className="h-40 animate-pulse rounded-xl border border-border bg-muted" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-8 w-8" />}
            title={t("No institutions registered yet")}
            hint={t("Share the form, or add a school yourself.")}
          />
        ) : filteredItems.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-card py-8 text-center text-sm text-muted-foreground">
            {t("No institutions match your filters.")}
          </p>
        ) : (
          <InstitutionTable items={filteredItems} fields={fieldDefs} />
        )}
      </div>

      <CreateFormDialog
        tournamentId={id}
        stage={ORG_STAGE}
        purpose={ORG_PURPOSE}
        defaultTitle={t("Institution registration")}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}

const STATUS_CLS: Record<string, string> = {
  registered: "bg-primary/15 text-primary",
  invited: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  withdrawn: "bg-muted text-muted-foreground",
  rejected: "bg-destructive/15 text-destructive",
};

function StatusPill({ status }: { status: string }): React.ReactElement {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[0.6875rem] font-medium capitalize", STATUS_CLS[status] ?? "bg-muted text-muted-foreground")}>
      {t(status)}
    </span>
  );
}

/** Header cell — sticky to the top of the scroll container. */
const TH =
  "sticky top-0 z-20 border-b border-border bg-muted px-3 py-2.5 text-left align-bottom font-medium";
/** Body cell — bottom border + row-hover tint (works on sticky cells too). */
const TD = "border-b border-border px-3 py-2.5 align-top group-hover:bg-accent/40";

function InstitutionTable({ items, fields }: { items: Institution[]; fields: Field[] }): React.ReactElement {
  return (
    <div className="max-h-[34rem] overflow-auto rounded-xl border border-border bg-card shadow-sm">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
            {/* Institution stays pinned to the left while the dynamic columns scroll. */}
            <th className={cn(TH, "sticky left-0 z-30 px-4")}>{t("Institution")}</th>
            <th className={TH}>{t("Type")}</th>
            <th className={TH}>{t("Region")}</th>
            {fields.map((f) => (
              <th key={f.key} className={TH} title={f.label}>
                <span className="block max-w-[11rem] truncate">{f.label}</span>
              </th>
            ))}
            <th className={cn(TH, "text-right")}>{t("Teams")}</th>
            <th className={TH}>{t("Status")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} className={cn("group", i.status === "withdrawn" && "opacity-60")}>
              <td
                className="sticky left-0 z-10 border-b border-border bg-card px-4 py-2.5 align-top font-medium"
                title={i.name}
              >
                <span className="block max-w-[14rem] truncate">{i.name}</span>
              </td>
              <td className={cn(TD, "capitalize text-muted-foreground")}>{t(i.kind)}</td>
              <td className={cn(TD, "text-muted-foreground")}>{i.region || "—"}</td>
              {fields.map((f) => {
                const v = fmtAnswer(f, i.answers[f.key]);
                return (
                  <td key={f.key} className={cn(TD, "text-muted-foreground")} title={v}>
                    <span className="block max-w-[12rem] truncate">{v}</span>
                  </td>
                );
              })}
              <td className={cn(TD, "text-right font-tabular")}>{i.team_count}</td>
              <td className={TD}>
                <StatusPill status={i.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
