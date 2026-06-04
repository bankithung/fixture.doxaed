/**
 * Translation placeholder. CLAUDE.md invariant #13 (i18n + a11y from day 1):
 * every user-visible string MUST be wrapped in `t()` even though only
 * English ships in v1. When we add i18next/Lingui later, this file is the
 * only call-site that changes.
 */
export const t = (s: string): string => s;
