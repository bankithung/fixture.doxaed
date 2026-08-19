import { Paperclip } from "lucide-react";
import type { UploadRef } from "@/api/tournaments";
import { cn } from "@/lib/tailwind";

/** A row of uploaded-file chips — images preview as thumbnails, everything
 * else shows a paperclip; each opens the signed view URL in a new tab.
 *
 * Shared because the same files are the answer to two different questions: the
 * Teams tab asks "what did this squad send in", the participants list asks
 * "what has this child's school sent for them". Same chip either way.
 */
export function FileChips({
  files,
  className,
}: {
  files: UploadRef[];
  className?: string;
}): React.ReactElement | null {
  if (!files.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {files.map((f) => {
        const isImg = f.content_type.startsWith("image/");
        // Show the respondent's document name when given; the filename is the
        // hover title so the admin can still see the original.
        const label = f.label || f.name;
        return (
          <a
            key={f.url}
            href={f.url}
            target="_blank"
            rel="noreferrer"
            title={f.label ? f.name : undefined}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-primary transition-colors hover:bg-accent"
          >
            {isImg ? (
              <img
                src={f.url}
                alt={label}
                className="h-6 w-6 shrink-0 rounded border border-border object-cover"
              />
            ) : (
              <Paperclip aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="max-w-[11rem] truncate">{label}</span>
          </a>
        );
      })}
    </div>
  );
}
