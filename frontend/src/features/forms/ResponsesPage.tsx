import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Clock,
  Copy,
  Download,
  MoreVertical,
  Send,
  X,
} from "lucide-react";
import { formsApi } from "@/api/forms";
import type {
  Field,
  FormResponseRow,
  FormSchema,
  FormSummary,
  ResponseStatus,
} from "./types";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { flipPlacement } from "@/lib/popover";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Status -> pill styling (tokens only; mirrors the FormsListPage badge idiom). */
function statusPill(status: ResponseStatus): { label: string; cls: string } {
  const m: Record<ResponseStatus, { label: string; cls: string }> = {
    submitted: { label: "Submitted", cls: "bg-muted text-muted-foreground" },
    accepted: { label: "Accepted", cls: "bg-primary/15 text-primary" },
    rejected: { label: "Rejected", cls: "bg-destructive/15 text-destructive" },
    waitlisted: {
      label: "Waitlisted",
      cls: "bg-secondary text-secondary-foreground",
    },
  };
  return m[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
}

function StatusPill({
  status,
}: {
  status: ResponseStatus;
}): React.ReactElement {
  const pill = statusPill(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
        pill.cls,
      )}
    >
      {t(pill.label)}
    </span>
  );
}

/** Render a (possibly array / object) answer value as readable text. */
function formatAnswer(value: unknown): string {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? t("Yes") : t("No");
  return String(value);
}

/** Format an ISO timestamp for display in the responses table. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Status filter tabs (the `all` pseudo-status fronts the real four). */
type StatusFilter = "all" | ResponseStatus;

const FILTER_TABS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "submitted", label: "Submitted" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "waitlisted", label: "Waitlisted" },
];

const STATUS_ACTIONS: {
  status: ResponseStatus;
  label: string;
  Icon: typeof Check;
}[] = [
  { status: "accepted", label: "Accept", Icon: Check },
  { status: "rejected", label: "Reject", Icon: X },
  { status: "waitlisted", label: "Waitlist", Icon: Clock },
];

/**
 * Map field keys -> human labels from the form schema (for the detail view),
 * skipping `section_text` (which carries no answer). Walks nested `group`
 * children too so repeating-subform fields resolve to a label.
 */
function buildLabelMap(schema: FormSchema | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!schema) return map;
  const walk = (fields: Field[]): void => {
    for (const f of fields) {
      if (f.type === "section_text") continue;
      map[f.key] = f.label || f.key;
      if (f.fields) walk(f.fields);
    }
  };
  for (const sec of schema.sections) walk(sec.fields);
  return map;
}

/** Read a DRF `{ detail }` off an ApiError, with a fallback. */
function errorDetail(e: unknown, fallback: string): string {
  return e instanceof ApiError ? (e.payload.detail ?? fallback) : fallback;
}

// --- Status action buttons (shared by table rows + mobile cards) ------------

function RowStatusActions({
  formId,
  row,
}: {
  formId: string;
  row: FormResponseRow;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
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
      // Flip above the trigger near the bottom of the viewport (~34px/item).
      const { top, bottom } = flipPlacement(r, STATUS_ACTIONS.length * 34 + 10, 4);
      setPos({ top, bottom, right: window.innerWidth - r.right });
    }
    setMenuOpen(true);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (
        !wrapRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    // Menu is portaled with fixed position — close on scroll/resize so it can't
    // drift away from its row.
    const close = (): void => setMenuOpen(false);
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
  }, [menuOpen]);

  const setStatus = useMutation({
    mutationFn: (status: ResponseStatus) =>
      formsApi.setResponseStatus(formId, row.id, status),
    onMutate: async (status: ResponseStatus) => {
      await qc.cancelQueries({ queryKey: ["form-responses", formId] });
      const prev = qc.getQueryData<FormResponseRow[]>([
        "form-responses",
        formId,
      ]);
      qc.setQueryData<FormResponseRow[]>(["form-responses", formId], (cur) =>
        (cur ?? []).map((r) => (r.id === row.id ? { ...r, status } : r)),
      );
      return { prev };
    },
    onError: (e, _status, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(["form-responses", formId], ctx.prev);
      }
      toast.push({
        kind: "error",
        title: t("Could not update status"),
        description: errorDetail(e, t("Please try again.")),
      });
    },
    onSuccess: (_data, status) => {
      const pill = statusPill(status);
      toast.push({ kind: "success", title: t(`Marked ${pill.label}`) });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["form-responses", formId] });
    },
  });

  return (
    <span ref={wrapRef} className="inline-block text-left">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t("Change status")}
        disabled={setStatus.isPending}
        onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
      >
        <MoreVertical aria-hidden="true" className="h-4 w-4" />
      </Button>
      {menuOpen && pos
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
              {STATUS_ACTIONS.map(({ status, label, Icon }) => {
                const active = row.status === status;
                return (
                  <button
                    key={status}
                    type="button"
                    role="menuitem"
                    disabled={active}
                    onClick={() => {
                      setMenuOpen(false);
                      setStatus.mutate(status);
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
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

// --- Response detail dialog -------------------------------------------------

function ResponseDetailDialog({
  formId,
  row,
  labels,
  onClose,
}: {
  formId: string;
  row: FormResponseRow | null;
  labels: Record<string, string>;
  onClose: () => void;
}): React.ReactElement | null {
  if (!row) return null;
  // Show every answered key; prefer a schema label, fall back to the raw key.
  const entries = Object.entries(row.answers);

  return (
    <Dialog
      open={row !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      ariaLabel={t("Response details")}
    >
      <DialogHeader>
        <DialogTitle>{row.title || t("Response")}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <StatusPill status={row.status} />
          {row.respondent_email ? (
            <span className="text-muted-foreground">{row.respondent_email}</span>
          ) : null}
          {row.respondent_phone ? (
            <span className="font-tabular text-muted-foreground">
              {row.respondent_phone}
            </span>
          ) : null}
        </div>
        <dl className="flex max-h-[50vh] flex-col gap-3 overflow-auto pr-1">
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("No answers recorded.")}
            </p>
          ) : (
            entries.map(([key, value]) => (
              <div key={key} className="flex flex-col gap-0.5">
                <dt className="text-xs font-medium text-muted-foreground">
                  {labels[key] ?? key}
                </dt>
                <dd className="text-sm">{formatAnswer(value)}</dd>
              </div>
            ))
          )}
        </dl>
        <div className="border-t border-border pt-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {t("Update status")}
          </p>
          <RowStatusActions formId={formId} row={row} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t("Close")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// --- Send Stage-2 dialog ----------------------------------------------------

function SendStage2Dialog({
  formId,
  tournamentId,
  open,
  onOpenChange,
}: {
  formId: string;
  tournamentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const toast = useToast();
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<{
    sent: number;
    links: { response_id: string; email: string; path: string }[];
  } | null>(null);

  // Stage-2 targets are this tournament's team_registration forms.
  const formsQuery = useQuery({
    queryKey: ["forms", tournamentId],
    queryFn: () => formsApi.list(tournamentId),
    enabled: open,
  });
  const targets = useMemo(
    () =>
      (formsQuery.data ?? []).filter(
        (f) => f.purpose === "team_registration" && f.id !== formId,
      ),
    [formsQuery.data, formId],
  );

  const send = useMutation({
    mutationFn: () => formsApi.sendStage2(formId, target),
    onSuccess: (data) => {
      setResult(data);
      toast.push({
        kind: "success",
        title: t(`Generated ${data.sent} Stage-2 link(s)`),
      });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not send Stage-2 links"),
        description: errorDetail(e, t("Please try again.")),
      }),
  });

  const copyPath = async (path: string): Promise<void> => {
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.push({ kind: "success", title: t("Link copied") });
    } catch {
      toast.push({ kind: "error", title: t("Could not copy"), description: url });
    }
  };

  const close = (): void => {
    setResult(null);
    setTarget("");
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      ariaLabel={t("Send Stage-2 links")}
    >
      <DialogHeader>
        <DialogTitle>{t("Send Stage-2 registration links")}</DialogTitle>
      </DialogHeader>

      {result ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {t(
              "Generated links for accepted respondents. Copy and share each one.",
            )}
          </p>
          {result.links.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("No accepted respondents yet — accept some responses first.")}
            </p>
          ) : (
            <ul className="flex max-h-[40vh] flex-col gap-2 overflow-auto pr-1">
              {result.links.map((l) => (
                <li
                  key={l.response_id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{l.email}</p>
                    <p className="truncate font-tabular text-xs text-muted-foreground">
                      {l.path}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copyPath(l.path)}
                  >
                    <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                    {t("Copy")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {t(
              "Pick the team-registration form to invite accepted respondents to. One single-use link is minted per accepted response.",
            )}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="stage2-target">{t("Target form")}</Label>
            <Select
              id="stage2-target"
              value={target}
              placeholder={
                formsQuery.isLoading
                  ? t("Loading forms…")
                  : t("Select a team-registration form")
              }
              options={targets.map((f: FormSummary) => ({
                value: f.id,
                label: f.title || t("Untitled form"),
              }))}
              onChange={setTarget}
              disabled={formsQuery.isLoading}
            />
            {!formsQuery.isLoading && targets.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("No team-registration forms exist in this tournament yet.")}
              </p>
            ) : null}
          </div>
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={close}>
          {result ? t("Done") : t("Cancel")}
        </Button>
        {result ? null : (
          <Button
            disabled={!target || send.isPending}
            onClick={() => send.mutate()}
          >
            <Send aria-hidden="true" className="h-4 w-4" />
            {send.isPending ? t("Sending…") : t("Send links")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

// --- Page -------------------------------------------------------------------

/**
 * Organizer responses dashboard for a single registration form (Increment 8).
 *
 * Lists submissions as a desktop table / mobile stacked cards, supports status
 * review (Accept / Reject / Waitlist) with optimistic updates, a per-response
 * detail dialog keyed by schema labels, CSV export, status filter tabs, and a
 * Stage-2 link-send dialog. Route: `/tournaments/:id/forms/:formId/responses`.
 */
export function ResponsesPage(): React.ReactElement {
  const { id = "", formId = "" } = useParams();
  const { isMobile } = useBreakpoint();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [detail, setDetail] = useState<FormResponseRow | null>(null);
  const [stage2Open, setStage2Open] = useState(false);

  const responsesQuery = useQuery({
    queryKey: ["form-responses", formId],
    queryFn: () => formsApi.responses(formId),
  });
  const formQuery = useQuery({
    queryKey: ["form", formId],
    queryFn: () => formsApi.get(formId),
  });

  const labels = useMemo(
    () => buildLabelMap(formQuery.data?.schema),
    [formQuery.data?.schema],
  );

  const rows = useMemo(() => {
    const all = responsesQuery.data ?? [];
    return filter === "all" ? all : all.filter((r) => r.status === filter);
  }, [responsesQuery.data, filter]);

  const total = responsesQuery.data?.length ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <Link
            to={routes.tournamentFormBuilder(id, formId)}
            className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          >
            {t("← Back to form")}
          </Link>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight sm:text-3xl">
            {formQuery.data?.title || t("Responses")}
          </h1>
          <p className="mt-1 font-tabular text-sm text-muted-foreground">
            {total} {total === 1 ? t("response") : t("responses")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => window.open(formsApi.csvUrl(formId))}
          >
            <Download aria-hidden="true" className="h-4 w-4" />
            {t("Export CSV")}
          </Button>
          <Button onClick={() => setStage2Open(true)}>
            <Send aria-hidden="true" className="h-4 w-4" />
            {t("Send Stage-2 links")}
          </Button>
        </div>
      </div>

      {/* Status filter tabs */}
      <div
        role="tablist"
        aria-label={t("Filter by status")}
        className="flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1"
      >
        {FILTER_TABS.map((tab) => {
          const active = filter === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(tab.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {t(tab.label)}
            </button>
          );
        })}
      </div>

      {/* Body */}
      {responsesQuery.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-xl border border-border bg-card"
            />
          ))}
        </div>
      ) : responsesQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load responses.")}
        </p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {filter === "all"
              ? t("No responses yet.")
              : t("No responses match this filter.")}
          </p>
        </div>
      ) : isMobile ? (
        /* Mobile: stacked cards */
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm"
            >
              <button
                type="button"
                onClick={() => setDetail(row)}
                className="flex items-start justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {row.title || t("Untitled")}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {row.respondent_email || "—"}
                  </p>
                  {row.respondent_phone ? (
                    <p className="font-tabular text-sm text-muted-foreground">
                      {row.respondent_phone}
                    </p>
                  ) : null}
                  <p className="mt-1 font-tabular text-xs text-muted-foreground">
                    {formatTimestamp(row.created_at)}
                  </p>
                </div>
                <StatusPill status={row.status} />
              </button>
              <RowStatusActions formId={formId} row={row} />
            </li>
          ))}
        </ul>
      ) : (
        /* Desktop: table */
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-3">
                  {t("Respondent")}
                </th>
                <th scope="col" className="px-4 py-3">
                  {t("Email")}
                </th>
                <th scope="col" className="px-4 py-3">
                  {t("Phone")}
                </th>
                <th scope="col" className="px-4 py-3">
                  {t("Status")}
                </th>
                <th scope="col" className="px-4 py-3">
                  {t("Submitted")}
                </th>
                <th scope="col" className="px-4 py-3 text-right">
                  {t("Actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border last:border-0 hover:bg-muted/40"
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setDetail(row)}
                      className="inline-flex items-center gap-1 font-medium hover:text-primary focus-visible:underline focus-visible:outline-none"
                    >
                      <span className="max-w-[14rem] truncate">
                        {row.title || t("Untitled")}
                      </span>
                      <ChevronRight
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 opacity-60"
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {row.respondent_email || "—"}
                  </td>
                  <td className="px-4 py-3 font-tabular text-muted-foreground">
                    {row.respondent_phone || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={row.status} />
                  </td>
                  <td className="px-4 py-3 font-tabular text-muted-foreground">
                    {formatTimestamp(row.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <RowStatusActions formId={formId} row={row} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ResponseDetailDialog
        formId={formId}
        row={detail}
        labels={labels}
        onClose={() => setDetail(null)}
      />
      <SendStage2Dialog
        formId={formId}
        tournamentId={id}
        open={stage2Open}
        onOpenChange={setStage2Open}
      />
    </div>
  );
}
