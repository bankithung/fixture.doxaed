import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import {
  assistantApi,
  type AssistantChatMessage,
  type AssistantReply,
} from "@/api/assistant";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { invalidateTournament } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useAssistantStore, type AssistantMsg } from "./assistantStore";

/** Stable reference for "no messages yet" — a fresh `[]` in the selector would
 * change identity every render and spin useSyncExternalStore forever. */
const EMPTY: AssistantMsg[] = [];

/** Starter prompts shown on the empty state — one tap sends them. */
const SUGGESTIONS = [
  "Set up everything for me",
  "What's done and what's left?",
  "Walk me through it step by step",
  "What format should each sport use?",
];

/** Launcher + slide-over chat. Renders nothing for non-managers (the assistant
 * performs setup writes, which are manager-only). */
export function AssistantWidget({
  tournamentId,
  canManage,
}: {
  tournamentId: string;
  canManage: boolean;
}): React.ReactElement | null {
  const open = useAssistantStore((s) => s.open);
  const setOpen = useAssistantStore((s) => s.setOpen);
  const openPlain = useAssistantStore((s) => s.openPlain);
  if (!canManage) return null;
  return (
    <>
      {!open ? (
        <button
          type="button"
          data-testid="assistant-launcher"
          onClick={openPlain}
          className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-lg transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Sparkles aria-hidden="true" className="h-4 w-4" />
          {t("Ask AI")}
        </button>
      ) : null}
      {open ? (
        <AssistantPanel
          tournamentId={tournamentId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function AssistantPanel({
  tournamentId,
  onClose,
}: {
  tournamentId: string;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const messages = useAssistantStore(
    (s) => s.byTournament[tournamentId] ?? EMPTY,
  );
  const appendMsg = useAssistantStore((s) => s.append);
  const reset = useAssistantStore((s) => s.reset);
  const focus = useAssistantStore((s) => s.focus);
  const clearFocus = useAssistantStore((s) => s.clearFocus);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const chat = useMutation({
    mutationFn: (vars: { history: AssistantChatMessage[]; focus?: string }) =>
      assistantApi.chat(tournamentId, vars.history, vars.focus),
    onSuccess: (data: AssistantReply) => {
      appendMsg(tournamentId, {
        role: "assistant",
        content: data.reply,
        actions: data.actions,
      });
      if (data.changed) invalidateTournament(qc, tournamentId);
    },
    onError: (e) => {
      const reply =
        e instanceof ApiError && typeof e.payload.reply === "string"
          ? e.payload.reply
          : t("Something went wrong. Please try again.");
      appendMsg(tournamentId, { role: "assistant", content: reply, error: true });
    },
  });

  // Keep the latest message in view + focus the box when opened.
  useEffect(() => {
    logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight });
  }, [messages, chat.isPending]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const send = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed || chat.isPending) return;
    const next: AssistantChatMessage[] = [
      ...messages
        .filter((m) => !m.error)
        .map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: trimmed },
    ];
    appendMsg(tournamentId, { role: "user", content: trimmed });
    chat.mutate({ history: next, focus: focus?.hint });
    if (inputRef.current) inputRef.current.value = "";
  };

  const suggestions = focus
    ? ["Set this up for me", "What do you recommend?", "Explain this"]
    : SUGGESTIONS;

  return (
    <aside
      aria-label={t("Setup assistant")}
      data-testid="assistant-panel"
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-card shadow-2xl"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Sparkles aria-hidden="true" className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t("Setup assistant")}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {t("Ask for help, or tell me what to set up")}
          </p>
        </div>
        {messages.length > 0 ? (
          <button
            type="button"
            aria-label={t("New chat")}
            title={t("New chat")}
            data-testid="assistant-reset"
            onClick={() => reset(tournamentId)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RotateCcw aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={t("Close")}
          data-testid="assistant-close"
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </header>

      {focus ? (
        <div
          data-testid="assistant-focus"
          className="flex items-center gap-2 border-b border-border bg-primary/5 px-4 py-2 text-xs"
        >
          <Sparkles aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted-foreground">{t("Helping with:")}</span>{" "}
            <span className="font-medium">{focus.label}</span>
          </span>
          <button
            type="button"
            aria-label={t("Clear focus")}
            data-testid="assistant-clear-focus"
            onClick={clearFocus}
            className="rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-busy={chat.isPending}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {focus
                ? t(`Ask me about ${focus.label}, or tell me to set it up for you.`)
                : t(
                    "I can set your dates, venues, formats, breaks and clash rules — just ask. I won't publish anything; that's still your click.",
                  )}
            </p>
            <div className="flex flex-col gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  data-testid="assistant-suggestion"
                  onClick={() => send(s)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                >
                  {t(s)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => <Bubble key={i} msg={m} />)
        )}
        {chat.isPending ? (
          <div
            data-testid="assistant-thinking"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            {t("Thinking…")}
          </div>
        ) : null}
      </div>

      <form
        className="border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(inputRef.current?.value ?? "");
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            data-testid="assistant-input"
            placeholder={t("Ask or tell me what to set up…")}
            className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send((e.target as HTMLTextAreaElement).value);
              }
            }}
          />
          <Button
            type="submit"
            size="icon"
            aria-label={t("Send")}
            data-testid="assistant-send"
            disabled={chat.isPending}
          >
            <Send aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </aside>
  );
}

function Bubble({ msg }: { msg: AssistantMsg }): React.ReactElement {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
          {msg.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-bl-sm px-3 py-2 text-sm",
          msg.error
            ? "bg-destructive-muted text-destructive"
            : "bg-muted text-foreground",
        )}
      >
        {msg.error ? (
          <span className="mb-1 flex items-center gap-1.5 font-medium">
            <AlertCircle aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Couldn't reach the assistant")}
          </span>
        ) : null}
        {msg.content}
      </div>
      {msg.actions && msg.actions.length > 0 ? (
        <ul className="flex flex-col gap-1 pl-1" data-testid="assistant-actions">
          {msg.actions.map((a, i) => (
            <li
              key={i}
              className={cn(
                "flex items-start gap-1.5 text-xs",
                a.ok ? "text-muted-foreground" : "text-destructive",
              )}
            >
              {a.ok ? (
                <Check aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0 text-success" />
              ) : (
                <AlertCircle aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
              )}
              <span>{a.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
