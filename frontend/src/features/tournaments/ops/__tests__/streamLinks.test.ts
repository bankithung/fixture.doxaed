import { describe, expect, it } from "vitest";
import type { CourtStreamRow, StreamLink } from "@/api/streaming";
import {
  effectiveCourtLink,
  findCategoryLink,
  findCourtDayLink,
  findMatchLink,
  isChannelLiveUrl,
  cameraBroadcastUrl,
  overlayCourtUrl,
  videoIdFromUrl,
  watchUrlWarning,
} from "../streamLinks";

const DAY = "2026-08-04";

function court(over: Partial<CourtStreamRow> = {}): CourtStreamRow {
  return {
    court_id: "c1",
    court_name: "MP Hall · T1",
    venue_id: "v1",
    index: 1,
    watch_url: "",
    enabled: false,
    yt_stream_id: "",
    has_stream_key: false,
    live_watch_url: null,
    is_streaming: false,
    public_link: "/api/public/tournaments/cup/t1/court/c1/live/",
    ...over,
  };
}

function link(over: Partial<StreamLink> = {}): StreamLink {
  return {
    id: "l1",
    scope: "court_day",
    match_id: null,
    court_id: "c1",
    day: DAY,
    leaf_key: "",
    watch_url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    enabled: true,
    updated_at: null,
    ...over,
  };
}

describe("effectiveCourtLink", () => {
  it("a link pasted for this court on this day wins", () => {
    const got = effectiveCourtLink(
      court({ watch_url: "https://youtu.be/bbbbbbbbbbb" }),
      link(),
      true,
    );
    expect(got.source).toBe("day");
    expect(got.url).toBe("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    expect(got.overridden).toBe(false);
  });

  it("falls through to the court default when the day link is switched off", () => {
    const got = effectiveCourtLink(
      court({ watch_url: "https://youtu.be/bbbbbbbbbbb" }),
      link({ enabled: false }),
      false,
    );
    expect(got.source).toBe("court_default");
    expect(got.url).toBe("https://youtu.be/bbbbbbbbbbb");
    // The row is still there to edit — it is just not applying.
    expect(got.overridden).toBe(true);
    expect(got.dayLink).not.toBeNull();
  });

  it("an emptied day link falls through exactly like a disabled one", () => {
    const got = effectiveCourtLink(
      court({ watch_url: "https://youtu.be/bbbbbbbbbbb" }),
      link({ watch_url: "" }),
      false,
    );
    expect(got.source).toBe("court_default");
    expect(got.overridden).toBe(true);
  });

  it("reports the auto broadcast when today resolves to something the court default does not explain", () => {
    const got = effectiveCourtLink(
      court({
        watch_url: "https://youtu.be/bbbbbbbbbbb",
        live_watch_url: "https://www.youtube.com/watch?v=ccccccccccc",
      }),
      null,
      true,
    );
    expect(got.source).toBe("broadcast");
    expect(got.url).toBe("https://www.youtube.com/watch?v=ccccccccccc");
  });

  it("does not claim a broadcast on a day that is not today", () => {
    const got = effectiveCourtLink(
      court({
        watch_url: "https://youtu.be/bbbbbbbbbbb",
        live_watch_url: "https://www.youtube.com/watch?v=ccccccccccc",
      }),
      null,
      false,
    );
    expect(got.source).toBe("court_default");
  });

  it("nothing set anywhere resolves to nothing", () => {
    const got = effectiveCourtLink(court(), null, true);
    expect(got.source).toBe("none");
    expect(got.url).toBeNull();
  });
});

describe("finders", () => {
  const links: StreamLink[] = [
    link({ id: "a" }),
    link({ id: "b", court_id: "c2", day: "2026-08-05" }),
    link({
      id: "c",
      scope: "category",
      court_id: null,
      day: null,
      leaf_key: "football.u15.girls",
    }),
    link({ id: "d", scope: "match", court_id: null, day: null, match_id: "m9" }),
  ];

  it("keys a court-day link on BOTH the court and the day", () => {
    expect(findCourtDayLink(links, "c1", DAY)?.id).toBe("a");
    expect(findCourtDayLink(links, "c1", "2026-08-05")).toBeNull();
    expect(findCourtDayLink(links, "c2", DAY)).toBeNull();
  });

  it("finds category and match links by their own target", () => {
    expect(findCategoryLink(links, "football.u15.girls")?.id).toBe("c");
    expect(findCategoryLink(links, "football.u17.boys")).toBeNull();
    expect(findMatchLink(links, "m9")?.id).toBe("d");
    expect(findMatchLink(links, "m8")).toBeNull();
  });
});

describe("watchUrlWarning", () => {
  it("says nothing about an empty box", () => {
    expect(watchUrlWarning("")).toBeNull();
    expect(watchUrlWarning("   ")).toBeNull();
  });

  it("accepts the three shapes a broadcast link comes in", () => {
    expect(watchUrlWarning("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(watchUrlWarning("https://youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(watchUrlWarning("youtube.com/live/dQw4w9WgXcQ")).toBeNull();
  });

  it("flags a channel-level /live URL, which cannot say which court", () => {
    expect(isChannelLiveUrl("https://www.youtube.com/@school/live")).toBe(true);
    expect(watchUrlWarning("https://www.youtube.com/@school/live")).toMatch(
      /channel-level/,
    );
  });

  it("does not confuse /live/<id> (one broadcast) with /@handle/live", () => {
    expect(isChannelLiveUrl("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe(false);
    expect(videoIdFromUrl("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("flags anything that is not a YouTube video link", () => {
    expect(watchUrlWarning("https://example.com/stream")).toMatch(/YouTube/);
    expect(watchUrlWarning("not a url at all")).toMatch(/YouTube/);
  });
});

describe("overlayCourtUrl", () => {
  it("percent-encodes the venue string OBS has to address the court by", () => {
    // `Court2 · T3` is a real venue shape: a space and a middle dot. The
    // overlay compares this segment with `Match.venue`, so a hand-typed URL
    // that gets the encoding wrong finds no match and shows an empty court.
    expect(
      overlayCourtUrl("https://fixture.doxaed.com", "cup", "t1", "Court2 · T3"),
    ).toBe(
      "https://fixture.doxaed.com/overlay/t/cup/t1/court/Court2%20%C2%B7%20T3",
    );
  });

  it("encodes an ampersand too, and leaves a plain name alone", () => {
    expect(overlayCourtUrl("https://x.test", "cup", "t1", "Court 1")).toBe(
      "https://x.test/overlay/t/cup/t1/court/Court%201",
    );
    expect(overlayCourtUrl("https://x.test", "cup", "t1", "Hall A & B")).toBe(
      "https://x.test/overlay/t/cup/t1/court/Hall%20A%20%26%20B",
    );
  });

  it("encodes the slug and the id as well, and degrades to a path with no origin", () => {
    expect(overlayCourtUrl("", "a b", "t 1", "Court 1")).toBe(
      "/overlay/t/a%20b/t%201/court/Court%201",
    );
  });
});

describe("cameraBroadcastUrl", () => {
  it("percent-encodes the venue string exactly as the overlay URL does", () => {
    // This URL is WhatsApped to a volunteer and opened on a phone — there is
    // even less chance of it being hand-typed correctly than the OBS one.
    expect(
      cameraBroadcastUrl("https://fixture.doxaed.com", "cup", "t1", "Court2 · T3"),
    ).toBe(
      "https://fixture.doxaed.com/broadcast/t/cup/t1/court/Court2%20%C2%B7%20T3",
    );
  });

  it("addresses the same court as the overlay, differing only in the route", () => {
    const court = "Hall A & B";
    expect(cameraBroadcastUrl("https://x.test", "cup", "t1", court)).toBe(
      overlayCourtUrl("https://x.test", "cup", "t1", court).replace(
        "/overlay/",
        "/broadcast/",
      ),
    );
  });

  it("degrades to a path with no origin", () => {
    expect(cameraBroadcastUrl("", "a b", "t 1", "Court 1")).toBe(
      "/broadcast/t/a%20b/t%201/court/Court%201",
    );
  });
});
