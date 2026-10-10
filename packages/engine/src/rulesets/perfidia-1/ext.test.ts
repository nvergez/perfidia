import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@perfidia/engine/core";
import {
  battlePointsOf,
  besiegerOf,
  countdownOf,
  initialExt,
  pairKey,
  type PerfidiaExt,
  PerfidiaExtSchema,
  relationEndedAt,
  siegeOf,
  tiebreakPosition,
  wereRelated,
} from "./ext.ts";

// `state.ext` of perfidia-1: schema and typed accessors.

const ext: PerfidiaExt = {
  tiebreak: ["p3", "p1", "p2"],
  sieges: { c14: { by: "p2", startedAt: 100, endsAt: 21700, seq: 12 } },
  battlePoints: { p1: 0, p2: 234, p3: 0 },
  related: ["p1|p3"],
  relationEnds: { "p1|p2": 5000 },
  domination: {
    open: true,
    countdowns: [{ bloc: "a1", members: ["p1", "p3"], startedAt: 300000, endsAt: 386400, seq: 40 }],
  },
};

const firstIssuePath = (value: unknown) =>
  PerfidiaExtSchema.safeParse(value).error?.issues[0]?.path;

describe("PerfidiaExtSchema", () => {
  test("parses a full ext and round-trips through canonical JSON", () => {
    const parsed = PerfidiaExtSchema.parse(ext);
    expect(parsed).toEqual(ext);
    expect(PerfidiaExtSchema.parse(JSON.parse(canonicalJson(ext)))).toEqual(ext);
  });

  test("rejects bad shapes with useful paths", () => {
    expect(firstIssuePath({ ...ext, sieges: { x1: ext.sieges["c14"] } })).toEqual(["sieges", "x1"]);
    expect(firstIssuePath({ ...ext, related: ["p1-p3"] })).toEqual(["related", 0]);
    expect(firstIssuePath({ ...ext, battlePoints: { p1: -1 } })).toEqual(["battlePoints", "p1"]);
    expect(
      firstIssuePath({ ...ext, domination: { open: true, countdowns: [{ bloc: "x" }] } })?.slice(
        0,
        3,
      ),
    ).toEqual(["domination", "countdowns", 0]);
    expect(PerfidiaExtSchema.safeParse({ ...ext, extra: 1 }).success).toBe(false);
  });

  test("the initial ext parses", () => {
    const x = initialExt(["p1", "p2"], ["p2", "p1"]);
    expect(PerfidiaExtSchema.parse(x)).toEqual({
      tiebreak: ["p2", "p1"],
      sieges: {},
      battlePoints: { p1: 0, p2: 0 },
      related: [],
      relationEnds: {},
      domination: { open: false, countdowns: [] },
    });
  });
});

describe("accessors", () => {
  test("sieges", () => {
    expect(siegeOf(ext, "c14")).toEqual({ by: "p2", startedAt: 100, endsAt: 21700, seq: 12 });
    expect(siegeOf(ext, "c1")).toBeNull();
    expect(besiegerOf(ext, "c14")).toBe("p2");
    expect(besiegerOf(ext, "c2")).toBeNull();
  });

  test("battle points", () => {
    expect(battlePointsOf(ext, "p2")).toBe(234);
    expect(battlePointsOf(ext, "p9")).toBe(0);
  });

  test("pair keys are ordered by compareIds", () => {
    expect(pairKey("p10", "p2")).toBe("p2|p10");
    expect(pairKey("p2", "p10")).toBe("p2|p10");
    expect(() => pairKey("p1", "p1")).toThrow(RangeError);
  });

  test("relations", () => {
    expect(wereRelated(ext, "p3", "p1")).toBe(true);
    expect(wereRelated(ext, "p1", "p2")).toBe(false);
    expect(relationEndedAt(ext, "p2", "p1")).toBe(5000);
    expect(relationEndedAt(ext, "p2", "p3")).toBeNull();
  });

  test("countdowns and the tie-break order", () => {
    expect(countdownOf(ext, "a1")?.endsAt).toBe(386400);
    expect(countdownOf(ext, "p2")).toBeNull();
    expect(tiebreakPosition(ext, "p3")).toBe(0);
    expect(tiebreakPosition(ext, "p2")).toBe(2);
    expect(() => tiebreakPosition(ext, "p7")).toThrow(RangeError);
  });
});
