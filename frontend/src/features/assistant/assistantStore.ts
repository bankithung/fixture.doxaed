import { create } from "zustand";
import type { AssistantAction } from "@/api/assistant";

/** What the user pointed the assistant at — a whole section or one input.
 * `label` is shown as a chip; `hint` is the richer context sent to the model. */
export interface AssistantFocus {
  label: string;
  hint: string;
}

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
  /** The section/field the user is asking about, or null for a general chat. */
  focus: AssistantFocus | null;
  /** Per-tournament transcript (kept for the session so reopening resumes). */
  byTournament: Record<string, AssistantMsg[]>;
  setOpen: (open: boolean) => void;
  /** Open with no focus (the floating launcher). */
  openPlain: () => void;
  /** Open focused on a section/field (an Ask-AI affordance). */
  openWith: (focus: AssistantFocus) => void;
  clearFocus: () => void;
  append: (tournamentId: string, msg: AssistantMsg) => void;
  reset: (tournamentId: string) => void;
}

export const useAssistantStore = create<AssistantState>((set) => ({
  open: false,
  focus: null,
  byTournament: {},
  setOpen: (open) => set({ open }),
  openPlain: () => set({ open: true, focus: null }),
  openWith: (focus) => set({ open: true, focus }),
  clearFocus: () => set({ focus: null }),
  append: (tournamentId, msg) =>
    set((s) => ({
      byTournament: {
        ...s.byTournament,
        [tournamentId]: [...(s.byTournament[tournamentId] ?? []), msg],
      },
    })),
  reset: (tournamentId) =>
    set((s) => ({
      byTournament: { ...s.byTournament, [tournamentId]: [] },
    })),
}));
