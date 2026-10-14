import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { adjacentTab, MyBidsSearch, parseMyBidsTab, watchErrorMessage, withWatched } from "./me";

describe("my bids tabs", () => {
  it("parses the tab search param, falling back to leading", () => {
    expect(parseMyBidsTab("outbid")).toBe("outbid");
    expect(parseMyBidsTab("won")).toBe("won");
    expect(parseMyBidsTab("WON")).toBe("leading");
    expect(parseMyBidsTab(undefined)).toBe("leading");
    expect(parseMyBidsTab(42)).toBe("leading");
    expect(MyBidsSearch.parse({ tab: "lost" })).toEqual({ tab: "lost" });
    expect(MyBidsSearch.parse({ tab: "<script>" })).toEqual({ tab: undefined });
    expect(MyBidsSearch.parse({})).toEqual({});
  });

  it("arrow keys move between tabs and wrap", () => {
    expect(adjacentTab("leading", 1)).toBe("outbid");
    expect(adjacentTab("lost", 1)).toBe("leading");
    expect(adjacentTab("leading", -1)).toBe("lost");
  });
});

describe("watchlist helpers", () => {
  it("adds newest first without duplicates and removes", () => {
    expect(withWatched(["a", "b"], "c", true)).toEqual(["c", "a", "b"]);
    expect(withWatched(["a", "b"], "b", true)).toEqual(["b", "a"]);
    expect(withWatched(["a", "b"], "a", false)).toEqual(["b"]);
    expect(withWatched([], "x", false)).toEqual([]);
  });

  it("maps error codes to human copy", () => {
    expect(watchErrorMessage(new ApiError(409, "CONFLICT"))).toMatch(/full \(100\)/);
    expect(watchErrorMessage(new ApiError(429, "RATE_LIMITED"))).toMatch(/very fast/);
    expect(watchErrorMessage(new Error("boom"))).toMatch(/Couldn't update/);
  });
});
