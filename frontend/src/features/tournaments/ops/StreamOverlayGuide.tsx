import { useId, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  MonitorPlay,
  Smartphone,
} from "lucide-react";
import type { CourtStreamRow } from "@/api/streaming";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { cameraBroadcastUrl, currentOrigin, overlayCourtUrl } from "./streamLinks";

/** Copy that differs between the two broadcast routes. Keeping it in one place
 * means the OBS rows and the phone rows are the same component with different
 * words, not two components that will drift. */
interface UrlRowCopy {
  /** Prefix for this row's test ids — `overlay-…` or `camera-…`. */
  idPrefix: string;
  copyLabel: string;
  openLabel: string;
  copiedToast: string;
  failedToast: string;
}

const OVERLAY_COPY: UrlRowCopy = {
  idPrefix: "overlay",
  copyLabel: t("Copy the overlay URL for {court}"),
  openLabel: t("Open the overlay for {court} in a new tab"),
  copiedToast: t("Overlay URL copied"),
  failedToast: t("Could not copy the overlay URL"),
};

const CAMERA_COPY: UrlRowCopy = {
  idPrefix: "camera",
  copyLabel: t("Copy the phone camera URL for {court}"),
  openLabel: t("Open the phone camera page for {court} in a new tab"),
  copiedToast: t("Phone camera URL copied"),
  failedToast: t("Could not copy the phone camera URL"),
};

/**
 * One court's ready-to-use broadcast URL: the string as text (so it can be
 * selected and copied by hand, or read by a screen reader character by
 * character) plus a real Copy button and a preview link.
 *
 * The URL is built by the app on purpose — see `overlayCourtUrl`. A venue like
 * `Court2 · T3` has to reach OBS as `Court2%20%C2%B7%20T3`, and nobody types
 * `%C2%B7` correctly twice. The phone URL addresses the court exactly the same
 * way, so it gets exactly the same treatment.
 */
function CourtUrlRow({
  copy: words,
  courtId,
  courtName,
  url,
}: {
  copy: UrlRowCopy;
  courtId: string;
  courtName: string;
  url: string;
}): React.ReactElement {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const doCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.push({
        kind: "success",
        title: words.copiedToast,
        description: courtName,
      });
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.push({
        kind: "error",
        title: words.failedToast,
        description: t("Select the URL below and copy it by hand."),
      });
    }
  };

  return (
    <div
      data-testid={`${words.idPrefix}-url-row-${courtId}`}
      className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{courtName}</span>
        {/* Selectable text, never truncated: the copy button is the shortcut,
            not the only way through. */}
        <code
          data-testid={`${words.idPrefix}-url-${courtId}`}
          className="block select-all break-all font-mono text-[0.6875rem] text-muted-foreground"
        >
          {url}
        </code>
      </span>
      <button
        type="button"
        data-testid={`${words.idPrefix}-copy-${courtId}`}
        aria-label={words.copyLabel.replace("{court}", courtName)}
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
        aria-label={words.openLabel.replace("{court}", courtName)}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ExternalLink aria-hidden="true" className="h-4 w-4" />
      </a>
    </div>
  );
}

/** A step's heading + body, numbered by the surrounding <ol>. */
function Step({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <li className="flex flex-col gap-2">
      <h4 className="text-[13px] font-semibold">{title}</h4>
      {children}
    </li>
  );
}

/** A two-column settings/options table (scrolls on its own below a phone). */
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
      <table data-testid={testid} className="w-full min-w-[22rem] text-xs">
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
 * **Put the score on your stream** — the in-product OBS setup guide, on the
 * page where an organiser already works on streaming.
 *
 * It lives here rather than in a nav item of its own because the two halves of
 * one job are here: the overlay feeds the score *into* the video, and the paste
 * boxes below publish the finished video back *out* to spectators. A collapsed
 * disclosure keeps the daily work (the court bands) at the top of the page —
 * the same idiom the court bands already use for "Default for every day".
 *
 * The steps are a faithful, shortened copy of `docs/obs-overlay.md`; the OBS
 * settings in it are load-bearing and are NOT re-invented here.
 */
export function StreamOverlayGuide({
  slug,
  tournamentId,
  courts,
}: {
  slug: string;
  tournamentId: string;
  courts: CourtStreamRow[];
}): React.ReactElement {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const origin = currentOrigin();

  return (
    <section data-testid="overlay-guide" className="panel flex flex-col">
      <h3>
        <button
          type="button"
          data-testid="overlay-guide-toggle"
          aria-expanded={open}
          aria-controls={`${uid}-body`}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <MonitorPlay aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="panel-title">
            {t("Put the live score on your stream")}
          </span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {t("One URL per court — for OBS on a laptop, or a phone on its own.")}
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
          data-testid="overlay-guide-body"
          className="border-t border-border px-4 py-3"
        >
          <p className="pb-3 text-xs text-muted-foreground">
            {t(
              "The overlay is a web page that draws the scorebug over your camera. It follows whatever match is live on that court by itself — set it up once at the start of the tournament and never touch it again.",
            )}
          </p>
          <p className="pb-3 text-xs text-muted-foreground">
            {t(
              "Steps 1–5 are the OBS route, for a laptop. With no laptop, skip to “No laptop?” at the bottom: the phone can do the whole job on its own.",
            )}
          </p>

          <ol className="flex list-none flex-col gap-5">
            <Step title={t("1. Copy this court's overlay URL")}>
              <p className="text-xs text-muted-foreground">
                {t(
                  "One URL per court, already encoded for you. Don't retype it — a court name with a space or a “·” has to be encoded exactly, and the app has done that here.",
                )}
              </p>
              {courts.length === 0 || !slug ? (
                <p
                  data-testid="overlay-guide-no-courts"
                  className="text-xs text-muted-foreground"
                >
                  {t("The URLs appear here once the fixtures have courts.")}
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {courts.map((c) => (
                    <CourtUrlRow
                      key={c.court_id}
                      copy={OVERLAY_COPY}
                      courtId={c.court_id}
                      courtName={c.court_name}
                      url={overlayCourtUrl(
                        origin,
                        slug,
                        tournamentId,
                        c.court_name,
                      )}
                    />
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t(
                  "Open one in a browser first: it should show the court name, or the match that is on. If it does, OBS will show the same thing.",
                )}
              </p>
            </Step>

            <Step title={t("2. Add it to OBS as a Browser Source")}>
              <p className="text-xs text-muted-foreground">
                {t(
                  "In OBS: Sources → + → Browser → Create new, and name it after the court.",
                )}
              </p>
              <SettingsTable
                testid="overlay-guide-obs-settings"
                caption={t("OBS Browser Source settings")}
                head={[t("Field"), t("Value")]}
                rows={[
                  [t("URL"), t("the court URL from step 1")],
                  [t("Width"), <Mono key="w">1920</Mono>],
                  [t("Height"), <Mono key="h">1080</Mono>],
                  [
                    t("Use custom frame rate"),
                    t("OFF — let it follow the canvas"),
                  ],
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
            </Step>

            <Step title={t("3. Options you can add to the URL")}>
              <SettingsTable
                testid="overlay-guide-options"
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
                {t("Options combine, e.g.")}{" "}
                <Mono>?scale=0.667&amp;side=right</Mono>
              </p>
            </Step>

            <Step title={t("4. Paste the YouTube link back here")}>
              <p className="text-xs text-muted-foreground">
                {t(
                  "OBS sends the picture out; this page sends viewers to it. Once you are streaming, copy the YouTube watch link of that broadcast and paste it into this court's box below. That is what publishes the “Watch live” button on the public schedule — without it, the stream exists but nobody is pointed at it.",
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  "The two halves are one job: the overlay puts the score into the video, this page puts the video in front of spectators.",
                )}
              </p>
            </Step>

            <Step title={t("5. When something looks wrong")}>
              <dl className="flex flex-col gap-2 text-xs text-muted-foreground">
                <div>
                  <dt className="font-medium text-foreground">
                    {t("The overlay is blank")}
                  </dt>
                  <dd>
                    {t(
                      "Move the source above the camera. Open the URL in a normal browser — if it is blank there too, re-copy it from step 1. Otherwise right-click the source → Refresh cache of current page, and check the source is 1920×1080 and not 0×0.",
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-foreground">
                    {t("The score is frozen, or the dot went amber")}
                  </dt>
                  <dd>
                    {t(
                      "Amber means nothing has been confirmed for 20 seconds — the venue's internet dropped or the backend restarted. It repairs itself; do not refresh. If only one court is amber, that court's scorer has probably stopped sending. And a match still “scheduled” shows UP NEXT, not a score, however loud the court is.",
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-foreground">
                    {t("Wrong court, or no match ever appears")}
                  </dt>
                  <dd>
                    {t(
                      "The court in the URL is matched against the fixture's venue text. If a match moved courts, change its venue in the control room — the overlay follows the fixture, not the room. A venue containing a slash cannot be addressed at all; rename it.",
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-foreground">
                    {t("The serve dot is on the wrong side")}
                  </dt>
                  <dd>
                    {t(
                      "Table tennis and sepak takraw only: add ?server=away to that court's URL and refresh the source once.",
                    )}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">
                {t(
                  "The full operator guide, with every board the overlay can show, is docs/obs-overlay.md in the product handbook.",
                )}
              </p>
            </Step>
          </ol>

          {/* The question every organiser asks. It used to be answered with
              "you can't" — the phone camera page is the answer now. */}
          <div
            data-testid="overlay-guide-phone"
            className="mt-5 flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3"
          >
            <h4 className="flex items-center gap-2 text-[13px] font-semibold">
              <Smartphone aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
              {t("No laptop? Stream from a phone, score included")}
            </h4>
            <p className="text-xs text-muted-foreground">
              {t(
                "Open this court's phone page on the phone that will film the match. It shows the phone's rear camera with the same live scoreboard drawn on top — then you broadcast that screen from the YouTube app. The score goes out inside the picture, with no OBS and no other app.",
              )}
            </p>

            {courts.length === 0 || !slug ? (
              <p
                data-testid="camera-guide-no-courts"
                className="text-xs text-muted-foreground"
              >
                {t("The URLs appear here once the fixtures have courts.")}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {courts.map((c) => (
                  <CourtUrlRow
                    key={c.court_id}
                    copy={CAMERA_COPY}
                    courtId={c.court_id}
                    courtName={c.court_name}
                    url={cameraBroadcastUrl(
                      origin,
                      slug,
                      tournamentId,
                      c.court_name,
                    )}
                  />
                ))}
              </div>
            )}

            <ol className="flex list-decimal flex-col gap-1 pl-4 text-xs text-muted-foreground">
              <li>
                {t(
                  "Send this court's URL to the phone that will film (WhatsApp it to the volunteer — don't retype it) and open it there.",
                )}
              </li>
              <li>
                {t(
                  "Tap Start camera, and allow the camera when the phone asks.",
                )}
              </li>
              <li>
                {t(
                  "Tap Full screen, so the address bar is not in the picture, and hold the phone sideways.",
                )}
              </li>
              <li>
                {t(
                  "Open the YouTube app → Create → Go live → Screen, choose this browser, and start the broadcast.",
                )}
              </li>
              <li>
                {t(
                  "Copy the YouTube watch link and paste it into this court's box below — that is what gives spectators the “Watch live” button.",
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
              <li>
                {t(
                  "It takes the same ?scale=, ?side= and ?server= options as the OBS URL, and it follows the court's fixtures the same way.",
                )}
              </li>
              <li>
                {t(
                  "If a laptop is available, OBS is still the better picture — it has scenes, a proper encoder and no phone to babysit. This is the route for when there isn't one.",
                )}
              </li>
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
