import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  History,
  RotateCcw,
  Users,
} from "lucide-react";
import {
  tournamentsApi,
  type FixtureEditMatch,
  type FixtureEditPayload,
  type FixtureEdits,
  type FixtureValidationReport,
  type FixtureViolation,
  type MiniTeam,
} from "@/api/tournaments";
import type { RosterIndex } from "@/features/fixtures/publicTournament";
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
 * The fixture EDIT workbench (owner ask, 2026-08-23; spreadsheet re-cut same
 * day). One dedicated page, shaped like the tool a host actually knows:
 *
 * - BOOKMARK TABS per sport — each game gets its own tab, exactly grouped.
 * - Inside a tab, one SPREADSHEET per COURT — the day reads top-to-bottom
 *   like a printed session sheet. An extra sheet catches unassigned slots.
 * - GROUP matches carry a GROUP BAND row (Group A …) with that group's teams'
 *   matches nested beneath it.
 * - REAL spreadsheet columns — every column edge drags to resize, widths
 *   remembered per table.
 * - NO free text anywhere: times come from the fixture's own slots, courts
 *   from court rows, sides from the competition's registered teams. Dragging
 *   a row onto another swaps their slots.
 * - KNOCKOUT renders as the flow-chart tree (the public BracketView); click a
 *   card to edit it. Pointer-fed sides are read-only (invariant 9).
 * - NOTHING touches the real fixture until review + confirm: edits live in a
 *   DRAFT (persisted), validated against the full rule set, applied in one
 *   atomic step with a pre-change snapshot.
 */

type SlotDraft = { start?: string; court_id?: string; venue?: string };
type TeamDraft = { home?: string | null; away?: string | null };

const draftKey = (id: string) => `fixture-edit-draft-${id}`;
const colWidthsKey = (id: string) => `fixture-edit-colwidths-${id}`;

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

function loadWidths(id: string): Record<string, number[]> {
  try {
    const raw = localStorage.getItem(colWidthsKey(id));
    if (raw) return JSON.parse(raw) as Record<string, number[]>;
  } catch {
    /* ignore */
  }
  return {};
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
    non_closing_round_too_late: t(
      "Non-closing round scheduled on the final days",
    ),
    phase_out_of_order: t("Finish phase played out of order"),
    pinned_round_venue: t("Round must be played on its pinned venue"),
    linked_team_overlap: t("Shared player would overlap"),
    insufficient_student_rest: t("Student has too little rest"),
  };
  return (
    map[code] ??
    code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
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

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ---------------------------------------------------------------------------
// Resizable-column primitives — a real spreadsheet lets you widen a column by
// dragging its edge, and remembers it.
// ---------------------------------------------------------------------------

const MIN_COL = 56;

function ColumnResizeHandle({
  onDelta,
}: {
  onDelta: (dx: number) => void;
}): React.ReactElement {
  const start = useRef<number | null>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    start.current = e.clientX;
    const move = (ev: MouseEvent) => {
      if (start.current == null) return;
      onDelta(ev.clientX - start.current);
      start.current = ev.clientX;
    };
    const up = () => {
      start.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={t("Resize column")}
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-0 z-10 flex h-full w-2 cursor-col-resize touch-none items-center justify-center opacity-0 transition-opacity hover:opacity-100 group-th:hover:opacity-60"
      data-testid="col-resizer"
    >
      <span className="h-6 w-[3px] rounded-full bg-primary/70" />
    </span>
  );
}

/** One spreadsheet table: fixed layout, per-column px widths, draggable
 * edges. Widths persist under `widthsId`. */
function SpreadTable({
  widthsId,
  columns,
  children,
  stored,
  onStore,
}: {
  widthsId: string;
  /** `[label, defaultPx]` per column. */
  columns: [string, number][];
  children: React.ReactNode;
  stored: Record<string, number[]>;
  onStore: (id: string, widths: number[]) => void;
}): React.ReactElement {
  const widths = useMemo(() => {
    const saved = stored[widthsId];
    return columns.map(([, def], i) =>
      typeof saved?.[i] === "number" && saved[i] >= MIN_COL ? saved[i] : def,
    );
  }, [columns, stored, widthsId]);

  const resize = (i: number, dx: number) => {
    const next = [...widths];
    next[i] = Math.max(MIN_COL, next[i] + dx);
    onStore(widthsId, next);
  };

  return (
    <table
      className="w-full table-fixed border-collapse text-sm"
      style={{ minWidth: widths.reduce((a, b) => a + b, 0) }}
      data-testid={`sheet-${widthsId}`}
    >
      <thead>
        <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          {columns.map(([label], i) => (
            <th
              key={i}
              // `group-th` lets the handle appear on hover of THIS cell only.
              className="group-th relative select-none px-3 py-2 font-medium"
              style={{ width: widths[i], minWidth: widths[i] }}
            >
              {label}
              <ColumnResizeHandle onDelta={(dx) => resize(i, dx)} />
            </th>
          ))}
        </tr>
      </thead>
      {children}
    </table>
  );
}

// ---------------------------------------------------------------------------

export function EditFixturePage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Draft>(() => loadDraft(id));
  const [storedWidths, setStoredWidths] = useState<Record<string, number[]>>(() =>
    loadWidths(id),
  );
  const [report, setReport] = useState<FixtureValidationReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeSport, setActiveSport] = useState<string>("");
  const [showStudents, setShowStudents] = useState(false);

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

  const storeWidths = useCallback(
    (tableId: string, widths: number[]) => {
      setStoredWidths((prev) => {
        const next = { ...prev, [tableId]: widths };
        try {
          localStorage.setItem(colWidthsKey(id), JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
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
    const findTeam = (tid: string | null | undefined): MiniTeam | null => {
      if (tid == null) return null;
      // Prefer an ORIGINAL row (full MiniTeam incl. crest).
      const orig = payload.matches.find(
        (x) => x.home_team?.id === tid || x.away_team?.id === tid,
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
        if (hit) return { ...hit, short_name: hit.name.slice(0, 12), crest: "" };
      }
      return null;
    };
    return payload.matches.map((m): FixtureEditMatch => {
      const sd = draft.slots[m.id];
      const td = draft.teams[m.id];
      let out = m;
      if (sd) {
        out = {
          ...out,
          scheduled_at: sd.start ?? out.scheduled_at,
          court_id: sd.court_id != null && sd.court_id !== "" ? sd.court_id : out.court_id,
          venue:
            sd.court_id != null && sd.court_id !== ""
              ? (payload.courts.find((c) => c.id === sd.court_id)?.name ??
                out.venue)
              : (sd.venue ?? out.venue),
        };
      }
      if (td) {
        if ("home" in td) out = { ...out, home_team: findTeam(td.home) ?? out.home_team };
        if ("away" in td) out = { ...out, away_team: findTeam(td.away) ?? out.away_team };
      }
      return out;
    });
  }, [payload, draft]);

  // ---- SPORT TABS --------------------------------------------------------
  const sports = useMemo(() => {
    const keys: string[] = [];
    for (const m of merged) {
      if (m.sport && !keys.includes(m.sport)) keys.push(m.sport);
      if (!m.sport && !keys.includes("")) keys.push("");
    }
    return keys;
  }, [merged]);

  const sportLabel = useCallback(
    (key: string) => {
      if (!payload) return key || t("General");
      // The SPORT name comes from the tournament's sports list — a leaf label
      // only names a category ("U-14 · Boys · Singles"), never the game.
      const sport = payload.sports?.find((sp) => sp.key === key);
      if (sport?.name) return sport.name;
      if (!key) return t("General");
      return key.replace(/_/g, " ");
    },
    [payload],
  );

  // An unset tab falls back to the FIRST sport — derived, never an effect.
  const effectiveSport = activeSport || sports[0] || "";
  const activeMatches = useMemo(
    () => merged.filter((m) => (m.sport || "") === effectiveSport),
    [merged, effectiveSport],
  );
  const activeGroup = useMemo(
    () => activeMatches.filter((m) => m.stage !== "knockout"),
    [activeMatches],
  );
  const activeKnockout = useMemo(
    () => activeMatches.filter((m) => m.stage === "knockout"),
    [activeMatches],
  );

  /** Court sections, in the payload's own court order; unmatched courts last;
   * unassigned slots get their own sheet at the end. */
  const courtSheets = useMemo(() => {
    if (!payload) return [];
    const buckets = new Map<string, FixtureEditMatch[]>();
    for (const m of activeGroup) {
      const key = m.court_id ?? "";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(m);
    }
    const ordered: { courtId: string; name: string; matches: FixtureEditMatch[] }[] =
      [];
    for (const c of payload.courts) {
      const list = buckets.get(c.id);
      if (list?.length) {
        ordered.push({ courtId: c.id, name: c.name, matches: list });
        buckets.delete(c.id);
      }
    }
    for (const [key, list] of buckets) {
      ordered.push({
        courtId: key,
        name: key ? t("Other courts") : t("No court assigned"),
        matches: list,
      });
    }
    return ordered;
  }, [activeGroup, payload]);

  const timeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of merged) if (m.scheduled_at) set.add(m.scheduled_at);
    return [...set].sort();
  }, [merged]);

  const matchNos = useMemo(
    () => new Map(merged.map((m) => [m.id, m.match_no] as const)),
    [merged],
  );

  /** Team -> students, in the shape BracketView's detailed cards read. */
  const rosterIndex: RosterIndex = useMemo(() => {
    const map: RosterIndex = new Map();
    for (const [teamId, players] of Object.entries(
      payload?.players_by_team ?? {},
    )) {
      map.set(
        teamId,
        players.map((p) => ({
          id: p.id,
          name: p.name,
          jersey_no: p.jersey_no,
          captain: p.captain,
        })),
      );
    }
    return map;
  }, [payload]);

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

  // The rule check re-runs BY ITSELF whenever the fixture or the draft moves,
  // so every row's status chip below is live — including breaks that were
  // already in the fixture before anyone touched this page.
  const checkSeq = useRef(0);
  useEffect(() => {
    if (!payload) return;
    const mine = ++checkSeq.current;
    const timer = window.setTimeout(() => {
      void tournamentsApi
        .fixtureEditValidate(id, buildEdits())
        .then((r) => {
          if (checkSeq.current === mine) setReport(r);
        })
        .catch(() => {
          /* transient — the manual Check button can retry */
        });
    }, 600);
    return () => window.clearTimeout(timer);
    // buildEdits reads draft/payload; the two deps cover it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, draft, id]);

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
        if (key) map.set(key, [...(map.get(key) ?? []), v]);
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
    // ONE section: header, rule status, sport tabs and every sheet live in
    // this single card - the workbench is one object on the page.
    <div className="flex w-full flex-col px-4 py-6 sm:px-6 lg:px-8">
      <div className="rounded-xl border border-border bg-card shadow-sm">
      {/* Header + draft state */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
        <div>
          <h1 className="page-title">{t("Edit fixture")}</h1>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant={showStudents ? "default" : "outline"}
            size="sm"
            aria-pressed={showStudents}
            onClick={() => setShowStudents((v) => !v)}
            data-testid="show-students"
          >
            <Users aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            {t("Show students")}
          </Button>
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
            "m-4 rounded-xl border p-4 text-sm",
            newHardCount > 0
              ? "border-destructive/40 bg-destructive/5"
              : "border-border bg-card",
          )}
        >
          <div className="flex flex-wrap items-center gap-4">
            <p className="font-medium">
              {newHardCount > 0
                ? t(`${newHardCount} rule violation(s) created by this draft`)
                : t("No new rule violations — this draft respects every rule.")}
            </p>
            <span className="font-tabular text-xs text-muted-foreground">
              {report.violations.filter((v) => v.pre_existing).length}{" "}
              {t("pre-existing")} ·{" "}
              {report.violations.filter((v) => !v.pre_existing).length}{" "}
              {t("new")} · {checking ? t("checking…") : t("up to date")}
            </span>
          </div>
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
                  {v.student ? (
                    <span className="text-xs">{String(v.student)}</span>
                  ) : null}
                  <span className="font-tabular text-xs text-muted-foreground">
                    {v.gap_minutes != null
                      ? t(`${v.gap_minutes} min gap · needs ${v.required_minutes}`)
                      : v.at
                        ? fmtSlot(v.at)
                        : (v.date ?? "")}
                    {v.pre_existing ? ` · ${t("already broken today")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* SPORT BOOKMARK TABS */}
      {sports.length > 1 ? (
        <div
          role="tablist"
          aria-label={t("Sports")}
          className="-mb-px flex gap-1 overflow-x-auto border-b border-border px-3 pt-1"
          data-testid="sport-tabs"
        >
          {sports.map((key) => {
            const active = key === effectiveSport;
            return (
              <button
                key={key || "_"}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setActiveSport(key)}
                className={cn(
                  "-mb-px whitespace-nowrap rounded-t-lg border border-b-0 px-4 py-2 text-sm font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-border bg-card text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                )}
              >
                {sportLabel(key)}
                <span className="ml-1 inline font-tabular text-xs text-muted-foreground">
                  {merged.filter((m) => (m.sport || "") === key).length}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* COURT SHEETS for the active sport */}
      <div className="flex flex-col gap-5 p-4">
        {courtSheets.length === 0 && activeKnockout.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t("No matches in this sport yet.")}
          </p>
        ) : null}

        {courtSheets.map((sheet) => (
          <CourtSheet
            key={sheet.courtId || "__none__"}
            sheetName={sheet.name}
            matches={[...sheet.matches].sort((a, b) =>
              (a.group_label || "").localeCompare(b.group_label || "") ||
              (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""),
            )}
            widthsId={`${activeSport}:${sheet.courtId || "none"}`}
            stored={storedWidths}
            onStore={storeWidths}
            draft={draft}
            showStudents={showStudents}
            playersByTeam={payload.players_by_team ?? {}}
            timeOptions={timeOptions}
            teamsFor={(leafKey) =>
              payload.teams_by_leaf[leafKey] ?? payload.teams_by_leaf[""] ?? []
            }
            violationsByMatch={violationsByMatch}
            onSetSlot={setSlot}
            onSetTeams={setTeams}
            onSwap={swapSlots}
          />
        ))}

        {/* KNOCKOUT — flow-chart view, still scoped to this sport tab */}
        {activeKnockout.length > 0 ? (
          <section>
            <header className="mb-2">
              <h3 className="font-semibold">{t("Knockout")}</h3>
            </header>
            {/* wrapNames grows every card until the LONGEST school name fits
                and wraps - no more truncated "Grace Academy Higher Secondar…".
                The scroll container keeps it responsive on a phone. */}
            <div className="-mx-1 overflow-x-auto px-1 pb-1">
              <BracketView
                matches={activeKnockout}
                timeZone={payload.time_zone}
                /* The FIXTURE numbering (the same # as the Matches board and
                   every court sheet) - not the tree's own positional count,
                   so "M53" here IS match 53 everywhere else. */
                matchNumbers={matchNos}
                linkFor={(m) => `?m=${m.id}`}
                wrapNames
                editIcon
                /* Students on the cards ONLY while the toggle is on - the
                   same switch that reveals them in the court sheets. */
                rosters={showStudents ? rosterIndex : undefined}
              />
            </div>
          </section>
        ) : null}
      </div>

      {/* Knockout card editor */}
      <KnockoutEditorDialog
        match={merged.find((m) => m.id === editTarget) ?? null}
        payload={payload}
        matchNos={matchNos}
        onClose={() => {
          const next = new URLSearchParams(params);
          next.delete("m");
          setParams(next, { replace: true });
        }}
        onSetSlot={setSlot}
        onSetTeams={setTeams}
        violations={violationsByMatch}
      />

      </div>

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

// ---------------------------------------------------------------------------
// One COURT'S spreadsheet. Group-stage matches sit under GROUP BAND rows so
// the sheet reads "Group A" then its teams' matches, exactly like a wall
// sheet. Knockout rows (if any landed on this court) follow their own band.
// ---------------------------------------------------------------------------

function CourtSheet({
  sheetName,
  matches,
  widthsId,
  stored,
  onStore,
  draft,
  showStudents,
  playersByTeam,
  timeOptions,
  teamsFor,
  violationsByMatch,
  onSetSlot,
  onSetTeams,
  onSwap,
}: {
  sheetName: string;
  matches: FixtureEditMatch[];
  widthsId: string;
  stored: Record<string, number[]>;
  onStore: (id: string, widths: number[]) => void;
  draft: Draft;
  showStudents: boolean;
  playersByTeam: Record<
    string,
    { id: string; name: string; jersey_no: number | null; captain: boolean }[]
  >;
  timeOptions: string[];
  teamsFor: (leafKey: string) => { id: string; name: string }[];
  violationsByMatch: Map<string, FixtureViolation[]>;
  onSetSlot: (id: string, patch: SlotDraft) => void;
  onSetTeams: (id: string, patch: TeamDraft) => void;
  onSwap: (aId: string, bId: string) => void;
}): React.ReactElement | null {
  const COLUMNS: [string, number][] = [
    [t("No"), 64],
    [t("Time"), 110],
    [t("Category"), 190],
    [t("Home"), 240],
    [t("Away"), 240],
    [t("Status"), 100],
  ];

  // Band rows are computed ONCE per render into a flat list — no mutable
  // state shared across row renders.
  const rows = useMemo(() => {
    const out: ({ kind: "band"; label: string } | { kind: "match"; m: FixtureEditMatch })[] =
      [];
    let lastBand: string | null = null;
    for (const m of matches) {
      const isKo = m.stage === "knockout";
      const band = isKo
        ? t("Knockout")
        : m.group_label || humanizeLeaf(m.leaf_key) || t("General");
      if (band !== lastBand) {
        out.push({ kind: "band", label: band });
        lastBand = band;
      }
      out.push({ kind: "match", m });
    }
    return out;
  }, [matches]);

  if (matches.length === 0) return null;

  return (
    <section className="overflow-x-auto rounded-lg border border-border">
      <div className="sticky-header flex items-center justify-between border-b border-border bg-muted/60 px-3 py-2">
        <h3 className="font-semibold">{sheetName}</h3>
        <span className="font-tabular text-xs text-muted-foreground">
          {matches.length}
        </span>
      </div>
      <SpreadTable
        widthsId={widthsId}
        columns={COLUMNS}
        stored={stored}
        onStore={onStore}
      >
        <tbody>
          {rows.map((row) => {
            if (row.kind === "band") {
              return (
                <tr key={`band-${row.label}`}>
                  <td
                    colSpan={COLUMNS.length}
                    className="border-y border-border bg-secondary/50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-secondary-foreground"
                  >
                    {row.label}
                  </td>
                </tr>
              );
            }
            const m = row.m;
            const changed =
              draft.slots[m.id] &&
              (draft.slots[m.id].start || draft.slots[m.id].court_id != null);
            const teamsChanged =
              draft.teams[m.id] &&
              (("home" in draft.teams[m.id]) || ("away" in draft.teams[m.id]));
            const teams = teamsFor(m.leaf_key);
            const vlist = violationsByMatch.get(m.id) ?? [];
            const hasNew = vlist.some((v) => !v.pre_existing);
            return (
              <Fragment key={m.id}>
                <tr
                  draggable={m.editable}
                  data-testid={`edit-row-${m.match_no}`}
                  onDragStart={(e) =>
                    e.dataTransfer.setData("text/match-id", m.id)
                  }
                  onDragOver={m.editable ? (e) => e.preventDefault() : undefined}
                  onDrop={
                    m.editable
                      ? (e) => {
                          e.preventDefault();
                          const other = e.dataTransfer.getData("text/match-id");
                          if (other) onSwap(other, m.id);
                        }
                      : undefined
                  }
                  className={cn(
                    "border-b border-border/60",
                    m.editable && "cursor-grab hover:bg-secondary/30",
                    !m.editable && "opacity-60",
                    hasNew && "bg-destructive/5",
                  )}
                >
                  <td className="px-3 py-1.5 font-tabular">{m.match_no}</td>
                  <td className="px-3 py-1.5">
                    <Select
                      size="sm"
                      aria-label={t("Time slot")}
                      value={m.scheduled_at ?? ""}
                      disabled={!m.editable}
                      onChange={(v) => onSetSlot(m.id, { start: v })}
                      options={[
                        ...(m.scheduled_at
                          ? [
                              {
                                value: m.scheduled_at,
                                label: fmtTime(m.scheduled_at),
                              },
                            ]
                          : []),
                        ...timeOptions
                          .filter((ts) => ts !== m.scheduled_at)
                          .map((ts) => ({ value: ts, label: fmtSlot(ts) })),
                      ]}
                    />
                    {changed || teamsChanged ? (
                      <span className="mt-0.5 block text-[11px] font-medium text-warning">
                        {t("edited")}
                      </span>
                    ) : null}
                  </td>
                  <td className="truncate px-3 py-1.5 text-xs text-muted-foreground">
                    {humanizeLeaf(m.leaf_key) || "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    {m.home_editable ? (
                      <Select
                        size="sm"
                        aria-label={t("Home team")}
                        value={m.home_team?.id ?? ""}
                        disabled={!m.editable}
                        searchable
                        onChange={(v) =>
                          onSetTeams(m.id, { home: v === "" ? null : v })
                        }
                        options={[
                          { value: "", label: t("TBD") },
                          ...teams.map((tm) => ({ value: tm.id, label: tm.name })),
                        ]}
                      />
                    ) : (
                      <span className="text-xs italic text-muted-foreground">
                        {sideWaiting(m, "home", matchNosOf(matches))}
                      </span>
                    )}
                    {showStudents && m.home_team ? (
                      <StudentList players={playersByTeam[m.home_team.id] ?? []} />
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5">
                    {m.away_editable ? (
                      <Select
                        size="sm"
                        aria-label={t("Away team")}
                        value={m.away_team?.id ?? ""}
                        disabled={!m.editable}
                        searchable
                        onChange={(v) =>
                          onSetTeams(m.id, { away: v === "" ? null : v })
                        }
                        options={[
                          { value: "", label: t("TBD") },
                          ...teams.map((tm) => ({ value: tm.id, label: tm.name })),
                        ]}
                      />
                    ) : (
                      <span className="text-xs italic text-muted-foreground">
                        {sideWaiting(m, "away", matchNosOf(matches))}
                      </span>
                    )}
                    {showStudents && m.away_team ? (
                      <StudentList players={playersByTeam[m.away_team.id] ?? []} />
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5">
                    <MatchRuleStatus
                      status={m.status}
                      violations={vlist}
                    />
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </SpreadTable>
    </section>
  );
}

/** The students ONE side fields, shown under a team cell while the
 * "Show students" toggle is on. */
function StudentList({
  players,
}: {
  players: {
    id: string;
    name: string;
    jersey_no: number | null;
    captain: boolean;
  }[];
}): React.ReactElement | null {
  if (players.length === 0) return null;
  return (
    <ul
      className="mt-1 space-y-0.5 border-t border-border/60 pt-1 text-[11px] leading-tight text-muted-foreground"
      data-testid="student-list"
    >
      {players.map((p) => (
        <li key={p.id} className="flex items-center gap-1">
          {p.jersey_no != null ? (
            <span className="font-tabular">{p.jersey_no}</span>
          ) : null}
          <span className="truncate">{p.name}</span>
          {p.captain ? <span title={t("Captain")}>©</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Per-match rule status: green tick when this match follows every rule;
 * otherwise a chip naming each break (red = created by the draft, amber =
 * already broken in the current fixture). */
function MatchRuleStatus({
  status,
  violations,
}: {
  status: string;
  violations: FixtureViolation[];
}): React.ReactElement {
  const fresh = violations.filter((v) => !v.pre_existing);
  const pre = violations.filter((v) => v.pre_existing);
  if (violations.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <CheckCircle2
          aria-hidden="true"
          className="h-3.5 w-3.5 text-success"
        />
        <span data-testid="rule-ok">{t("OK")}</span>
        {status !== "scheduled" ? (
          <span className="capitalize">· {status}</span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5">
      {fresh.length > 0 ? (
        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
          <AlertTriangle aria-hidden="true" className="h-3 w-3" />
          {humanizeCode(fresh[0].code)}
          {fresh.length > 1 ? ` +${fresh.length - 1}` : ""}
        </span>
      ) : null}
      {pre.length > 0 ? (
        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-warning-muted px-1.5 py-0.5 text-[11px] font-medium text-warning">
          <AlertTriangle aria-hidden="true" className="h-3 w-3" />
          {t("Existing")}: {humanizeCode(pre[0].code)}
          {pre.length > 1 ? ` +${pre.length - 1}` : ""}
        </span>
      ) : null}
    </span>
  );
}

/** match_no lookup scoped to one sheet — enough for pointer labels there. */
function matchNosOf(
  matches: FixtureEditMatch[],
): Map<string, number> {
  return new Map(matches.map((m) => [m.id, m.match_no] as const));
}

function sideWaiting(
  m: FixtureEditMatch,
  side: "home" | "away",
  matchNos: Map<string, number>,
): string {
  const src = side === "home" ? m.home_source : m.away_source;
  const type = src?.type;
  const no =
    src && "match_id" in src
      ? matchNos.get(String(src.match_id))
      : undefined;
  if (type === "winner_of")
    return no ? t(`Winner of M${no}`) : t("Winner of an earlier match");
  if (type === "loser_of")
    return no ? t(`Loser of M${no}`) : t("Loser of an earlier match");
  if (type === "group_position")
    return t(`${(src as { group_label?: string }).group_label ?? "Group"} place`);
  return t("To be decided");
}

/** Time/court editor for ONE knockout card. Teams read-only when pointer-fed. */
function KnockoutEditorDialog({
  match,
  payload,
  matchNos,
  onClose,
  onSetSlot,
  onSetTeams,
  violations,
}: {
  match: FixtureEditMatch | null;
  payload: FixtureEditPayload;
  matchNos: Map<string, number>;
  onClose: () => void;
  onSetSlot: (id: string, patch: { start?: string; court_id?: string }) => void;
  onSetTeams: (id: string, patch: TeamDraft) => void;
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
    <Dialog
      open={!!match}
      onOpenChange={(o) => !o && onClose()}
      ariaLabel={t("Edit match")}
    >
      <DialogHeader>
        <DialogTitle>{`M${match.match_no}`}</DialogTitle>
        <DialogDescription>
          {match.home_team?.name ?? sideWaiting(match, "home", matchNos)}
          {" vs "}
          {match.away_team?.name ?? sideWaiting(match, "away", matchNos)}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3 py-1">
        {/* Direct sides are editable here too - pointer sides stay read-only. */}
        {match.home_editable || match.away_editable ? (
          <div className="grid grid-cols-2 gap-3">
            {match.home_editable ? (
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor="ko-home">
                  {t("Home")}
                </label>
                <Select
                  id="ko-home"
                  size="sm"
                  searchable
                  value={match.home_team?.id ?? ""}
                  onChange={(v) =>
                    onSetTeams(match.id, { home: v === "" ? null : v })
                  }
                  options={[
                    { value: "", label: t("TBD") },
                    ...(payload.teams_by_leaf[match.leaf_key] ?? []).map(
                      (tm) => ({ value: tm.id, label: tm.name }),
                    ),
                  ]}
                />
              </div>
            ) : null}
            {match.away_editable ? (
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor="ko-away">
                  {t("Away")}
                </label>
                <Select
                  id="ko-away"
                  size="sm"
                  searchable
                  value={match.away_team?.id ?? ""}
                  onChange={(v) =>
                    onSetTeams(match.id, { away: v === "" ? null : v })
                  }
                  options={[
                    { value: "", label: t("TBD") },
                    ...(payload.teams_by_leaf[match.leaf_key] ?? []).map(
                      (tm) => ({ value: tm.id, label: tm.name }),
                    ),
                  ]}
                />
              </div>
            ) : null}
          </div>
        ) : null}
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
          onChange={(v) =>
            onSetSlot(match.id, v === "" ? { court_id: "" } : { court_id: v })
          }
          options={[
            { value: "", label: t("Unassigned") },
            ...payload.courts.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        {vlist.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {vlist.map((v, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <AlertTriangle
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 text-warning"
                />
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
