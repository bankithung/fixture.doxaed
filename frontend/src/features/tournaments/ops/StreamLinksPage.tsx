import { useId, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ExternalLink,
  Layers,
  MapPin,
  Radio,
  Trash2,
  Video,
} from "lucide-react";
import {
  streamingApi,
  type CourtStreamRow,
  type StreamLink,
} from "@/api/streaming";
import { tournamentsApi, type ControlRoomMatch } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import {
  fmtDayLabel,
  fmtKickoff,
  leafLabelOf,
  tzDate,
} from "@/features/controlroom/format";
import { errorDetail, writeMayHaveLanded } from "@/features/fixtures/repair";
import { newEventId } from "@/lib/eventId";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { ApiError } from "@/types/api";
import {
  effectiveCourtLink,
  findCategoryLink,
  findCourtDayLink,
  findMatchLink,
  sourceHint,
  sourceLabel,
  watchUrlWarning,
  type LinkSource,
} from "./streamLinks";
import { StreamOverlayGuide } from "./StreamOverlayGuide";

/** What a save/toggle/clear press asks for. Every one carries its own
 * `event_id` (invariant 3). */
type EditorAction =
  | { kind: "save"; url: string; eventId: string }
  | { kind: "toggle"; enabled: boolean; eventId: string }
  | { kind: "clear"; eventId: string };

/** The server's own explanation of a refusal, never one we invented. */
function serverMessage(e: unknown): string {
  if (e instanceof ApiError && typeof e.payload.message === "string") {
    return e.payload.message;
  }
  return errorDetail(e);
}

/** The level chip: which rung of the precedence rule a court is running on. */
function SourceChip({
  source,
  testid,
}: {
  source: LinkSource;
  testid?: string;
}): React.ReactElement {
  const tone: Record<LinkSource, string> = {
    day: "bg-primary/12 text-primary",
    broadcast: "bg-info-muted text-info",
    court_default: "bg-muted text-muted-foreground",
    none: "bg-warning-muted text-warning",
  };
  return (
    <span
      data-testid={testid}
      data-source={source}
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[0.6875rem] font-medium",
        tone[source],
      )}
    >
      {sourceLabel(source)}
    </span>
  );
}

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

/**
 * The one paste-a-link control, reused at every scope.
 *
 * Three verbs that mean three different things, which is why they are three
 * controls and not one:
 *
 * - **Save** writes the URL for this target.
 * - **Turn off** keeps the row but stops it applying, so the next level down
 *   takes over — reversible with one press.
 * - **Clear** deletes the binding outright.
 *
 * The client-side check is advisory: it flags the two mistakes organisers
 * actually make (a channel `/live` URL, something that is not a YouTube video)
 * without blocking a save, because `validate_watch_url` on the server is the
 * authority and its message is what gets shown when a write is refused.
 */
function LinkEditor({
  tournamentId,
  inputId,
  label,
  placeholder,
  currentUrl,
  exists,
  enabled,
  disabled,
  testid,
  run,
}: {
  tournamentId: string;
  inputId: string;
  /** Accessible name of the field (rendered as its <label>). */
  label: string;
  placeholder: string;
  /** The URL currently stored for this target ("" = nothing stored). */
  currentUrl: string;
  /** Whether a row exists to clear. */
  exists: boolean;
  /** The row's on/off state; `null` on targets that have no off switch. */
  enabled: boolean | null;
  disabled?: boolean;
  testid: string;
  run: (action: EditorAction) => Promise<unknown>;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState(currentUrl);
  // Re-seed when the server's value changes under us (a save landing, a day
  // switch): render-phase sync, no effect, no flash of the stale value.
  const [seed, setSeed] = useState(currentUrl);
  if (seed !== currentUrl) {
    setSeed(currentUrl);
    setDraft(currentUrl);
  }

  // ONE `event_id` per *intent* (invariant 3), minted outside `mutationFn` and
  // reset only when the URL being written changes — a retry after a client-side
  // timeout must REPLAY the same write, not run a second one.
  const [attempt, setAttempt] = useState(() => ({
    intent: draft,
    eventId: newEventId(),
  }));
  if (attempt.intent !== draft) setAttempt({ intent: draft, eventId: newEventId() });

  const write = useMutation({
    mutationFn: (action: EditorAction) => run(action),
    onSuccess: (_data, action) => {
      qc.invalidateQueries({ queryKey: qk.streamLinks(tournamentId) });
      qc.invalidateQueries({ queryKey: qk.courtStreams(tournamentId) });
      toast.push({
        kind: "success",
        title:
          action.kind === "clear"
            ? t("Link cleared")
            : action.kind === "toggle"
              ? action.enabled
                ? t("Link switched on")
                : t("Link switched off")
              : t("Link saved"),
      });
    },
    onError: (e) => {
      // A timeout/abort is not a failed write — the server may well have
      // committed. Pull the truth back down instead of crying failure.
      if (writeMayHaveLanded(e)) {
        qc.invalidateQueries({ queryKey: qk.streamLinks(tournamentId) });
        qc.invalidateQueries({ queryKey: qk.courtStreams(tournamentId) });
        return;
      }
      toast.push({
        kind: "error",
        title: t("Could not save that link"),
        description: serverMessage(e),
      });
    },
  });

  const warning = watchUrlWarning(draft);
  const dirty = draft.trim() !== currentUrl;
  const busy = write.isPending;
  const failure =
    write.isError && !writeMayHaveLanded(write.error)
      ? serverMessage(write.error)
      : null;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId} className="sr-only">
        {label}
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          type="url"
          inputMode="url"
          spellCheck={false}
          data-testid={`${testid}-input`}
          className="h-9 min-w-0 flex-1 sm:min-w-[18rem]"
          placeholder={placeholder}
          value={draft}
          disabled={disabled || busy}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          size="sm"
          data-testid={`${testid}-save`}
          disabled={disabled || busy || !dirty}
          onClick={() =>
            write.mutate({
              kind: "save",
              url: draft.trim(),
              eventId: attempt.eventId,
            })
          }
        >
          {t("Save")}
        </Button>
        {enabled !== null && exists ? (
          <Button
            size="sm"
            variant="outline"
            data-testid={`${testid}-toggle`}
            disabled={disabled || busy}
            onClick={() =>
              write.mutate({
                kind: "toggle",
                enabled: !enabled,
                // Flipping a switch is idempotent in its end state, so a fresh
                // token per press is safe here (unlike a save).
                eventId: newEventId(),
              })
            }
          >
            {enabled ? t("Turn off") : t("Turn on")}
          </Button>
        ) : null}
        {exists ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid={`${testid}-clear`}
            disabled={disabled || busy}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => write.mutate({ kind: "clear", eventId: newEventId() })}
          >
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Clear")}
          </Button>
        ) : null}
      </div>
      {failure ? (
        <p
          role="alert"
          data-testid={`${testid}-error`}
          className="text-xs text-destructive"
        >
          {failure}
        </p>
      ) : warning ? (
        <p
          role="status"
          data-testid={`${testid}-warning`}
          className="text-xs text-warning"
        >
          {warning}
        </p>
      ) : null}
    </div>
  );
}

/** One court's band for the chosen day: what is in effect and where it came
 * from, the day's paste box, and a disclosure for the standing default. */
function CourtBand({
  tournamentId,
  court,
  day,
  isToday,
  dayLink,
  matchCount,
  canManage,
}: {
  tournamentId: string;
  court: CourtStreamRow;
  day: string;
  isToday: boolean;
  dayLink: StreamLink | null;
  matchCount: number;
  canManage: boolean;
}): React.ReactElement {
  const uid = useId();
  const [showDefault, setShowDefault] = useState(false);
  const effective = effectiveCourtLink(court, dayLink, isToday);

  return (
    <div
      data-testid={`stream-court-${court.court_id}`}
      className="flex flex-col gap-2 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <MapPin aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[13px] font-semibold">{court.court_name}</h3>
        <SourceChip
          source={effective.source}
          testid={`stream-source-${court.court_id}`}
        />
        {effective.overridden && effective.source !== "day" ? (
          <span className="rounded-md bg-warning-muted px-2 py-0.5 text-[0.6875rem] font-medium text-warning">
            {t("Saved but not applying")}
          </span>
        ) : null}
        <span className="ml-auto font-tabular text-xs text-muted-foreground">
          {matchCount > 0
            ? `${matchCount} ${matchCount === 1 ? t("match") : t("matches")}`
            : t("No matches this day")}
        </span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="shrink-0">{t("In effect:")}</span>
        {effective.url ? (
          <WatchUrl url={effective.url} />
        ) : (
          <span data-testid={`stream-none-${court.court_id}`}>{t("nothing")}</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {sourceHint(effective.source)}
      </p>

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

      <div>
        <button
          type="button"
          data-testid={`stream-default-toggle-${court.court_id}`}
          aria-expanded={showDefault}
          onClick={() => setShowDefault((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn("h-3.5 w-3.5 transition-transform", showDefault && "rotate-180")}
          />
          {t("Default for every day")}
          {court.watch_url ? (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium">
              {t("set")}
            </span>
          ) : null}
        </button>
        {showDefault ? (
          <div className="mt-2 border-l-2 border-border pl-3">
            <p className="pb-1.5 text-xs text-muted-foreground">
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
        ) : null}
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
 * The day's courts are the body of the page because that is the everyday work.
 * The other two scopes the owner asked for — one link per sport category, or a
 * different one for a single match — sit below it, since they are the exception
 * rather than the routine. Most specific wins, and every court band says which
 * level it is currently running on, because a court showing the category link
 * or the standing default is NOT the same as one with its own link for today.
 *
 * Manager-gated to match the server (`can_manage_tournament`): pasting a link
 * publishes a Watch live button on the public schedule.
 */
export function StreamLinksPage(): React.ReactElement {
  const { id = "" } = useParams();
  const { isMobile } = useBreakpoint();
  const [day, setDay] = useState<string | null>(null);

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

  const loading =
    courtsQ.isLoading || linksQ.isLoading || matchesQ.isLoading;

  const header = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="page-title">{t("Live streams")}</h2>
      <span className="font-tabular text-xs text-muted-foreground">
        {courts.length} {courts.length === 1 ? t("court") : t("courts")} ·{" "}
        {links.length} {links.length === 1 ? t("link") : t("links")}
      </span>
    </div>
  );

  if (loading) {
    return (
      <div className="flex w-full flex-col gap-3">
        {header}
        <div className="h-48 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }

  if (courtsQ.isError) {
    return (
      <div className="flex w-full flex-col gap-3">
        {header}
        <p
          role="alert"
          className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground"
        >
          {t("Live streams are managed by the tournament's organisers.")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {header}

      {/* How the score gets INTO the video, one disclosure above the boxes that
          publish the video back OUT. Collapsed, so the day's work stays first. */}
      <StreamOverlayGuide
        slug={tournamentQ.data?.slug ?? ""}
        tournamentId={id}
        courts={courts}
      />

      <section data-testid="stream-board" className="panel flex flex-col">
        {/* The precedence rule, in one line — an organiser has to be able to
            predict which of their links a spectator will get. */}
        <p
          data-testid="stream-precedence"
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
        >
          <Radio aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Most specific wins:")}
          <span className="font-medium text-foreground">{t("one match")}</span>
          {"→"}
          <span className="font-medium text-foreground">
            {t("a court on a day")}
          </span>
          {"→"}
          <span className="font-medium text-foreground">
            {t("the day's auto broadcast")}
          </span>
          {"→"}
          <span className="font-medium text-foreground">
            {t("a sport category")}
          </span>
          {"→"}
          <span className="font-medium text-foreground">
            {t("the court's default")}
          </span>
        </p>

        {/* Day picker — the link is per court PER DAY, so the day is the first
            thing chosen, not a filter tucked away. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
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
              onChange={(v) => setDay(v)}
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
                    onClick={() => setDay(d)}
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
              {t("Read only — only organisers can change these links.")}
            </span>
          ) : null}
        </div>

        {courts.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            {t("No courts yet. They appear once the fixtures are scheduled.")}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {courts.map((c) => (
              <CourtBand
                key={c.court_id}
                tournamentId={id}
                court={c}
                day={selectedDay}
                isToday={selectedDay === today}
                dayLink={findCourtDayLink(links, c.court_id, selectedDay)}
                matchCount={perCourt.get(c.court_name) ?? 0}
                canManage={canManage}
              />
            ))}
          </div>
        )}
      </section>

      {/* Scope 2: one link for a whole competition. */}
      <section data-testid="stream-categories" className="panel flex flex-col">
        <div className="panel-header">
          <Layers aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
          <h3 className="panel-title">{t("One link per sport category")}</h3>
        </div>
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          {t(
            "Used by every match of that competition with no link of its own and no court link for its day.",
          )}
        </p>
        {categories.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t("No competitions yet.")}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {categories.map(([leafKey, label]) => (
              <CategoryRow
                key={leafKey}
                tournamentId={id}
                leafKey={leafKey}
                label={label}
                link={findCategoryLink(links, leafKey)}
                canManage={canManage}
              />
            ))}
          </div>
        )}
      </section>

      {/* Scope 3: one match, different from its court. */}
      <section data-testid="stream-matches" className="panel flex flex-col">
        <div className="panel-header">
          <Video aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
          <h3 className="panel-title">{t("Override one match")}</h3>
        </div>
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          {t("Beats every other link, including the day's own. {day}").replace(
            "{day}",
            selectedDay ? fmtDayLabel(selectedDay) : "",
          )}
        </p>
        {dayMatches.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t("No matches on this day.")}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {dayMatches.map((m) => (
              <MatchRowEditor
                key={m.id}
                tournamentId={id}
                match={m}
                tz={tz}
                link={findMatchLink(links, m.id)}
                canManage={canManage}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function CategoryRow({
  tournamentId,
  leafKey,
  label,
  link,
  canManage,
}: {
  tournamentId: string;
  leafKey: string;
  label: string;
  link: StreamLink | null;
  canManage: boolean;
}): React.ReactElement {
  const uid = useId();
  return (
    <div
      data-testid={`stream-category-${leafKey}`}
      className="flex flex-col gap-2 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[13px] font-semibold">{label}</h4>
        {link && link.watch_url && !link.enabled ? (
          <span className="rounded-md bg-warning-muted px-2 py-0.5 text-[0.6875rem] font-medium text-warning">
            {t("Switched off")}
          </span>
        ) : null}
      </div>
      <LinkEditor
        tournamentId={tournamentId}
        inputId={`${uid}-cat`}
        testid={`stream-cat-${leafKey}`}
        label={t("Live link for {label}").replace("{label}", label)}
        placeholder={t("Paste a link for this competition…")}
        currentUrl={link?.watch_url ?? ""}
        exists={link !== null}
        enabled={link ? link.enabled : null}
        disabled={!canManage}
        run={(action) => {
          if (action.kind === "save") {
            return streamingApi.saveLink(tournamentId, {
              scope: "category",
              leaf_key: leafKey,
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
    </div>
  );
}

function MatchRowEditor({
  tournamentId,
  match,
  tz,
  link,
  canManage,
}: {
  tournamentId: string;
  match: ControlRoomMatch;
  tz: string;
  link: StreamLink | null;
  canManage: boolean;
}): React.ReactElement {
  const uid = useId();
  const title = `${match.home_team?.name ?? t("TBD")} v ${match.away_team?.name ?? t("TBD")}`;
  return (
    <div
      data-testid={`stream-match-${match.id}`}
      className="flex flex-col gap-2 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="w-11 shrink-0 font-tabular text-xs font-semibold text-muted-foreground">
          {fmtKickoff(match.scheduled_at, tz)}
        </span>
        <h4 className="text-[13px] font-medium">{title}</h4>
        <span className="text-xs text-muted-foreground">{match.venue}</span>
        {link && link.watch_url && link.enabled ? (
          <span className="rounded-md bg-primary/12 px-2 py-0.5 text-[0.6875rem] font-medium text-primary">
            {t("Own link")}
          </span>
        ) : null}
      </div>
      <LinkEditor
        tournamentId={tournamentId}
        inputId={`${uid}-match`}
        testid={`stream-m-${match.id}`}
        label={t("Live link for {match}").replace("{match}", title)}
        placeholder={t("Paste a link for this match only…")}
        currentUrl={link?.watch_url ?? ""}
        exists={link !== null}
        enabled={link ? link.enabled : null}
        disabled={!canManage}
        run={(action) => {
          if (action.kind === "save") {
            return streamingApi.saveLink(tournamentId, {
              scope: "match",
              match_id: match.id,
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
    </div>
  );
}
