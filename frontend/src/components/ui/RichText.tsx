import { isLikelyHtml, sanitizeRichText } from "@/lib/richText";
import { cn } from "@/lib/tailwind";

/**
 * Render admin-authored instructions safely. Legacy plain-text values keep
 * their line breaks + spacing (`whitespace-pre-wrap`); formatted values are
 * sanitised (see {@link sanitizeRichText}) before being injected, so the public
 * page can never run author-supplied script.
 */
export function RichText({
  html,
  className,
}: {
  html: string | null | undefined;
  className?: string;
}): React.ReactElement | null {
  const value = (html ?? "").trim();
  if (!value) return null;

  if (!isLikelyHtml(value)) {
    return <div className={cn("whitespace-pre-wrap", className)}>{value}</div>;
  }

  return (
    <div
      className={cn(
        "break-words [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
        className,
      )}
      // Sanitised to a small formatting allowlist immediately above.
      dangerouslySetInnerHTML={{ __html: sanitizeRichText(value) }}
    />
  );
}
