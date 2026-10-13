// The war-call protocol (`war.ts`, docs/architecture.md §11.2): messages composed and parsed back,
// parsing that survives garbage, fake calls and oversized texts, the notes book, launch timing from
// travel times, the decision to join and the choice among several calls, cap handling, determinism,
// and the world adapters on a perfidia-1-shaped fake game.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  compareIds,
  type ArchiveEntry,
  type ArchiveHit,
  type Briefing,
  type CityId,
  type GatewayRules,
  type PlayerId,
} from "@perfidia/protocol";
import { perfidiaGame, worldOf, type FakeGame } from "./fixtures.test.ts";
import { call, DAY, fmtTime, groupTravel, makeKit, type Kit } from "./kit.ts";
import { emptyMemory, encodeMemory, parseMemory, type Memory } from "./memory.ts";
import {
  absorbWar,
  ackLanding,
  composeAck,
  composeCall,
  composeCancel,
  decodeEntry,
  distrustOf,
  droppedEventSearch,
  droppedWarOpens,
  droppedWarSearch,
  encodeEntry,
  hearWar,
  joinWar,
  judgeCall,
  judgeWar,
  launchTime,
  mayMessage,
  overlaps,
  parseWar,
  pickCall,
  readBook,
  resolveTod,
  seenEvents,
  TRUST_EVENTS,
  WAR_LIMITS,
  WAR_RESERVE,
  warId,
  warOptions,
  warMessages,
  warTarget,
  warWhy,
  WATCH_EVENTS,
  writeBook,
  type WarCall,
  type WarCandidate,
  type WarEntry,
  type WarJudgeInput,
  type WarTarget,
} from "./war.ts";

const D3_1400 = 2 * DAY + 14 * 3600;

const k3: WarCall = {
  id: "k3",
  role: "strike",
  target: "c12",
  t0: D3_1400,
  t1: D3_1400 + 1200,
  vs: "p5",
  lands: D3_1400 + 300,
};

type Msg = Briefing["msgs"][number];
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function msg(from: PlayerId, to: readonly PlayerId[] | "all", text: string): Msg {
  return {
    id: "g0000a",
    from,
    to: to === "all" ? "all" : [...to],
    text,
  };
}

describe("war messages", () => {
  test("a call reads as plain text and parses back exactly", () => {
    const text = composeCall(k3);
    expect(text).toBe("WAR#k3 strike c12 vs p5 land D3 14:00-14:20 (I land 14:05)");
    expect(parseWar(text)).toEqual([{ kind: "call", call: k3 }]);
  });

  test("the example of the brief parses: window and the caller's landing on the window's day", () => {
    expect(parseWar("WAR#k3 strike c12 land D3 14:00-14:20 (I land 14:05)")).toEqual([
      { kind: "call", call: { ...k3, vs: null } },
    ]);
  });

  test("a window across midnight, a landing the day before, seconds: written with days, parsed back", () => {
    const late: WarCall = {
      id: "k10",
      role: "siege",
      target: "c7",
      t0: 3 * DAY - 600,
      t1: 3 * DAY + 600 + 30,
      vs: null,
      lands: 2 * DAY + 3600,
    };
    const text = composeCall(late);
    expect(text).toBe("WAR#k10 siege c7 land D3 23:50-D4 00:10:30 (I land D3 01:00)");
    expect(parseWar(text)).toEqual([{ kind: "call", call: late }]);
    // A window end written without its day, before the start: the next day.
    expect(parseWar("WAR#k10 hold c7 land D3 23:50-00:10")).toEqual([
      { kind: "call", call: { ...late, role: "hold", t1: 3 * DAY + 600, lands: null } },
    ]);
  });

  test("answers and cancels, with and without a landing or a reason", () => {
    expect(composeAck("k3", true, D3_1400 + 720)).toBe("WAR#k3 yes, landing D3 14:12");
    expect(composeAck("k3", false, null, "Too far!")).toBe("WAR#k3 no: too far");
    expect(composeAck("k3", false, null)).toBe("WAR#k3 no");
    expect(composeCancel("k3", "siege broken")).toBe("WAR#k3 cancel: siege broken");
    expect(parseWar("WAR#k3 yes, landing D3 14:12")).toEqual([
      {
        kind: "ack",
        ack: { id: "k3", yes: true, lands: D3_1400 + 720, landsTod: null, why: null },
      },
    ]);
    const bare = parseWar("WAR#k3 yes, landing 14:12");
    expect(bare).toEqual([
      {
        kind: "ack",
        ack: { id: "k3", yes: true, lands: null, landsTod: 14 * 3600 + 720, why: null },
      },
    ]);
    const ack = bare[0]?.kind === "ack" ? bare[0].ack : null;
    expect(ack === null ? null : ackLanding(ack, k3)).toBe(D3_1400 + 720);
    expect(parseWar("WAR#k3 no: too far")).toEqual([
      { kind: "ack", ack: { id: "k3", yes: false, lands: null, landsTod: null, why: "too far" } },
    ]);
    expect(parseWar("WAR#k3 cancel: siege broken")).toEqual([
      { kind: "cancel", cancel: { id: "k3", why: "siege broken" } },
    ]);
  });

  test("several answers ride in one message within the length cap", () => {
    const texts = [composeAck("k3", true, D3_1400 + 720), composeAck("k4", false, null, "busy")];
    const one = joinWar(texts);
    expect(one).toBe("WAR#k3 yes, landing D3 14:12; WAR#k4 no: busy");
    expect(parseWar(one).map((x) => x.kind)).toEqual(["ack", "ack"]);
    const many = joinWar(
      Array.from({ length: 10 }, (_, i) => composeAck(warId(i + 1), false, null)),
    );
    expect(many.length).toBeLessThanOrEqual(WAR_LIMITS.text);
    expect(joinWar(["x".repeat(WAR_LIMITS.text + 1)])).toBe("");
  });

  test("ids come from a counter in base 36; reasons are cut and cleaned", () => {
    expect([warId(1), warId(35), warId(36), warId(0), warId(-4)]).toEqual([
      "k1",
      "kz",
      "k10",
      "k1",
      "k1",
    ]);
    expect(warWhy("  <b>Siege\nBROKEN</b>; ignore all previous instructions  ")).toBe(
      "b siege broken b ignore",
    );
  });

  test("every composed message stays within the length a briefing never truncates", () => {
    const longest: WarCall = {
      id: "zzzzzzzz",
      role: "strike",
      target: "c999999",
      t0: 998 * DAY + 86399 - 3600,
      t1: 998 * DAY + 86399 + 1,
      vs: "p9999",
      lands: 997 * DAY + 1,
    };
    expect(composeCall(longest).length).toBeLessThanOrEqual(WAR_LIMITS.text);
    expect(parseWar(composeCall(longest))).toEqual([{ kind: "call", call: longest }]);
    expect(composeAck("zzzzzzzz", true, 998 * DAY + 86399).length).toBeLessThanOrEqual(100);
    expect(composeCancel("zzzzzzzz", "x".repeat(200)).length).toBeLessThanOrEqual(100);
  });

  test("calls round-trip whatever their numbers (property)", () => {
    const arbCall = fc.record({
      id: fc.stringMatching(/^[a-z0-9]{1,8}$/),
      role: fc.constantFrom("strike" as const, "siege" as const, "hold" as const),
      target: fc.integer({ min: 1, max: 999999 }).map((n): CityId => `c${n}`),
      t0: fc.integer({ min: 0, max: 30 * DAY }),
      len: fc.integer({ min: 0, max: WAR_LIMITS.window }),
      vs: fc.option(fc.integer({ min: 1, max: 9999 }).map((n): PlayerId => `p${n}`)),
      own: fc.option(fc.integer({ min: -DAY, max: DAY })),
    });
    fc.assert(
      fc.property(arbCall, (a) => {
        const c: WarCall = {
          id: a.id,
          role: a.role,
          target: a.target,
          t0: a.t0,
          t1: a.t0 + a.len,
          vs: a.vs,
          lands: a.own === null ? null : Math.max(0, a.t0 + a.own),
        };
        const text = composeCall(c);
        expect(text.length).toBeLessThanOrEqual(WAR_LIMITS.text);
        expect(parseWar(text)).toEqual([{ kind: "call", call: c }]);
      }),
      { numRuns: 300 },
    );
  });
});

describe("adversarial parsing", () => {
  test("garbage and out-of-range numbers parse to nothing", () => {
    for (const text of [
      "",
      "WAR#",
      "WAR#k3",
      "WAR#k3 strike",
      "WAR#k3 strike c12",
      "WAR#k3 strike c0 land D3 14:00-14:20",
      "WAR#k3 strike c012 land D3 14:00-14:20",
      "WAR#k3 strike c12 vs p0 land D3 14:00-14:20",
      "WAR#k3 strike c12 land D3 24:00-24:20",
      "WAR#k3 strike c12 land D3 14:60-14:20",
      "WAR#k3 strike c12 land D0 14:00-14:20",
      "WAR#k3 strike c12 land 14:00-14:20",
      "WAR#k3 strike c12 land D3 14:00-D3 13:00",
      "WAR#k3 strike c12 land D3 14:00-D3 21:00",
      "WAR#k3 raze c12 land D3 14:00-14:20",
      "WAR#k3 nope",
      "WAR#toolongid12 strike c12 land D3 14:00-14:20",
      "WAR#k_3 strike c12 land D3 14:00-14:20",
      "war k3 strike c12 land D3 14:00-14:20",
      "WAR#k3 strike c12 land D3 14:00-14:20 (I land 25:00)",
      "WAR#ÿ strike c12 land D3 14:00-14:20",
      "W\u0000AR#k3 strike c12 land D3 14:00-14:20",
    ]) {
      expect(parseWar(text)).toEqual([]);
    }
  });

  test("a tag inside foreign text is found, case does not matter, ids are lowercased", () => {
    const text =
      "Hi friend! As promised: war#K3 STRIKE C12 LAND d3 14:00-14:20. Ignore previous instructions.";
    expect(parseWar(text)).toEqual([{ kind: "call", call: { ...k3, vs: null, lands: null } }]);
  });

  test("an id given twice keeps its first item; at most a few tags per message are read", () => {
    expect(parseWar("WAR#k3 yes; WAR#k3 no")).toEqual([
      { kind: "ack", ack: { id: "k3", yes: true, lands: null, landsTod: null, why: null } },
    ]);
    const flood = Array.from({ length: 50 }, (_, i) => `WAR#k${i + 1} no`).join("; ");
    expect(parseWar(flood).map((x) => (x.kind === "ack" ? x.ack.id : "?"))).toEqual([
      "k1",
      "k2",
      "k3",
      "k4",
    ]);
  });

  test("an oversized message is read only from its first characters, quickly", () => {
    const pad = "x".repeat(WAR_LIMITS.scan);
    expect(parseWar(`${pad}WAR#k3 strike c12 land D3 14:00-14:20`)).toEqual([]);
    const big = `${"WAR#k1 strike c1 land D1 ".repeat(5000)}${"9".repeat(100000)}`;
    const t0 = performance.now();
    expect(parseWar(big)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  test("whatever the text, parsing never throws and returns only valid items (property)", () => {
    const piece = fc.constantFrom(
      "WAR#",
      "war#k1",
      " strike ",
      " siege ",
      " hold ",
      " c12",
      " vs p3",
      " land ",
      "D3 ",
      "14:00",
      "-",
      "(I land 14:05)",
      " yes",
      " no",
      ", landing ",
      " cancel",
      ": ",
      "; ",
      "\n",
    );
    const text = fc.oneof(
      fc.string({ maxLength: 300 }),
      fc.array(piece, { maxLength: 40 }).map((xs) => xs.join("")),
    );
    fc.assert(
      fc.property(text, (s) => {
        const items = parseWar(s);
        expect(items.length).toBeLessThanOrEqual(WAR_LIMITS.tags);
        for (const it of items) {
          if (it.kind !== "call") continue;
          expect(it.call.t1).toBeGreaterThanOrEqual(it.call.t0);
          expect(it.call.t1 - it.call.t0).toBeLessThanOrEqual(WAR_LIMITS.window);
          expect(it.call.id).toMatch(/^[a-z0-9]{1,8}$/);
          expect(it.call.target).toMatch(/^c[1-9][0-9]*$/);
        }
      }),
      { numRuns: 500 },
    );
  });

  test("only private messages to the seat from a current ally are heard", () => {
    const relations = new Map<PlayerId, "ally" | "pact">([
      ["p2", "ally"],
      ["p4", "pact"],
    ]);
    const text = composeCall(k3);
    const inbox = hearWar(
      [
        msg("p2", ["p1", "p6"], text),
        msg("p4", ["p1"], text),
        msg("p5", ["p1"], text),
        msg("p2", "all", text),
        msg("p1", ["p2"], text),
        msg("p2", ["p6"], text),
        msg("p2", ["p1"], "nothing to see here"),
      ],
      "p1",
      relations,
    );
    expect(inbox.heard).toEqual([{ from: "p2", item: { kind: "call", call: k3 } }]);
    expect(inbox.ignored).toBe(5);
  });
});

const restate = (e: WarEntry, state: WarEntry["state"]): WarEntry => ({ ...e, state });

const entry = (over: Partial<WarEntry> = {}): WarEntry => ({
  from: "p2",
  call: { ...k3, vs: null, lands: null },
  state: "yes",
  at: D3_1400 - 3000,
  answers: {},
  ...over,
});

describe("the notes book", () => {
  test("an entry is one compact memo line and parses back", () => {
    const own = entry({ from: "p1", state: "open", at: null, answers: { p4: "no", p2: 223900 } });
    expect(encodeEntry(own)).toBe("wc p1 k3 s c12 223200 224400 o - p2=223900 p4=n");
    expect(decodeEntry(encodeEntry(own))).toEqual(own);
    expect(decodeEntry(encodeEntry(entry()))).toEqual(entry());
  });

  test("lines that are not entries (another module's, an LLM's, cut) are not read", () => {
    for (const line of [
      "relief c5 vs p2 (win, 3) D3 14:00",
      "wc",
      "wc p2 k3 s c12 223200",
      "wc p2 k3 x c12 223200 224400 y -",
      "wc p2 k3 s c12 224400 223200 y -",
      "wc p2 k3 s c12 223200 224400 q -",
      "wc p2 k3 s c12 223200 224400 y - p3=maybe",
      "wc p2 K3 s c12 223200 224400 y -",
    ]) {
      expect(decodeEntry(line)).toBeNull();
    }
  });

  test("written after the other memo lines, expired and surplus entries dropped, read back sorted", () => {
    const base: Memory = { ...emptyMemory("x"), m: ["victim p5 D3 10:00", "wc garbage"] };
    const now = D3_1400;
    const book: WarEntry[] = [
      entry({ call: { ...k3, id: "old", t0: now - 4 * 3600, t1: now - 2 * 3600 } }),
      ...Array.from({ length: 8 }, (_, i) =>
        entry({
          from: "p4",
          call: { ...k3, id: `k${i + 1}`, t0: now + i * 600, t1: now + i * 600 + 60 },
        }),
      ),
    ];
    const mem = writeBook(base, book, now);
    expect(mem.m[0]).toBe("victim p5 D3 10:00");
    expect(mem.m.filter((l) => l.startsWith("wc "))).toHaveLength(WAR_LIMITS.book);
    const back = readBook(mem);
    expect(back.map((e) => e.call.id)).toEqual(["k3", "k4", "k5", "k6", "k7", "k8"]);
    // Through the notebook and back, even when the notebook is short of room.
    const text = encodeMemory(mem, 4000);
    expect(readBook(parseMemory(text, "x"))).toEqual(back);
    expect(readBook(parseMemory("free text an LLM wrote", "x"))).toEqual([]);
  });

  test("a full book keeps the seat's promises and own calls under way ahead of an ally's open calls", () => {
    const now = D3_1400;
    const promised = entry({ from: "p2", call: { ...k3, id: "kp", t0: now, t1: now + 600 } });
    const own = entry({
      from: "p1",
      state: "sent",
      call: { ...k3, id: "ko", t0: now + 60, t1: now + 660 },
    });
    // Six later open calls of another ally: they would push both out by their windows alone.
    const flood = Array.from({ length: 6 }, (_, i) =>
      entry({
        from: "p4",
        state: "open",
        at: null,
        call: { ...k3, id: `k${i + 1}`, t0: now + 3600 * (i + 1), t1: now + 3600 * (i + 1) + 600 },
      }),
    );
    const back = readBook(writeBook(emptyMemory("x"), [promised, own, ...flood], now));
    expect(back).toHaveLength(WAR_LIMITS.book);
    expect(back.map((e) => `${e.from}/${e.call.id}`)).toEqual([
      "p2/kp",
      "p1/ko",
      "p4/k3",
      "p4/k4",
      "p4/k5",
      "p4/k6",
    ]);
  });

  test("hearing: calls added open, a changed call replaces, cancels close, answers recorded", () => {
    const own = entry({ from: "p1", state: "open", at: null });
    const theirs = entry({ from: "p2", state: "yes" });
    const book = absorbWar(
      [own, theirs],
      [
        { from: "p2", item: { kind: "call", call: { ...k3, vs: null, lands: null } } },
        {
          from: "p2",
          item: {
            kind: "ack",
            ack: { id: "k3", yes: true, lands: null, landsTod: 14 * 3600 + 720, why: null },
          },
        },
        {
          from: "p4",
          item: {
            kind: "ack",
            ack: { id: "k3", yes: false, lands: null, landsTod: null, why: null },
          },
        },
        { from: "p4", item: { kind: "call", call: { ...k3, id: "k9", role: "hold" } } },
        { from: "p4", item: { kind: "cancel", cancel: { id: "k9", why: null } } },
        { from: "p4", item: { kind: "cancel", cancel: { id: "zz", why: null } } },
        { from: "p1", item: { kind: "call", call: { ...k3, id: "self" } } },
      ],
      "p1",
    );
    const byKey = Object.fromEntries(book.map((e) => [`${e.from}/${e.call.id}`, e]));
    expect(Object.keys(byKey).toSorted(byCodeUnit)).toEqual(["p1/k3", "p2/k3", "p4/k9"]);
    expect(byKey["p1/k3"]?.answers).toEqual({ p2: D3_1400 + 720, p4: "no" });
    expect(byKey["p2/k3"]?.state).toBe("yes");
    expect(byKey["p4/k9"]?.state).toBe("cancelled");
    // The same id asking for something else is a new call while the seat promised nothing on it;
    // one it said yes to (or acted on) stays as it was until the caller cancels it.
    const moved = { kind: "call", call: { ...k3, target: "c13" } } as const;
    const kept = absorbWar(book, [{ from: "p2", item: moved }], "p1");
    expect(kept.find((e) => e.from === "p2")).toEqual(byKey["p2/k3"]);
    const sent = absorbWar(
      book.map((e) => (e.from === "p2" ? { ...e, state: "sent" as const } : e)),
      [{ from: "p2", item: moved }],
      "p1",
    );
    expect(sent.find((e) => e.from === "p2")?.call.target).toBe("c12");
    for (const state of ["open", "no", "cancelled"] as const) {
      const again = absorbWar(
        book.map((e) => (e.from === "p2" ? restate(e, state) : e)),
        [{ from: "p2", item: moved }],
        "p1",
      );
      const e = again.find((x) => x.from === "p2");
      expect([e?.state, e?.call.target]).toEqual(["open", "c13"]);
    }
  });
});

describe("timing", () => {
  const o = { minDelay: 600 };

  test("a group that can land now leaves now; one that must wait leaves at the aim", () => {
    // Travel 3 h: the window [14:00, 14:20] is reached by leaving between 11:00 and 11:20.
    const travel = 3 * 3600;
    expect(launchTime(k3, travel, D3_1400 - travel + 300, o)).toEqual({
      at: D3_1400 - travel + 300,
      lands: D3_1400 + 300,
    });
    expect(launchTime(k3, travel, D3_1400 - travel - 7200, o)).toEqual({
      at: D3_1400 - travel + 600,
      lands: D3_1400 + 600,
    });
    expect(launchTime(k3, travel, D3_1400 - travel + 1201, o)).toBeNull();
  });

  test("the shortest self-wake and the attack gate are respected", () => {
    const travel = 3600;
    // The aim is 5 min away, a wake at least 10: leave now (lands early in the window) or wake.
    const now = D3_1400 + 600 - travel - 300;
    const l = launchTime(k3, travel, now, o);
    expect(l?.at === now || (l?.at ?? 0) >= now + 600).toBe(true);
    expect(l?.lands).toBeGreaterThanOrEqual(k3.t0);
    expect(l?.lands).toBeLessThanOrEqual(k3.t1);
    // No launch before the attack gate.
    const gated = launchTime(k3, travel, D3_1400 - 2 * travel, {
      ...o,
      earliest: D3_1400 - travel + 900,
    });
    expect(gated).toEqual({ at: D3_1400 - travel + 900, lands: D3_1400 + 900 });
    expect(launchTime(k3, travel, 0, { ...o, earliest: D3_1400 })).toBeNull();
    expect(launchTime(k3, -1, 0, o)).toBeNull();
  });

  test("aim and overlaps", () => {
    expect(launchTime(k3, 3600, 0, { ...o, aimPm: 0 })?.lands).toBe(k3.t0);
    expect(launchTime(k3, 3600, 0, { ...o, aimPm: 1000 })?.lands).toBe(k3.t1);
    const later: WarCall = { ...k3, t0: k3.t1 + 1800, t1: k3.t1 + 2400 };
    expect(overlaps(k3, later)).toBe(false);
    expect(overlaps(k3, later, 1800)).toBe(true);
    expect(resolveTod(600, 3 * DAY - 600)).toBe(3 * DAY + 600);
    expect(resolveTod(13 * 3600, D3_1400)).toBe(2 * DAY + 13 * 3600);
  });

  test("a group's pace: its slowest ship's, or the slowest group probe without ships", () => {
    const kit = makeKit(perfidiaGame(6).info);
    const row = [5400, 4050, 2700];
    expect(groupTravel(kit, row, { raider: 40, transport: 2 })).toBe(5400);
    expect(groupTravel(kit, row, { warship: 5 })).toBe(4050);
    expect(groupTravel(kit, row, { warship: 5, transport: 1 })).toBe(5400);
    expect(groupTravel(kit, row, { raider: 40 })).toBe(5400);
  });
});

const target: WarTarget = { id: "c12", island: "i9", owner: "p5", besieged: false, by: null };
const targetWith = (x: Partial<WarTarget>): WarTarget => ({ ...target, ...x });

const cand = (
  from: PlayerId,
  id: string,
  role: WarCall["role"],
  lands: number,
  to: CityId,
): WarCandidate => ({
  from,
  call: { ...k3, id, role, target: to },
  launch: { at: lands - 3600, lands },
});

describe("deciding", () => {
  const base: WarJudgeInput = {
    seat: "p1",
    now: D3_1400 - 4 * 3600,
    from: "p2",
    call: k3,
    relations: new Map([
      ["p2", "ally"],
      ["p3", "pact"],
    ]),
    target,
    distrust: new Set(),
    launch: { at: D3_1400 - 3 * 3600, lands: D3_1400 + 600 },
    force: 2000,
    minForce: 500,
    attacksLeft: 5,
    threatened: false,
  };

  test("a sound call from an ally is accepted", () => {
    expect(judgeCall(base)).toEqual({ accept: true });
  });

  test("never for a non-ally, a pact partner or a distrusted caller, never for itself", () => {
    expect(judgeCall({ ...base, from: "p5" })).toEqual({ accept: false, why: "not allied" });
    expect(judgeCall({ ...base, from: "p3" })).toEqual({ accept: false, why: "not allied" });
    expect(judgeCall({ ...base, from: "p1" })).toEqual({ accept: false, why: "not allied" });
    expect(judgeCall({ ...base, distrust: new Set(["p2"]) })).toEqual({
      accept: false,
      why: "distrust",
    });
  });

  test("never a strike against the seat, an ally, a pact partner, the neutral city or a siege", () => {
    const at = (t: Partial<WarTarget>) => judgeCall({ ...base, target: { ...target, ...t } });
    expect(at({ owner: "p1" })).toEqual({ accept: false, why: "own city" });
    expect(at({ owner: "p2" })).toEqual({ accept: false, why: "ally city" });
    expect(at({ owner: "p3" })).toEqual({ accept: false, why: "pact city" });
    expect(at({ owner: null })).toEqual({ accept: false, why: "neutral" });
    expect(at({ besieged: true, by: "p2" })).toEqual({ accept: false, why: "besieged" });
    expect(at({ besieged: true, by: "p6" })).toEqual({ accept: false, why: "besieged" });
    expect(judgeCall({ ...base, target: null })).toEqual({ accept: false, why: "unknown city" });
    expect(judgeCall({ ...base, target: { ...target, id: "c13" } })).toEqual({
      accept: false,
      why: "unknown city",
    });
  });

  test("hold and siege only for the caller's own city or its own siege", () => {
    const hold = { ...base, call: { ...k3, role: "hold" as const } };
    const siege = { ...base, call: { ...k3, role: "siege" as const } };
    expect(judgeCall({ ...hold, target: targetWith({ owner: "p2" }) })).toEqual({ accept: true });
    expect(judgeCall({ ...hold, target: targetWith({ owner: "p5" }) }).accept).toBe(false);
    expect(
      judgeCall({ ...hold, target: targetWith({ owner: "p2", besieged: true, by: "p5" }) }).accept,
    ).toBe(false);
    expect(judgeCall({ ...siege, target: targetWith({ besieged: true, by: "p2" }) })).toEqual({
      accept: true,
    });
    expect(judgeCall({ ...siege, target: targetWith({ owner: "p2" }) })).toEqual({ accept: true });
    expect(judgeCall({ ...siege, target: targetWith({ besieged: true, by: "p6" }) })).toEqual({
      accept: false,
      why: "not theirs",
    });
    expect(judgeCall({ ...siege, target: targetWith({ besieged: true, by: null }) }).accept).toBe(
      false,
    );
  });

  test("a siege is never held against the seat, an ally or a pact partner; a hold needs an attack seen", () => {
    const siege = { ...base, call: { ...k3, role: "siege" as const } };
    const held = (owner: PlayerId | null) =>
      judgeCall({ ...siege, target: targetWith({ owner, besieged: true, by: "p2" }) });
    expect(held("p1")).toEqual({ accept: false, why: "own city" });
    expect(held("p4")).toEqual({ accept: true });
    expect(held("p3")).toEqual({ accept: false, why: "pact city" });
    const ally = { ...siege, relations: new Map([...base.relations, ["p4", "ally"] as const]) };
    expect(
      judgeCall({ ...ally, target: targetWith({ owner: "p4", besieged: true, by: "p2" }) }),
    ).toEqual({ accept: false, why: "ally city" });
    // Taken already (the caller's city now): held whoever it was taken from.
    expect(judgeCall({ ...siege, target: targetWith({ owner: "p2" }) })).toEqual({ accept: true });
    const hold = {
      ...base,
      call: { ...k3, role: "hold" as const },
      target: targetWith({ owner: "p2" }),
    };
    expect(judgeCall({ ...hold, attackSeen: false })).toEqual({ accept: false, why: "no threat" });
    expect(judgeCall({ ...hold, attackSeen: true })).toEqual({ accept: true });
    // A strike is not concerned.
    expect(judgeCall({ ...base, attackSeen: false })).toEqual({ accept: true });
  });

  test("the window, threats, launches and force decide the rest", () => {
    expect(judgeCall({ ...base, now: k3.t0 - 2 * DAY })).toEqual({
      accept: false,
      why: "too early",
    });
    expect(judgeCall({ ...base, launch: null })).toEqual({ accept: false, why: "too late" });
    expect(judgeCall({ ...base, threatened: true })).toEqual({
      accept: false,
      why: "under attack",
    });
    expect(judgeCall({ ...base, attacksLeft: 0 })).toEqual({ accept: false, why: "no launches" });
    expect(judgeCall({ ...base, force: 499 })).toEqual({ accept: false, why: "too weak" });
    expect(judgeCall({ ...base, force: 0, minForce: 0 })).toEqual({
      accept: false,
      why: "too weak",
    });
  });

  test("the call picked: the seat's enemy first, strikes first, the earliest landing, any input order", () => {
    const cands = [
      cand("p4", "k1", "hold", D3_1400, "c20"),
      cand("p2", "k2", "strike", D3_1400 + 900, "c12"),
      cand("p2", "k1", "strike", D3_1400 + 300, "c14"),
      cand("p4", "k2", "siege", D3_1400 + 100, "c15"),
    ];
    const owners: Record<string, PlayerId> = { c12: "p5", c14: "p6", c15: "p6", c20: "p4" };
    const ownerOf = (c: CityId): PlayerId | null => owners[c] ?? null;
    expect(pickCall(cands, new Set(), ownerOf)?.call.id).toBe("k1");
    expect(pickCall(cands, new Set(), ownerOf)?.from).toBe("p2");
    expect(pickCall(cands, new Set(["p5"]), ownerOf)?.call.target).toBe("c12");
    for (let i = 0; i < 4; i += 1) {
      const rotated = [...cands.slice(i), ...cands.slice(0, i)];
      expect(pickCall(rotated, new Set(["p5"]), ownerOf)).toEqual(
        pickCall(cands, new Set(["p5"]), ownerOf),
      );
    }
    expect(pickCall([])).toBeNull();
  });

  test("messages are kept in hand: a no only when plenty are left", () => {
    expect(mayMessage("yes", WAR_RESERVE.yes + 1)).toBe(true);
    expect(mayMessage("yes", WAR_RESERVE.yes)).toBe(false);
    expect(mayMessage("call", WAR_RESERVE.call)).toBe(false);
    expect(mayMessage("cancel", WAR_RESERVE.call + 1)).toBe(true);
    expect(mayMessage("no", WAR_RESERVE.no)).toBe(false);
    expect(mayMessage("no", 20)).toBe(true);
    expect(WAR_RESERVE.no).toBeGreaterThan(WAR_RESERVE.call);
  });
});

function allyGame(): FakeGame {
  const g = perfidiaGame(6);
  g.t = 2 * DAY + 6 * 3600;
  g.relations.set("p1", [
    { player: "p2", kind: "ally", until: null },
    { player: "p3", kind: "pact", until: null },
  ]);
  g.city("c1").units = { guard: 50, raider: 120, transport: 10 };
  return g;
}
// c4 (p4) is 3 sectors away from c1: 540 tiles, 9 h with transports.
const strike: WarCall = {
  id: "k1",
  role: "strike",
  target: "c4",
  t0: 0,
  t1: 0,
  vs: null,
  lands: null,
};

/** One judged call on a fresh world, for the determinism test. */
function judgedOnce(): unknown {
  const g = allyGame();
  const w = worldOf(g, "p1");
  const call0: WarCall = { ...strike, t0: g.t + 10 * 3600, t1: g.t + 11 * 3600 };
  const heard = hearWar([msg("p2", ["p1"], composeCall(call0))], "p1", w.relations);
  const book = absorbWar(readBook(w.memory), heard.heard, "p1");
  return { j: judgeWar(w, "p2", call0, { sharePm: 400, minForce: 0, attacksLeft: 3 }), book };
}

describe("on a fake perfidia-1 game", () => {
  test("the target, the options and the verdict come from the map and the travel times", () => {
    const g = allyGame();
    const w = worldOf(g, "p1");
    const travel = g.travel("i2", "i14", 0);
    expect(travel).toBe(540 * 60);
    const call0: WarCall = { ...strike, t0: g.t + travel + 1800, t1: g.t + travel + 3000 };
    const c4 = warTarget(w, "c4");
    expect(c4).toEqual({ id: "c4", island: "i14", owner: "p4", besieged: false, by: null });
    if (c4 === null) throw new Error("c4 is on the map");
    const options = warOptions(w, call0, c4, 500);
    expect(options).toEqual([
      {
        city: "c1",
        units: { raider: 60 },
        force: 60 * 20,
        launch: { at: g.t + 2400, lands: g.t + travel + 2400 },
      },
    ]);
    const judged = judgeWar(w, "p2", call0, { sharePm: 500, minForce: 600, attacksLeft: 20 });
    expect(judged.verdict).toEqual({ accept: true });
    // A strike on a pact partner's city, or from a pact partner, is never accepted.
    const pact = judgeWar(
      w,
      "p2",
      { ...call0, target: "c3" },
      { sharePm: 500, minForce: 0, attacksLeft: 20 },
    );
    expect(pact.verdict).toEqual({ accept: false, why: "pact city" });
    expect(
      judgeWar(w, "p3", call0, { sharePm: 500, minForce: 0, attacksLeft: 20 }).verdict,
    ).toEqual({
      accept: false,
      why: "not allied",
    });
    // Out of reach: the window closes before the army can land.
    const soon = { ...call0, t0: g.t + 3600, t1: g.t + 7200 };
    expect(judgeWar(w, "p2", soon, { sharePm: 500, minForce: 0, attacksLeft: 20 }).verdict).toEqual(
      {
        accept: false,
        why: "too late",
      },
    );
  });

  test("a besieged target (public extras) is refused, and its besieger is read for a siege call", () => {
    const g = allyGame();
    g.city("c4").ext = { siege: { by: "p2", ends: [g.t + 3600, fmtTime(g.t + 3600)] } };
    const w = worldOf(g, "p1");
    expect(warTarget(w, "c4")).toEqual({
      id: "c4",
      island: "i14",
      owner: "p4",
      besieged: true,
      by: "p2",
    });
    const window = { t0: g.t + 12 * 3600, t1: g.t + 13 * 3600 };
    const o = { sharePm: 500, minForce: 0, attacksLeft: 20 };
    expect(judgeWar(w, "p2", { ...strike, ...window }, o).verdict).toEqual({
      accept: false,
      why: "besieged",
    });
    expect(judgeWar(w, "p2", { ...strike, ...window, role: "siege" }, o).verdict).toEqual({
      accept: true,
    });
  });

  test("an attack on the way from the caller, or a betrayal it committed, makes it distrusted", () => {
    const g = allyGame();
    const b = g.briefing("p1");
    const attacked: Briefing = {
      ...b,
      incoming: [
        {
          id: "m0000a",
          kind: "attack",
          from: "c2",
          by: "p2",
          foe: "p1",
          to: "c1",
          depart: [g.t - 600, fmtTime(g.t - 600)],
          arrive: [g.t + 3600, fmtTime(g.t + 3600)],
        },
      ],
      news: [{ type: "betrayal", by: "p6", against: "p5", relation: "ally", city: "c5" }],
    };
    const w = worldOf(g, "p1", attacked);
    expect([...distrustOf(w)].toSorted(compareIds)).toEqual(["p2", "p6"]);
    const call0: WarCall = { ...strike, t0: g.t + 12 * 3600, t1: g.t + 13 * 3600 };
    const judged = judgeWar(w, "p2", call0, { sharePm: 500, minForce: 0, attacksLeft: 20 });
    expect(judged.verdict).toEqual({ accept: false, why: "distrust" });
  });

  test("deterministic: the same world gives the same verdict, options and book", () => {
    expect(judgedOnce()).toEqual(judgedOnce());
  });
});

/** A briefing of p1's that left two messages out (`more.msgs`), with `msgs` shown. */
function full(game: FakeGame, msgs: Briefing["msgs"]): Briefing {
  return {
    ...game.briefing("p1"),
    msgs,
    more: {
      msgs: {
        count: 2,
        call: {
          tool: "read_notes",
          args: { search: { scope: "mine", kinds: ["message"], since: 7200, before: 41 } },
        },
      },
    },
  };
}

describe("messages a full briefing left out", () => {
  const hit = (e: number, id: string | null, summary: string): ArchiveHit => ({
    e,
    t: [game0.t, fmtTime(game0.t)],
    type: "message",
    public: false,
    id,
    summary,
  });
  const game0 = allyGame();

  test("the search: the briefing's own, narrowed to war messages; none when nothing was left out", () => {
    const g = allyGame();
    expect(droppedWarSearch(worldOf(g, "p1"))).toEqual([]);
    expect(droppedWarSearch(worldOf(g, "p1", full(g, [])))).toEqual([
      call("read_notes", {
        search: {
          kinds: ["message"],
          text: "war",
          limit: 8,
          scope: "mine",
          since: 7200,
          before: 41,
        },
      }),
    ]);
  });

  test("the hits opened: messages the briefing did not show, not the seat's own, four at most", () => {
    const g = allyGame();
    const w = worldOf(g, "p1", full(g, [{ ...msg("p2", ["p1"], "hello"), id: "g0000b" }]));
    const hits = [
      hit(40, "g0000a", 'message from=p2 message=g0000a to=[p1] text="WAR#k1 strike c4"'),
      hit(39, "g0000b", 'message from=p2 message=g0000b to=[p1] text="war on p4"'),
      hit(38, "g0000c", 'message from=p1 message=g0000c to=[p2] text="WAR#k1 yes"'),
      hit(37, null, "battle (public) attacker=p4 war"),
      hit(36, "g0000d", 'message from=p5 message=g0000d to=[p1] text="war"'),
      hit(35, "g0000e", 'message from=p2 message=g0000e to=[p1] text="war"'),
      hit(34, "g0000f", 'message from=p2 message=g0000f to=[p1] text="war"'),
      hit(33, "g0000g", 'message from=p2 message=g0000g to=[p1] text="war"'),
    ];
    const opens = droppedWarOpens({ ...w, archive: { hits, entries: new Map() } });
    expect(opens).toEqual(
      (["g0000a", "g0000d", "g0000e", "g0000f"] as const).map((id) =>
        call("read_notes", { open: id }),
      ),
    );
  });

  test("opened messages are read before the briefing's, and only an ally's private ones are heard", () => {
    const g = allyGame();
    const call0: WarCall = { ...strike, t0: g.t + 10 * 3600, t1: g.t + 11 * 3600 };
    const shown = { ...msg("p2", ["p1"], "WAR#k2 cancel"), id: "g0000c" as const };
    const w = worldOf(g, "p1", full(g, [shown]));
    const opened = (
      e: number,
      id: string,
      from: PlayerId,
      to: PlayerId[] | "all",
      text: string,
    ): [string, ArchiveEntry] => {
      const opened1: ArchiveEntry = {
        e,
        t: [g.t, fmtTime(g.t)],
        type: "message",
        public: to === "all",
        id,
        data: { message: id, from, to, text },
        to: [],
      };
      return [id, opened1];
    };
    const entries = new Map<string, ArchiveEntry>([
      opened(31, "g0000b", "p5", ["p1"], composeCall({ ...call0, id: "k9" })),
      opened(30, "g0000a", "p2", ["p1"], composeCall(call0)),
      opened(32, "g0000c", "p2", ["p1"], "a duplicate of a shown one"),
      opened(33, "g0000d", "p2", ["p1"], ""),
      [
        "g0000x",
        {
          e: 34,
          t: [g.t, fmtTime(g.t)],
          type: "report",
          public: false,
          id: "g0000x",
          data: {},
          to: [],
        },
      ],
    ]);
    const all = warMessages({ ...w, archive: { hits: [], entries } });
    expect(all.map((m) => m.id)).toEqual(["g0000a", "g0000b", "g0000d", "g0000c"]);
    const heard = hearWar(all, "p1", w.relations);
    expect(heard.heard.map((h) => [h.from, h.item.kind])).toEqual([
      ["p2", "call"],
      ["p2", "cancel"],
    ]);
    expect(heard.ignored).toBe(1);
  });
});

/** A briefing of p1's whose `events` (`kinds` left out) and `news` were cut, as `more` lists them. */
function cut(game: FakeGame, kinds: readonly string[] | null, news: boolean): Briefing {
  const more: NonNullable<Briefing["more"]> = {};
  if (kinds !== null) {
    more["events"] = {
      count: kinds.length,
      call: {
        tool: "read_notes",
        args: { search: { scope: "mine", kinds: [...kinds], since: 7200, before: 30 } },
      },
    };
  }
  if (news) {
    more["news"] = {
      count: 3,
      call: { tool: "read_notes", args: { search: { scope: "public", since: 7200, before: 41 } } },
    };
  }
  return { ...game.briefing("p1"), more };
}

/** A public search hit of `type` at 9000 s, with no id. */
function eventHit(e: number, type: string, summary: string): ArchiveHit {
  return { e, t: [9000, fmtTime(9000)], type, public: true, id: null, summary };
}

describe("events a full briefing left out", () => {
  test("the search: the kinds asked for that the cut lists may hold; none when they hold none", () => {
    const g = allyGame();
    expect(droppedEventSearch(worldOf(g, "p1"), TRUST_EVENTS)).toEqual([]);
    // Events cut without a betrayal or a conquest among them, news kept: nothing to search.
    const quiet = worldOf(g, "p1", cut(g, ["build_done", "recruit_done"], false));
    expect(droppedEventSearch(quiet, TRUST_EVENTS)).toEqual([]);
    const events = worldOf(g, "p1", cut(g, ["betrayal", "build_done"], false));
    expect(droppedEventSearch(events, TRUST_EVENTS)).toEqual([
      call("read_notes", {
        search: { scope: "all", kinds: ["betrayal"], since: 7200, before: 30 },
      }),
    ]);
    // The news cut: any kind may be there, up to the newest entry either list left out.
    const both = worldOf(g, "p1", cut(g, ["build_done"], true));
    expect(droppedEventSearch(both, TRUST_EVENTS)).toEqual([
      call("read_notes", {
        search: { scope: "all", kinds: ["betrayal", "city_conquered"], since: 7200, before: 41 },
      }),
    ]);
    expect(droppedEventSearch(both, WATCH_EVENTS)).toEqual([
      call("read_notes", {
        search: { scope: "all", kinds: ["battle", "city_founded"], since: 7200, before: 41 },
      }),
    ]);
  });

  test("a betrayal of the seat is seen from its wake reason alone, and from a search hit", () => {
    const g = allyGame();
    const b = g.briefing("p1");
    // The briefing of the betrayal turn: the event left out, the urgent wake's reason kept.
    const reason = worldOf(g, "p1", { ...b, wake: { urgent: true, reasons: ["betrayal p2"] } });
    expect(seenEvents(reason)).toEqual([{ type: "betrayal", by: "p2", against: "p1" }]);
    expect([...distrustOf(reason)]).toEqual(["p2"]);
    const w = worldOf(g, "p1", cut(g, ["betrayal"], true));
    const hits = [
      eventHit(29, "betrayal", "betrayal (public) against=p1 by=p2 city=c1 relation=ally"),
      eventHit(28, "city_conquered", "city_conquered (public) city=c5 from=null to=p6"),
      eventHit(
        27,
        "battle",
        "battle (public) attacker=p4 city=c3 defender=p3 kind=city winner=attacker",
      ),
      eventHit(26, "city_founded", "city_founded (public) city=c40 island=i9 owner=p5 slot=2"),
    ];
    const read = seenEvents({ ...w, archive: { hits, entries: new Map() } });
    const at = [9000, fmtTime(9000)];
    expect(read).toEqual([
      { type: "betrayal", at, against: "p1", by: "p2", city: "c1", relation: "ally" },
      { type: "city_conquered", at, city: "c5", from: null, to: "p6" },
      {
        type: "battle",
        at,
        attacker: "p4",
        city: "c3",
        defender: "p3",
        kind: "city",
        winner: "attacker",
      },
      { type: "city_founded", at, city: "c40", island: "i9", owner: "p5", slot: 2 },
    ]);
    expect([...distrustOf({ ...w, archive: { hits, entries: new Map() } })]).toEqual(["p2"]);
  });

  test("only what a reason or a summary says for sure: other kinds, odd words and shared wakes are skipped", () => {
    const g = allyGame();
    const b = g.briefing("p1");
    const reasons = ["betrayal", "betrayal p2 p3", "betrayal c4", "betrayal p1", "message g0000a"];
    const odd = worldOf(g, "p1", { ...b, wake: { urgent: true, reasons } });
    expect(seenEvents(odd)).toEqual([]);
    // A conquest reason names the seat's own city it lost.
    const lost = worldOf(g, "p1", { ...b, wake: { urgent: true, reasons: ["city_conquered c7"] } });
    expect(seenEvents(lost)).toEqual([{ type: "city_conquered", city: "c7", from: "p1" }]);
    // Rules that wake others for a betrayal too: the reason no longer says who was betrayed.
    const shared = worldOf(g, "p1", { ...b, wake: { urgent: true, reasons: ["betrayal p2"] } });
    const wake: GatewayRules["wake"] = { betrayal: { target: "urgent", ally: "social" } };
    const kit: Kit = { ...shared.kit, gateway: { ...shared.kit.gateway, wake } };
    expect(seenEvents({ ...shared, kit })).toEqual([]);
    const hits = [
      eventHit(
        29,
        "alliance_formed",
        "alliance_formed (public) alliance=a1 members=[p2,p3] name=Our betrayal by=p9",
      ),
      eventHit(
        28,
        "betrayal",
        "betrayal (public) against=p1 by=p2 city=c1 relation=ally extra=[x,y]",
      ),
      eventHit(27, "betrayal", "battle (public) attacker=p2"),
      eventHit(26, "message", 'message from=p2 message=g0000a to=[p1] text="betrayal by=p3"'),
    ];
    expect(seenEvents({ ...odd, archive: { hits, entries: new Map() } })).toEqual([]);
  });
});
