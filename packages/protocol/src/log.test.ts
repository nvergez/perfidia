import { describe, expect, test } from "bun:test";
import { logLines, snapshot } from "./fixtures.test.ts";
import { LOG_LINE_KINDS, LogLineSchema, SnapshotSchema, type LogLine } from "./index.ts";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("every LogLine kind round-trips through JSON (§10.2)", () => {
  for (const kind of LOG_LINE_KINDS) {
    test(kind, () => {
      const line: LogLine = logLines[kind];
      expect(line.k).toBe(kind);
      const parsed = LogLineSchema.parse(roundTrip(line));
      expect(parsed).toEqual(line);
      expect(roundTrip(parsed)).toEqual(roundTrip(line));
    });
  }
});

test("LOG_LINE_KINDS lists every kind of the union, defer and controller included", () => {
  const kinds = LogLineSchema.options.map((o) => o.shape.k.value);
  expect(LOG_LINE_KINDS.toSorted(byCodeUnit)).toEqual(kinds.toSorted(byCodeUnit));
  expect(LOG_LINE_KINDS).toContain("defer");
  expect(LOG_LINE_KINDS).toContain("controller");
  expect(Object.keys(logLines).toSorted(byCodeUnit)).toEqual(LOG_LINE_KINDS.toSorted(byCodeUnit));
});

test("Snapshot round-trips through JSON (§10.3)", () => {
  const parsed = SnapshotSchema.parse(roundTrip(snapshot));
  expect(parsed).toEqual(snapshot);
  expect(roundTrip(parsed)).toEqual(roundTrip(snapshot));
});

test("the turn line records selfAt and the gw line its details and error", () => {
  const turn = LogLineSchema.parse(logLines.turn);
  expect(turn.k === "turn" ? turn.selfAt : undefined).toBe(7200);
  const gw = LogLineSchema.parse({
    k: "gw",
    n: 20,
    t: 0,
    seat: "p3",
    turn: 1,
    rt: 0,
    tool: "view_city",
    r: { ok: false, code: "INTERNAL" },
    error: "TypeError: boom",
  });
  expect(gw.k === "gw" ? [gw.r.code, gw.error] : []).toEqual(["INTERNAL", "TypeError: boom"]);
  expect(LogLineSchema.safeParse({ ...logLines.turn, selfAt: undefined }).success).toBe(false);
});
