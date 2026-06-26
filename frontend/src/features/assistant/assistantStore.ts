import { create } from "zustand";
import type { AssistantAction } from "@/api/assistant";

/** A rendered message — user/assistant text, optional action receipt, and an
 * `error` flag so a failed turn renders distinctly (and is excluded from the
 * history replayed to the server). */
export interface AssistantMsg {
  role: "user" | "assistant";
  content: string;
  actions?: AssistantAction[];
  error?: boolean;
}

interface AssistantState {
  /** Slide-over open/closed (one panel, shared across the setup pages). */
  open: boolean;
  /** Per-tournament transcript (kept for the session so reopening resumes). */
  byTournament: Record<string, AssistantMsg[]>;
  setOpen: (open: boolean) => void;
  append: (tournamentId: string, msg: AssistantMsg) => void;
  /** Replace the last message (used to swap a "thinking" placeholder). */
  replaceLast: (tournamentId: string, msg: AssistantMsg) => void;
  reset: (tournamentId: string) => void;
}

export const useAssistantStore = create<AssistantState>((set) => ({
  open: false,
  byTournament: {},
  setOpen: (open) => set({ open }),
  append: (tournamentId, msg) =>
    set((s) => ({
      byTournament: {
        ...s.byTournament,
        [tournamentId]: [...(s.byTournament[tournamentId] ?? []), msg],
      },
    })),
  replaceLast: (tournamentId, msg) =>
    set((s) => {
      const cur = s.byTournament[tournamentId] ?? [];
      return {
        byTournament: {
          ...s.byTournament,
          [tournamentId]: [...cur.slice(0, -1), msg],
        },
      };
    }),
  reset: (tournamentId) =>
    set((s) => ({
      byTournament: { ...s.byTournament, [tournamentId]: [] },
    })),
}));
