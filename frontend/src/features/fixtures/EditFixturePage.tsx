import { useCallback, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ClipboardCheck,
  History,
  RotateCcw,
} from "lucide-react";
import {
  tournamentsApi,
  type FixtureEditMatch,
  type FixtureEditPayload,
  type FixtureEdits,
  type FixtureValidationReport,
  type FixtureViolation,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/Select";
import { BracketView } from "@/features/tournaments/BracketView";
import { humanizeLeaf } from "@/features/controlroom/format";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * The fixture EDIT workbench (owner ask, 2026-08-23). One dedicated page:
 *
 * - GROUP matches in a TABLE — every editable value is a DROPDOWN (time slot
 *   chosen from the fixture's own slots, court from real court rows, each
 *   side from the competition's registered teams) and a row DRAGGED onto
 *   another swaps their slots. No free text anywhere.
 * - KNOCKOUT matches in the FLOW-CHART view (the same BracketView the public
 *   board uses) — click a card to open its editor; sides fed by
 *   winner_of/loser_of stay read-only because invariant 9 keeps pointers
 *   typed.
 * - NOTHING touches the real fixture until review + confirm: edits live in a
 *   local DRAFT (persisted to localStorage), validated against the full rule
 *   set on demand, then applied atomically with one audit row + snapshot.
 */

type SlotDraft = { start?: string; court_id?: string; venue?: string };
type TeamDraft = { home?: string | null; away?: string | null };

const draftKey = (id: string) => `fixture-edit-draft-${id}`;

interface Draft {
  slots: Record<string, SlotDraft>;
  teams: Record<string, TeamDraft>;
}

function loadDraft(id: string): Draft {
  try {
    const raw = localStorage.getItem(draftKey(id));
    if (raw) return JSON.parse(raw) as Draft;
  } catch {
    /* corrupted draft = no draft */
  }
  return { slots: {}, teams: {} };
}

function humanizeCode(code: string): string {
  const map: Record<string, string> = {
    venue_double_booked: t("Court double-booked"),
    team_double_booked: t("Team plays two matches at once"),
    insufficient_rest: t("Not enough rest between matches"),
    exceeds_max_per_day: t("Too many matches in one day for a team"),
    venue_unavailable: t("Court is unavailable that day"),
    venue_sport_mismatch: t("Court is not reserved for this sport"),
    court_competition_mismatch: t("Court is reserved for another competition"),
    court_capacity_exceeded: t("More matches than the court can hold"),
    team_blackout: t("Team has a blackout that day"),
    closing_round_too_early: t("Closing round scheduled too early"),
    non_closing_round_too_late: t("Non-closing round scheduled on the final days"),
    phase_out_of_order: t("Finish phase played out of order"),
    pinned_round_venue: t("Round must be played on its pinned venue"),
    linked_team_overlap: t("Shared player would overlap"),
  };
  return (
    map[code] ?? code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function fmtSlot(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function EditFixturePage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Draft>(() => loadDraft(id));
  const [report, setReport] = useState<FixtureValidationReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const query = useQuery({
    queryKey: ["fixture-edit", id],
    queryFn: () => tournamentsApi.fixtureEdit(id),
  });
  const payload = query.data;

  const persist = useCallback(
    (next: Draft) => {
      setDraft(next);
      try {
        localStorage.setItem(draftKey(id), JSON.stringify(next));
      } catch {
        /* storage full/unavailable — draft stays in memory */
      }
    },
    [id],
  );

  const discard = useCallback(() => {
    persist({ slots: {}, teams: {} });
    setReport(null);
  }, [persist]);

  // ---- merged view: payload rows with the DRAFT laid over them ----------
  const merged = useMemo(() => {
    if (!payload) return [];
    return payload.matches.map((m): FixtureEditMatch => {
      const sd = draft.slots[m.id];
      const td = draft.teams[m.id];
      let out = m;
      if (sd) {
        out = {
          ...out,
          scheduled_at: sd.start ?? out.scheduled_at,
          court_id: sd.court_id ?? out.court_id,
          venue:
            sd.court_id != null
              ? (payload?.courts.find((c) => c.id === sd.court_id)?.name ??
                out.venue)
              : (sd.venue ?? out.venue),
        };
      }
      if (td && payload) {
        const find = (tid: string | null | undefined) => {
          if (tid == null) return null;
          // Prefer the ORIGINAL row (full MiniTeam shape incl. crest).
          const orig = payload.matches.find(
            (x) =>
              x.home_team?.id === tid ||
              x.away_team?.id === tid,
          );
          const fromOrig =
            orig?.home_team?.id === tid
              ? orig.home_team
              : orig?.away_team?.id === tid
                ? orig.away_team
                : null;
          if (fromOrig) return fromOrig;
          for (const list of Object.values(payload.teams_by_leaf)) {
            const hit = list.find((x) => x.id === tid);
            if (hit)
              return { ...hit, short_name: hit.name.slice(0, 12), crest: "" };
          }
          return null;
        };
        if ("home" in td)
          out = { ...out, home_team: find(td.home) ?? out.home_team };
        if ("away" in td)
          out = { ...out, away_team: find(td.away) ?? out.away_team };
      }
      return out;
    });
  }, [payload, draft]);

  const groupMatches = useMemo(
    () => merged.filter((m) => m.stage !== "knockout"),
    [merged],
  );
  const knockoutMatches = useMemo(
    () => merged.filter((m) => m.stage === "knockout"),
    [merged],
  );

  const timeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of merged) if (m.scheduled_at) set.add(m.scheduled_at);
    return [...set].sort();
  }, [merged]);

  const matchNos = useMemo(
    () => new Map(merged.map((m) => [m.id, m.match_no] as const)),
    [merged],
  );

  const dirtyCount =
    Object.keys(draft.slots).length + Object.keys(draft.teams).length;

  const buildEdits = (): FixtureEdits => ({
    slots: Object.entries(draft.slots).map(([match_id, s]) => ({
      match_id,
      start: s.start ?? "",
      ...(s.court_id != null ? { court_id: s.court_id } : {}),
      ...(s.court_id == null && s.venue ? { venue: s.venue } : {}),
    })),
    teams: Object.entries(draft.teams).map(([match_id, tm]) => ({
      match_id,
      ...(tm as Record<string, string | null>),
    })),
  });

  const runCheck = async () => {
    setChecking(true);
    try {
      const r = await tournamentsApi.fixtureEditValidate(id, buildEdits());
      setReport(r);
    } finally {
      setChecking(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      await tournamentsApi.fixtureEditApply(id, {
        ...buildEdits(),
        event_id: crypto.randomUUID(),
      });
      qc.invalidateQueries({ queryKey: ["fixture-edit", id] });
      qc.invalidateQueries({ queryKey: qk.matches(id) });
      qc.invalidateQueries({ queryKey: ["control-room"] });
      discard();
      setReviewOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const setSlot = (matchId: string, patch: SlotDraft) => {
    const cur = draft.slots[matchId] ?? {};
    persist({
      ...draft,
      slots: { ...draft.slots, [matchId]: { ...cur, ...patch } },
    });
    setReport(null);
  };
  const setTeams = (matchId: string, patch: TeamDraft) => {
    const cur = draft.teams[matchId] ?? {};
    persist({
      ...draft,
      teams: { ...draft.teams, [matchId]: { ...cur, ...patch } },
    });
    setReport(null);
  };
  /** Drag row A onto row B ⇒ swap their slots (the classic repair verb). */
  const swapSlots = (aId: string, bId: string) => {
    if (aId === bId) return;
    const a = merged.find((m) => m.id === aId);
    const b = merged.find((m) => m.id === bId);
    if (!a || !b || !a.editable || !b.editable) return;
    const next: Draft = { slots: { ...draft.slots }, teams: { ...draft.teams } };
    next.slots[aId] = {
      ...(next.slots[aId] ?? {}),
      start: b.scheduled_at ?? "",
      court_id: b.court_id ?? undefined,
    };
    next.slots[bId] = {
      ...(next.slots[bId] ?? {}),
      start: a.scheduled_at ?? "",
      court_id: a.court_id ?? undefined,
    };
    persist(next);
    setReport(null);
  };

  const violationsByMatch = useMemo(() => {
    const map = new Map<string, FixtureViolation[]>();
    for (const v of report?.violations ?? []) {
      for (const key of [v.match_id, v.other_match_id]) {
        if (key) {
          map.set(key, [...(map.get(key) ?? []), v]);
        }
      }
    }
    return map;
  }, [report]);

  const newHardCount = useMemo(
    () => (report?.new_violations ?? []).filter((v) => v.hard !== false).length,
    [report],
  );

  if (query.isLoading || !payload) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="h-10 w-64 animate-pulse rounded-lg bg-muted" />
        <div className="h-96 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }

  const editTarget = params.get("m");

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header + draft state */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="page-title">{t("Edit fixture")}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t(
              "Changes stay a DRAFT until you review and submit. Every value is picked from a list; rules are checked before anything lands.",
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {dirtyCount > 0 ? (
            <>
              <span className="rounded-full bg-warning-muted px-2.5 py-1 text-xs font-medium text-warning">
                {t("Draft")} ·{" "}
                {t(`${dirtyCount} pending change${dirtyCount === 1 ? "" : "s"}`)}
              </span>
              <Button variant="outline" size="sm" onClick={discard}>
                <RotateCcw aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                {t("Discard")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={checking}
                onClick={runCheck}
              >
                <History aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                {checking ? t("Checking…") : t("Check rules")}
              </Button>
              <Button size="sm" onClick={() => setReviewOpen(true)}>
                <ClipboardCheck aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                {t("Review & submit")}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* Validation report */}
      {report ? (
        <div
          role="status"
          className={cn(
            "rounded-xl border p-4 text-sm",
            newHardCount > 0
              ? "border-destructive/40 bg-destructive/5"
              : "border-border bg-card",
          )}
        >
          <p className="font-medium">
            {newHardCount > 0
              ? t(`${newHardCount} rule violation(s) created by this draft`)
              : t("No new rule violations — this draft respects every rule.")}
          </p>
          {report.violations.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {report.violations.map((v, i) => (
                <li
                  key={i}
                  className={cn(
                    "flex items-center gap-2",
                    v.pre_existing && "text-muted-foreground",
                  )}
                >
                  <AlertTriangle
                    aria-hidden="true"
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      v.pre_existing ? "text-muted-foreground" : "text-warning",
                    )}
                  />
                  <span className="font-medium">{humanizeCode(v.code)}</span>
                  <span className="font-tabular text-xs text-muted-foreground">
                    {v.at ? fmtSlot(v.at) : v.date ? v.date : ""}
                    {v.pre_existing ? ` · ${t("already broken today")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* GROUP STAGE — table */}
      <section className="rounded-xl border border-border bg-card shadow-sm">
        <header className="border-b border-border px-4 py-3">
          <h2 className="font-semibold">{t("Group stage")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Pick times, courts and teams from the lists — or drag a row onto another to swap their slots.",
            )}
          </p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[62rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t("No")}</th>
                <th className="px-3 py-2 font-medium">{t("Group")}</th>
                <th className="px-3 py-2 font-medium">{t("Time")}</th>
                <th className="px-3 py-2 font-medium">{t("Court")}</th>
                <th className="px-3 py-2 font-medium">{t("Home")}</th>
                <th className="px-3 py-2 font-medium">{t("Away")}</th>
                <th className="px-3 py-2 font-medium">{t("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {groupMatches.map((m) => {
                const changed = draft.slots[m.id] || draft.teams[m.id];
                const teams =
                  payload.teams_by_leaf[m.leaf_key] ??
                  payload.teams_by_leaf[""] ??
                  [];
                const vlist = violationsByMatch.get(m.id) ?? [];
                const hasNew = vlist.some((v) => !v.pre_existing);
                return (
                  <tr
                    key={m.id}
                    draggable={m.editable}
                    data-testid={`edit-row-${m.match_no}`}
                    onDragStart={(e) =>
                      e.dataTransfer.setData("text/match-id", m.id)
                    }
                    onDragOver={
                      m.editable
                        ? (e) => e.preventDefault()
                        : undefined
                    }
                    onDrop={
                      m.editable
                        ? (e) => {
                            e.preventDefault();
                            const other = e.dataTransfer.getData("text/match-id");
                            if (other) swapSlots(other, m.id);
                          }
                        : undefined
                    }
                    className={cn(
                      "border-b border-border/60",
                      m.editable && "cursor-grab hover:bg-secondary/40",
                      !m.editable && "opacity-60",
                      hasNew && "bg-destructive/5",
                    )}
                  >
                    <td className="px-3 py-2 font-tabular">{m.match_no}</td>
                    <td className="max-w-[14rem] truncate px-3 py-2">
                      {m.group_label || humanizeLeaf(m.leaf_key) || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        size="sm"
                        aria-label={t("Time slot")}
                        value={m.scheduled_at ?? ""}
                        disabled={!m.editable}
                        onChange={(v) => setSlot(m.id, { start: v })}
                        options={[
                          ...(m.scheduled_at
                            ? [
                                {
                                  value: m.scheduled_at,
                                  label: fmtSlot(m.scheduled_at),
                                },
                              ]
                            : []),
                          ...timeOptions
                            .filter((ts) => ts !== m.scheduled_at)
                            .map((ts) => ({ value: ts, label: fmtSlot(ts) })),
                        ]}
                      />
                      {changed ? (
                        <span className="mt-1 block text-[11px] font-medium text-warning">
                          {t("edited")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        size="sm"
                        aria-label={t("Court")}
                        value={m.court_id ?? ""}
                        disabled={!m.editable}
                        searchable
                        onChange={(v) =>
                          setSlot(
                            m.id,
                            v === ""
                              ? { court_id: "", venue: "" }
                              : { court_id: v },
                          )
                        }
                        options={[
                          { value: "", label: t("Unassigned") },
                          ...payload.courts.map((c) => ({
                            value: c.id,
                            label: c.name,
                          })),
                        ]}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {m.home_editable ? (
                        <Select
                          size="sm"
                          aria-label={t("Home team")}
                          value={m.home_team?.id ?? ""}
                          disabled={!m.editable}
                          searchable
                          onChange={(v) =>
                            setTeams(m.id, { home: v === "" ? null : v })
                          }
                          options={[
                            { value: "", label: t("TBD") },
                            ...teams.map((tm) => ({
                              value: tm.id,
                              label: tm.name,
                            })),
                          ]}
                        />
                      ) : (
                        <span className="text-xs italic text-muted-foreground">
                          {sideWaiting(m, "home", matchNos)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {m.away_editable ? (
                        <Select
                          size="sm"
                          aria-label={t("Away team")}
                          value={m.away_team?.id ?? ""}
                          disabled={!m.editable}
                          searchable
                          onChange={(v) =>
                            setTeams(m.id, { away: v === "" ? null : v })
                          }
                          options={[
                            { value: "", label: t("TBD") },
                            ...teams.map((tm) => ({
                              value: tm.id,
                              label: tm.name,
                            })),
                          ]}
                        />
                      ) : (
                        <span className="text-xs italic text-muted-foreground">
                          {sideWaiting(m, "away", matchNos)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs capitalize text-muted-foreground">
                      {m.status}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* KNOCKOUT — flow-chart view */}
      {knockoutMatches.length > 0 ? (
        <section className="rounded-xl border border-border bg-card shadow-sm">
          <header className="border-b border-border px-4 py-3">
            <h2 className="font-semibold">{t("Knockout")}</h2>
            <p className="text-xs text-muted-foreground">
              {t(
                "The draw as a tree. Click a card to re-slot it — sides fed by another match's winner or loser are decided on the court, not here.",
              )}
            </p>
          </header>
          <div className="p-4">
            <BracketView
              matches={knockoutMatches}
              timeZone={payload.time_zone}
              linkFor={(m) => `?m=${m.id}`}
            />
          </div>
        </section>
      ) : null}

      {/* Knockout card editor */}
      <KnockoutEditorDialog
        match={knockoutMatches.find((m) => m.id === editTarget) ?? null}
        payload={payload}
        matchNos={matchNos}
        onClose={() => {
          const next = new URLSearchParams(params);
          next.delete("m");
          setParams(next, { replace: true });
        }}
        onSetSlot={setSlot}
        violations={violationsByMatch}
      />

      {/* Review & submit */}
      <Dialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        ariaLabel={t("Review fixture changes")}
      >
        <DialogHeader>
          <DialogTitle>{t("Review fixture changes")}</DialogTitle>
          <DialogDescription>
            {t(
              "Nothing has been applied yet. Confirming writes these changes to the real fixture in one step (the previous fixture is snapshotted first).",
            )}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-sm">
          {Object.keys(draft.slots).length > 0 ? (
            <li className="font-medium">
              {t(`Slot moves: ${Object.keys(draft.slots).length}`)}
            </li>
          ) : null}
          {Object.keys(draft.teams).length > 0 ? (
            <li className="font-medium">
              {t(`Team changes: ${Object.keys(draft.teams).length}`)}
            </li>
          ) : null}
          {(report?.new_violations ?? []).map((v, i) => (
            <li key={`v${i}`} className="flex items-center gap-2 text-warning">
              <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
              {humanizeCode(v.code)}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => setReviewOpen(false)}>
            {t("Keep editing")}
          </Button>
          <Button
            disabled={submitting}
            onClick={() => void submit()}
            data-testid="confirm-fixture-apply"
          >
            {submitting ? t("Applying…") : t("Confirm & apply")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

function sideWaiting(
  m: FixtureEditMatch,
  side: "home" | "away",
  matchNos: Map<string, number>,
): string {
  const src = side === "home" ? m.home_source : m.away_source;
  const type = src?.type;
  const no = src && "match_id" in src ? matchNos.get(String(src.match_id)) : undefined;
  if (type === "winner_of")
    return no ? t(`Winner of M${no}`) : t("Winner of an earlier match");
  if (type === "loser_of")
    return no ? t(`Loser of M${no}`) : t("Loser of an earlier match");
  if (type === "group_position")
    return t(`${(src as { group_label?: string }).group_label ?? "Group"} place`);
  return t("To be decided");
}

/** Time/court editor for ONE knockout card. Teams are read-only here when a
 * pointer feeds them; direct sides still get dropdowns. */
function KnockoutEditorDialog({
  match,
  payload,
  matchNos,
  onClose,
  onSetSlot,
  violations,
}: {
  match: FixtureEditMatch | null;
  payload: FixtureEditPayload;
  matchNos: Map<string, number>;
  onClose: () => void;
  onSetSlot: (id: string, patch: { start?: string; court_id?: string }) => void;
  violations: Map<string, FixtureViolation[]>;
}): React.ReactElement {
  const timeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of payload.matches) if (m.scheduled_at) set.add(m.scheduled_at);
    return [...set].sort();
  }, [payload.matches]);
  if (!match) return <></>;
  const vlist = violations.get(match.id) ?? [];

  return (
    <Dialog open={!!match} onOpenChange={(o) => !o && onClose()} ariaLabel={t("Edit match")}>
      <DialogHeader>
        <DialogTitle>{`M${match.match_no}`}</DialogTitle>
        <DialogDescription>
          {match.home_team?.name ?? sideWaiting(match, "home", matchNos)}
          {" vs "}
          {match.away_team?.name ?? sideWaiting(match, "away", matchNos)}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3 py-1">
        <label className="block text-sm font-medium" htmlFor="ko-time">
          {t("Time slot")}
        </label>
        <Select
          id="ko-time"
          value={match.scheduled_at ?? ""}
          onChange={(v) => onSetSlot(match.id, { start: v })}
          options={timeOptions.map((ts) => ({ value: ts, label: fmtSlot(ts) }))}
        />
        <label className="block text-sm font-medium" htmlFor="ko-court">
          {t("Court")}
        </label>
        <Select
          id="ko-court"
          value={match.court_id ?? ""}
          searchable
          onChange={(v) => onSetSlot(match.id, v === "" ? { court_id: "" } : { court_id: v })}
          options={[
            { value: "", label: t("Unassigned") },
            ...payload.courts.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        {vlist.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {vlist.map((v, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0 text-warning" />
                {humanizeCode(v.code)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <DialogFooter>
        <Button onClick={onClose}>{t("Done")}</Button>
      </DialogFooter>
    </Dialog>
  );
}

