import { api } from "./client";

/** One turn in the setup-assistant conversation (text only; the server holds
 * no state — the client replays the history each call). */
export interface AssistantChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** A write the assistant performed this turn, surfaced under its reply so the
 * organiser sees exactly what changed ("✓ Set match dates to Jun 29–30"). */
export interface AssistantAction {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface AssistantReply {
  reply: string;
  actions: AssistantAction[];
  /** True when any action mutated setup → the caller refetches tournament data. */
  changed: boolean;
}

export const assistantApi = {
  /** Send the running conversation (last entry = the new user message); the
   * server runs the Gemini tool-loop and returns the assistant's reply plus a
   * receipt of any setup changes it made. `focus` (optional) tells the model
   * which section/input the user is pointing at. */
  chat: (
    tournamentId: string,
    messages: AssistantChatMessage[],
    focus?: string,
  ) =>
    api.post<AssistantReply>(
      `/api/tournaments/${tournamentId}/assistant/chat/`,
      focus ? { messages, focus } : { messages },
    ),
};
