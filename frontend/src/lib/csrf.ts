/**
 * Read the Django CSRF token from the `csrftoken` cookie.
 *
 * Per v1Users.md Appendix B.10, the SPA shares the Django session cookie
 * (same origin via Vite proxy in dev) and must echo the CSRF token back in
 * the `X-CSRFToken` header on every unsafe verb.
 */
export function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
