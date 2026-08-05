import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { errorDetail, writeMayHaveLanded } from "@/features/fixtures/repair";
import { newEventId } from "@/lib/eventId";
import { qk } from "@/lib/queryKeys";
import { t } from "@/lib/t";
import { cn } from "@/lib/tailwind";
import { ApiError } from "@/types/api";
import { sourceLabel, watchUrlWarning, type LinkSource } from "./streamLinks";

/**
 * The paste-a-YouTube-link control and the "where is this court's link coming
 * from" chip — shared by the two streaming surfaces.
 *
 * They live here rather than in either page because BOTH pages have to be able
 * to publish a link: the Live streams board (the morning's per-court/per-day
 * work) and the broadcast setup page (a volunteer at a court, closing the loop
 * without navigating away). One copy, so a fix to the retry semantics or to the
 * refusal message reaches both.
 */

/** What a save/toggle/clear press asks for. Every one carries its own
 * `event_id` (invariant 3). */
export type EditorAction =
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
export function SourceChip({
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
export function LinkEditor({
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
