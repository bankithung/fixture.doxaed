import { useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Tags, typed or picked.
 *
 * Free text on purpose: nothing here decides what is worth tagging. The
 * tournament's own sports and categories are offered as one-tap suggestions so
 * the common case costs nothing, and the host can still type "Final" or
 * "Best rally" — which is the half a fixed vocabulary always misses.
 */
export function TagField({
  value,
  onChange,
  suggestions,
  testid = "tags",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  testid?: string;
}): React.ReactElement {
  const [draft, setDraft] = useState("");

  const add = (raw: string): void => {
    const label = raw.trim().slice(0, 40);
    if (!label) return;
    if (value.some((v) => v.toLowerCase() === label.toLowerCase())) return;
    onChange([...value, label].slice(0, 12));
    setDraft("");
  };

  const unused = suggestions.filter(
    (s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-2">
      {value.length ? (
        <span className="flex flex-wrap gap-1.5" data-testid={`${testid}-chips`}>
          {value.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary"
            >
              {tag}
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v !== tag))}
                aria-label={`${t("Remove tag")} ${tag}`}
                data-testid={`${testid}-remove-${tag}`}
                className="rounded-full p-0.5 hover:bg-primary/20"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          ))}
        </span>
      ) : null}

      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => add(draft)}
        placeholder={t("Type a tag and press Enter")}
        aria-label={t("Tags")}
        data-testid={`${testid}-input`}
      />

      {unused.length ? (
        <span className="flex flex-wrap gap-1" data-testid={`${testid}-suggestions`}>
          {unused.slice(0, 14).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              data-testid={`${testid}-suggest-${s}`}
              className={cn(
                "rounded-full border border-dashed border-border px-2 py-0.5 text-[0.6875rem]",
                "text-muted-foreground hover:border-primary/40 hover:text-primary",
              )}
            >
              {s}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}
