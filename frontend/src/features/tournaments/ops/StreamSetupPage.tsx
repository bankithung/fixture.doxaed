import { useId, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  HelpCircle,
  MonitorPlay,
  QrCode,
  Settings2,
  Smartphone,
  Video,
  X,
} from "lucide-react";
import {
  streamingApi,
  type CourtStreamRow,
  type StreamLink,
} from "@/api/streaming";
import { tournamentsApi } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { fmtDayLabel, tzDate } from "@/features/controlroom/format";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  cameraBroadcastUrl,
  currentOrigin,
  effectiveCourtLink,
  findCourtDayLink,
  overlayCourtUrl,
} from "./streamLinks";
import { FolderTabs } from "./FolderTabs";
import { LinkEditor, SourceChip } from "./StreamLinkEditor";

/** How this court is being filmed. Two routes, never both at once. */
type Method = "phone" | "obs";

/**
 * One court's ready-to-use URL: the string as selectable text (so it can be
 * read out, copied by hand, or read by a screen reader) plus a real Copy button
 * and a preview link.
 *
 * The URL is built by the app on purpose — see `overlayCourtUrl`. A venue like
 * `Court2 · T3` has to arrive as `Court2%20%C2%B7%20T3`, and nobody types
 * `%C2%B7` correctly twice. A wrong encoding produces a page that silently
 * never finds a match.
 */
function UrlRow({
  idPrefix,
  courtId,
  courtName,
  url,
  copyLabel,
  openLabel,
  copiedToast,
  failedToast,
}: {
  /** Prefix for this row's test ids — `overlay-…` or `camera-…`. */
  idPrefix: string;
  courtId: string;
  courtName: string;
  url: string;
  copyLabel: string;
  openLabel: string;
  copiedToast: string;
  failedToast: string;
}): React.ReactElement {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const doCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.push({ kind: "success", title: copiedToast, description: courtName });
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.push({
        kind: "error",
        title: failedToast,
        description: t("Select the URL and copy it by hand."),
      });
    }
  };

  return (
    <div
      data-testid={`${idPrefix}-url-row-${courtId}`}
      className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2"
    >
      {/* Selectable text, never truncated: the copy button is the shortcut,
          not the only way through. */}
      <code
        data-testid={`${idPrefix}-url-${courtId}`}
        className="block min-w-0 flex-1 select-all break-all font-mono text-[0.6875rem] text-muted-foreground"
      >
        {url}
      </code>
      <button
        type="button"
        data-testid={`${idPrefix}-copy-${courtId}`}
        aria-label={copyLabel}
        onClick={() => void doCopy()}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? (
          <Check aria-hidden="true" className="h-4 w-4 text-primary" />
        ) : (
          <Copy aria-hidden="true" className="h-4 w-4" />
        )}
      </button>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={openLabel}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ExternalLink aria-hidden="true" className="h-4 w-4" />
      </a>
    </div>
  );
}

/** A two-column settings table (scrolls on its own below a phone). */
function SettingsTable({
  caption,
  head,
  rows,
  testid,
}: {
  caption: string;
  head: [string, string];
  rows: [string, React.ReactNode][];
  testid: string;
}): React.ReactElement {
  return (
    <div className="overflow-x-auto">
      <table data-testid={testid} className="w-full min-w-[20rem] text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              {head[0]}
            </th>
            <th scope="col" className="py-1.5 font-medium">
              {head[1]}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th
                scope="row"
                className="w-2/5 py-1.5 pr-3 text-left align-top font-medium text-foreground"
              >
                {label}
              </th>
              <td className="py-1.5 align-top text-muted-foreground">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline literal (a setting value, a query option). */
function Mono({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.6875rem] text-foreground">
      {children}
    </code>
  );
}

/** A numbered step. Short line, no paragraph. */
function Steps({ items }: { items: string[] }): React.ReactElement {
  return (
    <ol className="flex flex-col gap-1.5">
      {items.map((s, i) => (
        <li key={s} className="flex items-start gap-2 text-xs">
          <span className="mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/12 font-tabular text-[0.625rem] font-semibold text-primary">
            {i + 1}
          </span>
          <span className="text-muted-foreground">{s}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The QR code — the one control on this page that does something no button on
 * a laptop can.
 *
 * The broadcast URL is `…/broadcast/t/<slug>/<id>/court/Court%20%C2%B7%20T1`.
 * It is displayed on a laptop and needed on a **phone**, and a clipboard cannot
 * cross that gap. The camera can: the phone reads this square off the screen
 * and opens the page. Rendered server-side (`apps/streaming/services/qr.py`)
 * from the same court addressing, so the picture and the text below it are the
 * same URL.
 *
 * White plate in both themes, because a QR inverted by a dark background does
 * not scan on many phone cameras.
 */
function BroadcastQr({
  tournamentId,
  courtId,
  courtName,
}: {
  tournamentId: string;
  courtId: string;
  courtName: string;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <p
        data-testid={`qr-failed-${courtId}`}
        role="status"
        className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground"
      >
        {t(
          "The QR code could not be loaded. Send the URL below to the phone instead.",
        )}
      </p>
    );
  }
  return (
    <img
      data-testid={`qr-${courtId}`}
      src={streamingApi.broadcastQrUrl(tournamentId, courtId)}
      onError={() => setFailed(true)}
      width={256}
      height={256}
      alt={t(
        "QR code. Scanning it with a phone camera opens the broadcast page for {court}.",
      ).replace("{court}", courtName)}
      className="h-44 w-44 max-w-full rounded-lg border border-border bg-white p-2"
    />
  );
}

/** The OBS Browser Source reference, on demand. It is a lookup table, not
 * something anyone reads on the way in — so it opens from a button instead of
 * printing two tables and four warnings under every court. */
function ObsSettingsDialog({
  courtId,
  onClose,
}: {
  courtId: string;
  onClose: () => void;
}): React.ReactElement {
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      ariaLabel={t("OBS Browser Source settings")}
      variant="side"
    >
      <div data-testid="setup-obs-dialog" className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base">
              {t("OBS Browser Source settings")}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs">
              {t("Sources, then +, then Browser, named after the court.")}
            </DialogDescription>
          </div>
          <button
            type="button"
            data-testid="setup-obs-dialog-close"
            aria-label={t("Close")}
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        <SettingsTable
          testid={`setup-obs-settings-${courtId}`}
          caption={t("OBS Browser Source settings")}
          head={[t("Field"), t("Value")]}
          rows={[
            [t("URL"), t("the overlay URL")],
            [t("Width"), <Mono key="w">1920</Mono>],
            [t("Height"), <Mono key="h">1080</Mono>],
            [t("Use custom frame rate"), t("OFF, let it follow the canvas")],
            [
              t("Custom CSS"),
              <Mono key="css">
                {"body { background: transparent; margin: 0; overflow: hidden; }"}
              </Mono>,
            ],
            [t("Shutdown source when not visible"), t("OFF (the default)")],
            [
              t("Refresh browser when scene becomes active"),
              t("OFF (the default)"),
            ],
            [t("Control audio via OBS"), t("OFF")],
          ]}
        />

        <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
          <li>
            {t(
              "Put the overlay above the camera source, or the video hides it.",
            )}
          </li>
          <li>
            {t(
              "Leave both browser-source switches OFF. Refreshing on scene change throws away the overlay's live state mid-rally, and shutting it down when hidden means it reconnects while you are already cut to it.",
            )}
          </li>
          <li>
            {t(
              "Do not drag to resize: scaling a browser source softens thin type. Keep 1920x1080 and use the scale option.",
            )}
          </li>
        </ul>

        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <h4 className="text-xs font-semibold">{t("URL options")}</h4>
          <SettingsTable
            testid={`setup-obs-options-${courtId}`}
            caption={t("Overlay URL query options")}
            head={[t("Option"), t("What it does")]}
            rows={[
              [
                "?scale=",
                t(
                  "0.4 to 4, default 1. The graphic is drawn for 1920x1080; for a 1280x720 canvas use 0.667.",
                ),
              ],
              [
                "?side=",
                t(
                  "left or right, the anchor corner. Court sports sit top-left, football top-centre.",
                ),
              ],
              [
                "?server=",
                t(
                  "home (default) or away, which side served first. Table tennis and sepak takraw only.",
                ),
              ],
            ]}
          />
          <p className="text-xs text-muted-foreground">
            {t("They combine, and the phone page takes the same ones:")}{" "}
            <Mono>?scale=0.667&amp;side=right</Mono>
          </p>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The things that go wrong at a court, and what to do about them — the
 * troubleshooting half of `docs/obs-overlay.md`. Reference material: nobody
 * reads it on the way in, and everybody wants it at 10:04 when a court has
 * gone amber. So it lives behind the help icon, not on the page.
 */
function HelpDialog({
  tournamentId,
  onClose,
}: {
  tournamentId: string;
  onClose: () => void;
}): React.ReactElement {
  const items: [string, string][] = [
    [
      t("The overlay is blank in OBS"),
      t(
        "Move the source above the camera. Open the URL in a normal browser: if it is blank there too, re-copy it from this page. Otherwise right-click the source, Refresh cache of current page, and check it is 1920x1080 and not 0x0.",
      ),
    ],
    [
      t("The score is frozen, or the dot went amber"),
      t(
        "Amber means nothing has been confirmed for 20 seconds: the venue's internet dropped or the backend restarted. It repairs itself, do not refresh. If only one court is amber, that court's scorer has stopped sending. A match still scheduled shows UP NEXT, not a score.",
      ),
    ],
    [
      t("Wrong court, or no match ever appears"),
      t(
        "The court in the URL is matched against the fixture's venue text. If a match moved courts, change its venue in the control room. A venue containing a slash cannot be addressed at all, so rename it.",
      ),
    ],
    [
      t("The serve dot is on the wrong side"),
      t(
        "Table tennis and sepak takraw only: add ?server=away to that court's URL and refresh once.",
      ),
    ],
  ];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      ariaLabel={t("When something looks wrong")}
      variant="sheet"
    >
      <div className="flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">
            {t("When something looks wrong")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("The four that actually happen at a venue.")}
          </DialogDescription>
        </DialogHeader>

        <dl
          data-testid="setup-help-body"
          className="flex flex-col gap-3 text-xs text-muted-foreground"
        >
          {items.map(([term, detail]) => (
            <div key={term}>
              <dt className="font-semibold text-foreground">{term}</dt>
              <dd className="mt-0.5">{detail}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
          {t("A link for one match, or a whole sport category, is set on")}{" "}
          <Link
            to={routes.tournamentStreams(tournamentId)}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {t("Live streams")}
          </Link>
          . {t("The full operator guide is docs/obs-overlay.md.")}
        </p>

        <div className="mt-4 flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            data-testid="setup-help-close"
            onClick={onClose}
          >
            {t("Close")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Everything one court needs for ONE route, phone or OBS. */
function CourtSetup({
  tournamentId,
  slug,
  court,
  day,
  isToday,
  dayLink,
  canManage,
  method,
  onOpenObsSettings,
}: {
  tournamentId: string;
  slug: string;
  court: CourtStreamRow;
  day: string;
  isToday: boolean;
  /** This court's link for this day — the row the paste box writes. */
  dayLink: StreamLink | null;
  canManage: boolean;
  method: Method;
  onOpenObsSettings: () => void;
}): React.ReactElement {
  const uid = useId();
  const origin = currentOrigin();
  const effective = effectiveCourtLink(court, dayLink, isToday);
  const phoneUrl = cameraBroadcastUrl(origin, slug, tournamentId, court.court_name);
  const obsUrl = overlayCourtUrl(origin, slug, tournamentId, court.court_name);

  return (
    <div
      data-testid={`setup-body-${court.court_id}`}
      className="flex flex-col gap-4 px-4 py-4"
    >
      {!slug ? (
        <p
          data-testid={`setup-no-slug-${court.court_id}`}
          className="text-xs text-muted-foreground"
        >
          {t("The URLs appear as soon as the tournament has finished loading.")}
        </p>
      ) : method === "phone" ? (
        /* ------------------------------------------------- the phone route */
        <div
          data-testid={`setup-phone-${court.court_id}`}
          className="flex flex-col gap-4 sm:flex-row sm:items-start"
        >
          <div className="flex flex-col items-center gap-1.5">
            <BroadcastQr
              tournamentId={tournamentId}
              courtId={court.court_id}
              courtName={court.court_name}
            />
            <p className="flex items-center gap-1.5 text-center text-[0.6875rem] font-medium">
              <QrCode aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Scan with the filming phone")}
            </p>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              {t(
                "The phone films with its own camera, this court's scoreboard drawn on top, and YouTube broadcasts that screen.",
              )}
            </p>
            <Steps
              items={[
                t("Tap Start camera on the phone and allow the camera."),
                t("Tap Full screen, then hold the phone sideways."),
                t("In YouTube: Create, Go live, Screen. Pick this browser."),
                t("Paste the YouTube link below."),
              ]}
            />
            {/* The URL stays on the page, not behind a disclosure: it is the
                fallback when a QR will not scan or the phone is elsewhere. */}
            <div className="flex flex-col gap-1">
              <span className="text-[0.6875rem] font-medium text-muted-foreground">
                {t("Or send this link to whoever is filming")}
              </span>
              <UrlRow
                idPrefix="camera"
                courtId={court.court_id}
                courtName={court.court_name}
                url={phoneUrl}
                copyLabel={t("Copy the phone broadcast URL for {court}").replace(
                  "{court}",
                  court.court_name,
                )}
                openLabel={t(
                  "Open the phone broadcast page for {court} in a new tab",
                ).replace("{court}", court.court_name)}
                copiedToast={t("Phone broadcast URL copied")}
                failedToast={t("Could not copy the phone broadcast URL")}
              />
            </div>
            <p className="text-[0.6875rem] text-muted-foreground">
              {t(
                "The mic is untouched, so YouTube gets the venue sound. Keep the phone plugged in: a screen broadcast eats battery.",
              )}
            </p>
          </div>
        </div>
      ) : (
        /* --------------------------------------------------- the OBS route */
        <div
          data-testid={`setup-obs-${court.court_id}`}
          className="flex flex-col gap-3"
        >
          <p className="text-xs text-muted-foreground">
            {t(
              "Add this court's overlay as a Browser Source above the camera. It follows whatever match is live on the court.",
            )}
          </p>
          <UrlRow
            idPrefix="overlay"
            courtId={court.court_id}
            courtName={court.court_name}
            url={obsUrl}
            copyLabel={t("Copy the OBS overlay URL for {court}").replace(
              "{court}",
              court.court_name,
            )}
            openLabel={t("Open the overlay for {court} in a new tab").replace(
              "{court}",
              court.court_name,
            )}
            copiedToast={t("Overlay URL copied")}
            failedToast={t("Could not copy the overlay URL")}
          />
          <Steps
            items={[
              t("In OBS: Sources, +, Browser, named after the court."),
              t("Paste the URL above and set it to 1920x1080."),
              t("Drag it above the camera source in the scene."),
              t("Start streaming, then paste the YouTube link below."),
            ]}
          />
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            data-testid={`setup-obs-settings-open-${court.court_id}`}
            onClick={onOpenObsSettings}
          >
            <Settings2 aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Browser Source settings")}
          </Button>
        </div>
      )}

      {/* --------------------------- closing the loop, on the same screen */}
      <div
        data-testid={`setup-publish-${court.court_id}`}
        className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold">
            {t("Paste the YouTube link")}
          </h4>
          <span className="text-xs text-muted-foreground">
            {t("This publishes the Watch live button for {day}.").replace(
              "{day}",
              fmtDayLabel(day),
            )}
          </span>
        </div>
        <LinkEditor
          tournamentId={tournamentId}
          inputId={`${uid}-publish`}
          testid={`setup-link-${court.court_id}`}
          label={t("Live link for {court} on {day}")
            .replace("{court}", court.court_name)
            .replace("{day}", fmtDayLabel(day))}
          placeholder={t("Paste the YouTube watch link…")}
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
        <p className="text-xs text-muted-foreground">
          {t("In effect now:")}{" "}
          {effective.url ? (
            <a
              href={effective.url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`setup-effective-${court.court_id}`}
              className="break-all underline-offset-2 hover:text-foreground hover:underline"
            >
              {effective.url}
            </a>
          ) : (
            <span data-testid={`setup-effective-none-${court.court_id}`}>
              {t("nothing, so no Watch live button for this court.")}
            </span>
          )}
        </p>
        {!canManage ? (
          <p className="text-xs text-muted-foreground">
            {t("Read only. Only organisers can publish a link.")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Operations — **Set up a camera on a court**.
 *
 * The tournament owner, twice, could not find the broadcast instructions when
 * they were a collapsed disclosure on the Live streams page: *"look how the
 * fuck do you think the user will know the link, we need a proper setup page
 * right"*. This is that page, and it is written for the person who actually
 * does the job — a volunteer standing at a court, minutes before a match,
 * holding a phone.
 *
 * Redesigned 2026-08-05 (owner: *"shorter sub text and more readable"*). It was
 * one accordion per court, each opening a full page of prose: two paragraphs,
 * two settings tables, three bullet lists and the paste box, times six courts.
 * Now it asks two questions and answers exactly one of them:
 *
 * 1. **Which court?** A row of chips, each saying whether that court is already
 *    publishing a link.
 * 2. **Phone or OBS?** Folder tabs. Only the chosen route is on the page.
 * 3. Four numbered steps, the one URL that route needs, and the paste box that
 *    closes the loop where it was opened.
 *
 * The reference material — the OBS Browser Source table, the URL options, the
 * troubleshooting list — is behind buttons. It is looked up, not read.
 *
 * The QR code stays the lead of the phone route: it is the only control that
 * can move `…/court/Court%20%C2%B7%20T1` from this screen onto the handset that
 * will film, and a copy button cannot cross that gap.
 */
export function StreamSetupPage(): React.ReactElement {
  const { id = "" } = useParams();
  const [chosen, setChosen] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>("phone");
  const [helpOpen, setHelpOpen] = useState(false);
  const [obsOpen, setObsOpen] = useState(false);

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
  const slug = tournamentQ.data?.slug ?? "";
  const tz = tournamentQ.data?.time_zone ?? "UTC";
  const matches = useMemo(() => matchesQ.data ?? [], [matchesQ.data]);
  const courts = courtsQ.data?.court_streams ?? [];
  const links = useMemo(() => linksQ.data?.stream_links ?? [], [linksQ.data]);

  // The day, in the TOURNAMENT's wall clock (invariant 14) — the same key
  // `StreamLink.day` is filed under, and the same default the Live streams
  // board opens on, so the two surfaces write the same row.
  const days = useMemo(() => {
    const set = new Set<string>();
    for (const m of matches) {
      const d = tzDate(m.scheduled_at, tz);
      if (d) set.add(d);
    }
    return [...set].sort();
  }, [matches, tz]);
  const today = tzDate(new Date().toISOString(), tz);
  const day = days.find((d) => d >= today) ?? days[0] ?? today;

  const perCourt = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of matches) {
      if (m.venue && tzDate(m.scheduled_at, tz) === day) {
        counts.set(m.venue, (counts.get(m.venue) ?? 0) + 1);
      }
    }
    return counts;
  }, [matches, tz, day]);

  const loading = courtsQ.isLoading || matchesQ.isLoading || linksQ.isLoading;
  const openCourt = chosen ?? courts[0]?.court_id ?? null;
  const court = courts.find((c) => c.court_id === openCourt) ?? null;

  const header = (
    <div className="flex flex-col gap-1 border-b border-border px-4 py-3">
      <Link
        to={routes.tournamentStreams(id)}
        data-testid="setup-back"
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Back to Live streams")}
      </Link>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Video aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
        <h2 className="page-title">{t("Set up a camera on a court")}</h2>
        <button
          type="button"
          data-testid="setup-help-toggle"
          aria-label={t("When something looks wrong")}
          onClick={() => setHelpOpen(true)}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HelpCircle aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("Pick a court, film it, then paste the YouTube link back here.")}
      </p>
    </div>
  );

  if (loading) {
    return (
      <div className="flex w-full flex-col gap-3">
        <section className="panel flex flex-col">
          {header}
          <div className="h-64 animate-pulse bg-muted/40" />
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
      <section data-testid="setup-courts" className="panel flex flex-col">
        {header}

        {courts.length === 0 ? (
          <p
            data-testid="setup-no-courts"
            className="px-4 py-12 text-center text-sm text-muted-foreground"
          >
            {t("No courts yet. They appear once the fixtures are scheduled.")}
          </p>
        ) : (
          <>
            {/* Which court. Six chips beat six accordions: the whole choice is
                one line, and each chip already says whether that court is
                publishing anything. */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t("Court")}
              </span>
              <div
                role="group"
                aria-label={t("Court")}
                className="flex flex-wrap items-center gap-1"
              >
                {courts.map((c) => {
                  const active = c.court_id === openCourt;
                  const eff = effectiveCourtLink(
                    c,
                    findCourtDayLink(links, c.court_id, day),
                    day === today,
                  );
                  return (
                    <button
                      key={c.court_id}
                      type="button"
                      data-testid={`setup-toggle-${c.court_id}`}
                      aria-pressed={active}
                      onClick={() => setChosen(c.court_id)}
                      className={cn(
                        "inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
                      )}
                    >
                      <span data-testid={`setup-court-${c.court_id}`}>
                        {c.court_name}
                      </span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          eff.source === "none" ? "bg-warning" : "bg-success",
                        )}
                      />
                    </button>
                  );
                })}
              </div>
              <span className="ml-auto font-tabular text-xs text-muted-foreground">
                {days.length > 0 ? `${fmtDayLabel(day)} · ` : ""}
                {court ? (perCourt.get(court.court_name) ?? 0) : 0}{" "}
                {t("matches")}
              </span>
            </div>

            {court ? (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-4 py-2">
                  <h3 className="text-[13px] font-semibold">
                    {court.court_name}
                  </h3>
                  <SourceChip
                    source={
                      effectiveCourtLink(
                        court,
                        findCourtDayLink(links, court.court_id, day),
                        day === today,
                      ).source
                    }
                    testid={`setup-source-${court.court_id}`}
                  />
                </div>

                {/* Phone or OBS. Only one route is ever on the page. */}
                <FolderTabs
                  ariaLabel={t("How you are filming")}
                  testidPrefix="setup-method"
                  value={method}
                  onChange={setMethod}
                  tabs={[
                    { key: "phone", label: t("Phone") },
                    { key: "obs", label: t("Laptop and OBS") },
                  ]}
                />

                <CourtSetup
                  key={court.court_id}
                  tournamentId={id}
                  slug={slug}
                  court={court}
                  day={day}
                  isToday={day === today}
                  dayLink={findCourtDayLink(links, court.court_id, day)}
                  canManage={canManage}
                  method={method}
                  onOpenObsSettings={() => setObsOpen(true)}
                />
              </>
            ) : null}
          </>
        )}
      </section>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Smartphone aria-hidden="true" className="h-3.5 w-3.5" />
        {t("A phone is enough. OBS is only better where there is a laptop.")}
        <MonitorPlay aria-hidden="true" className="h-3.5 w-3.5" />
      </p>

      {helpOpen ? (
        <HelpDialog tournamentId={id} onClose={() => setHelpOpen(false)} />
      ) : null}
      {obsOpen && court ? (
        <ObsSettingsDialog
          courtId={court.court_id}
          onClose={() => setObsOpen(false)}
        />
      ) : null}
    </div>
  );
}
