import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  ExternalLink,
  Eye,
  LayoutTemplate,
  Lock,
  MoreVertical,
  PanelRightClose,
  PanelRightOpen,
  Save,
  Send,
  Settings2,
  Trash2,
} from "lucide-react";
import { formsApi } from "@/api/forms";
import type { FormSummary } from "./types";
import { CopyFromDialog } from "./CopyFromDialog";
import { useBuilderStore } from "./builderStore";
import { FieldPalette } from "./FieldPalette";
import { FormCanvas } from "./FormCanvas";
import { FormPreviewDialog } from "./FormPreviewDialog";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Convert an ISO timestamp to a value an `<input type="datetime-local">` accepts. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Collapsible form-level settings (title, close date, confirmation). */
function SettingsPanel({
  form,
  tournamentId,
}: {
  form: FormSummary;
  tournamentId: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(form.title);
  const [confirmation, setConfirmation] = useState(form.confirmation_message);
  const [closesAt, setClosesAt] = useState(toLocalInput(form.closes_at));
  // Instructions shown to respondents at the top of the PUBLIC form (stored on
  // the form's `description`; the institution + team forms both render it).
  const [instructions, setInstructions] = useState(form.description ?? "");
  // Public-directory headline KPIs (org-registration forms only): default =
  // total + per-game registrations; admins can reduce to the total only.
  const hasDirectory = form.purpose === "organization_registration";
  const [kpiMode, setKpiMode] = useState<string>(
    form.settings?.directory_kpis === "total" ? "total" : "games",
  );
  // Per-game headline-stat names. The sport name is the default; admins can
  // rename each one. Games come from the generated sports question's options.
  const games = useMemo<{ key: string; label: string }[]>(() => {
    const sportsField = (form.settings as { sports_field?: string } | undefined)
      ?.sports_field;
    if (!sportsField) return [];
    for (const s of form.schema?.sections ?? [])
      for (const f of s.fields ?? [])
        if (f.key === sportsField)
          return (f.options ?? []).map((o) => ({
            key: String(o.value),
            label: o.label,
          }));
    return [];
  }, [form]);
  const [kpiLabels, setKpiLabels] = useState<Record<string, string>>(
    () => (form.settings?.kpi_labels as Record<string, string>) ?? {},
  );
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const cleanedKpis = Object.fromEntries(
        Object.entries(kpiLabels)
          .map(([k, v]) => [k, v.trim()] as const)
          .filter(([, v]) => v !== ""),
      );
      return formsApi.update(form.id, {
        title: title.trim(),
        description: instructions,
        confirmation_message: confirmation,
        closes_at: closesAt ? new Date(closesAt).toISOString() : null,
        ...(hasDirectory
          ? {
              settings: {
                ...(form.settings ?? {}),
                directory_kpis: kpiMode,
                kpi_labels: cleanedKpis,
              },
            }
          : {}),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["form", form.id] });
      qc.invalidateQueries({ queryKey: ["forms", tournamentId] });
      setSavedAt(Date.now());
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not save settings"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  // Autosave (debounced) so settings persist the way the schema does — relying
  // on a manual button left edits (instructions, KPI names) silently unsaved.
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!dirtyRef.current) {
      dirtyRef.current = true; // skip the initial hydrate-from-form render
      return;
    }
    const handle = setTimeout(() => save.mutate(), 800);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, confirmation, closesAt, instructions, kpiMode, kpiLabels]);

  return (
    <section
      aria-label={t("Form settings")}
      className="rounded-xl border border-border bg-card shadow-sm"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-xl px-5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Settings2 aria-hidden="true" className="h-4 w-4 text-primary" />
        <h2 className="flex-1 text-sm font-semibold">{t("Form settings")}</h2>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div className="flex flex-col gap-4 border-t border-border p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="form-title">{t("Title")}</Label>
              <Input
                id="form-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="form-closes">{t("Closes at")}</Label>
              <Input
                id="form-closes"
                type="datetime-local"
                value={closesAt}
                onChange={(e) => setClosesAt(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="form-instructions">{t("Instructions")}</Label>
            <textarea
              id="form-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
              placeholder={t(
                "Shown at the top of the public form — e.g. who can register, documents to keep ready, the deadline.",
              )}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            <p className="text-xs text-muted-foreground">
              {t("Respondents read this before they start filling the form.")}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="form-confirm">{t("Confirmation message")}</Label>
            <Input
              id="form-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={t("Shown to respondents after they submit")}
            />
          </div>
          {hasDirectory ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="form-kpis">{t("Directory headline stats")}</Label>
              <Select
                id="form-kpis"
                value={kpiMode}
                onChange={setKpiMode}
                aria-label={t("Directory headline stats")}
                options={[
                  {
                    value: "games",
                    label: t("Total + registrations per game (default)"),
                  },
                  { value: "total", label: t("Total registrations only") },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                {t("What the public directory shows at the top of the page.")}
              </p>
              {kpiMode === "games" && games.length > 0 ? (
                <div className="mt-1 flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("Stat names (leave blank to use the game's name)")}
                  </p>
                  {games.map((g) => (
                    <div key={g.key} className="flex items-center gap-2">
                      <span
                        className="w-28 shrink-0 truncate text-xs text-muted-foreground"
                        title={g.label}
                      >
                        {g.label}
                      </span>
                      <Input
                        value={kpiLabels[g.key] ?? ""}
                        onChange={(e) =>
                          setKpiLabels((s) => ({ ...s, [g.key]: e.target.value }))
                        }
                        placeholder={t("Custom name (optional)")}
                        aria-label={t(`Stat name for ${g.label}`)}
                        className="h-8"
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? t("Saving…") : t("Save settings")}
            </Button>
            {savedAt && !save.isPending ? (
              <span className="inline-flex items-center gap-1 text-xs text-primary">
                <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Saved")}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                {t("Changes save automatically.")}
              </span>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Builder route container. Loads the form, hydrates the Zustand store, and
 * lays out a Google-Forms-style canvas (inline-editable question cards) beside
 * a collapsible "Add a field" palette. Schema edits debounce-autosave; header
 * actions cover Save / Publish / Close. Route: `/tournaments/:id/forms/:formId/edit`.
 */
export function FormBuilderPage(): React.ReactElement {
  const { id = "", formId = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();

  const schema = useBuilderStore((s) => s.schema);
  const load = useBuilderStore((s) => s.load);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  const query = useQuery({
    queryKey: ["form", formId],
    queryFn: () => formsApi.get(formId),
  });

  const loadedId = useRef<string | null>(null);
  useEffect(() => {
    if (query.data && loadedId.current !== query.data.id) {
      loadedId.current = query.data.id;
      load(query.data.schema);
    }
  }, [query.data, load]);

  const [savedAt, setSavedAt] = useState<number | null>(null);
  const saveSchema = useMutation({
    mutationFn: () => formsApi.update(formId, { schema }),
    onSuccess: () => {
      setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ["form", formId] });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not save"),
        description:
          e instanceof ApiError
            ? (e.payload.detail ?? "")
            : t("Check your connection and try again."),
      }),
  });

  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!loadedId.current) return;
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      return;
    }
    const handle = setTimeout(() => saveSchema.mutate(), 1200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  const publish = useMutation({
    mutationFn: () => formsApi.publish(formId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["form", formId] });
      qc.invalidateQueries({ queryKey: ["forms", id] });
      toast.push({ kind: "success", title: t("Form published") });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not publish"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  const close = useMutation({
    mutationFn: () => formsApi.close(formId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["form", formId] });
      qc.invalidateQueries({ queryKey: ["forms", id] });
      toast.push({ kind: "success", title: t("Form closed") });
    },
  });

  // Generated form whose sports/categories changed since generation: offer
  // the rebuild right here (previously only the Sports page's Continue did
  // it — a stale published form had no refresh path from the builder).
  const regenerate = useMutation({
    mutationFn: () => formsApi.regenerate(formId),
    onSuccess: (fresh) => {
      qc.invalidateQueries({ queryKey: ["form", formId] });
      qc.invalidateQueries({ queryKey: ["forms", id] });
      load(fresh.schema);
      toast.push({
        kind: "success",
        title: t("Form rebuilt from the current categories"),
      });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not rebuild the form"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Overflow (⋯) menu hosting the destructive action (W2-E).
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent): void => {
      if (
        moreRef.current &&
        e.target instanceof Node &&
        !moreRef.current.contains(e.target)
      ) {
        setMoreOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);
  const remove = useMutation({
    mutationFn: () => formsApi.remove(formId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["forms", id] });
      toast.push({ kind: "success", title: t("Form deleted") });
      navigate(routes.tournamentForms(id));
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not delete the form"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      }),
  });

  if (query.isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="h-10 w-64 animate-pulse rounded-lg bg-card" />
        <div className="h-96 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load this form.")}
        </p>
        <Link to={routes.tournamentForms(id)} className="text-sm text-primary hover:underline">
          {t("← Back to forms")}
        </Link>
      </div>
    );
  }

  const form = query.data;
  const status = form.status;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header — compact. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <Link
            to={routes.tournamentForms(id)}
            className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          >
            {t("← Back to forms")}
          </Link>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">
              {form.title || t("Untitled form")}
            </h1>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
              {t(status)}
            </span>
            {saveSchema.isPending ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t("Saving…")}
              </span>
            ) : savedAt ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                {t("All changes saved")}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setCopyOpen(true)}>
            <LayoutTemplate aria-hidden="true" className="h-4 w-4" />
            {t("Templates")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={saveSchema.isPending}
            onClick={() => saveSchema.mutate()}
          >
            <Save aria-hidden="true" className="h-4 w-4" />
            {t("Save")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPreviewOpen(true)}
          >
            <Eye aria-hidden="true" className="h-4 w-4" />
            {t("Preview")}
          </Button>
          <Link to={routes.tournamentFormResponses(id, formId)}>
            <Button variant="outline" size="sm">
              <ClipboardList aria-hidden="true" className="h-4 w-4" />
              {t("Responses")}
            </Button>
          </Link>
          {status === "draft" || status === "closed" ? (
            <Button size="sm" disabled={publish.isPending} onClick={() => publish.mutate()}>
              <Send aria-hidden="true" className="h-4 w-4" />
              {t("Publish")}
            </Button>
          ) : (
            <>
              {/* Published → jump straight into the real public form (W2-E). */}
              <a href={`/f/${form.id}`} target="_blank" rel="noreferrer">
                <Button size="sm">
                  <ExternalLink aria-hidden="true" className="h-4 w-4" />
                  {t("View live form")}
                </Button>
              </a>
              <Button
                variant="outline"
                size="sm"
                disabled={close.isPending}
                onClick={() => close.mutate()}
              >
                <Lock aria-hidden="true" className="h-4 w-4" />
                {t("Close")}
              </Button>
            </>
          )}
          {/* Destructive action lives behind the overflow menu so it can't be
              mis-clicked next to Publish (W2-E), still one confirm away. */}
          <div ref={moreRef} className="relative">
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("More actions")}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((o) => !o)}
            >
              <MoreVertical aria-hidden="true" className="h-4 w-4" />
            </Button>
            {moreOpen ? (
              <div
                role="menu"
                aria-label={t("More actions")}
                className="absolute right-0 z-30 mt-1 w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
              >
                <button
                  role="menuitem"
                  type="button"
                  data-testid="builder-delete-form"
                  onClick={() => {
                    setMoreOpen(false);
                    setConfirmDelete(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10 focus-visible:outline-none"
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                  {t("Delete form")}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {form.stale ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <p className="text-sm">
            {t("The sports/categories changed after this form was generated — it may be missing competitions.")}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={regenerate.isPending}
            onClick={() => regenerate.mutate()}
            data-testid="builder-regenerate"
          >
            {regenerate.isPending
              ? t("Rebuilding…")
              : t("Rebuild from current categories")}
          </Button>
        </div>
      ) : null}

      <Dialog
        open={confirmDelete}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(false);
        }}
        ariaLabel={t("Delete form")}
      >
        <DialogHeader>
          <DialogTitle>{t("Delete this form?")}</DialogTitle>
          <DialogDescription>
            {t("The form and its public link stop working immediately. Submitted responses are kept for your records.")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmDelete(false)}>
            {t("Keep form")}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
            data-testid="builder-confirm-delete"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
            {t("Delete form")}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Builder: the form column (settings + questions) capped + centered so it
          reads like a real form, beside the collapsible palette rail. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <SettingsPanel form={form} tournamentId={id} />
            <FormCanvas className="w-full" />
          </div>
        </div>

        {paletteOpen ? (
          <div className="lg:sticky lg:top-20 lg:w-72 lg:shrink-0">
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                onClick={() => setPaletteOpen(false)}
                aria-label={t("Collapse field palette")}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PanelRightClose aria-hidden="true" className="h-4 w-4" />
                {t("Hide")}
              </button>
            </div>
            <FieldPalette />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="inline-flex items-center gap-2 self-start rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium shadow-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:sticky lg:top-20"
          >
            <PanelRightOpen aria-hidden="true" className="h-4 w-4 text-primary" />
            {t("Add a field")}
          </button>
        )}
      </div>

      {previewOpen ? (
        <FormPreviewDialog
          schema={schema}
          title={form.title}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}

      <CopyFromDialog
        formId={formId}
        open={copyOpen}
        onClose={() => setCopyOpen(false)}
        onCopied={() => {
          // Force the builder store to reload from the freshly-copied schema.
          loadedId.current = null;
          qc.invalidateQueries({ queryKey: ["form", formId] });
        }}
      />
    </div>
  );
}
