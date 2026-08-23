import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Copy } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
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
import { t } from "@/lib/t";

const MAX = 200;

/**
 * Clone action + dialog for a tournament card. ANY signed-in user can clone
 * any tournament they can see: the fork is an exact, fully independent copy —
 * settings, venues, forms, teams, players and the fixture with its scores and
 * event history — landing in the cloner's own workspace. Nothing written in
 * the clone ever reaches the original, and vice versa. The trigger stops
 * propagation so it never fires the card's navigation.
 */
export function CloneTournamentButton({
  tournamentId,
  currentName,
}: {
  tournamentId: string;
  currentName: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${currentName} (Clone)`);

  const clone = useMutation({
    mutationFn: () =>
      tournamentsApi.clone(tournamentId, {
        name: name.trim() || undefined,
      }),
    onSuccess: (created) => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["tournaments"] });
      qc.invalidateQueries({ queryKey: ["me-overview"] });
      toast.push({
        kind: "success",
        title: t("Tournament cloned"),
        description: t(
          "An exact independent copy — fixture included — is in your workspace.",
        ),
      });
      navigate(routes.tournamentDetail(created.id));
    },
    onError: () => {
      toast.push({ kind: "error", title: t("Could not clone the tournament") });
    },
  });

  const trimmed = name.trim();
  const canSave =
    trimmed.length > 0 && trimmed.length <= MAX && !clone.isPending;

  return (
    // Swallow clicks so the surrounding card link/navigation never fires.
    <span onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        data-testid="clone-tournament"
        aria-label={t("Clone tournament")}
        title={t("Clone tournament")}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setName(`${currentName} (Clone)`); // re-seed on every open
          setOpen(true);
        }}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Copy aria-hidden="true" className="h-4 w-4" />
      </button>

      <Dialog open={open} onOpenChange={setOpen} ariaLabel={t("Clone tournament")}>
        <DialogHeader>
          <DialogTitle>{t("Clone tournament")}</DialogTitle>
          <DialogDescription>
            {t(
              "Creates an exact, fully independent copy in your workspace — settings, teams and the whole fixture with results included. The original is never affected.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="py-1">
          <label className="text-sm font-medium" htmlFor="clone-name">
            {t("Clone name")}
          </label>
          <Input
            id="clone-name"
            autoFocus
            className="mt-1"
            value={name}
            maxLength={MAX}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSave) {
                e.preventDefault();
                clone.mutate();
              }
            }}
            aria-label={t("Clone name")}
            data-testid="clone-name-input"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => clone.mutate()}
            data-testid="confirm-clone"
          >
            {clone.isPending ? t("Cloning…") : t("Clone")}
          </Button>
        </DialogFooter>
      </Dialog>
    </span>
  );
}
