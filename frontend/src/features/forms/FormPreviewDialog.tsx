import { useEffect, useMemo, useState } from "react";
import { Eye, X } from "lucide-react";
import { FieldRenderer } from "./fieldRenderers";
import type { FormSchema } from "./types";
import { isVisible, reachableSections } from "@/lib/formLogic";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/t";

/**
 * Google-Forms-style preview: a full-screen overlay that renders the working
 * schema exactly as a respondent sees it — a paged wizard (Next/Back) with the
 * SAME branching evaluator as the public form and backend. Interactive so you
 * can exercise conditional sections, but nothing is submitted or saved.
 */
export function FormPreviewDialog({
  schema,
  title,
  onClose,
}: {
  schema: FormSchema;
  title: string;
  onClose: () => void;
}): React.ReactElement {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [stepIndex, setStepIndex] = useState(0);
  const [done, setDone] = useState(false);

  const sections = useMemo(
    () => reachableSections(schema, answers),
    [schema, answers],
  );
  const clamped = Math.min(stepIndex, Math.max(sections.length - 1, 0));
  const current = sections[clamped];
  const isLast = clamped >= sections.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Lock background scroll while the overlay is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const set = (key: string, value: unknown): void =>
    setAnswers((a) => ({ ...a, [key]: value }));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("Form preview")}
      className="fixed inset-0 z-50 flex flex-col bg-muted/40 backdrop-blur-sm"
    >
      {/* Top bar */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 sm:px-6">
        <Eye aria-hidden="true" className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">{t("Preview")}</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {t("This is how respondents see your form. Nothing is saved.")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close preview")}
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>

      {/* Scrollable respondent view */}
      <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-6">
        <div className="mx-auto w-full max-w-2xl">
          {/* Form title banner */}
          <div className="rounded-t-xl border-x border-t border-border border-t-4 border-t-primary bg-card p-6">
            <h1 className="text-xl font-semibold tracking-tight">
              {title || t("Untitled form")}
            </h1>
          </div>

          {done ? (
            <div className="rounded-b-xl border border-border bg-card p-6">
              <p className="text-sm">
                {schema && t("Thanks — this is the end of the preview.")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Responses are not recorded in preview mode.")}
              </p>
              <div className="mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setAnswers({});
                    setStepIndex(0);
                    setDone(false);
                  }}
                >
                  {t("Restart preview")}
                </Button>
              </div>
            </div>
          ) : sections.length === 0 || !current ? (
            <div className="rounded-b-xl border border-border bg-card p-6">
              <p className="text-sm text-muted-foreground">
                {t("Add a section and some fields to preview the form.")}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="rounded-b-xl border-x border-b border-border bg-card p-6">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("Section")} {clamped + 1} {t("of")} {sections.length}
                </div>
                <h2 className="text-base font-semibold">{t(current.title)}</h2>
                {current.description ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t(current.description)}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-5 rounded-xl border border-border bg-card p-6">
                {current.fields
                  .filter((f) => isVisible(f.visibility, answers))
                  .map((f) => (
                    <div key={f.key} className="flex flex-col gap-1.5">
                      <FieldRenderer
                        field={f}
                        value={answers[f.key]}
                        onChange={(v) => set(f.key, v)}
                      />
                    </div>
                  ))}
              </div>

              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={clamped === 0}
                  onClick={() => setStepIndex((i) => Math.max(i - 1, 0))}
                >
                  {t("Back")}
                </Button>
                {isLast ? (
                  <Button size="sm" onClick={() => setDone(true)}>
                    {t("Submit")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() =>
                      setStepIndex((i) => Math.min(i + 1, sections.length - 1))
                    }
                  >
                    {t("Next")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
