import { describe, expect, it } from "vitest";

import { stateVerbsFor } from "../MatchActionsMenu";
import type { ControlRoomPerms } from "../MatchActionsMenu";
import type { ControlRoomMatch } from "@/api/tournaments";

const perms = (over: Partial<ControlRoomPerms>): ControlRoomPerms =>
  ({ canManage: false, canScore: false, canSchedule: false, userId: "u1", ...over }) as ControlRoomPerms;
const match = (status: string): ControlRoomMatch =>
  ({ id: "m1", status }) as unknown as ControlRoomMatch;

describe("stateVerbsFor", () => {
  it("lets a manager return a postponed match to the schedule (or cancel it)", () => {
    // Owner report 2026-08-29: a postponed 3rd-place match could not be
    // awarded as a walkover because nothing in the UI un-postponed it.
    expect(stateVerbsFor(match("postponed"), perms({ canManage: true }))).toEqual([
      "resume",
      "cancel",
    ]);
  });

  it("offers nothing on a postponed match to a scorer", () => {
    expect(stateVerbsFor(match("postponed"), perms({ canScore: true }))).toEqual([]);
  });

  it("does not offer 'resume' outside the postponed state", () => {
    expect(stateVerbsFor(match("scheduled"), perms({ canManage: true }))).toEqual([
      "postpone",
      "cancel",
    ]);
    expect(stateVerbsFor(match("live"), perms({ canManage: true }))).toEqual([
      "postpone",
      "cancel",
      "abandon",
    ]);
  });
});
