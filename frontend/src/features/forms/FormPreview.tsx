import { useMemo, useState } from "react";
import { Eye } from "lucide-react";
import { FieldRenderer } from "./fieldRenderers";
import type { FormSchema } from "./types";
import { isVisible, reachableSections } from "@/lib/formLogic";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Live preview of the working schema. Holds its own `answers` state and renders
 * ONLY the reachable+visible sections/fields via the shared evaluator, so
 * choosing an answer shows/hides downstream sections exactly as the public
 * renderer (and the backend) will. Read-only-ish: it accepts input purely to
 * exercise branching.
 */
export function FormPreview({
  schema,
  className,
}: {
  schema: FormSchema;
  className?: string;
}): React.ReactElement {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const sections = useMemo(
    () => reachableSections(schema, answers),
    [schema, answers],
  );

  const set = (key: string, value: unknown) =>
    setAnswers((a) => ({ ...a, [key]: value }));

  return (
    <div
      aria-label={t("Form preview")}
      className={cn(
        "flex flex-col gap-4 rounded-xl border border-border bg-card p-5 shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <Eye aria-hidden="true" className="h-4 w-4 text-primary" />
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t("Live preview")}
        </p>
      </div>

      {sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("Add a section and fields to preview.")}
        </p>
      ) : (
        sections.map((sec) => (
          <section
            key={sec.key}
            aria-label={sec.title || t("Section")}
            className="flex flex-col gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0"
          >
            <div>
              <h3 className="text-sm font-semibold">{t(sec.title)}</h3>
              {sec.description ? (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {t(sec.description)}
                </p>
              ) : null}
            </div>
            {sec.fields
              .filter((f) => isVisible(f.visibility, answers))
              .map((f) => (
                <FieldRenderer
                  key={f.key}
                  field={f}
                  value={answers[f.key]}
                  onChange={(v) => set(f.key, v)}
                />
              ))}
          </section>
        ))
      )}
    </div>
  );
}
