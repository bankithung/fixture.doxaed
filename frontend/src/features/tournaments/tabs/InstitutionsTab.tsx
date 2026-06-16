import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Building2,
  Check,
  Download,
  ExternalLink,
  Eye,
  Link2,
  MoreVertical,
  Pencil,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { institutionsApi, type Institution } from "@/api/institutions";
import { formsApi } from "@/api/forms";
import { tournamentsApi } from "@/api/tournaments";
import type { Field } from "@/features/forms/types";
import {
  buildCompTree,
  FilterPanel,
  matchesCompPrefix,
} from "@/features/forms/FilterPanel";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { flipPlacement } from "@/lib/popover";
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

  // Table COLUMNS come from every form field (as before); the rail's
  // per-question FILTERS exclude the sport/category chain questions (same
  // exclusion the public directory applies) — the competition tree covers
  // those without a dropdown per sub-category.
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
  const chainKeys = useMemo(() => {
    const settings = (orgForm?.settings ?? {}) as {
      category_fields?: Record<string, string>;
      category_fields_all?: Record<string, string[]>;
      sports_field?: string;
    };
    return new Set<string>([
      ...Object.values(settings.category_fields ?? {}),
      ...Object.values(settings.category_fields_all ?? {}).flat(),
      ...(settings.sports_field ? [settings.sports_field] : []),
    ]);
  }, [orgForm]);
  const choiceFields = fieldDefs.filter(
    (f) => CHOICE.has(f.type) && !chainKeys.has(f.key) && f.directory !== false,
  );

  const items = list.data ?? [];
  const isOpen = orgForm?.status === "open";

  // Hierarchical competition tree (same as the public directory's rail) —
  // built from the registered institutions' labelled leaves; counts = entries
  // per node. Selecting "Sepak Takraw" matches everything under it.
  const compTree = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const i of items) {
      for (const c of i.competitions ?? []) {
        const cur = counts.get(c.leaf_key);
        if (cur) cur.count += 1;
        else counts.set(c.leaf_key, { label: c.label, count: 1 });
      }
    }
    return buildCompTree(
      [...counts.entries()]
        .map(([leaf_key, v]) => ({ leaf_key, label: v.label, count: v.count }))
        .sort((a, b) => a.leaf_key.localeCompare(b.leaf_key)),
    );
  }, [items]);
  const [compSel, setCompSel] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

  const q = search.trim().toLowerCase();
  const filteredItems = items.filter((i) => {
    if (q && !i.name.toLowerCase().includes(q) && !(i.region ?? "").toLowerCase().includes(q))
      return false;
    if (
      compSel.size > 0 &&
      ![...compSel].some((p) => matchesCompPrefix(i.competitions ?? [], p))
    )
      return false;
    return Object.entries(filters).every(([k, val]) => {
      if (!val) return true;
      const ev = i.answers[k];
      return Array.isArray(ev) ? ev.map(String).includes(val) : String(ev ?? "") === val;
    });
  });
  const hasActiveFilters =
    q !== "" || compSel.size > 0 || Object.values(filters).some(Boolean);
  const clearFilters = (): void => {
    setFilters({});
    setCompSel(new Set());
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
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs font-medium">
              {isOpen ? (
                <a href={directoryUrl} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-primary hover:underline">
                  <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("View public directory")}
                  <ExternalLink aria-hidden="true" className="h-3 w-3" />
                </a>
              ) : null}
              <button type="button"
                onClick={() => navigate(routes.tournamentFormResponses(id, orgForm.id))}
                className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline">
                {t("Review raw submissions")}
                <ExternalLink aria-hidden="true" className="h-3 w-3" />
              </button>
              {orgForm.response_count > 0 ? (
                <a href={formsApi.csvUrl(orgForm.id)} download
                  className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline">
                  <Download aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Export CSV")}
                </a>
              ) : null}
            </div>
          </div>
        )
      ) : null}

      {/* Registered institutions — flexible table driven by the form's fields,
          with the directory-style filter rail on the side (right on desktop,
          above the table on mobile). */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{t("Registered institutions")}</h3>
          <span className="font-tabular text-xs text-muted-foreground">
            {filteredItems.length === items.length ? items.length : `${filteredItems.length}/${items.length}`}
          </span>
        </div>

        <div className="flex flex-col gap-4 lg:flex-row lg:gap-6">
          {items.length > 0 ? (
            <aside
              aria-label={t("Filters")}
              className="w-full shrink-0 lg:order-last lg:w-72"
            >
              <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold">{t("Filters")}</h4>
                  {hasActiveFilters ? (
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
                  filters={choiceFields.map((f) => ({
                    key: f.key,
                    label: f.label,
                    options: (f.options ?? []).map((o) => ({
                      value: String(o.value),
                      label: o.label,
                    })),
                  }))}
                  values={filters}
                  onValue={(key, v) => setFilters((s) => ({ ...s, [key]: v }))}
                />
              </div>
            </aside>
          ) : null}

          <div className="flex min-w-0 flex-1 flex-col gap-3">
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
              <InstitutionTable
                items={filteredItems}
                fields={fieldDefs}
                tournamentId={id}
                canManage={canManage}
              />
            )}
          </div>
        </div>
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

const REVIEW_ACTIONS: { status: string; label: string; Icon: typeof Check }[] = [
  { status: "registered", label: "Approve", Icon: Check },
  { status: "rejected", label: "Reject", Icon: X },
  { status: "withdrawn", label: "Withdraw", Icon: Archive },
];

/**
 * Per-institution review menu (three-dots). Sets the institution status
 * (Approve / Reject / Withdraw) — the institution-stage equivalent of the
 * generic form Responses inbox. Portaled to body so the table's overflow can't
 * clip it; optimistic so the pill flips instantly.
 */
function ReviewMenu({
  tournamentId,
  inst,
}: {
  tournamentId: string;
  inst: Institution;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
  } | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const openMenu = (): void => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) {
      // Flip above the trigger near the bottom of the viewport (~34px/item;
      // +1 row for Delete).
      const { top, bottom } = flipPlacement(r, (REVIEW_ACTIONS.length + 1) * 34 + 10, 4);
      setPos({ top, bottom, right: window.innerWidth - r.right });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const tgt = e.target as Node;
      if (!wrapRef.current?.contains(tgt) && !menuRef.current?.contains(tgt)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const close = (): void => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const review = useMutation({
    mutationFn: (status: string) =>
      institutionsApi.update(tournamentId, inst.id, { status }),
    onMutate: async (status: string) => {
      await qc.cancelQueries({ queryKey: ["t-institutions", tournamentId] });
      const prev = qc.getQueryData<Institution[]>(["t-institutions", tournamentId]);
      qc.setQueryData<Institution[]>(["t-institutions", tournamentId], (cur) =>
        (cur ?? []).map((r) => (r.id === inst.id ? { ...r, status } : r)),
      );
      return { prev };
    },
    onError: (e, _status, ctx) => {
      if (ctx?.prev) qc.setQueryData(["t-institutions", tournamentId], ctx.prev);
      toast.push({
        kind: "error",
        title: t("Could not update status"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      });
    },
    onSuccess: () => toast.push({ kind: "success", title: t("Status updated") }),
    onSettled: () =>
      qc.invalidateQueries({ queryKey: ["t-institutions", tournamentId] }),
  });

  const remove = useMutation({
    mutationFn: () => institutionsApi.remove(tournamentId, inst.id),
    onSuccess: () => {
      setConfirmOpen(false);
      qc.invalidateQueries({ queryKey: ["t-institutions", tournamentId] });
      toast.push({ kind: "success", title: t("Application deleted") });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not delete"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  return (
    <span ref={wrapRef} className="inline-block">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(`Review ${inst.name}`)}
        disabled={review.isPending}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <MoreVertical aria-hidden="true" className="h-4 w-4" />
      </Button>
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{
                position: "fixed",
                top: pos.top,
                bottom: pos.bottom,
                right: pos.right,
              }}
              className="z-50 w-40 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
            >
              {REVIEW_ACTIONS.map(({ status, label, Icon }) => {
                const active = inst.status === status;
                return (
                  <button
                    key={status}
                    type="button"
                    role="menuitem"
                    disabled={active}
                    onClick={() => {
                      setOpen(false);
                      review.mutate(status);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                      active && "bg-accent font-medium text-foreground",
                    )}
                  >
                    <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                    {t(label)}
                    {active ? (
                      <Check aria-hidden="true" className="ml-auto h-3.5 w-3.5" />
                    ) : null}
                  </button>
                );
              })}
              {/* Delete — permanent removal (confirmed), set apart from the
                  reversible review actions above. */}
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setConfirmOpen(true);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Delete")}
              </button>
            </div>,
            document.body,
          )
        : null}
      <Dialog
        open={confirmOpen}
        onOpenChange={(o) => !remove.isPending && setConfirmOpen(o)}
        ariaLabel={t("Delete application")}
      >
        <DialogHeader>
          <DialogTitle>{t("Delete this application?")}</DialogTitle>
          <DialogDescription>
            {t(
              "This removes the institution, its teams and players, and the original submission. Reject instead if you only want to hide it from the public.",
            )}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium">{inst.name}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? t("Deleting…") : t("Delete")}
          </Button>
        </DialogFooter>
      </Dialog>
    </span>
  );
}

/** Header cell — sticky to the top of the scroll container. */
const TH =
  "sticky top-0 z-20 border-b border-border bg-muted px-3 py-2.5 text-left align-bottom font-medium";
/** Body cell — bottom border + row-hover tint (works on sticky cells too). */
const TD = "border-b border-border px-3 py-2.5 align-top group-hover:bg-accent/40";

function InstitutionTable({
  items,
  fields,
  tournamentId,
  canManage,
}: {
  items: Institution[];
  fields: Field[];
  tournamentId: string;
  canManage: boolean;
}): React.ReactElement {
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
            {canManage ? (
              <th className={cn(TH, "text-right")}>
                <span className="sr-only">{t("Actions")}</span>
              </th>
            ) : null}
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
              {canManage ? (
                <td className={cn(TD, "text-right")}>
                  <ReviewMenu tournamentId={tournamentId} inst={i} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
