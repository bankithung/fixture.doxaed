import { useRef, useState } from "react";
import { Bold, Italic, RemoveFormatting, Underline } from "lucide-react";
import { t } from "@/lib/t";

/** Content colours the author can apply (concrete values — this is user content,
 *  not UI chrome, so it carries real colours rather than theme tokens). */
const COLORS = [
  { name: "Default", value: "#111827" },
  { name: "Grey", value: "#6b7280" },
  { name: "Red", value: "#dc2626" },
  { name: "Orange", value: "#ea580c" },
  { name: "Green", value: "#16a34a" },
  { name: "Blue", value: "#2563eb" },
  { name: "Purple", value: "#7c3aed" },
];

/** execCommand font-size buckets (1–7 scale). */
const SIZES = [
  { label: "S", value: "2" },
  { label: "M", value: "3" },
  { label: "L", value: "5" },
  { label: "XL", value: "6" },
];

function ToolbarButton({
  title,
  onApply,
  children,
}: {
  title: string;
  onApply: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      // Keep the editor's selection — a mousedown on the button would blur it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onApply}
      className="inline-flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

/**
 * Minimal contenteditable rich-text editor (bold / italic / underline / colour /
 * size / line breaks) — no third-party dependency. The HTML it emits is
 * sanitised on save + on render (see `lib/richText`), so paste injection can't
 * reach the public page.
 */
export function RichTextEditor({
  value,
  onChange,
  ariaLabel,
  placeholder,
}: {
  value: string;
  onChange: (html: string) => void;
  ariaLabel: string;
  placeholder?: string;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const inited = useRef(false);
  const [empty, setEmpty] = useState(true);

  // Seed the editable region once from `value`; never re-write it on each
  // keystroke (that would reset the caret). The parent owns the value after.
  const attach = (el: HTMLDivElement | null): void => {
    ref.current = el;
    if (el && !inited.current) {
      el.innerHTML = value || "";
      inited.current = true;
      setEmpty(!el.textContent?.trim());
    }
  };

  const sync = (): void => {
    const el = ref.current;
    if (!el) return;
    setEmpty(!el.textContent?.trim());
    onChange(el.innerHTML);
  };

  const exec = (command: string, arg?: string): void => {
    ref.current?.focus();
    try {
      // Emit CSS spans (e.g. font-weight) rather than legacy tags where the
      // browser supports it — keeps the sanitiser's allowlist small.
      document.execCommand("styleWithCSS", false, "true");
    } catch {
      /* not all engines accept styleWithCSS; harmless */
    }
    document.execCommand(command, false, arg);
    sync();
  };

  return (
    <div className="rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
      <div
        role="toolbar"
        aria-label={t("Text formatting")}
        className="flex flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1"
      >
        <ToolbarButton title={t("Bold")} onApply={() => exec("bold")}>
          <Bold aria-hidden="true" className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title={t("Italic")} onApply={() => exec("italic")}>
          <Italic aria-hidden="true" className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title={t("Underline")} onApply={() => exec("underline")}>
          <Underline aria-hidden="true" className="h-3.5 w-3.5" />
        </ToolbarButton>

        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        {SIZES.map((s) => (
          <ToolbarButton
            key={s.value}
            title={t(`Text size ${s.label}`)}
            onApply={() => exec("fontSize", s.value)}
          >
            <span className="font-medium">{s.label}</span>
          </ToolbarButton>
        ))}

        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        {COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            title={t(`${c.name} text`)}
            aria-label={t(`${c.name} text`)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => exec("foreColor", c.value)}
            className="h-4 w-4 rounded-full border border-border/70 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ backgroundColor: c.value }}
          />
        ))}

        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <ToolbarButton
          title={t("Clear formatting")}
          onApply={() => exec("removeFormat")}
        >
          <RemoveFormatting aria-hidden="true" className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>

      <div className="relative">
        <div
          ref={attach}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          onInput={sync}
          className="min-h-[96px] w-full px-3 py-2 text-sm leading-relaxed focus-visible:outline-none [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5"
        />
        {empty && placeholder ? (
          <span className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">
            {placeholder}
          </span>
        ) : null}
      </div>
    </div>
  );
}
