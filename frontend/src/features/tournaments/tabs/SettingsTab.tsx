import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Lock, Power, ScrollText } from "lucide-react";
import { tournamentsApi, type TournamentRules } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";
import { DeleteTournamentButton } from "@/features/tournaments/DeleteTournamentButton";
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


const TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Kathmandu",
  "Asia/Yangon",
  "Asia/Bangkok",
  "UTC",
];

/** Event basics: when the tournament runs + its clock. The timezone locks
 * once the schedule is live (invariant 14) — the server answers tz_locked. */
function BasicsCard({ tournamentId }: { tournamentId: string }): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["tournament", tournamentId],
    queryFn: () => tournamentsApi.get(tournamentId),
  });
  const [draft, setDraft] = useState<{
    starts_at: string;
    ends_at: string;
    season: string;
    time_zone: string;
  } | null>(null);
  useEffect(() => {
    if (q.data && draft === null) {
      setDraft({
        starts_at: q.data.starts_at ?? "",
        ends_at: q.data.ends_at ?? "",
        season: q.data.season ?? "",
        time_zone: q.data.time_zone ?? "Asia/Kolkata",
      });
    }
  }, [q.data, draft]);

  const save = useMutation({
    mutationFn: () =>
      tournamentsApi.patch(tournamentId, {
        starts_at: draft!.starts_at || null,
        ends_at: draft!.ends_at || null,
        season: draft!.season,
        time_zone: draft!.time_zone,
      }),
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({ kind: "success", title: t("Basics saved") });
    },
    onError: (e) => {
      const detail = e instanceof ApiError ? String(e.payload.detail ?? "") : "";
      toast.push({
        kind: "error",
        title:
          detail === "tz_locked"
            ? t("The timezone is locked while the schedule is live.")
            : detail === "ends_before_starts"
              ? t("The end date is before the start date.")
              : t("Could not save the basics"),
      });
    },
  });

  if (!draft) {
    return <div className="h-24 animate-pulse rounded-xl border border-border bg-card" />;
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("Event basics")}</h3>
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() => save.mutate()}
          data-testid="save-basics"
        >
          {t("Save basics")}
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t("Starts")}</span>
          <Input
            type="date"
            value={draft.starts_at}
            onChange={(e) => setDraft({ ...draft, starts_at: e.target.value })}
            className="h-9 font-tabular"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t("Ends")}</span>
          <Input
            type="date"
            value={draft.ends_at}
            onChange={(e) => setDraft({ ...draft, ends_at: e.target.value })}
            className="h-9 font-tabular"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t("Season")}</span>
          <Input
            value={draft.season}
            placeholder="2026"
            onChange={(e) => setDraft({ ...draft, season: e.target.value })}
            className="h-9 font-tabular"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t("Timezone")}</span>
          <Select
            aria-label={t("Timezone")}
            value={draft.time_zone}
            onChange={(v) => setDraft({ ...draft, time_zone: v })}
            options={TIMEZONES.map((z) => ({ value: z, label: z }))}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("Dates show on lists and public pages. The timezone locks once the schedule is live.")}
      </p>
    </div>
  );
}

export function SettingsTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Editable | null>(null);

  const settings = useQuery({
    queryKey: qk.settings(id),
    queryFn: () => tournamentsApi.settings(id),
  });

  useEffect(() => {
    if (settings.data) {
      const r = settings.data.rules;
      setDraft({ points: r.points, match: r.match, squad: r.squad });
    }
  }, [settings.data]);

  const frozen = !!settings.data?.rules_frozen_at;
  // Pre-freeze: plain editing. Post-freeze: fields stay editable and saving
  // routes through the audited amend-with-reason flow (the backend supports
  // it; the UI used to hard-disable everything forever).
  const canEdit = (settings.data?.can_edit ?? false) || frozen;

  const [amendOpen, setAmendOpen] = useState(false);
  const [amendReason, setAmendReason] = useState("");

  const save = useMutation({
    mutationFn: (amend: { reason: string } | undefined) =>
      tournamentsApi.updateSettings(id, {
        rules: draft!,
        event_id: newEventId(),
        ...(amend ? { amend: true, reason: amend.reason } : {}),
      }),
    onSuccess: () => {
      invalidateTournament(qc, id); // covers t-settings + all tournament data
      setAmendOpen(false);
      setAmendReason("");
      toast.push({ kind: "success", title: t("Settings saved") });
    },
    onError: (e) => {
      const detail = e instanceof ApiError ? String(e.payload.detail ?? "") : "";
      if (detail === "rules_frozen") {
        // Frozen is correctable, not terminal: the audited amend flow asks
        // for a reason (participants are notified of rule amendments).
        setAmendOpen(true);
        return;
      }
      toast.push({
        kind: "error",
        title: t("Could not save settings"),
        description: detail,
      });
    },
  });

  // Tournament identity (cached by the workspace) — drives status + the
  // archive/delete controls.
  const tournament = useQuery({
    queryKey: ["tournament", id],
    queryFn: () => tournamentsApi.get(id),
    enabled: Boolean(id),
  });
  // Danger zone is ORGANIZER-only (creator / workspace admin) — invited
  // managers can edit settings but never delete/deactivate (owner 2026-06-11).
  const canDelete = settings.data?.can_delete ?? false;
  const archived = tournament.data?.status === "archived";

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
          {t("Scoring rules, match format and squad limits. Stage changes happen on Overview.")}
        </p>
      </div>

      {frozen ? (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-sm">
          <Lock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground" />
          <span>
            {t("Rules are frozen while registration is open. Changes need a written reason and are audited.")}
          </span>
        </div>
      ) : null}

      <BasicsCard tournamentId={id} />

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
              <Button disabled={save.isPending} onClick={() => save.mutate(undefined)}>
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
            {t("Every stage change, score and admin action. Append-only.")}
          </div>
        </div>
        <ChevronRight aria-hidden="true" className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>

      <Dialog
        open={amendOpen}
        onOpenChange={setAmendOpen}
        ariaLabel={t("Amend frozen rules")}
      >
        <DialogHeader>
          <DialogTitle>{t("Amend frozen rules?")}</DialogTitle>
          <DialogDescription>
            {t("Registration is open, so this change is recorded as an amendment with your reason.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5 py-2">
          <span className="text-xs font-medium text-muted-foreground">{t("Reason")}</span>
          <textarea
            value={amendReason}
            onChange={(e) => setAmendReason(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder={t("E.g. squad size corrected after the referees' meeting")}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setAmendOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            data-testid="amend-confirm"
            disabled={save.isPending || amendReason.trim().length < 5}
            onClick={() => save.mutate({ reason: amendReason })}
          >
            {t("Amend rules")}
          </Button>
        </DialogFooter>
      </Dialog>

      <DisputesPanel tournamentId={id} />

      {/* Status + danger zone (organizer only — invited managers never see it). */}
      {canDelete ? (
        <section className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-card p-4 shadow-sm">
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
