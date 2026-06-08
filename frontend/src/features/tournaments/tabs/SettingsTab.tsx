import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Lock, ScrollText } from "lucide-react";
import { tournamentsApi, type TournamentRules } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";
import { DisputesPanel } from "@/features/disputes/DisputesPanel";

type Editable = Pick<TournamentRules, "points" | "match" | "squad">;

function NumberField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  disabled: boolean;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input
        type="number"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="font-tabular"
      />
    </label>
  );
}

export function SettingsTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Editable | null>(null);

  const settings = useQuery({
    queryKey: ["t-settings", id],
    queryFn: () => tournamentsApi.settings(id),
  });

  useEffect(() => {
    if (settings.data) {
      const r = settings.data.rules;
      setDraft({ points: r.points, match: r.match, squad: r.squad });
    }
  }, [settings.data]);

  const canEdit = settings.data?.can_edit ?? false;
  const frozen = !!settings.data?.rules_frozen_at;

  const save = useMutation({
    mutationFn: () =>
      tournamentsApi.updateSettings(id, { rules: draft!, event_id: newEventId() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["t-settings", id] });
      invalidateTournament(qc, id);
      toast.push({ kind: "success", title: t("Settings saved") });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not save settings"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  const set = <G extends keyof Editable, K extends keyof Editable[G]>(
    group: G,
    key: K,
    val: Editable[G][K],
  ): void => setDraft((d) => (d ? { ...d, [group]: { ...d[group], [key]: val } } : d));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold">{t("Settings")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Scoring rules, match format and squad limits, plus admin tools. Stage changes happen on Overview.")}
        </p>
      </div>

      {frozen ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <Lock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>{t("Rules are frozen because registration is open — they're read-only to keep the competition fair.")}</span>
        </div>
      ) : null}

      {/* Rules editor */}
      {settings.isLoading || !draft ? (
        <div className="h-48 animate-pulse rounded-xl border border-border bg-card" />
      ) : (
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm">
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t("Points")}</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <NumberField label={t("Win")} value={draft.points.win} disabled={!canEdit}
                onChange={(n) => set("points", "win", n)} />
              <NumberField label={t("Draw")} value={draft.points.draw} disabled={!canEdit}
                onChange={(n) => set("points", "draw", n)} />
              <NumberField label={t("Loss")} value={draft.points.loss} disabled={!canEdit}
                onChange={(n) => set("points", "loss", n)} />
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t("Match format")}</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <NumberField label={t("Halves")} value={draft.match.halves} disabled={!canEdit}
                onChange={(n) => set("match", "halves", n)} />
              <NumberField label={t("Minutes / half")} value={draft.match.half_minutes} disabled={!canEdit}
                onChange={(n) => set("match", "half_minutes", n)} />
              <label className="flex items-center gap-2 pt-5 text-sm">
                <input type="checkbox" checked={draft.match.extra_time} disabled={!canEdit}
                  onChange={(e) => set("match", "extra_time", e.target.checked)}
                  className="h-4 w-4 accent-[hsl(var(--primary))]" />
                {t("Extra time")}
              </label>
              <label className="flex items-center gap-2 pt-5 text-sm">
                <input type="checkbox" checked={draft.match.penalties} disabled={!canEdit}
                  onChange={(e) => set("match", "penalties", e.target.checked)}
                  className="h-4 w-4 accent-[hsl(var(--primary))]" />
                {t("Penalties")}
              </label>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t("Squad limits")}</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <NumberField label={t("Min players")} value={draft.squad.min_players} disabled={!canEdit}
                onChange={(n) => set("squad", "min_players", n)} />
              <NumberField label={t("Max players")} value={draft.squad.max_players} disabled={!canEdit}
                onChange={(n) => set("squad", "max_players", n)} />
              <NumberField label={t("Max subs")} value={draft.squad.max_subs} disabled={!canEdit}
                onChange={(n) => set("squad", "max_subs", n)} />
            </div>
          </section>

          {settings.data?.rules.tiebreakers?.length ? (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-sm font-semibold">{t("Tiebreakers")}</h3>
              <div className="flex flex-wrap gap-1.5">
                {settings.data.rules.tiebreakers.map((tb, i) => (
                  <span key={tb} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {i + 1}. {t(tb.replace(/_/g, " "))}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {canEdit ? (
            <div className="flex justify-end">
              <Button disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? t("Saving…") : t("Save settings")}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {/* Admin tools */}
      <Link
        to={routes.tournamentAudit(id)}
        className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/30"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10">
          <ScrollText aria-hidden="true" className="h-5 w-5 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("Audit log")}</div>
          <div className="text-xs text-muted-foreground">
            {t("Every stage change, score, and admin action — append-only.")}
          </div>
        </div>
        <ChevronRight aria-hidden="true" className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>

      <DisputesPanel tournamentId={id} />
    </div>
  );
}
