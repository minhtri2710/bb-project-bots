import { describe, expect, it } from "vitest";
import { mostRecentRootId, sortBotRoots } from "../lib/thread-order";

describe("thread-order", () => {
  it("places new unranked threads above ranked normal threads while keeping leading specials first", () => {
    const roots = [
      { id: "thr_old_a", updatedAt: 100 },
      { id: "thr_old_b", updatedAt: 200 },
      { id: "thr_lander", updatedAt: 50 },
      { id: "thr_brand_new", updatedAt: 500 },
    ];
    const sorted = sortBotRoots(
      roots,
      ["thr_lander", "thr_old_a", "thr_old_b"],
      new Set(["thr_lander"]),
    );
    expect(sorted.map((r) => r.id)).toEqual([
      "thr_lander",
      "thr_brand_new",
      "thr_old_a",
      "thr_old_b",
    ]);
  });

  it("identifies the newest thread by activity independent of display order", () => {
    const roots = [
      { id: "thr_first_in_order", updatedAt: 100 },
      { id: "thr_actually_newest", updatedAt: 999 },
      { id: "thr_middle", updatedAt: 500 },
    ];
    expect(mostRecentRootId(roots)).toBe("thr_actually_newest");
  });
});
