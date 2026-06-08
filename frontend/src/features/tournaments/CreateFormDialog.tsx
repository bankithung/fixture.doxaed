import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FilePlus2 } from "lucide-react";
import { formsApi } from "@/api/forms";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

/**
 * "Create form" flow that first asks whether to start blank or duplicate an
 * existing form. On confirm it creates the form (bound to the given stage +
 * purpose, optionally copying a source form's schema) and opens the builder.
 */
export function CreateFormDialog({
  tournamentId,
  stage,
  purpose,
  defaultTitle,
  open,
  onClose,
}: {
  tournamentId: string;
  stage: string;
  purpose: string;
  defaultTitle: string;
  open: boolean;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"choose" | "existing">("choose");
  const [title, setTitle] = useState(defaultTitle);
  const [sourceId, setSourceId] = useState("");

  const forms = useQuery({
    queryKey: ["t-forms", tournamentId],
    queryFn: () => formsApi.list(tournamentId),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: (sourceFormId?: string) =>
      formsApi.create(tournamentId, {
        title: title.trim() || defaultTitle,
        purpose,
        stage,
        ...(sourceFormId ? { source_form_id: sourceFormId } : {}),
      }),
    onSuccess: (f) => {
      qc.invalidateQueries({ queryKey: ["t-forms", tournamentId] });
      close();
      navigate(routes.tournamentFormBuilder(tournamentId, f.id));
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not create the form"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  const close = (): void => {
    setMode("choose");
    setSourceId("");
    setTitle(defaultTitle);
    onClose();
  };

  const existing = forms.data ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      ariaLabel={t("Create form")}
    >
      <DialogHeader>
        <DialogTitle>{t("Create form")}</DialogTitle>
        <DialogDescription>
          {mode === "choose"
            ? t("Start from scratch, or duplicate one of your existing forms as a starting point.")
            : t("Pick a form to copy. You can edit everything afterwards.")}
        </DialogDescription>
      </DialogHeader>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t("Form title")}</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>

      {mode === "choose" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => create.mutate(undefined)}
            disabled={create.isPending}
            className={cn(
              "flex flex-col items-start gap-1.5 rounded-xl border border-border bg-card p-4 text-left transition-colors",
              "hover:border-primary/50 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <FilePlus2 aria-hidden="true" className="h-5 w-5 text-primary" />
            <span className="text-sm font-medium">{t("Start blank")}</span>
            <span className="text-xs text-muted-foreground">{t("An empty form you build from scratch.")}</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("existing")}
            disabled={existing.length === 0}
            className={cn(
              "flex flex-col items-start gap-1.5 rounded-xl border border-border bg-card p-4 text-left transition-colors",
              existing.length === 0
                ? "cursor-not-allowed opacity-50"
                : "hover:border-primary/50 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <Copy aria-hidden="true" className="h-5 w-5 text-primary" />
            <span className="text-sm font-medium">{t("Use an existing form")}</span>
            <span className="text-xs text-muted-foreground">
              {existing.length === 0
                ? t("No existing forms yet.")
                : t("Copy the questions from another form.")}
            </span>
          </button>
        </div>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t("Copy from")}</span>
          <Select
            value={sourceId}
            onChange={setSourceId}
            options={existing.map((f) => ({
              value: f.id,
              label: `${f.title} (${t(f.purpose)})`,
            }))}
            placeholder={t("Select a form")}
            aria-label={t("Copy from")}
          />
        </label>
      )}

      <DialogFooter>
        {mode === "existing" ? (
          <>
            <Button variant="outline" onClick={() => setMode("choose")}>
              {t("Back")}
            </Button>
            <Button
              disabled={!sourceId || create.isPending}
              onClick={() => create.mutate(sourceId)}
            >
              {create.isPending ? t("Creating…") : t("Create from this form")}
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={close}>
            {t("Cancel")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
