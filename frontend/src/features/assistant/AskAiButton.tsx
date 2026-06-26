import { Sparkles } from "lucide-react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useAssistantStore, type AssistantFocus } from "./assistantStore";

/**
 * Contextual "Ask AI" affordance — attach it to a whole section header or to a
 * single input. Clicking opens the assistant focused on `focus`, so the model
 * interprets the user's questions (and actions) in that context.
 *
 * - `variant="pill"` → a small labelled button for section headers.
 * - `variant="icon"` → an icon-only button to sit beside one field.
 */
export function AskAiButton({
  focus,
  variant = "pill",
  className,
}: {
  focus: AssistantFocus;
  variant?: "pill" | "icon";
  className?: string;
}): React.ReactElement {
  const openWith = useAssistantStore((s) => s.openWith);
  const label = t(`Ask AI about ${focus.label}`);

  if (variant === "icon") {
    return (
      <button
        type="button"
        aria-label={label}
        title={t("Ask AI")}
        data-testid="ask-ai"
        onClick={() => openWith(focus)}
        className={cn(
          "inline-grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <Sparkles aria-hidden="true" className="h-4 w-4" />
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-label={label}
      data-testid="ask-ai"
      onClick={() => openWith(focus)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
      {t("Ask AI")}
    </button>
  );
}
