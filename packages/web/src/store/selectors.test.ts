import { describe, expect, test } from "bun:test";
import type { Moment } from "@perfidia/protocol/spectator";
import { applyStep } from "@perfidia/spectator/reduce";
import { NEUTRAL_COLOR, playerColor } from "../lib/colors.ts";
import { skinFor } from "../skins/index.ts";
import { frame, meta, scoreStep } from "../testkit.test.ts";
import {
  colorOf,
  labelOf,
  lastMoment,
  memoOne,
  momentsUntil,
  selectDomination,
  selectStandings,
} from "./selectors.ts";

const moment = (seq: number, k: Moment["k"]): Moment => ({
  item: `${seq}:0`,
  seq,
  t: seq * 10,
  k,
  importance: 3,
  title: `${k} ${seq}`,
  players: [],
  cities: [],
});

describe("shared selectors", () => {
  test("memoOne keeps its result while its inputs are the same objects", () => {
    let calls = 0;
    const f = memoOne((a: object, n: number) => {
      calls += 1;
      return { a, n };
    });
    const a = {};
    expect(f(a, 1)).toBe(f(a, 1));
    expect(calls).toBe(1);
    f({}, 1);
    expect(calls).toBe(2);
  });

  test("standings are memoised on the frame's players", () => {
    const f0 = frame();
    const s0 = selectStandings(f0);
    expect(s0.map((s) => s.player)).toEqual(["p1", "p2"]);
    const same = { ...f0, seq: 9 };
    expect(selectStandings(same)).toBe(s0);
    const next = applyStep(f0, scoreStep(1, 10, 50));
    expect(selectStandings(next)).not.toBe(s0);
    expect(selectStandings(next)[0]?.score).toBe(50);
    expect(selectStandings(null)).toEqual([]);
  });

  test("labels and colours of seats; neutral for nobody", () => {
    const m = meta();
    expect(labelOf(m, "p1")).toBe("Odysseus · p1");
    expect(labelOf(m, "p9")).toBe("p9");
    expect(colorOf(m, "p2")).toBe(playerColor(1));
    expect(colorOf(m, null)).toBe(NEUTRAL_COLOR);
  });

  test("domination is memoised on the frame's ext", () => {
    const skin = skinFor("perfidia-1@1.1.0");
    const m = meta();
    const ext = {
      domination: { open: false, need: 16, needTaken: 2, slots: 43, blocs: [], countdowns: [] },
    };
    const f0 = frame(0, 0, { ext });
    const d0 = selectDomination(skin, m, f0);
    expect(d0?.need).toBe(16);
    expect(selectDomination(skin, m, { ...f0, seq: 5 })).toBe(d0);
    expect(selectDomination(skin, m, { ...f0, ext: { ...ext } })).not.toBe(d0);
    expect(selectDomination(null, m, f0)).toBeNull();
  });

  test("moments up to a cursor, and the last one of some kinds", () => {
    const ms = [moment(5, "battle"), moment(9, "betrayal"), moment(20, "conquest")];
    expect(momentsUntil(ms, 9).map((m) => m.seq)).toEqual([5, 9]);
    expect(momentsUntil(ms, 4)).toEqual([]);
    expect(momentsUntil(ms, 100)).toBe(ms);
    // The same array while no moment is passed.
    expect(momentsUntil(ms, 10)).toBe(momentsUntil(ms, 15));
    expect(lastMoment(ms, 15, ["betrayal"])?.seq).toBe(9);
    expect(lastMoment(ms, 8, ["betrayal"])).toBeNull();
  });
});
