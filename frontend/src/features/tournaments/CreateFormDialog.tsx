import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FilePlus2, LayoutTemplate } from "lucide-react";
import { formsApi, type CopyableItem } from "@/api/forms";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
 * "Create form" flow: start blank, or copy from a built-in TEMPLATE or any form
 * the organizer can access (incl. other tournaments). Creates the form bound to
 * the given stage + purpose, copies the chosen schema, and opens the builder.
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
  const [mode, setMode] = useState<"choose" | "copy">("choose");
  const [title, setTitle] = useState(defaultTitle);
  const [selected, setSelected] = useState<string | null>(null);

  const copyable = useQuery({
    queryKey: ["forms-copyable"],
    queryFn: () => formsApi.copyable(),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: async (item: CopyableItem | null) => {
      const form = await formsApi.create(tournamentId, {
        title: title.trim() || defaultTitle,
        purpose,
        stage,
      });
      if (item) {
        await formsApi.copyFrom(
          form.id,
          item.is_template ? { template_id: item.id } : { source_form_id: item.id },
        );
      }
      return form;
    },
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
    setSelected(null);
    setTitle(defaultTitle);
    onClose();
  };

  const templates = copyable.data?.templates ?? [];
  const forms = (copyable.data?.forms ?? []).filter((f) => f.id !== tournamentId);
  const allItems = [...templates, ...forms];
  const pick = allItems.find((i) => i.id === selected) ?? null;

  const ItemCard = ({ item }: { item: CopyableItem }): React.ReactElement => (
    <button
      type="button"
      onClick={() => setSelected(item.id)}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        selected === item.id
          ? "border-primary bg-primary/[0.05] ring-1 ring-primary/40"
          : "border-border bg-card hover:border-primary/40 hover:bg-accent/30",
      )}
    >
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10">
        {item.is_template ? (
          <LayoutTemplate aria-hidden="true" className="h-4 w-4 text-primary" />
        ) : (
          <Copy aria-hidden="true" className="h-4 w-4 text-primary" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{item.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {item.is_template
            ? item.description
            : `${item.tournament_name ?? ""} · ${t(item.purpose)}`}
          {` · ${item.field_count} ${t("fields")}`}
        </span>
      </span>
    </button>
  );

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
            ? t("Start from scratch, or copy a ready-made template or one of your existing forms.")
            : t("Pick a template or form to copy. You can edit everything afterwards.")}
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
            onClick={() => create.mutate(null)}
            disabled={create.isPending}
            className="flex flex-col items-start gap-1.5 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FilePlus2 aria-hidden="true" className="h-5 w-5 text-primary" />
            <span className="text-sm font-medium">{t("Start blank")}</span>
            <span className="text-xs text-muted-foreground">{t("An empty form you build from scratch.")}</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("copy")}
            className="flex flex-col items-start gap-1.5 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LayoutTemplate aria-hidden="true" className="h-5 w-5 text-primary" />
            <span className="text-sm font-medium">{t("Use a template or existing form")}</span>
            <span className="text-xs text-muted-foreground">
              {t("Copy questions from a ready-made template or another form.")}
            </span>
          </button>
        </div>
      ) : (
        <div className="flex max-h-72 flex-col gap-3 overflow-y-auto pr-1">
          {copyable.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
          ) : (
            <>
              {templates.length ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    {t("Templates")}
                  </p>
                  {templates.map((i) => (
                    <ItemCard key={i.id} item={i} />
                  ))}
                </div>
              ) : null}
              {forms.length ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    {t("Your forms")}
                  </p>
                  {forms.map((i) => (
                    <ItemCard key={i.id} item={i} />
                  ))}
                </div>
              ) : null}
              {!templates.length && !forms.length ? (
                <p className="text-sm text-muted-foreground">{t("Nothing to copy yet.")}</p>
              ) : null}
            </>
          )}
        </div>
      )}

      <DialogFooter>
        {mode === "copy" ? (
          <>
            <Button variant="outline" onClick={() => setMode("choose")}>
              {t("Back")}
            </Button>
            <Button disabled={!pick || create.isPending} onClick={() => create.mutate(pick)}>
              {create.isPending ? t("Creating…") : t("Create from selection")}
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
