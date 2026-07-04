import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { isFollowed, toggleFollow, useFollows } from "../follows";

describe("follows store (P6 follow v1)", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset module snapshot by unfollowing anything left over.
    for (const id of [...(JSON.parse(localStorage.getItem("fixture.followed-teams.v1") ?? "[]") as string[])]) {
      toggleFollow(id);
    }
    while (isFollowed("a")) toggleFollow("a");
    while (isFollowed("b")) toggleFollow("b");
  });

  it("toggles, persists and reacts", () => {
    const { result } = renderHook(() => useFollows());
    expect(result.current).toEqual([]);

    act(() => toggleFollow("a"));
    expect(result.current).toEqual(["a"]);
    expect(isFollowed("a")).toBe(true);
    expect(
      JSON.parse(localStorage.getItem("fixture.followed-teams.v1") ?? "[]"),
    ).toEqual(["a"]);

    act(() => toggleFollow("b"));
    act(() => toggleFollow("a"));
    expect(result.current).toEqual(["b"]);
    expect(isFollowed("a")).toBe(false);
  });
});
