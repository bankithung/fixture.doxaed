import { QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/types/api";

/**
 * Side-channel for cross-cutting auth/reauth signals. The auth feature
 * subscribes to these and reacts (redirect to /login, open re-auth modal).
 * Decoupling avoids a hard import cycle between queryClient and authStore.
 */
export type AuthEvent =
  | { type: "unauthenticated" }
  | { type: "password_reauth_required" };

type Listener = (e: AuthEvent) => void;
const listeners = new Set<Listener>();
export function onAuthEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(e: AuthEvent): void {
  for (const fn of listeners) fn(e);
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError) {
        if (error.isUnauthenticated) emit({ type: "unauthenticated" });
        else if (error.isPasswordReauthRequired)
          emit({ type: "password_reauth_required" });
      }
    },
  }),
});

/** Bus exported for mutations to call directly when they catch an error. */
export const authBus = { emit };
