import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Eye,
  LayoutTemplate,
  Lock,
  PanelRightClose,
  PanelRightOpen,
  Save,
  Send,
  Settings2,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

  const save = useMutation({
    mutationFn: () =>
      formsApi.update(form.id, {
        title: title.trim(),
        confirmation_message: confirmation,
        closes_at: closesAt ? new Date(closesAt).toISOString() : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["form", form.id] });
      qc.invalidateQueries({ queryKey: ["forms", tournamentId] });
      toast.push({ kind: "success", title: t("Settings saved") });
    },
  });

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
            <Label htmlFor="form-confirm">{t("Confirmation message")}</Label>
            <Input
              id="form-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={t("Shown to respondents after they submit")}
            />
          </div>
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? t("Saving...") : t("Save settings")}
            </Button>
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

  if (query.isLoading) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="h-10 w-64 animate-pulse rounded-lg bg-card" />
        <div className="h-96 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="flex w-full flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
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
    <div className="flex w-full flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
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
            <Button
              variant="outline"
              size="sm"
              disabled={close.isPending}
              onClick={() => close.mutate()}
            >
              <Lock aria-hidden="true" className="h-4 w-4" />
              {t("Close")}
            </Button>
          )}
        </div>
      </div>

      <SettingsPanel form={form} tournamentId={id} />

      {/* Builder: inline-editable canvas + collapsible palette rail. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <FormCanvas className="min-w-0 flex-1" />

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
