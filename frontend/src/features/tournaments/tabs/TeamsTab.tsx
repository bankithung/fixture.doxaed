import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Sparkles, Users } from "lucide-react";
import { institutionsApi } from "@/api/institutions";
import { formsApi } from "@/api/forms";
import { tournamentsApi, type TeamRow } from "@/api/tournaments";
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
import { FilePlus2 } from "lucide-react";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";
import { CreateFormDialog } from "../CreateFormDialog";
import { EmptyState } from "./shared";

export function TeamsTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [institutionId, setInstitutionId] = useState("");
  const [name, setName] = useState("");

  const teams = useQuery({ queryKey: ["t-teams", id], queryFn: () => tournamentsApi.teams(id) });
  const institutions = useQuery({
    queryKey: ["t-institutions", id],
    queryFn: () => institutionsApi.list(id),
  });
  const forms = useQuery({ queryKey: ["forms", id], queryFn: () => formsApi.list(id) });
  const stage = useQuery({
    queryKey: ["tournament-stage", id],
    queryFn: () => tournamentsApi.stage(id),
  });
  const canManage = stage.data?.can_manage ?? false;
  const teamForm =
    (forms.data ?? []).find((f) => f.stage === "team_registration") ??
    (forms.data ?? []).find((f) => f.purpose === "team_registration");

  const generateForm = useMutation({
    mutationFn: () => formsApi.generateTeamForm(id),
    onSuccess: (f) => {
      invalidateTournament(qc, id);
      toast.push({
        kind: "success",
        title: t("Team form generated"),
        description: t("Review and edit the template, then open it for registration."),
      });
      navigate(routes.tournamentFormBuilder(id, f.id));
    },
    onError: () => toast.push({ kind: "error", title: t("Could not generate the team form") }),
  });

  const grouped = useMemo(() => {
    const g: Record<string, TeamRow[]> = {};
    for (const tm of teams.data ?? []) {
      (g[tm.institution_name || tm.school || t("Unassigned")] ||= []).push(tm);
    }
    return g;
  }, [teams.data]);

  const add = useMutation({
    mutationFn: () =>
      institutionsApi.addTeam(id, {
        institution_id: institutionId,
        name: name.trim(),
        event_id: newEventId(),
      }),
    onSuccess: () => {
      invalidateTournament(qc, id);
      toast.push({ kind: "success", title: t("Team added") });
      setOpen(false);
      setName("");
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not add team"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : t("Try again."),
      }),
  });

  const instOptions = (institutions.data ?? []).map((i) => ({ value: i.id, label: i.name }));
  const total = teams.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t("Teams")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("Each institution's teams. Add them directly, or collect them via the registration form.")}
          </p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            {teamForm ? (
              <Button
                variant="outline"
                onClick={() => navigate(routes.tournamentFormBuilder(id, teamForm.id))}
              >
                <Pencil aria-hidden="true" className="h-4 w-4" />
                {t("Edit team form")}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={(institutions.data?.length ?? 0) === 0 || generateForm.isPending}
                  onClick={() => generateForm.mutate()}
                  title={
                    (institutions.data?.length ?? 0) === 0
                      ? t("Register institutions first")
                      : undefined
                  }
                >
                  <Sparkles aria-hidden="true" className="h-4 w-4" />
                  {generateForm.isPending ? t("Generating…") : t("Auto-generate team form")}
                </Button>
                <Button variant="outline" onClick={() => setCreateOpen(true)}>
                  <FilePlus2 aria-hidden="true" className="h-4 w-4" />
                  {t("Create form")}
                </Button>
              </>
            )}
            <Button
              disabled={(institutions.data?.length ?? 0) === 0}
              onClick={() => {
                setInstitutionId(institutions.data?.[0]?.id ?? "");
                setOpen(true);
              }}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("Add team")}
            </Button>
          </div>
        ) : null}
      </div>

      {canManage && (institutions.data?.length ?? 0) > 0 && !teamForm ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          {t("Tip: “Auto-generate team form” builds a registration form from the categories each institution selected — a conditional section per category — for you to review and open.")}
        </p>
      ) : null}

      {total === 0 ? (
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title={t("No teams yet")}
          hint={
            (institutions.data?.length ?? 0) === 0
              ? t("Register an institution first, then add its teams.")
              : t("Add a team directly, or share the registration form.")
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {Object.entries(grouped).map(([inst, rows]) => (
            <section key={inst} className="rounded-xl border border-border bg-card shadow-sm">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold">{inst}</h3>
                <span className="font-tabular text-xs text-muted-foreground">{rows.length}</span>
              </div>
              <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map((tm) => (
                  <div
                    key={tm.id}
                    className="rounded-lg border border-border bg-background px-3 py-2.5"
                  >
                    <div className="truncate text-sm font-medium">{tm.name}</div>
                    <div className="mt-0.5 font-tabular text-xs text-muted-foreground">
                      {tm.pool || t("Unseeded")} · {tm.player_count} {t("players")}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) setOpen(false);
        }}
        ariaLabel={t("Add team")}
      >
        <DialogHeader>
          <DialogTitle>{t("Add team")}</DialogTitle>
          <DialogDescription>
            {t("Select the institution, then name the team.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t("Institution")}</span>
            <Select
              value={institutionId}
              onChange={setInstitutionId}
              options={instOptions}
              placeholder={t("Select an institution")}
              aria-label={t("Institution")}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t("Team name")}</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("e.g. U-16 Boys")}
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={!institutionId || !name.trim() || add.isPending}
            onClick={() => add.mutate()}
          >
            {add.isPending ? t("Adding…") : t("Add team")}
          </Button>
        </DialogFooter>
      </Dialog>

      <CreateFormDialog
        tournamentId={id}
        stage="team_registration"
        purpose="team_registration"
        defaultTitle={t("Team registration")}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
