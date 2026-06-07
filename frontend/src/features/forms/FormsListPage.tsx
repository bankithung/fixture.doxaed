import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  ClipboardList,
  Copy,
  ExternalLink,
  Plus,
} from "lucide-react";
import { formsApi } from "@/api/forms";
import type { FormPurpose, FormStatus, FormSummary } from "./types";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const PURPOSE_OPTIONS: { value: FormPurpose; label: string }[] = [
  { value: "organization_registration", label: "Organization registration" },
  { value: "team_registration", label: "Team registration" },
  { value: "generic", label: "Generic form" },
];

function statusBadge(status: FormStatus): { label: string; cls: string } {
  const m: Record<FormStatus, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
    open: { label: "Open", cls: "bg-primary/15 text-primary" },
    closed: { label: "Closed", cls: "bg-secondary text-secondary-foreground" },
  };
  return m[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
}

function NewFormDialog({
  tournamentId,
  open,
  onOpenChange,
}: {
  tournamentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState<FormPurpose>("team_registration");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      formsApi.create(tournamentId, { title: title.trim(), purpose }),
    onSuccess: (form) => {
      qc.invalidateQueries({ queryKey: ["forms", tournamentId] });
      toast.push({ kind: "success", title: t("Form created") });
      onOpenChange(false);
      navigate(routes.tournamentFormBuilder(tournamentId, form.id));
    },
    onError: (e) =>
      setError(
        e instanceof ApiError
          ? (e.payload.detail ?? t("Could not create the form"))
          : t("Could not create the form"),
      ),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} ariaLabel={t("New form")}>
      <DialogHeader>
        <DialogTitle>{t("New registration form")}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-form-title">{t("Form title")}</Label>
          <Input
            id="new-form-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("e.g. School registration")}
            autoFocus
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-form-purpose">{t("Purpose")}</Label>
          <Select
            id="new-form-purpose"
            value={purpose}
            options={PURPOSE_OPTIONS.map((o) => ({
              value: o.value,
              label: t(o.label),
            }))}
            onChange={(v) => setPurpose(v as FormPurpose)}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t("Cancel")}
        </Button>
        <Button
          disabled={!title.trim() || create.isPending}
          onClick={() => {
            setError(null);
            create.mutate();
          }}
        >
          {create.isPending ? t("Creating...") : t("Create form")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function FormCard({
  tournamentId,
  form,
}: {
  tournamentId: string;
  form: FormSummary;
}): React.ReactElement {
  const toast = useToast();
  const badge = statusBadge(form.status);

  const copyPublicLink = async (): Promise<void> => {
    const url = `${window.location.origin}/f/${form.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.push({ kind: "success", title: t("Public link copied") });
    } catch {
      toast.push({
        kind: "error",
        title: t("Could not copy"),
        description: url,
      });
    }
  };

  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <Link
          to={routes.tournamentFormBuilder(tournamentId, form.id)}
          className="min-w-0 font-semibold tracking-tight hover:text-primary focus-visible:underline focus-visible:outline-none"
        >
          <span className="block truncate">{form.title || t("Untitled form")}</span>
        </Link>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
            badge.cls,
          )}
        >
          {t(badge.label)}
        </span>
      </div>
      <p className="mt-1 font-tabular text-xs text-muted-foreground">
        {form.response_count}{" "}
        {form.response_count === 1 ? t("response") : t("responses")}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Link
          to={routes.tournamentFormBuilder(tournamentId, form.id)}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {t("Edit form")}
          <ChevronRight aria-hidden="true" className="h-4 w-4" />
        </Link>
        <Link
          to={routes.tournamentFormResponses(tournamentId, form.id)}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          <ClipboardList aria-hidden="true" className="h-4 w-4" />
          {t("Responses")}
        </Link>
        {form.status === "open" ? (
          <>
            <button
              type="button"
              onClick={() => void copyPublicLink()}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Copy aria-hidden="true" className="h-4 w-4" />
              {t("Copy link")}
            </button>
            <a
              href={`/f/${form.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              <ExternalLink aria-hidden="true" className="h-4 w-4" />
              {t("Open")}
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Per-tournament list of registration forms — the builder entry point.
 * Route: `/tournaments/:id/forms`.
 */
export function FormsListPage(): React.ReactElement {
  const { id = "" } = useParams();
  const [dialogOpen, setDialogOpen] = useState(false);
  const query = useQuery({
    queryKey: ["forms", id],
    queryFn: () => formsApi.list(id),
  });
  const forms = query.data ?? [];

  const newCta = (
    <Button onClick={() => setDialogOpen(true)}>
      <Plus aria-hidden="true" className="h-4 w-4" />
      {t("New form")}
    </Button>
  );

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            to={routes.tournamentDetail(id)}
            className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          >
            {t("← Back to tournament")}
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("Registration forms")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Build data-driven registration forms with branching logic.")}
          </p>
        </div>
        {newCta}
      </div>

      {query.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-32 animate-pulse rounded-xl border border-border bg-card"
            />
          ))}
        </div>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load forms.")}
        </p>
      ) : forms.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {t("No registration forms yet.")}
          </p>
          {newCta}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {forms.map((form) => (
            <FormCard key={form.id} tournamentId={id} form={form} />
          ))}
        </div>
      )}

      <NewFormDialog
        tournamentId={id}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}
