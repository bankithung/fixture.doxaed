/**
 * Client-generated UUID for idempotent writes (architectural invariant 3 —
 * every mutation carries an `event_id`). Uses the Web Crypto UUID when
 * available, with a non-crypto fallback for older/headless environments.
 */
export function newEventId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return (
    c?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}
