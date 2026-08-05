import { useId, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  ExternalLink,
  HelpCircle,
  MonitorPlay,
  Radio,
  Search,
  X,
} from "lucide-react";
import {
  streamingApi,
  type CourtStreamRow,
  type StreamLink,
} from "@/api/streaming";
import { tournamentsApi, type ControlRoomMatch } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import {
  fmtDayLabel,
  fmtKickoff,
  leafLabelOf,
  tzDate,
} from "@/features/controlroom/format";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import {
  effectiveCourtLink,
  findCategoryLink,
  findCourtDayLink,
  findMatchLink,
  sourceHint,
} from "./streamLinks";
import { FolderTabs } from "./FolderTabs";
import { LinkEditor, SourceChip } from "./StreamLinkEditor";

const PAGE_SIZE = 20;

/** Which list the panel is showing. One at a time: the three scopes are three
 * different jobs, and stacking them made a page nobody could scroll. */
type Tab = "courts" | "categories" | "matches";

/** Which target's editor is open. Editing happens in a dialog, so a list of a
 * hundred matches is a hundred rows, not a hundred open forms. */
type Editing =
  | { kind: "court"; court: CourtStreamRow }
  | { kind: "category"; leafKey: string; label: string }
  | { kind: "match"; match: ControlRoomMatch }
  | null;

/** A resolved URL as an opens-in-YouTube link (truncated, never wrapped). */
function WatchUrl({ url }: { url: string }): React.ReactElement {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-w-0 items-center gap-1 rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="truncate">{url}</span>
      <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
    </a>
  );
}

/** Small status chip; tone carries the meaning, never colour alone. */
function Chip({
  tone,
  children,
}: {
  tone: "on" | "off" | "muted";
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[0.6875rem] font-medium",
        tone === "on" && "bg-primary/12 text-primary",
        tone === "off" && "bg-warning-muted text-warning",
        tone === "muted" && "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/**
 * ONE row shape for all three scopes: what it is, what is in effect, and the
 * single control that opens its editor. Everything readable without opening
 * anything; nothing editable without asking.
 */
function LinkRow({
  testid,
  title,
  lead,
  chips,
  url,
  emptyLabel,
  emptyTestid,
  meta,
  actionLabel,
  onEdit,
}: {
  testid: string;
  title: string;
  /** Fixed-width leading cell (a kickoff time), optional. */
  lead?: string;
  chips?: React.ReactNode;
  url: string | null;
  emptyLabel: string;
  emptyTestid?: string;
  meta?: string;
  actionLabel: string;
  onEdit: () => void;
}): React.ReactElement {
  return (
    <div
      data-testid={testid}
      className="flex flex-col gap-1.5 px-4 py-2.5 transition-colors hover:bg-secondary/30 md:flex-row md:items-center md:gap-3"
    >
      <div className="flex min-w-0 items-center gap-2 md:w-[38%]">
        {lead ? (
          <span className="w-11 shrink-0 font-tabular text-xs font-semibold text-muted-foreground">
            {lead}
          </span>
        ) : null}
        <span className="truncate text-[13px] font-medium">{title}</span>
        {chips}
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        {url ? (
          <WatchUrl url={url} />
        ) : (
          <span
            data-testid={emptyTestid}
            className="text-xs text-muted-foreground"
          >
            {emptyLabel}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 md:justify-end">
        {meta ? (
          <span className="font-tabular text-xs text-muted-foreground">
            {meta}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          data-testid={`${testid}-edit`}
          onClick={onEdit}
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Operations — **Live streams**. The page an organiser opens each morning to
 * paste one YouTube link per court for the day, exactly as the owner described
 * the job: *"per court and per day there will be one live stream link that will
 * be used throughout the day; it can be updated, it's just a link."*
 *
 * Shape of the page (redesign, owner 2026-08-05 — the previous one stacked
 * every scope on one endless page with every input open at once):
 *
 * 1. **Pick a day.** The link is per court PER DAY, so the day comes first.
 * 2. **Pick a scope** — Courts, Competitions, Matches. One list at a time.
 * 3. **Read the list.** Each row says what is in effect and where it came from.
 * 4. **Open one editor.** Editing is a dialog on the row you chose; the Matches
 *    list is searchable, filterable and paged, so a 100-match day is 20 rows.
 *
 * Most specific wins, and every court row says which level it is currently
 * running on, because a court showing the category link or the standing default
 * is NOT the same as one with its own link for today.
 *
 * Manager-gated to match the server (`can_manage_tournament`): pasting a link
 * publishes a Watch live button on the public schedule.
 */
export function StreamLinksPage(): React.ReactElement {
  const { id = "" } = useParams();
  const { isMobile } = useBreakpoint();
  const [day, setDay] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("courts");
  const [editing, setEditing] = useState<Editing>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [linkFilter, setLinkFilter] = useState<"all" | "with" | "without">("all");
  const [courtFilter, setCourtFilter] = useState("all");
  const [page, setPage] = useState(0);

  const tournamentQ = useQuery({
    queryKey: qk.tournament(id),
    queryFn: () => tournamentsApi.get(id),
  });
  const stageQ = useQuery({
    queryKey: qk.stage(id),
    queryFn: () => tournamentsApi.stage(id),
  });
  const matchesQ = useQuery({
    queryKey: qk.matches(id),
    queryFn: () => tournamentsApi.matchesEnriched(id),
  });
  const courtsQ = useQuery({
    queryKey: qk.courtStreams(id),
    queryFn: () => streamingApi.courtStreams(id),
  });
  const linksQ = useQuery({
    queryKey: qk.streamLinks(id),
    queryFn: () => streamingApi.links(id),
  });

  const canManage = stageQ.data?.can_manage ?? false;
  const tz = tournamentQ.data?.time_zone ?? "UTC";
  const matches = useMemo(() => matchesQ.data ?? [], [matchesQ.data]);
  const courts = courtsQ.data?.court_streams ?? [];
  const links = useMemo(() => linksQ.data?.stream_links ?? [], [linksQ.data]);

  // Days of the fixture, in the TOURNAMENT's wall clock (invariant 14) — the
  // same key `StreamLink.day` is filed under.
  const days = useMemo(() => {
    const set = new Set<string>();
    for (const m of matches) {
      const d = tzDate(m.scheduled_at, tz);
      if (d) set.add(d);
    }
    return [...set].sort();
  }, [matches, tz]);
  const today = tzDate(new Date().toISOString(), tz);
  const selectedDay = day ?? days.find((d) => d >= today) ?? days[0] ?? today;

  const dayMatches = useMemo(
    () => matches.filter((m) => tzDate(m.scheduled_at, tz) === selectedDay),
    [matches, tz, selectedDay],
  );
  // `Court.name` IS the `Match.venue` display string, so the day's load per
  // court needs no extra lookup.
  const perCourt = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of dayMatches) {
      if (m.venue) counts.set(m.venue, (counts.get(m.venue) ?? 0) + 1);
    }
    return counts;
  }, [dayMatches]);

  const categories = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of matches) {
      if (m.leaf_key) map.set(m.leaf_key, leafLabelOf(m));
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [matches]);

  // The day's matches, narrowed by the toolbar and ordered by kickoff. Search
  // covers the two things an organiser has in front of them: a team name and a
  // court.
  const visibleMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return dayMatches
      .filter((m) => {
        if (courtFilter !== "all" && m.venue !== courtFilter) return false;
        const own = findMatchLink(links, m.id);
        if (linkFilter === "with" && !own) return false;
        if (linkFilter === "without" && own) return false;
        if (!q) return true;
        const hay = `${m.home_team?.name ?? ""} ${m.away_team?.name ?? ""} ${m.venue ?? ""}`;
        return hay.toLowerCase().includes(q);
      })
      .sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""));
  }, [dayMatches, search, courtFilter, linkFilter, links]);

  const pageCount = Math.max(1, Math.ceil(visibleMatches.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount - 1);
  const pageMatches = visibleMatches.slice(
    curPage * PAGE_SIZE,
    (curPage + 1) * PAGE_SIZE,
  );

  const dayCourts = useMemo(
    () => [...new Set(dayMatches.map((m) => m.venue).filter(Boolean))].sort(),
    [dayMatches],
  ) as string[];

  const matchLinkCount = dayMatches.filter((m) =>
    findMatchLink(links, m.id),
  ).length;
  const categoryLinkCount = categories.filter(([k]) =>
    findCategoryLink(links, k),
  ).length;

  const loading = courtsQ.isLoading || linksQ.isLoading || matchesQ.isLoading;

  // The page's own heading lives INSIDE the panel, with everything else
  // (owner 2026-08-05): a title and two paragraphs floating above the board
  // were three things to scroll past before the work began. The long version
  // of the explanation moved behind the help icon.
  const header = (
    <div className="flex flex-col gap-1 border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <Radio aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
        <h2 className="page-title">{t("Live streams")}</h2>
        <span className="font-tabular text-xs text-muted-foreground">
          {courts.length} {courts.length === 1 ? t("court") : t("courts")} ·{" "}
          {links.length} {links.length === 1 ? t("link") : t("links")}
        </span>
        <button
          type="button"
          data-testid="stream-help"
          aria-label={t("How live links work")}
          onClick={() => setHelpOpen(true)}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HelpCircle aria-hidden="true" className="h-4 w-4" />
        </button>
        {/* The way IN to filming a court. It was a collapsed disclosure on this
            page and the tournament owner could not find it twice — so it is a
            primary action now, and the instructions live on a page of their own
            that a volunteer can be sent to. */}
        <Link
          to={routes.tournamentStreamSetup(id)}
          data-testid="stream-setup-link"
          className="ml-auto inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <MonitorPlay aria-hidden="true" className="h-4 w-4" />
          {t("Set up a camera on a court")}
          <ChevronRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </div>
      <p data-testid="stream-setup-hint" className="text-xs text-muted-foreground">
        {t("One YouTube link per court, per day. The most specific link wins.")}
      </p>
    </div>
  );

  if (loading) {
    return (
      <div className="flex w-full flex-col gap-3">
        <section className="panel flex flex-col">
          {header}
          <div className="h-48 animate-pulse bg-muted/40" />
        </section>
      </div>
    );
  }

  if (courtsQ.isError) {
    return (
      <div className="flex w-full flex-col gap-3">
        <section className="panel flex flex-col">
          {header}
          <p role="alert" className="px-4 py-12 text-center text-sm text-muted-foreground">
            {t("Live streams are managed by the tournament's organisers.")}
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <section data-testid="stream-board" className="panel flex flex-col">
        {header}

        {/* Day picker — the link is per court PER DAY, so the day is the first
            thing chosen, not a filter tucked away. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t("Day")}
          </span>
          {days.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("Nothing is on the calendar yet.")}
            </span>
          ) : isMobile ? (
            <Select
              aria-label={t("Match day")}
              className="w-full"
              value={selectedDay}
              onChange={(v) => {
                setDay(v);
                setPage(0);
              }}
              options={days.map((d) => ({ value: d, label: fmtDayLabel(d) }))}
            />
          ) : (
            <div
              role="group"
              aria-label={t("Match day")}
              className="inline-flex w-fit flex-wrap items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5"
            >
              {days.map((d) => {
                const active = d === selectedDay;
                return (
                  <button
                    key={d}
                    type="button"
                    data-testid={`stream-day-${d}`}
                    aria-pressed={active}
                    onClick={() => {
                      setDay(d);
                      setPage(0);
                    }}
                    className={cn(
                      "inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {fmtDayLabel(d)}
                  </button>
                );
              })}
            </div>
          )}
          {!canManage ? (
            <span className="ml-auto text-xs text-muted-foreground">
              {t("Read only. Only organisers can change these links.")}
            </span>
          ) : null}
        </div>

        <FolderTabs
          ariaLabel={t("Link scope")}
          testidPrefix="stream-tab"
          value={tab}
          onChange={(next) => {
            setTab(next);
            setPage(0);
          }}
          tabs={[
            { key: "courts", label: t("Courts"), count: courts.length },
            { key: "categories", label: t("Competitions"), count: categories.length },
            { key: "matches", label: t("Matches"), count: dayMatches.length },
          ]}
        />

        {tab === "courts" ? (
          courts.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              {t("No courts yet. They appear once the fixtures are scheduled.")}
            </p>
          ) : (
            <>
              <p className="border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
                {t("One link per court for {day}.").replace(
                  "{day}",
                  fmtDayLabel(selectedDay),
                )}
              </p>
              <div className="divide-y divide-border">
                {courts.map((c) => {
                  const dayLink = findCourtDayLink(links, c.court_id, selectedDay);
                  const eff = effectiveCourtLink(
                    c,
                    dayLink,
                    selectedDay === today,
                  );
                  const count = perCourt.get(c.court_name) ?? 0;
                  return (
                    <LinkRow
                      key={c.court_id}
                      testid={`stream-court-${c.court_id}`}
                      title={c.court_name}
                      chips={
                        <>
                          <SourceChip
                            source={eff.source}
                            testid={`stream-source-${c.court_id}`}
                          />
                          {eff.overridden && eff.source !== "day" ? (
                            <Chip tone="off">{t("Saved but not applying")}</Chip>
                          ) : null}
                        </>
                      }
                      url={eff.url}
                      emptyLabel={t("nothing")}
                      emptyTestid={`stream-none-${c.court_id}`}
                      meta={
                        count > 0
                          ? `${count} ${count === 1 ? t("match") : t("matches")}`
                          : t("no matches")
                      }
                      actionLabel={dayLink ? t("Edit") : t("Set link")}
                      onEdit={() => setEditing({ kind: "court", court: c })}
                    />
                  );
                })}
              </div>
            </>
          )
        ) : null}

        {tab === "categories" ? (
          categories.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              {t("No competitions yet.")}
            </p>
          ) : (
            <>
              <p className="border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
                {t(
                  "Used by every match of that competition with no link of its own and no court link for its day.",
                )}{" "}
                <span className="font-tabular">
                  {categoryLinkCount} {t("of")} {categories.length} {t("set")}
                </span>
              </p>
              <div className="divide-y divide-border">
                {categories.map(([leafKey, label]) => {
                  const link = findCategoryLink(links, leafKey);
                  const live = link?.watch_url && link.enabled;
                  return (
                    <LinkRow
                      key={leafKey}
                      testid={`stream-category-${leafKey}`}
                      title={label}
                      chips={
                        link && link.watch_url && !link.enabled ? (
                          <Chip tone="off">{t("Switched off")}</Chip>
                        ) : null
                      }
                      url={live ? link.watch_url : null}
                      emptyLabel={t("No link")}
                      actionLabel={link ? t("Edit") : t("Set link")}
                      onEdit={() =>
                        setEditing({ kind: "category", leafKey, label })
                      }
                    />
                  );
                })}
              </div>
            </>
          )
        ) : null}

        {tab === "matches" ? (
          <>
            {/* A day is up to a hundred matches. The list is a list: search it,
                narrow it, page it — never a hundred open inputs. */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
              <div className="relative w-full min-w-0 sm:w-64">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  data-testid="stream-match-search"
                  className="h-9 pl-8"
                  placeholder={t("Search team or court…")}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                  aria-label={t("Search matches")}
                />
              </div>
              <Select
                aria-label={t("Court")}
                className="w-full sm:w-44"
                value={courtFilter}
                onChange={(v) => {
                  setCourtFilter(v);
                  setPage(0);
                }}
                options={[
                  { value: "all", label: t("All courts") },
                  ...dayCourts.map((c) => ({ value: c, label: c })),
                ]}
              />
              <Select
                aria-label={t("Link state")}
                className="w-full sm:w-44"
                value={linkFilter}
                onChange={(v) => {
                  setLinkFilter(v as "all" | "with" | "without");
                  setPage(0);
                }}
                options={[
                  { value: "all", label: t("All matches") },
                  { value: "with", label: t("Has its own link") },
                  { value: "without", label: t("No override") },
                ]}
              />
              <span className="ml-auto font-tabular text-xs text-muted-foreground">
                {matchLinkCount} {t("of")} {dayMatches.length} {t("overridden")}
              </span>
            </div>

            {visibleMatches.length === 0 ? (
              <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                {dayMatches.length === 0
                  ? t("No matches on this day.")
                  : t("No match here matches those filters.")}
              </p>
            ) : (
              <>
                <div className="divide-y divide-border">
                  {pageMatches.map((m) => {
                    const link = findMatchLink(links, m.id);
                    const live = link?.watch_url && link.enabled;
                    const title = `${m.home_team?.name ?? t("TBD")} v ${m.away_team?.name ?? t("TBD")}`;
                    return (
                      <LinkRow
                        key={m.id}
                        testid={`stream-match-${m.id}`}
                        lead={fmtKickoff(m.scheduled_at, tz)}
                        title={title}
                        chips={
                          link && link.watch_url && !link.enabled ? (
                            <Chip tone="off">{t("Switched off")}</Chip>
                          ) : live ? (
                            <Chip tone="on">{t("Own link")}</Chip>
                          ) : null
                        }
                        url={live ? link.watch_url : null}
                        emptyLabel={t("Follows its court")}
                        meta={m.venue ?? undefined}
                        actionLabel={link ? t("Edit") : t("Set link")}
                        onEdit={() => setEditing({ kind: "match", match: m })}
                      />
                    );
                  })}
                </div>
                {visibleMatches.length > PAGE_SIZE ? (
                  <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
                    <p className="font-tabular text-xs text-muted-foreground">
                      {curPage * PAGE_SIZE + 1}
                      {t(" to ")}
                      {Math.min(
                        (curPage + 1) * PAGE_SIZE,
                        visibleMatches.length,
                      )}{" "}
                      {t("of")} {visibleMatches.length}
                    </p>
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        data-testid="stream-prev"
                        disabled={curPage === 0}
                        onClick={() => setPage(curPage - 1)}
                        className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-xs font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                      >
                        {t("Previous")}
                      </button>
                      <span className="font-tabular text-xs text-muted-foreground">
                        {curPage + 1}/{pageCount}
                      </span>
                      <button
                        type="button"
                        data-testid="stream-next"
                        disabled={curPage >= pageCount - 1}
                        onClick={() => setPage(curPage + 1)}
                        className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-xs font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                      >
                        {t("Next")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </section>

      {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}

      {editing ? (
        <EditDialog
          tournamentId={id}
          editing={editing}
          day={selectedDay}
          isToday={selectedDay === today}
          tz={tz}
          links={links}
          canManage={canManage}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The detail, on demand. Everything here used to be printed on the page —
 * two paragraphs and a five-rung ladder above the first row of work. It is
 * reference material: read once, then never again, so it lives behind the
 * help icon next to the heading.
 */
function HelpDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const rungs = [
    t("one match"),
    t("a court on a day"),
    t("the day's auto broadcast"),
    t("a sport category"),
    t("the court's default"),
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} ariaLabel={t("How live links work")} variant="sheet">
      <div data-testid="stream-help-dialog" className="flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">
            {t("How live links work")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t(
              "A link published here gives spectators a Watch live button on the public schedule.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div data-testid="stream-precedence" className="flex flex-col gap-1.5">
            <h4 className="text-xs font-semibold">{t("Most specific wins")}</h4>
            <ol className="flex flex-col gap-1">
              {rungs.map((label, i) => (
                <li key={label} className="flex items-center gap-2 text-xs">
                  <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted font-tabular text-[0.625rem] font-semibold text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="font-medium">{label}</span>
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted-foreground">
              {t(
                "A match with its own link ignores everything below it. Anything with nothing set falls to the next rung.",
              )}
            </p>
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <h4 className="text-xs font-semibold">{t("Filming a court?")}</h4>
            <p className="text-xs text-muted-foreground">
              {t(
                "Set up a camera on a court has the QR code for the phone broadcast page, the OBS overlay URL, and the steps. This page is where the finished YouTube link gets pasted.",
              )}
            </p>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button size="sm" variant="ghost" data-testid="stream-help-close" onClick={onClose}>
            {t("Close")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The one editing surface. Which scope is being edited only changes the title,
 * the explanation and the write it runs — the control is the same `LinkEditor`
 * everywhere, so Save/Turn off/Clear mean one thing on this page.
 */
function EditDialog({
  tournamentId,
  editing,
  day,
  isToday,
  tz,
  links,
  canManage,
  onClose,
}: {
  tournamentId: string;
  editing: NonNullable<Editing>;
  day: string;
  isToday: boolean;
  tz: string;
  links: StreamLink[];
  canManage: boolean;
  onClose: () => void;
}): React.ReactElement {
  const uid = useId();
  // Save and Clear are finishing moves, so they close; a toggle is a state the
  // organiser may well flip back, so it leaves the dialog open.
  const done = (kind: "save" | "toggle" | "clear"): void => {
    if (kind !== "toggle") onClose();
  };

  let title = "";
  let description = "";
  let body: React.ReactElement | null = null;

  if (editing.kind === "court") {
    const court = editing.court;
    const dayLink = findCourtDayLink(links, court.court_id, day);
    const eff = effectiveCourtLink(court, dayLink, isToday);
    title = court.court_name;
    description = t("Live link for {day}").replace("{day}", fmtDayLabel(day));
    body = (
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t("In effect:")}
            </span>
            {eff.url ? (
              <WatchUrl url={eff.url} />
            ) : (
              <span
                data-testid={`stream-dialog-none-${court.court_id}`}
                className="text-xs text-muted-foreground"
              >
                {t("nothing")}
              </span>
            )}
            <SourceChip
              source={eff.source}
              testid={`stream-dialog-source-${court.court_id}`}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {sourceHint(eff.source)}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold">
            {t("This day only")}
          </h4>
          <LinkEditor
            tournamentId={tournamentId}
            inputId={`${uid}-day`}
            testid={`stream-day-${court.court_id}`}
            label={t("Live link for {court} on {day}")
              .replace("{court}", court.court_name)
              .replace("{day}", fmtDayLabel(day))}
            placeholder={t("Paste this court's YouTube link for this day…")}
            currentUrl={dayLink?.watch_url ?? ""}
            exists={dayLink !== null}
            enabled={dayLink ? dayLink.enabled : null}
            disabled={!canManage}
            onDone={done}
            run={(action) => {
              if (action.kind === "save") {
                return streamingApi.saveLink(tournamentId, {
                  scope: "court_day",
                  court_id: court.court_id,
                  day,
                  watch_url: action.url,
                  event_id: action.eventId,
                });
              }
              if (!dayLink) return Promise.resolve();
              if (action.kind === "toggle") {
                return streamingApi.updateLink(tournamentId, dayLink.id, {
                  enabled: action.enabled,
                  event_id: action.eventId,
                });
              }
              return streamingApi.deleteLink(tournamentId, dayLink.id);
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <h4 className="text-xs font-semibold">
            {t("Default for every day")}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t(
              "Used on any day this court has no link of its own. Clearing a day's link falls back to this.",
            )}
          </p>
          <LinkEditor
            tournamentId={tournamentId}
            inputId={`${uid}-standing`}
            testid={`stream-standing-${court.court_id}`}
            label={t("Default live link for {court}").replace(
              "{court}",
              court.court_name,
            )}
            placeholder={t("Paste a link used on every day…")}
            currentUrl={court.watch_url}
            exists={Boolean(court.watch_url)}
            // A CourtStream's `enabled` means "is this court on air", NOT
            // "does this URL apply" — so it gets no off switch here.
            enabled={null}
            disabled={!canManage}
            onDone={done}
            run={(action) => {
              if (action.kind === "save") {
                return streamingApi.saveCourtStream(tournamentId, {
                  court_id: court.court_id,
                  watch_url: action.url,
                  event_id: action.eventId,
                });
              }
              if (action.kind === "clear") {
                return streamingApi.deleteCourtStream(
                  tournamentId,
                  court.court_id,
                );
              }
              return Promise.resolve();
            }}
          />
        </div>
      </div>
    );
  }

  if (editing.kind === "category") {
    const link = findCategoryLink(links, editing.leafKey);
    title = editing.label;
    description = t(
      "Used by every match of this competition with no link of its own and no court link for its day.",
    );
    body = (
      <LinkEditor
        tournamentId={tournamentId}
        inputId={`${uid}-cat`}
        testid={`stream-cat-${editing.leafKey}`}
        label={t("Live link for {label}").replace("{label}", editing.label)}
        placeholder={t("Paste a link for this competition…")}
        currentUrl={link?.watch_url ?? ""}
        exists={link !== null}
        enabled={link ? link.enabled : null}
        disabled={!canManage}
        onDone={done}
        run={(action) => {
          if (action.kind === "save") {
            return streamingApi.saveLink(tournamentId, {
              scope: "category",
              leaf_key: editing.leafKey,
              watch_url: action.url,
              event_id: action.eventId,
            });
          }
          if (!link) return Promise.resolve();
          if (action.kind === "toggle") {
            return streamingApi.updateLink(tournamentId, link.id, {
              enabled: action.enabled,
              event_id: action.eventId,
            });
          }
          return streamingApi.deleteLink(tournamentId, link.id);
        }}
      />
    );
  }

  if (editing.kind === "match") {
    const m = editing.match;
    const link = findMatchLink(links, m.id);
    const label = `${m.home_team?.name ?? t("TBD")} v ${m.away_team?.name ?? t("TBD")}`;
    title = label;
    description = `${fmtKickoff(m.scheduled_at, tz)} · ${m.venue ?? ""} · ${t("Beats every other link, including the day's own.")}`;
    body = (
      <LinkEditor
        tournamentId={tournamentId}
        inputId={`${uid}-match`}
        testid={`stream-m-${m.id}`}
        label={t("Live link for {match}").replace("{match}", label)}
        placeholder={t("Paste a link for this match only…")}
        currentUrl={link?.watch_url ?? ""}
        exists={link !== null}
        enabled={link ? link.enabled : null}
        disabled={!canManage}
        onDone={done}
        run={(action) => {
          if (action.kind === "save") {
            return streamingApi.saveLink(tournamentId, {
              scope: "match",
              match_id: m.id,
              watch_url: action.url,
              event_id: action.eventId,
            });
          }
          if (!link) return Promise.resolve();
          if (action.kind === "toggle") {
            return streamingApi.updateLink(tournamentId, link.id, {
              enabled: action.enabled,
              event_id: action.eventId,
            });
          }
          return streamingApi.deleteLink(tournamentId, link.id);
        }}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      ariaLabel={title}
      // A right-hand drawer, half the screen: the list it was opened from stays
      // visible beside it, so an organiser can see which row they are editing
      // and step down the courts without the page jumping (owner 2026-08-05).
      variant="side"
    >
      <div data-testid="stream-edit-dialog" className="flex flex-col">
        <div className="flex items-start gap-3 pb-4">
          <div className="min-w-0 flex-1">
            {/* Team names run long; a clipped title hides which match is being
                edited, which is the one thing this drawer has to say. */}
            <DialogTitle className="text-base leading-snug">{title}</DialogTitle>
            <DialogDescription className="mt-1 text-xs">
              {description}
            </DialogDescription>
          </div>
          <button
            type="button"
            data-testid="stream-edit-close"
            aria-label={t("Close")}
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        {body}
      </div>
    </Dialog>
  );
}
