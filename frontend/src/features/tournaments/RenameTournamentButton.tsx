import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
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
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const MAX = 200;

/**
 * Edit-name action + dialog for a tournament row/card. Renames the display name
 * only — the slug (and the public link) stays stable. Manager-allowed; the
 * server enforces. The trigger stops propagation so it never opens the row's
 * workspace link/navigation it lives inside.
 */
export function RenameTournamentButton({
  tournamentId,
  currentName,
}: {
  tournamentId: string;
  currentName: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName);

  const rename = useMutation({
    mutationFn: (next: string) => tournamentsApi.rename(tournamentId, next),
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["tournaments"] });
      toast.push({ kind: "success", title: t("Tournament renamed") });
    },
    onError: (e) => {
      const denied =
        e instanceof ApiError && e.payload.detail === "not_tournament_manager";
      toast.push({
        kind: "error",
        title: denied
          ? t("You can't rename this tournament")
          : t("Could not rename the tournament"),
      });
    },
  });

  const trimmed = name.trim();
  const canSave =
    trimmed.length > 0 &&
    trimmed.length <= MAX &&
    trimmed !== currentName &&
    !rename.isPending;
  const submit = (): void => {
    if (canSave) rename.mutate(trimmed);
  };

  return (
    // The wrapper swallows clicks so the surrounding row link/navigation never
    // fires from the trigger or anything inside the (non-portaled) dialog.
    <span onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        data-testid="rename-tournament"
        aria-label={t("Edit name")}
        title={t("Edit name")}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setName(currentName); // re-seed from the latest name when opening
          setOpen(true);
        }}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Pencil aria-hidden="true" className="h-4 w-4" />
      </button>

      <Dialog open={open} onOpenChange={setOpen} ariaLabel={t("Rename tournament")}>
        <DialogHeader>
          <DialogTitle>{t("Rename tournament")}</DialogTitle>
          <DialogDescription>
            {t("Renames the display name. The link stays the same.")}
          </DialogDescription>
        </DialogHeader>
        <div className="py-1">
          <Input
            autoFocus
            value={name}
            maxLength={MAX}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            aria-label={t("Tournament name")}
            data-testid="rename-input"
          />
          <p
            className={cn(
              "mt-1 text-right font-tabular text-xs",
              trimmed.length > MAX ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {trimmed.length}/{MAX}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button disabled={!canSave} onClick={submit} data-testid="confirm-rename">
            {rename.isPending ? t("Saving…") : t("Save")}
          </Button>
        </DialogFooter>
      </Dialog>
    </span>
  );
}
