import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Pencil, Power, ScrollText, Settings } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";
import { DeleteTournamentButton } from "@/features/tournaments/DeleteTournamentButton";
import { StarBorder } from "@/components/ui/StarBorder";
import "@/components/ui/star-border.css";

/**
 * Settings — deliberately SMALL (owner 2026-07-05): rename the tournament,
 * jump to the audit log, and the status/danger zone. Everything else that
 * used to live here (event basics, points, match format, squad limits,
 * tiebreakers, disputes) has a proper home elsewhere (fixture setup rules,
 * per-competition scoring, the ops surfaces) and was removed rather than
 * duplicated.
 */
export function SettingsTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();

  // can_delete gates the danger zone (organizer only); can_edit gates rename.
  const settings = useQuery({
    queryKey: qk.settings(id),
    queryFn: () => tournamentsApi.settings(id),
  });
  const tournament = useQuery({
    queryKey: ["tournament", id],
    queryFn: () => tournamentsApi.get(id),
    enabled: Boolean(id),
  });
  // Rename gates on MANAGER, not on settings.can_edit — the backend flips
  // can_edit off once rules freeze (registration open), but a name is not a
  // rule (owner report 2026-07-05: "no option to edit the name").
  const stage = useQuery({
    queryKey: qk.stage(id),
    queryFn: () => tournamentsApi.stage(id),
    enabled: Boolean(id),
  });

  const canEdit = stage.data?.can_manage ?? false;
  const canDelete = settings.data?.can_delete ?? false;
  const archived = tournament.data?.status === "archived";

  const [nameDraft, setNameDraft] = useState("");
  useEffect(() => {
    if (tournament.data?.name) setNameDraft(tournament.data.name);
  }, [tournament.data?.name]);
  const nameChanged =
    nameDraft.trim().length > 0 && nameDraft.trim() !== tournament.data?.name;

  const rename = useMutation({
    mutationFn: () => tournamentsApi.rename(id, nameDraft.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tournament", id] });
      qc.invalidateQueries({ queryKey: ["tournaments"] });
      toast.push({ kind: "success", title: t("Tournament renamed") });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not rename the tournament"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  const setActive = useMutation({
    mutationFn: (active: boolean) => tournamentsApi.setActive(id, active),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["tournament", id] });
      qc.invalidateQueries({ queryKey: ["tournaments"] });
      toast.push({
        kind: "success",
        title:
          data.status === "archived"
            ? t("Tournament deactivated")
            : t("Tournament reactivated"),
      });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not update the tournament"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  return (
    <div className="flex w-full flex-col gap-4">
      {/* Name — the one thing edited HERE. */}
      <StarBorder>
        <section
          className="bento-card panel"
          aria-label={t("Tournament name")}
        >
          <div className="flex items-center gap-2 border-b border-border p-3">
            <Settings aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
            <h2 className="text-sm font-semibold">{t("Settings")}</h2>
            <span className="text-xs text-muted-foreground">
              {t("Rules and formats live in fixture setup. Stage changes happen on Overview.")}
            </span>
          </div>
          <div className="flex flex-col gap-2 p-3">
            <label
              htmlFor="tournament-name"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("Tournament name")}
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="tournament-name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                disabled={!canEdit || tournament.isLoading}
                data-testid="tournament-name-input"
                className="h-9 sm:max-w-md"
                placeholder={t("Tournament name")}
              />
              {canEdit ? (
                <Button
                  size="sm"
                  className="h-9 w-fit"
                  data-testid="save-tournament-name"
                  disabled={!nameChanged || rename.isPending}
                  onClick={() => rename.mutate()}
                >
                  <Pencil aria-hidden="true" className="h-4 w-4" />
                  {rename.isPending ? t("Saving…") : t("Save name")}
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Shown everywhere, including public pages. The web address stays the same.")}
            </p>
          </div>
        </section>
      </StarBorder>

      {/* Audit log */}
      <Link
        to={routes.tournamentAudit(id)}
        className="bento-card star-rim group flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/30"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10">
          <ScrollText aria-hidden="true" className="h-5 w-5 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("Audit log")}</div>
          <div className="text-xs text-muted-foreground">
            {t("Every stage change, score and admin action. Append-only.")}
          </div>
        </div>
        <ChevronRight
          aria-hidden="true"
          className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        />
      </Link>

      {/* Status + danger zone (organizer only — invited managers never see it). */}
      {canDelete ? (
        <section className="bento-card star-rim flex flex-col gap-3 rounded-xl border border-destructive/30 bg-card p-4 shadow-sm">
          <div>
            <h3 className="text-sm font-semibold">{t("Status & danger zone")}</h3>
            <p className="text-xs text-muted-foreground">
              {archived
                ? t("Inactive (archived). Reactivate it to resume.")
                : t("Deactivate to hide it, or delete it permanently.")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={setActive.isPending}
              onClick={() => setActive.mutate(archived ? true : false)}
              data-testid="toggle-active"
            >
              <Power aria-hidden="true" className="h-4 w-4" />
              {archived ? t("Reactivate") : t("Deactivate")}
            </Button>
            <DeleteTournamentButton tournamentId={id} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
