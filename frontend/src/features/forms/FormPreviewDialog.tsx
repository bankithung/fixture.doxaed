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
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      {/* Top bar */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 sm:px-6">
        <Eye aria-hidden="true" className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">{t("Preview")}</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {t("How respondents see your form. Nothing is saved.")}
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
                {schema && t("That's the end of the preview.")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Nothing is recorded in preview.")}
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
                {t("Add a section and fields to preview.")}
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
                {(() => {
                  // Mirror the public renderer's group cards (W2) so the
                  // admin previews exactly what schools will see.
                  const out: React.ReactNode[] = [];
                  const fields = current.fields;
                  let i = 0;
                  while (i < fields.length) {
                    const f = fields[i];
                    if (!f.group) {
                      if (isVisible(f.visibility, answers)) {
                        out.push(
                          <div key={f.key} className="flex flex-col gap-1.5">
                            <FieldRenderer
                              field={f}
                              value={answers[f.key]}
                              onChange={(v) => set(f.key, v)}
                            />
                          </div>,
                        );
                      }
                      i += 1;
                      continue;
                    }
                    const group = f.group;
                    const chunk: typeof fields = [];
                    while (i < fields.length && fields[i].group === group) {
                      chunk.push(fields[i]);
                      i += 1;
                    }
                    const visible = chunk.filter((c) =>
                      isVisible(c.visibility, answers),
                    );
                    if (!visible.length) continue;
                    out.push(
                      <div
                        key={`group-${group}`}
                        className="flex flex-col gap-4 rounded-lg border border-border bg-muted/20 p-4"
                      >
                        <h3 className="text-sm font-semibold">
                          {t(chunk[0].group_label ?? group)}
                        </h3>
                        {visible.map((c) => {
                          const depth = Math.min(c.indent ?? 0, 4);
                          return (
                            <div
                              key={c.key}
                              className={
                                depth > 0
                                  ? "border-l-2 border-border pl-3"
                                  : undefined
                              }
                              style={
                                depth > 0
                                  ? { marginLeft: (depth - 1) * 16 }
                                  : undefined
                              }
                            >
                              <FieldRenderer
                                field={{
                                  ...c,
                                  label: c.short_label ?? c.label,
                                }}
                                value={answers[c.key]}
                                onChange={(v) => set(c.key, v)}
                              />
                            </div>
                          );
                        })}
                      </div>,
                    );
                  }
                  return out;
                })()}
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
