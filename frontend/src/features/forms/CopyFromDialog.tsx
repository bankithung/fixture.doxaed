import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, LayoutTemplate } from "lucide-react";
import { formsApi, type CopyableItem } from "@/api/forms";
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
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * In-builder "copy from" picker: replace THIS form's questions with a built-in
 * template or another accessible form's schema. Used from the empty state +
 * toolbar of the form builder.
 */
export function CopyFromDialog({
  formId,
  open,
  onClose,
  onCopied,
}: {
  formId: string;
  open: boolean;
  onClose: () => void;
  onCopied: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);

  const copyable = useQuery({
    queryKey: ["forms-copyable"],
    queryFn: () => formsApi.copyable(),
    enabled: open,
  });

  const apply = useMutation({
    mutationFn: (item: CopyableItem) =>
      formsApi.copyFrom(
        formId,
        item.is_template ? { template_id: item.id } : { source_form_id: item.id },
      ),
    onSuccess: () => {
      toast.push({ kind: "success", title: t("Questions copied in") });
      onCopied();
      close();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not copy"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  const close = (): void => {
    setSelected(null);
    onClose();
  };

  const templates = copyable.data?.templates ?? [];
  const forms = (copyable.data?.forms ?? []).filter((f) => f.id !== formId);
  const pick = [...templates, ...forms].find((i) => i.id === selected) ?? null;

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
      ariaLabel={t("Copy from a template or form")}
    >
      <DialogHeader>
        <DialogTitle>{t("Copy from a template or form")}</DialogTitle>
        <DialogDescription>
          {t("Replaces the current questions. You can edit them after.")}
        </DialogDescription>
      </DialogHeader>

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

      <DialogFooter>
        <Button variant="outline" onClick={close}>
          {t("Cancel")}
        </Button>
        <Button disabled={!pick || apply.isPending} onClick={() => pick && apply.mutate(pick)}>
          {apply.isPending ? t("Copying…") : t("Copy in")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
