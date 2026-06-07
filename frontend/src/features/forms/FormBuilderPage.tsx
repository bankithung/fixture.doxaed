import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ClipboardList,
  Lock,
  Save,
  Send,
  Settings2,
} from "lucide-react";
import { formsApi } from "@/api/forms";
import type { FormSummary } from "./types";
import { useBuilderStore } from "./builderStore";
import { FieldPalette } from "./FieldPalette";
import { FormCanvas } from "./FormCanvas";
import { FieldInspector } from "./FieldInspector";
import { FormPreview } from "./FormPreview";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { useBreakpoint } from "@/lib/useBreakpoint";
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

function SettingsPanel({
  form,
  tournamentId,
}: {
  form: FormSummary;
  tournamentId: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
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
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <Settings2 aria-hidden="true" className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">{t("Form settings")}</h2>
      </div>
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
    </section>
  );
}

/**
 * Builder route container. Loads the form, hydrates the Zustand store, and
 * lays out the palette / canvas / inspector (3-column on desktop, stacked on
 * mobile). Schema edits debounce-autosave; header actions cover an explicit
 * Save plus Publish / Close. Route: `/tournaments/:id/forms/:formId/edit`.
 */
export function FormBuilderPage(): React.ReactElement {
  const { id = "", formId = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { isMobile } = useBreakpoint();

  const schema = useBuilderStore((s) => s.schema);
  const load = useBuilderStore((s) => s.load);

  const query = useQuery({
    queryKey: ["form", formId],
    queryFn: () => formsApi.get(formId),
  });

  // Hydrate the store once the form loads. `loadedId` guards against
  // re-loading (and wiping unsaved edits) on background refetches.
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

  // Debounced autosave whenever the schema changes after the initial load.
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!loadedId.current) return;
    if (!dirtyRef.current) {
      dirtyRef.current = true; // skip the first run (hydration)
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
        description:
          e instanceof ApiError ? (e.payload.detail ?? "") : "",
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
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <Link
            to={routes.tournamentForms(id)}
            className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          >
            {t("← Back to forms")}
          </Link>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight sm:text-3xl">
            {form.title || t("Untitled form")}
          </h1>
          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-0.5 font-medium capitalize">
              {t(status)}
            </span>
            {saveSchema.isPending ? (
              <span>{t("Saving…")}</span>
            ) : savedAt ? (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                {t("All changes saved")}
              </span>
            ) : null}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={saveSchema.isPending}
            onClick={() => saveSchema.mutate()}
          >
            <Save aria-hidden="true" className="h-4 w-4" />
            {t("Save")}
          </Button>
          <Link to={routes.tournamentFormResponses(id, formId)}>
            <Button variant="outline">
              <ClipboardList aria-hidden="true" className="h-4 w-4" />
              {t("Responses")}
            </Button>
          </Link>
          {status === "draft" || status === "closed" ? (
            <Button disabled={publish.isPending} onClick={() => publish.mutate()}>
              <Send aria-hidden="true" className="h-4 w-4" />
              {t("Publish")}
            </Button>
          ) : (
            <Button
              variant="outline"
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

      {/* Builder grid: palette | canvas | inspector — stacked on mobile. */}
      <div
        className={cn(
          "grid gap-4",
          isMobile ? "grid-cols-1" : "lg:grid-cols-[16rem_minmax(0,1fr)_20rem]",
        )}
      >
        <FieldPalette />
        <FormCanvas />
        <FieldInspector />
      </div>

      {/* Preview spans full width below the builder. */}
      <FormPreview schema={schema} />
    </div>
  );
}
