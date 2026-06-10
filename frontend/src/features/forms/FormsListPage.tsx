import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardList,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  Pencil,
  Plus,
  Trash2,
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const PURPOSE_OPTIONS: { value: FormPurpose; label: string }[] = [
  { value: "organization_registration", label: "Institution registration" },
  { value: "team_registration", label: "Team registration" },
  { value: "generic", label: "Generic form" },
];

function purposeLabel(purpose: string): string {
  return PURPOSE_OPTIONS.find((o) => o.value === purpose)?.label ?? "Form";
}

function statusMeta(status: FormStatus): { label: string; badge: string; dot: string } {
  switch (status) {
    case "open":
      return { label: "Open", badge: "bg-primary/15 text-primary", dot: "bg-primary" };
    case "closed":
      return {
        label: "Closed",
        badge: "bg-secondary text-secondary-foreground",
        dot: "bg-muted-foreground",
      };
    case "draft":
    default:
      return {
        label: status === "draft" ? "Draft" : status,
        badge: "bg-muted text-muted-foreground",
        dot: "bg-muted-foreground/40",
      };
  }
}

function StatusPill({ status }: { status: FormStatus }): React.ReactElement {
  const m = statusMeta(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        m.badge,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", m.dot)} />
      {t(m.label)}
    </span>
  );
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

function InstitutionLinksDialog({
  form,
  open,
  onOpenChange,
}: {
  form: FormSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const toast = useToast();

  const mint = useMutation({
    mutationFn: (formId: string) => formsApi.institutionLinks(formId),
    onError: () =>
      toast.push({ kind: "error", title: t("Could not create institution links") }),
  });

  // Mint (idempotent on the server) when the dialog opens for a form. The list is
  // derived from the mutation result, so there's no state to set in the effect.
  useEffect(() => {
    if (open && form) mint.mutate(form.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form?.id]);

  const links = mint.data?.links ?? null;

  const copy = async (path: string): Promise<void> => {
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.push({ kind: "success", title: t("Link copied") });
    } catch {
      toast.push({ kind: "error", title: t("Could not copy"), description: url });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={t("Institution links")}
    >
      <DialogHeader>
        <DialogTitle>{t("Per-institution links")}</DialogTitle>
        <DialogDescription>
          {t(
            "Each registered institution gets a private link that pre-fills and locks its details — copy and send these. Links created earlier can't be shown again.",
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="max-h-80 overflow-y-auto" data-testid="institution-links">
        {mint.isPending ? (
          <p className="text-sm text-muted-foreground">{t("Creating links…")}</p>
        ) : links && links.length > 0 ? (
          <ul className="divide-y divide-border">
            {links.map((l) => (
              <li
                key={l.institution_id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="min-w-0 truncate text-sm text-foreground">
                  {l.name}
                </span>
                {l.path ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copy(l.path as string)}
                    className="shrink-0 gap-1"
                  >
                    <Copy aria-hidden="true" className="h-4 w-4" />
                    {t("Copy link")}
                  </Button>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t("Already created")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("No registered institutions yet.")}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t("Done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function FormRow({
  tournamentId,
  form,
  onDelete,
  onLinks,
}: {
  tournamentId: string;
  form: FormSummary;
  onDelete: (form: FormSummary) => void;
  onLinks: (form: FormSummary) => void;
}): React.ReactElement {
  const navigate = useNavigate();
  const toast = useToast();

  const copyPublicLink = async (): Promise<void> => {
    const url = `${window.location.origin}/f/${form.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.push({ kind: "success", title: t("Public link copied") });
    } catch {
      toast.push({ kind: "error", title: t("Could not copy"), description: url });
    }
  };

  const builderHref = routes.tournamentFormBuilder(tournamentId, form.id);

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <FileText aria-hidden="true" className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              to={builderHref}
              className="truncate font-medium text-foreground hover:text-primary hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {form.title || t("Untitled form")}
            </Link>
            <StatusPill status={form.status} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(purposeLabel(form.purpose))}
            {" · "}
            <span className="font-tabular">
              {form.response_count}{" "}
              {form.response_count === 1 ? t("response") : t("responses")}
            </span>
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(builderHref)}
          className="gap-1"
        >
          <Pencil aria-hidden="true" className="h-4 w-4" />
          {t("Edit")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            navigate(routes.tournamentFormResponses(tournamentId, form.id))
          }
          className="gap-1"
        >
          <ClipboardList aria-hidden="true" className="h-4 w-4" />
          {t("Responses")}
        </Button>
        {form.purpose === "team_registration" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onLinks(form)}
            className="gap-1"
            data-testid={`links-${form.id}`}
          >
            <Link2 aria-hidden="true" className="h-4 w-4" />
            {t("Links")}
          </Button>
        ) : null}
        {form.status === "open" ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copyPublicLink()}
              aria-label={t("Copy public link")}
              title={t("Copy public link")}
            >
              <Copy aria-hidden="true" className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                window.open(`/f/${form.id}`, "_blank", "noopener,noreferrer")
              }
              aria-label={t("Open public form")}
              title={t("Open public form")}
            >
              <ExternalLink aria-hidden="true" className="h-4 w-4" />
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(form)}
          aria-label={t(`Delete ${form.title || "Untitled form"}`)}
          title={t("Delete form")}
          data-testid={`delete-form-${form.id}`}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Per-tournament list of registration forms — the builder entry point. Renders
 * inside the tournament workspace (contextual sidebar), so it uses the shared
 * tab layout (no bespoke padding / back-link) and the standard section heading
 * scale. Route: `/tournaments/:id/forms`.
 */
export function FormsListPage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<FormSummary | null>(null);
  const [linksForm, setLinksForm] = useState<FormSummary | null>(null);

  const query = useQuery({
    queryKey: ["forms", id],
    queryFn: () => formsApi.list(id),
  });
  const forms = query.data ?? [];

  const del = useMutation({
    mutationFn: (formId: string) => formsApi.remove(formId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["forms", id] });
      toast.push({ kind: "success", title: t("Form deleted") });
      setPendingDelete(null);
    },
    onError: (e) => {
      toast.push({
        kind: "error",
        title: t("Could not delete the form"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      });
      setPendingDelete(null);
    },
  });

  const newCta = (
    <Button onClick={() => setDialogOpen(true)} className="shrink-0">
      <Plus aria-hidden="true" className="h-4 w-4" />
      {t("New form")}
    </Button>
  );

  const pendingTitle = pendingDelete?.title || t("Untitled form");
  const pendingResponses = pendingDelete?.response_count ?? 0;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{t("Registration forms")}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("Build data-driven registration forms with branching logic.")}
          </p>
        </div>
        {newCta}
      </div>

      {query.isLoading ? (
        <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="divide-y divide-border" data-testid="forms-loading">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 p-4">
                <div className="h-10 w-10 animate-pulse rounded-lg bg-muted" />
                <div className="flex flex-1 flex-col gap-2">
                  <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-1/4 animate-pulse rounded bg-muted/70" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load forms.")}
        </p>
      ) : forms.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card p-12 text-center">
          <FileText
            aria-hidden="true"
            className="h-8 w-8 text-muted-foreground/50"
          />
          <div>
            <h3 className="text-base font-semibold">
              {t("No registration forms yet")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("Create a form to collect institution or team registrations.")}
            </p>
          </div>
          {newCta}
        </div>
      ) : (
        <section
          className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
          aria-label={t("Forms")}
        >
          <div className="divide-y divide-border" data-testid="forms-list">
            {forms.map((form) => (
              <FormRow
                key={form.id}
                tournamentId={id}
                form={form}
                onDelete={setPendingDelete}
                onLinks={setLinksForm}
              />
            ))}
          </div>
        </section>
      )}

      <NewFormDialog
        tournamentId={id}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />

      <InstitutionLinksDialog
        form={linksForm}
        open={linksForm !== null}
        onOpenChange={(open) => {
          if (!open) setLinksForm(null);
        }}
      />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        ariaLabel={t("Delete form")}
      >
        <DialogHeader>
          <DialogTitle>{t("Delete form")}</DialogTitle>
          <DialogDescription>
            {pendingResponses > 0
              ? t(
                  `Delete "${pendingTitle}"? It has ${pendingResponses} ${pendingResponses === 1 ? "response" : "responses"} that will no longer be accessible. This can't be undone.`,
                )
              : t(`Delete "${pendingTitle}"? This can't be undone.`)}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setPendingDelete(null)}>
            {t("Cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={del.isPending}
            onClick={() => pendingDelete && del.mutate(pendingDelete.id)}
            data-testid="confirm-delete-form"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
            {del.isPending ? t("Deleting...") : t("Delete form")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
