import { useId, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  LifeBuoy,
  MapPin,
  MonitorPlay,
  QrCode,
  Smartphone,
} from "lucide-react";
import {
  streamingApi,
  type CourtStreamRow,
  type StreamLink,
} from "@/api/streaming";
import { tournamentsApi } from "@/api/tournaments";
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
import { LinkEditor, SourceChip } from "./StreamLinkEditor";

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
          "The QR code could not be loaded. Send the URL below to the phone instead — WhatsApp it to the volunteer rather than retyping it.",
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
      className="h-56 w-56 max-w-full rounded-lg border border-border bg-white p-2"
    />
  );
}

/** Everything one court needs, in the order the decision is actually made:
 * phone first (it needs no equipment), OBS second, publish the link last. */
function CourtSetup({
  tournamentId,
  slug,
  court,
  day,
  isToday,
  dayLink,
  matchCount,
  canManage,
  open,
  onToggle,
}: {
  tournamentId: string;
  slug: string;
  court: CourtStreamRow;
  day: string;
  isToday: boolean;
  /** This court's link for this day — the row the paste box writes. */
  dayLink: StreamLink | null;
  matchCount: number;
  canManage: boolean;
  open: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const uid = useId();
  const origin = currentOrigin();
  const effective = effectiveCourtLink(court, dayLink, isToday);
  const phoneUrl = cameraBroadcastUrl(origin, slug, tournamentId, court.court_name);
  const obsUrl = overlayCourtUrl(origin, slug, tournamentId, court.court_name);

  return (
    <section data-testid={`setup-court-${court.court_id}`}>
      <h3>
        <button
          type="button"
          data-testid={`setup-toggle-${court.court_id}`}
          aria-expanded={open}
          aria-controls={`${uid}-body`}
          onClick={onToggle}
          className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <MapPin aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[13px] font-semibold">{court.court_name}</span>
          <SourceChip
            source={effective.source}
            testid={`setup-source-${court.court_id}`}
          />
          <span className="font-tabular text-xs text-muted-foreground">
            {matchCount > 0
              ? `${matchCount} ${matchCount === 1 ? t("match") : t("matches")}`
              : t("No matches this day")}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </h3>

      {open ? (
        <div
          id={`${uid}-body`}
          data-testid={`setup-body-${court.court_id}`}
          className="flex flex-col gap-4 border-t border-border px-4 py-4"
        >
          {!slug ? (
            <p
              data-testid={`setup-no-slug-${court.court_id}`}
              className="text-xs text-muted-foreground"
            >
              {t("The URLs appear as soon as the tournament has finished loading.")}
            </p>
          ) : (
            <>
              {/* ------------------------------------------- the phone route */}
              <div
                data-testid={`setup-phone-${court.court_id}`}
                className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3"
              >
                <h4 className="flex items-center gap-2 text-sm font-semibold">
                  <Smartphone aria-hidden="true" className="h-4 w-4 text-primary" />
                  {t("Film it with a phone — no laptop, no extra app")}
                </h4>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "The phone shows its own rear camera with this court's live scoreboard drawn on top, and the YouTube app broadcasts that screen. The score goes out inside the picture.",
                  )}
                </p>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  <div className="flex flex-col items-center gap-1.5">
                    <BroadcastQr
                      tournamentId={tournamentId}
                      courtId={court.court_id}
                      courtName={court.court_name}
                    />
                    <p className="flex items-center gap-1.5 text-center text-[0.6875rem] font-medium text-foreground">
                      <QrCode aria-hidden="true" className="h-3.5 w-3.5" />
                      {t("Point the filming phone's camera at this")}
                    </p>
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <p className="text-xs text-muted-foreground">
                      {t(
                        "Scanning opens this court's page on the phone — nothing to type. Prefer to send it instead? Copy the URL and message it to whoever is filming.",
                      )}
                    </p>
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
                </div>

                <ol className="flex list-decimal flex-col gap-1 pl-4 text-xs text-muted-foreground">
                  <li>{t("On the phone, tap Start camera and allow the camera.")}</li>
                  <li>
                    {t(
                      "Tap Full screen so the address bar is out of the picture, and hold the phone sideways.",
                    )}
                  </li>
                  <li>
                    {t(
                      "Open the YouTube app → Create → Go live → Screen, pick this browser, and start the broadcast.",
                    )}
                  </li>
                  <li>
                    {t(
                      "Copy the YouTube watch link and paste it into the box below — that is what gives spectators the “Watch live” button.",
                    )}
                  </li>
                </ol>
                <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
                  <li>
                    {t(
                      "The page never touches the microphone, so YouTube gets the sound of the venue as normal.",
                    )}
                  </li>
                  <li>
                    {t(
                      "It keeps the screen awake by itself, but plug the phone in: a screen broadcast on full brightness drains a battery fast.",
                    )}
                  </li>
                </ul>
              </div>

              {/* --------------------------------------------- the OBS route */}
              <div
                data-testid={`setup-obs-${court.court_id}`}
                className="flex flex-col gap-3 rounded-lg border border-border p-3"
              >
                <h4 className="flex items-center gap-2 text-sm font-semibold">
                  <MonitorPlay aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                  {t("Have a laptop and OBS? Use the overlay instead")}
                </h4>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "OBS is the better picture where there is a laptop: scenes, a proper encoder, and no phone to babysit. Add this court's overlay as a Browser Source above the camera — it follows whatever match is live on the court by itself.",
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
                <p className="text-xs text-muted-foreground">
                  {t("In OBS: Sources → + → Browser → Create new, named after the court.")}
                </p>
                <SettingsTable
                  testid={`setup-obs-settings-${court.court_id}`}
                  caption={t("OBS Browser Source settings")}
                  head={[t("Field"), t("Value")]}
                  rows={[
                    [t("URL"), t("the overlay URL above")],
                    [t("Width"), <Mono key="w">1920</Mono>],
                    [t("Height"), <Mono key="h">1080</Mono>],
                    [t("Use custom frame rate"), t("OFF — let it follow the canvas")],
                    [
                      t("Custom CSS"),
                      <Mono key="css">
                        {"body { background: transparent; margin: 0; overflow: hidden; }"}
                      </Mono>,
                    ],
                    [
                      t("Shutdown source when not visible"),
                      t("OFF (this is the default — leave it)"),
                    ],
                    [
                      t("Refresh browser when scene becomes active"),
                      t("OFF (this is the default — leave it)"),
                    ],
                    [t("Control audio via OBS"), t("OFF")],
                  ]}
                />
                <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
                  <li>
                    {t(
                      "Put the overlay above the camera source in the scene list, or the video hides it.",
                    )}
                  </li>
                  <li>
                    {t(
                      "Leave “Refresh browser when scene becomes active” OFF. Turning it on reloads the page every time you cut to that scene, which throws away the overlay's live state mid-rally.",
                    )}
                  </li>
                  <li>
                    {t(
                      "Leave “Shutdown source when not visible” OFF so the overlay stays connected and is already correct the moment you cut to it.",
                    )}
                  </li>
                  <li>
                    {t(
                      "Do not resize the source by dragging — scaling a browser source visibly softens thin type and hairlines. Keep it at 1920×1080 and use ?scale= instead.",
                    )}
                  </li>
                </ul>
                <SettingsTable
                  testid={`setup-obs-options-${court.court_id}`}
                  caption={t("Overlay URL query options")}
                  head={[t("Option"), t("What it does")]}
                  rows={[
                    [
                      "?scale=",
                      t(
                        "0.4–4, default 1. The graphic is drawn for a 1920×1080 canvas — for a 1280×720 canvas use ?scale=0.667.",
                      ),
                    ],
                    [
                      "?side=",
                      t(
                        "left or right — the anchor corner. Court sports sit top-left; football sits top-centre. Setting side overrides both.",
                      ),
                    ],
                    [
                      "?server=",
                      t(
                        "home (default) or away — which side served first. Only affects table tennis and sepak takraw.",
                      ),
                    ],
                  ]}
                />
                <p className="text-xs text-muted-foreground">
                  {t("The options combine, and the phone page takes the same ones, e.g.")}{" "}
                  <Mono>?scale=0.667&amp;side=right</Mono>
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "OBS sends the picture out; the box below sends viewers to it. Once you are streaming, paste that broadcast's YouTube watch link there.",
                  )}
                </p>
              </div>
            </>
          )}

          {/* ------------------------- closing the loop, on the same screen */}
          <div
            data-testid={`setup-publish-${court.court_id}`}
            className="flex flex-col gap-2 rounded-lg border border-border p-3"
          >
            <h4 className="text-sm font-semibold">
              {t("Then paste the YouTube link here")}
            </h4>
            <p className="text-xs text-muted-foreground">
              {t(
                "This is what publishes the “Watch live” button for {court} on {day}. Without it the stream exists and nobody is pointed at it.",
              )
                .replace("{court}", court.court_name)
                .replace("{day}", fmtDayLabel(day))}
            </p>
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
                  {t("nothing — spectators see no Watch live button for this court.")}
                </span>
              )}
            </p>
            {!canManage ? (
              <p className="text-xs text-muted-foreground">
                {t("Read only — only organisers can publish a link.")}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The things that go wrong at a court, and what to do about them — the
 * troubleshooting half of `docs/obs-overlay.md`, kept as a disclosure at the
 * bottom because it is reference material: nobody reads it on the way in, and
 * everybody wants it at 10:04 when a court has gone amber.
 */
function Troubleshooting(): React.ReactElement {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const items: [string, string][] = [
    [
      t("The overlay is blank in OBS"),
      t(
        "Move the source above the camera. Open the URL in a normal browser — if it is blank there too, re-copy it from this page. Otherwise right-click the source → Refresh cache of current page, and check the source is 1920×1080 and not 0×0.",
      ),
    ],
    [
      t("The score is frozen, or the dot went amber"),
      t(
        "Amber means nothing has been confirmed for 20 seconds — the venue's internet dropped or the backend restarted. It repairs itself; do not refresh. If only one court is amber, that court's scorer has probably stopped sending. And a match still “scheduled” shows UP NEXT, not a score, however loud the court is.",
      ),
    ],
    [
      t("Wrong court, or no match ever appears"),
      t(
        "The court in the URL is matched against the fixture's venue text. If a match moved courts, change its venue in the control room — the pages follow the fixture, not the room. A venue containing a slash cannot be addressed at all; rename it.",
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
    <section data-testid="setup-help" className="panel flex flex-col">
      <h3>
        <button
          type="button"
          data-testid="setup-help-toggle"
          aria-expanded={open}
          aria-controls={`${uid}-help`}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <LifeBuoy aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="panel-title">{t("When something looks wrong")}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </h3>
      {open ? (
        <dl
          id={`${uid}-help`}
          data-testid="setup-help-body"
          className="flex flex-col gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground"
        >
          {items.map(([term, detail]) => (
            <div key={term}>
              <dt className="font-medium text-foreground">{term}</dt>
              <dd>{detail}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
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
 * The shape follows the real decision, *how are you filming this court?*:
 *
 * 1. **Pick the court.** Every court, each showing whether a watch link is
 *    already live for it, so a walk-up can see what still needs doing.
 * 2. **The phone route leads**, because it needs no equipment — and it opens
 *    with a **QR code**, which is the only control that can move the broadcast
 *    URL from this screen onto the handset that will film. A copy button cannot
 *    do that, and `…/court/Court%20%C2%B7%20T1` is not something anyone types
 *    on a phone keyboard.
 * 3. **OBS** for whoever has a laptop, faithfully from `docs/obs-overlay.md`.
 * 4. **The YouTube link goes back in on this same page** — the loop closes
 *    where it was opened, with no "now go and find the other page".
 *
 * Everything is per court and self-contained; the sections are one-at-a-time
 * so a phone-sized screen shows one court's whole job rather than a scroll of
 * six identical guides.
 */
export function StreamSetupPage(): React.ReactElement {
  const { id = "" } = useParams();
  const [chosen, setChosen] = useState<string | null>(null);

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
  // The first court is open on arrival: a setup page that opens on a list of
  // closed rows is the disclosure problem again, one level down.
  const openCourt = chosen ?? courts[0]?.court_id ?? null;

  const header = (
    <div className="flex flex-col gap-2">
      <Link
        to={routes.tournamentStreams(id)}
        data-testid="setup-back"
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Back to Live streams")}
      </Link>
      <h2 className="page-title">{t("Set up a camera on a court")}</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">
        {t(
          "Pick the court you are filming. Scan the QR code with the phone that will film it, or use OBS if you have a laptop — then paste the YouTube link back in, which is what gives spectators a “Watch live” button.",
        )}
      </p>
    </div>
  );

  if (loading) {
    return (
      <div className="flex w-full flex-col gap-3">
        {header}
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
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

      <section data-testid="setup-courts" className="panel flex flex-col">
        <div className="panel-header">
          <MapPin aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
          <h3 className="panel-title">{t("Choose a court")}</h3>
          <span className="ml-auto font-tabular text-xs text-muted-foreground">
            {courts.length} {courts.length === 1 ? t("court") : t("courts")}
            {days.length > 0 ? ` · ${fmtDayLabel(day)}` : ""}
          </span>
        </div>

        {courts.length === 0 ? (
          <p
            data-testid="setup-no-courts"
            className="px-4 py-12 text-center text-sm text-muted-foreground"
          >
            {t("No courts yet. They appear once the fixtures are scheduled.")}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {courts.map((c) => (
              <CourtSetup
                key={c.court_id}
                tournamentId={id}
                slug={slug}
                court={c}
                day={day}
                isToday={day === today}
                dayLink={findCourtDayLink(links, c.court_id, day)}
                matchCount={perCourt.get(c.court_name) ?? 0}
                canManage={canManage}
                open={openCourt === c.court_id}
                // Collapsing the open one parks an empty string, which the
                // `?? courts[0]` default deliberately does NOT fall through.
                onToggle={() =>
                  setChosen(openCourt === c.court_id ? "" : c.court_id)
                }
              />
            ))}
          </div>
        )}
      </section>

      <Troubleshooting />

      <p className="text-xs text-muted-foreground">
        {t(
          "A link for one match only, or for a whole sport category, is set on the Live streams page. The full operator guide is docs/obs-overlay.md in the product handbook.",
        )}
      </p>
    </div>
  );
}
