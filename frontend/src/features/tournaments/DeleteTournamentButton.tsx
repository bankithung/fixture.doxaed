import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
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
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Delete-tournament action + confirm dialog, shared by the setup-flow header
 * (W2-C: the owner wants delete reachable from the top of the flow) and the
 * Settings danger zone. The backend refuses while matches are live.
 *
 * `compact` renders an icon-first ghost button that fits a header row.
 */
export function DeleteTournamentButton({
  tournamentId,
  compact = false,
}: {
  tournamentId: string;
  compact?: boolean;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);

  const remove = useMutation({
    mutationFn: () => tournamentsApi.remove(tournamentId),
    onSuccess: () => {
      setConfirm(false);
      qc.invalidateQueries({ queryKey: ["tournaments"] });
      toast.push({ kind: "success", title: t("Tournament deleted") });
      navigate(routes.tournaments());
    },
    onError: (e) => {
      setConfirm(false);
      const live = e instanceof ApiError && e.payload.detail === "tournament_live";
      toast.push({
        kind: "error",
        title: live
          ? t("Can't delete a live tournament")
          : t("Could not delete the tournament"),
        description: live
          ? t("Finish or pause the live matches first.")
          : undefined,
      });
    },
  });

  return (
    <>
      <Button
        variant="ghost"
        size={compact ? "sm" : "default"}
        disabled={remove.isPending}
        onClick={() => setConfirm(true)}
        data-testid="delete-tournament"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 aria-hidden="true" className="h-4 w-4" />
        {compact ? t("Delete") : t("Delete tournament")}
      </Button>

      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        ariaLabel={t("Delete tournament")}
      >
        <DialogHeader>
          <DialogTitle>{t("Delete tournament")}</DialogTitle>
          <DialogDescription>
            {t(
              "This removes the tournament and everything in it (forms, teams, fixtures) from your workspace. This can't be undone.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirm(false)}>
            {t("Cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
            data-testid="confirm-delete-tournament"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
            {remove.isPending ? t("Deleting…") : t("Delete tournament")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
