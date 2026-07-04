import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/types/api";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: { ...actual.api, post: vi.fn() } };
});

import { api } from "@/api/client";
import {
  clearWrites,
  enqueueWrite,
  flushWrites,
  pendingWrites,
} from "@/lib/offlineQueue";

const post = vi.mocked(api.post);

beforeEach(() => {
  clearWrites();
  vi.clearAllMocks();
});
afterEach(() => clearWrites());

describe("offlineQueue", () => {
  it("dedupes by id: one logical tap enqueues once", () => {
    enqueueWrite({ id: "e1", path: "/api/matches/m1/events/", body: { a: 1 } });
    enqueueWrite({ id: "e1", path: "/api/matches/m1/events/", body: { a: 1 } });
    expect(pendingWrites()).toBe(1);
  });

  it("persists across a reload (localStorage-backed)", () => {
    enqueueWrite({ id: "e1", path: "/p", body: {} });
    // A fresh read (as a new session would do) still sees the entry.
    expect(
      JSON.parse(localStorage.getItem("fixture.offline-writes.v1") ?? "[]"),
    ).toHaveLength(1);
  });

  it("flushes FIFO with the ORIGINAL event ids and clears the queue", async () => {
    post.mockResolvedValue(undefined);
    enqueueWrite({ id: "e1", path: "/p", body: { event_id: "e1", n: 1 } });
    enqueueWrite({ id: "e2", path: "/p", body: { event_id: "e2", n: 2 } });

    const rejected = await flushWrites();

    expect(rejected).toEqual([]);
    expect(pendingWrites()).toBe(0);
    expect(post).toHaveBeenNthCalledWith(1, "/p", { event_id: "e1", n: 1 });
    expect(post).toHaveBeenNthCalledWith(2, "/p", { event_id: "e2", n: 2 });
  });

  it("keeps the queue while the server stays unreachable", async () => {
    post.mockRejectedValue(new TypeError("Failed to fetch"));
    enqueueWrite({ id: "e1", path: "/p", body: {} });

    const rejected = await flushWrites();

    expect(rejected).toEqual([]);
    expect(pendingWrites()).toBe(1); // nothing lost, retried later
  });

  it("drops (and reports) writes the server rejected — never retries a 4xx", async () => {
    post
      .mockRejectedValueOnce(new ApiError(400, { detail: "already_voided" }))
      .mockResolvedValueOnce(undefined);
    enqueueWrite({ id: "e1", path: "/p", body: { event_id: "e1" } });
    enqueueWrite({ id: "e2", path: "/p", body: { event_id: "e2" } });

    const rejected = await flushWrites();

    expect(rejected.map((r) => r.id)).toEqual(["e1"]);
    expect(pendingWrites()).toBe(0); // e1 dropped, e2 delivered
  });
});
