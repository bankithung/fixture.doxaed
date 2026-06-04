import * as React from "react";
import { cn } from "@/lib/tailwind";

/**
 * Initials avatar with a deterministic background colour derived from the
 * email's hash. Used by the member directory and (later) by anywhere we
 * want to give a person a recognisable but generated visual identity.
 *
 * Keep this self-contained: no external state, no avatar URLs (v1 has no
 * upload pipeline). When the upload pipeline lands we'll add an `imgSrc`
 * prop and prefer it over the initials fallback.
 */

export interface AvatarProps {
  /** Email string — used both for the colour hash and a default `alt`. */
  email: string;
  /** Optional name to derive initials from. Falls back to email local-part. */
  name?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE_CLASS: Record<NonNullable<AvatarProps["size"]>, string> = {
  sm: "h-7 w-7 text-xs",
  md: "h-9 w-9 text-sm",
  lg: "h-12 w-12 text-base",
};

/** 12 muted-but-distinct hues. Saturation/lightness tuned for AA-on-white. */
const PALETTE = [
  "hsl(0 65% 45%)",
  "hsl(20 70% 42%)",
  "hsl(45 75% 38%)",
  "hsl(80 55% 35%)",
  "hsl(140 50% 36%)",
  "hsl(170 55% 36%)",
  "hsl(195 60% 38%)",
  "hsl(215 60% 45%)",
  "hsl(245 55% 50%)",
  "hsl(270 50% 48%)",
  "hsl(300 50% 42%)",
  "hsl(330 60% 44%)",
];

/** Stable djb2-ish hash → palette index. Deterministic across renders. */
export function colourForEmail(email: string): string {
  let h = 5381;
  const s = email.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h) % PALETTE.length;
  return PALETTE[idx];
}

/**
 * Initials derivation.
 *
 * Goal (DEFECT-K): make initials disambiguate similar email local-parts
 * such as ``coord@…`` vs ``coorg@…``, both of which previously collapsed
 * to ``CO``.
 *
 * Rules, in priority order:
 *   1. If a name with two or more words is provided, take
 *      ``first(word_0) + first(word_last)``.
 *      Example: ``"Coordinator User"`` → ``CU``.
 *   2. If a single-word name is provided, take its first two letters.
 *      Example: ``"Solo"`` → ``SO``. (Short names render a single letter.)
 *   3. With no name, derive from the email local-part:
 *        - Multi-segment local-parts (``john.doe`` / ``jane_q_public``)
 *          use ``first(seg_0) + first(seg_last)`` → ``JD`` / ``JP``.
 *        - Single-segment local-parts use
 *          ``first_char + last_char`` of the local-part so adjacent
 *          spellings disambiguate. ``coord`` → ``CD``; ``coorg`` → ``CG``.
 *          Single-character local-parts return one upper-case letter.
 *   4. Empty input returns ``?``.
 */
export function initialsFor(name: string | undefined, email: string): string {
  const trimmedName = name?.trim() ?? "";
  if (trimmedName) {
    const parts = trimmedName.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
  }
  const local = (email.split("@")[0] ?? "").trim();
  if (!local) return "?";
  const segs = local.split(/[._-]+/).filter(Boolean);
  if (segs.length >= 2) {
    return (segs[0][0] + segs[segs.length - 1][0]).toUpperCase();
  }
  if (local.length === 1) return local.toUpperCase();
  // First and last letters of the single-segment local-part disambiguate
  // similar prefixes (``coord`` -> CD vs ``coorg`` -> CG).
  return (local[0] + local[local.length - 1]).toUpperCase();
}

export function Avatar({
  email,
  name,
  size = "md",
  className,
}: AvatarProps): React.ReactElement {
  const colour = colourForEmail(email);
  const initials = initialsFor(name, email);
  const label = name?.trim() || email;
  return (
    <span
      role="img"
      aria-label={label}
      data-testid="avatar"
      data-color={colour}
      style={{ backgroundColor: colour }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white shadow-sm select-none",
        SIZE_CLASS[size],
        className,
      )}
    >
      {initials}
    </span>
  );
}
