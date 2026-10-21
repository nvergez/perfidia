import { describe, expect, test } from "bun:test";
import type { AnyRuleset, Ruleset } from "@perfidia/engine/contracts";
import {
  FIXTURE_BUILDINGS,
  LogRecorder,
  fakeDomain,
  fixtureMatch,
  fixtureRuleset,
  type FixtureConfig,
  type FixtureExt,
} from "@perfidia/engine/testing";
import { canonicalJson, idKeyFromSeed } from "@perfidia/engine/core";
import { domain } from "@perfidia/engine/domain";
import { findRuleset } from "@perfidia/engine/rulesets";
import type {
  Action,
  ActLine,
  CityId,
  CkptLine,
  HeaderLine,
  LogLine,
  PlayerId,
} from "@perfidia/protocol";
import fc from "fast-check";
import {
  EngineMisuse,
  createMatch,
  createReplay,
  verifyLog,
  type ApplyOutput,
  type Replay,
  type ReplayDivergence,
  type ReplayReport,
  type ReplayStep,
  type VerifyOptions,
} from "./index.ts";

// The fast-check properties of P7 and `createReplay` run about a third of their runs in the default
// suite and all of them in the slow suite (PERFIDIA_SLOW=1: `bun run test:slow`, run by
// `bun run test:exit`; docs/architecture.md §13.8). Read through `import.meta.env`: the pure
// packages' tests may not name the `process` global.
const SLOW = import.meta.env["PERFIDIA_SLOW"] === "1";

// Level E replay (§10.4) and P7: a log recorded from a random run replays with zero divergence, and
// tampering with an act's `a` (whether or not that changes its verdict) or `r`, the order of act
// lines, the payloads of two act lines, an `ev` line (a non-integer number included) or a `ckpt`
// line is reported at the right `n` or hour.
//
// The incremental replay (`createReplay`): pushing a log line by line gives `verifyLog`'s report and
// `onLine` sequence whatever is read in between; a prefix of a log being written holds up with
// `requireEnd: false`; `changed` flags every line where an act applied or a scheduled event ran, a
// silent world timer included; a snapshot taken at a ckpt line resumes a later replay.

const resolve = (ref: string): AnyRuleset | undefined =>
  ref === fixtureRuleset.ref ? fixtureRuleset : undefined;

function verify(lines: readonly LogLine[], opts: VerifyOptions = {}): ReplayReport {
  return verifyLog(lines, resolve, fakeDomain, opts);
}

function cloneLines(lines: readonly LogLine[]): LogLine[] {
  return structuredClone([...lines]);
}

type Step =
  | { readonly k: "act"; readonly seat: number; readonly what: number; readonly x: number }
  | { readonly k: "wait"; readonly dt: number }
  | { readonly k: "line"; readonly what: number; readonly seat: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant("act" as const),
      seat: fc.nat({ max: 3 }),
      what: fc.nat({ max: 11 }),
      x: fc.nat({ max: 50 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant("wait" as const),
      dt: fc.integer({ min: 0, max: 4000 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("line" as const),
      what: fc.nat({ max: 7 }),
      seat: fc.nat({ max: 3 }),
    }),
  },
);

/** An action intent resolved against the current state, so most are valid. */
function intent(rec: LogRecorder, seat: PlayerId, what: number, x: number): Action {
  const s = rec.match.read().state;
  const n = Object.keys(s.players).length;
  const me = Number(seat.slice(1));
  const own: CityId = `c${me}`;
  const foe: CityId = `c${(me % n) + 1}`;
  const movements = Object.values(s.movements).filter((m) => m.owner === seat);
  const proposals = Object.values(s.proposals).filter((p) => p.to === seat);
  const city = s.cities[own];
  const items =
    city === undefined
      ? []
      : [...city.build, ...Object.values(city.recruit).flat()].map((i) => i.id);
  switch (what) {
    case 0:
      return {
        type: "build",
        city: own,
        building: FIXTURE_BUILDINGS[x % FIXTURE_BUILDINGS.length] ?? "tower",
      };
    case 1:
      return {
        type: "recruit",
        city: own,
        unit: x % 7 === 0 ? "ship" : "soldier",
        count: 1 + (x % 4),
      };
    case 2:
      return { type: "attack", from: own, to: foe, units: { soldier: 1 + (x % 6) } };
    case 3:
      return { type: "support", from: own, to: foe, units: { soldier: 1 } };
    case 4:
      return { type: "spy", from: own, to: foe, gold: 5 + x };
    case 5: {
      const m = movements[x % Math.max(1, movements.length)];
      return { type: "recall", movement: m?.id ?? "m00000" };
    }
    case 6:
      return {
        type: "send_message",
        to: x % 2 === 0 ? "all" : [`p${(me % n) + 1}`],
        text: `hello ${x}`,
      };
    case 7:
      return {
        type: "propose",
        to: `p${(me % n) + 1}`,
        kind: "pact",
        name: null,
        text: "peace",
        until: null,
      };
    case 8: {
      const p = proposals[x % Math.max(1, proposals.length)];
      return { type: "answer", proposal: p?.id ?? "q00000", accept: x % 3 !== 0 };
    }
    case 9:
      return { type: "cancel_queue", city: own, item: items[x % Math.max(1, items.length)] ?? 99 };
    case 10:
      return { type: "ext", tool: "fixture_rename", args: { city: own, name: `Town ${x}` } };
    default:
      return { type: "leave", with: null };
  }
}

/** Records a log from a random run; every run starts with two adjacent act lines (the first rejected). */
function record(seed: number, players: number, steps: readonly Step[]): LogRecorder {
  const m = fixtureMatch({
    players,
    seed,
    overrides: { "time.matchEnd": 6 * 3600 },
    invariants: "checkpoint",
  });
  const rec = new LogRecorder(m, { snapshotEvery: 2 });
  for (let i = 1; i <= players; i += 1) rec.wake(`p${i}`);
  rec.batch(0, ["p1", "p2"]);
  rec.act("p1", { type: "build", city: "c2", building: "tower" });
  rec.act("p1", { type: "attack", from: "c1", to: "c2", units: { soldier: 2 } });
  for (const s of steps) {
    const seat: PlayerId = `p${1 + ("seat" in s ? s.seat % players : 0)}`;
    if (s.k === "wait") {
      rec.advanceTo(rec.match.now + s.dt);
    } else if (s.k === "act") {
      rec.act(seat, intent(rec, seat, s.what, s.x));
    } else {
      switch (s.what) {
        case 0:
          rec.wake(seat, ["self"]);
          break;
        case 1:
          rec.turn(seat, "end_turn", rec.match.now + 600);
          break;
        case 2:
          rec.defer(seat, rec.match.now + 1);
          break;
        case 3:
          rec.controller(seat, "bot:turtle@1");
          break;
        case 4:
          rec.gw(seat, "attack", "DAILY_CAP", { cap: 10, used: 10 });
          break;
        case 5:
          rec.obs(seat, "view_city", { city: "c1" });
          break;
        case 6:
          rec.note(seat, "remember", "append");
          break;
        default:
          rec.batch(1, [seat]);
      }
    }
  }
  rec.end();
  return rec;
}

const runArb = fc.record({
  seed: fc.integer({ min: 0, max: 0xffffffff }),
  players: fc.integer({ min: 2, max: 4 }),
  steps: fc.array(stepArb, { maxLength: 40 }),
});

/** The first act line after `index`, if any. */
function nextAct(lines: readonly LogLine[], index: number): ActLine | undefined {
  return lines.slice(index + 1).find((l): l is ActLine => l.k === "act");
}

/** The first ckpt line after `index`, if any. */
function nextCkpt(lines: readonly LogLine[], index: number): CkptLine | undefined {
  return lines.slice(index + 1).find((l): l is CkptLine => l.k === "ckpt");
}

/** Whether the act line at `index` is followed by ev lines of its own events. */
function hasOwnEvents(lines: readonly LogLine[], index: number): boolean {
  return lines[index + 1]?.k === "ev" && emitterN(lines, index + 1) !== undefined;
}

/**
 * A change made at act line `index` (and `last`) that keeps every `n` and `t` shows once the
 * replay observes it: at that act's verdict or events, at a later act or event before the next
 * checkpoint, at that checkpoint, or at the end when no checkpoint follows.
 */
function expectBetween(
  d: ReplayDivergence | undefined,
  lines: readonly LogLine[],
  index: number,
  last = index,
): void {
  const first = lines[index];
  if (first?.k !== "act") throw new Error("not an act line");
  const ck = nextCkpt(lines, last);
  const end = lines.at(-1);
  const bound = ck?.t ?? (end?.k === "end" ? end.t : Number.MAX_SAFE_INTEGER);
  expect(["result", "event", "checkpoint", "end"]).toContain(d?.kind ?? "none");
  expect(d?.t ?? -1).toBeGreaterThanOrEqual(first.t);
  expect(d?.t ?? -1).toBeLessThanOrEqual(bound);
  if (d?.n !== undefined) expect(d.n).toBeGreaterThanOrEqual(first.n);
  if (d?.kind === "checkpoint") expect(d.hour).toBe(ck?.hour ?? -1);
}

/** The n of the act line whose events this ev line carries, if any. */
function emitterN(lines: readonly LogLine[], index: number): number | undefined {
  const line = lines[index];
  if (line?.k !== "ev") return undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    const prev = lines[i];
    if (prev?.k === "ev" && prev.t === line.t) continue;
    return prev?.k === "act" && prev.t === line.t ? prev.n : undefined;
  }
  return undefined;
}

describe("P7: replay of recorded logs", () => {
  test("a log recorded from a random run replays with zero divergence", () => {
    fc.assert(
      fc.property(runArb, ({ seed, players, steps }) => {
        const rec = record(seed, players, steps);
        const report = verify(rec.lines, { invariants: "step" });
        expect(report.divergence).toBeUndefined();
        expect(report.ok).toBe(true);
        expect(report.finalHash).toBe(rec.match.hash());
        expect(report.actions).toBe(rec.lines.filter((l) => l.k === "act").length);
        expect(report.checkpoints).toBe(rec.lines.filter((l) => l.k === "ckpt").length);
        expect(report.warnings).toEqual([]);
      }),
      { numRuns: SLOW ? 40 : 15 },
    );
  });

  test("tampering is reported at the right n or hour", () => {
    const tamper = fc.constantFrom("a", "units", "r", "order", "swap", "ev", "float", "ckpt");
    fc.assert(
      fc.property(runArb, tamper, fc.nat(), ({ seed, players, steps }, kind, pick) => {
        const lines = cloneLines(record(seed, players, steps).lines);
        const at = (pred: (l: LogLine, i: number) => boolean): number[] =>
          lines.flatMap((l, i) => (pred(l, i) ? [i] : []));
        let candidates: number[];
        switch (kind) {
          case "a":
            candidates = at((l) => l.k === "act" && l.r.ok);
            break;
          case "units":
            candidates = at(
              (l) => l.k === "act" && l.r.ok && (l.a.type === "attack" || l.a.type === "support"),
            );
            break;
          case "r":
            candidates = at((l) => l.k === "act");
            break;
          case "order":
            candidates = at((l, i) => l.k === "act" && lines[i + 1]?.k === "act");
            break;
          case "swap":
            candidates = at((l, i) => l.k === "act" && nextAct(lines, i)?.t === l.t);
            break;
          case "ev":
          case "float":
            candidates = at((l) => l.k === "ev");
            break;
          case "ckpt":
            candidates = at((l) => l.k === "ckpt");
        }
        const index = candidates[pick % Math.max(1, candidates.length)];
        if (index === undefined) return;
        const line = lines[index];
        if (line === undefined) return;
        const report = (): ReplayReport => {
          const r = verify(lines);
          expect(r.ok).toBe(false);
          return r;
        };
        if (kind === "a" && line.k === "act") {
          line.a = { type: "build", city: "c9", building: "tower" };
          expect(report().divergence).toMatchObject({ kind: "result", n: line.n, t: line.t });
        } else if (kind === "units" && line.k === "act") {
          if (line.a.type !== "attack" && line.a.type !== "support") return;
          const k = line.a.units["soldier"] ?? 0;
          line.a.units["soldier"] = k > 1 ? k - 1 : k + 1;
          expectBetween(report().divergence, lines, index);
        } else if (kind === "swap" && line.k === "act") {
          const other = nextAct(lines, index);
          if (other === undefined) return;
          const j = lines.indexOf(other);
          if (canonicalJson([line.seat, line.a]) === canonicalJson([other.seat, other.a])) return;
          // A swap can be unobservable (two attacks of one seat that both die in their battle
          // leave the same state and events); it is certain to show when two seats swap and one
          // line has events of its own, because every event of an action names its actor.
          const observable =
            line.seat !== other.seat && (hasOwnEvents(lines, index) || hasOwnEvents(lines, j));
          const [seat, a] = [line.seat, line.a];
          line.seat = other.seat;
          line.a = other.a;
          other.seat = seat;
          other.a = a;
          const r = verify(lines);
          if (observable) expect(r.ok).toBe(false);
          if (!r.ok) expectBetween(r.divergence, lines, index, j);
        } else if (kind === "r" && line.k === "act") {
          line.r = line.r.ok ? { ok: false, code: "INVALID_ARGS" } : { ok: true };
          expect(report().divergence).toMatchObject({ kind: "result", n: line.n, t: line.t });
        } else if (kind === "order" && line.k === "act") {
          const next = lines[index + 1];
          if (next?.k !== "act") return;
          lines[index] = next;
          lines[index + 1] = line;
          const d = report().divergence;
          expect([line.n, next.n]).toContain(d?.n ?? -1);
          expect(["order", "result", "event"]).toContain(d?.kind ?? "none");
        } else if ((kind === "ev" || kind === "float") && line.k === "ev") {
          line.e.data["tampered"] = kind === "ev" ? 1 : 0.5;
          const n = emitterN(lines, index);
          const d = report().divergence;
          expect(d).toMatchObject({ kind: "event", t: line.t });
          expect(d?.n).toBe(n);
          if (kind === "float") expect(d?.actual).toContain("0.5 is not a safe integer");
        } else if (line.k === "ckpt") {
          line.h = line.h === "0123456789abcdef" ? "fedcba9876543210" : "0123456789abcdef";
          expect(report().divergence).toMatchObject({
            kind: "checkpoint",
            hour: line.hour,
            t: line.t,
          });
        }
      }),
      // 30 runs outside the slow suite, which runs 120.
      { numRuns: SLOW ? 120 : 30 },
    );
  });

  test("the logs include defer, controller, wake, turn, batch, gw, obs and note lines", () => {
    const rec = record(1, 3, [
      { k: "line", what: 2, seat: 0 },
      { k: "line", what: 3, seat: 1 },
      { k: "line", what: 1, seat: 2 },
      { k: "line", what: 4, seat: 0 },
      { k: "line", what: 5, seat: 0 },
      { k: "line", what: 6, seat: 0 },
      { k: "wait", dt: 3600 },
      { k: "line", what: 7, seat: 1 },
    ]);
    const kinds = new Set(rec.lines.map((l) => l.k));
    const expected: LogLine["k"][] = [
      "header",
      "wake",
      "batch",
      "act",
      "gw",
      "obs",
      "note",
      "turn",
      "defer",
      "controller",
      "ev",
      "ckpt",
      "end",
    ];
    for (const k of expected) expect(kinds.has(k)).toBe(true);
    expect(verify(rec.lines).ok).toBe(true);
  });

  test("a deleted gw, obs or note line, or a rejected act line, is an order divergence at the next n", () => {
    const rec = record(1, 3, [
      { k: "line", what: 2, seat: 0 },
      { k: "line", what: 3, seat: 1 },
      { k: "line", what: 1, seat: 2 },
      { k: "line", what: 4, seat: 0 },
      { k: "line", what: 5, seat: 0 },
      { k: "line", what: 6, seat: 0 },
      { k: "wait", dt: 3600 },
      { k: "line", what: 7, seat: 1 },
      { k: "act", seat: 1, what: 11, x: 0 },
      { k: "line", what: 4, seat: 2 },
    ]);
    const picks: [string, (l: LogLine) => boolean][] = [
      ["gw", (l) => l.k === "gw"],
      ["obs", (l) => l.k === "obs"],
      ["note", (l) => l.k === "note"],
      ["rejected act", (l) => l.k === "act" && !l.r.ok],
    ];
    for (const [what, pick] of picks) {
      const i = rec.lines.findIndex(pick);
      const line = rec.lines[i];
      if (line === undefined || !("n" in line)) throw new Error(`the record has no ${what} line`);
      const next = rec.lines.slice(i + 1).find((l) => "n" in l);
      if (next === undefined || !("n" in next)) throw new Error(`no numbered line after ${what}`);
      const d = verify(rec.lines.toSpliced(i, 1)).divergence;
      expect([what, d]).toMatchObject([
        what,
        { kind: "order", n: next.n, expected: `n = ${line.n}` },
      ]);
    }
  });
});

function sample(): LogRecorder {
  const rec = new LogRecorder(fixtureMatch({ players: 3, invariants: "checkpoint" }), {
    snapshotEvery: 4,
  });
  rec.wake("p1");
  rec.act("p1", { type: "attack", from: "c1", to: "c2", units: { soldier: 4 } });
  rec.act("p2", { type: "recruit", city: "c2", unit: "soldier", count: 3 });
  rec.turn("p1");
  rec.advanceTo(9000);
  rec.act("p3", { type: "ext", tool: "fixture_rename", args: { city: "c3", name: "Third" } });
  rec.advanceTo(30000);
  rec.act("p2", { type: "propose", to: "p1", kind: "pact", name: null, text: "", until: null });
  rec.end();
  return rec;
}

describe("verifyLog", () => {
  test("onLine is called for every line, in order, with the result of act lines", () => {
    const rec = sample();
    const seen: LogLine[] = [];
    let applied = 0;
    const report = verify(rec.lines, {
      onLine: (line, r, out) => {
        seen.push(line);
        if (line.k === "act") {
          expect(out).toBeDefined();
          applied += 1;
        } else {
          expect(out).toBeUndefined();
        }
        if (line.k !== "header") expect(r.now).toBeGreaterThanOrEqual(line.t);
      },
    });
    expect(report.ok).toBe(true);
    expect(seen).toEqual(rec.lines);
    expect(applied).toBe(4);
  });

  test("onCheckpoint sees the engine exactly in each checkpoint state", () => {
    const rec = sample();
    const hours: number[] = [];
    const ckpts = new Map(
      rec.lines.flatMap((l) => (l.k === "ckpt" ? [[l.hour, l.h] as const] : [])),
    );
    verify(rec.lines, {
      onCheckpoint: (hour, r) => {
        hours.push(hour);
        expect(r.now).toBe(hour * 3600);
        expect(ckpts.has(hour)).toBe(true);
      },
    });
    expect(hours).toEqual([...ckpts.keys()]);
  });

  test("resumes from a snapshot right after the ckpt line of its hour", () => {
    const rec = sample();
    const snap = rec.snapshots.find((s) => s.hour === 8);
    if (snap === undefined) throw new Error("no snapshot at hour 8");
    const ckptIndex = rec.lines.findIndex((l) => l.k === "ckpt" && l.hour === 8);
    const seen: LogLine[] = [];
    const report = verify(rec.lines, { from: snap, onLine: (l) => seen.push(l) });
    expect(report.ok).toBe(true);
    expect(report.finalHash).toBe(verify(rec.lines).finalHash);
    expect(seen).toEqual(rec.lines.slice(ckptIndex + 1));
    expect(report.actions).toBe(1);

    const wrong = structuredClone(snap);
    wrong.afterN += 1;
    expect(verify(rec.lines, { from: wrong }).divergence).toMatchObject({
      kind: "snapshot",
      hour: 8,
    });
    const lines = cloneLines(rec.lines);
    const ck = lines[ckptIndex];
    if (ck?.k === "ckpt") ck.h = "0123456789abcdef";
    expect(verify(lines, { from: snap }).divergence).toMatchObject({ kind: "snapshot", hour: 8 });
    const final = rec.snapshots.at(-1);
    if (final === undefined) throw new Error("no final snapshot");
    expect(verify(rec.lines, { from: final }).divergence?.kind).toBe("snapshot");
  });

  test("a rules divergence is reported before replaying", () => {
    const rec = sample();
    const changed: Ruleset<FixtureConfig, FixtureExt> = {
      ...fixtureRuleset,
      compile: (c, n) => {
        const rules = fixtureRuleset.compile(c, n);
        return { ...rules, levels: { ...rules.levels, storage: [600, 1000, 2000, 5000] } };
      },
    };
    const seen: LogLine[] = [];
    const report = verifyLog(rec.lines, () => changed, fakeDomain, { onLine: (l) => seen.push(l) });
    expect(report.divergence).toMatchObject({ kind: "rules", t: 0 });
    expect(report.divergence?.actual).toContain(
      "the compiled tables differ for fixture-1@1.0.0 under the same config",
    );
    expect(report.actions).toBe(0);
    expect(seen).toEqual([]);
  });

  test("header, config and initial divergences", () => {
    const rec = sample();
    expect(verifyLog(rec.lines, () => undefined, fakeDomain).divergence).toMatchObject({
      kind: "header",
      actual: "fixture-1@1.0.0 is not in this build",
    });
    expect(verify(rec.lines.slice(1)).divergence?.kind).toBe("header");
    expect(verify([]).divergence?.kind).toBe("header");
    const config = cloneLines(rec.lines);
    const header = config[0];
    if (header?.k === "header") header.config["start"] = { stock: 1, soldiers: 1 };
    expect(verify(config).divergence?.kind).toBe("config");
    const initial = cloneLines(rec.lines);
    const h2 = initial[0];
    if (h2?.k === "header") h2.initialHash = "0123456789abcdef";
    expect(verify(initial).divergence).toMatchObject({
      kind: "initial",
      expected: "0123456789abcdef",
    });
    const version = cloneLines(rec.lines);
    const h3 = version[0];
    if (h3?.k === "header") h3.engine = "0.0.9";
    const warned = verify(version);
    expect(warned.ok).toBe(true);
    expect(warned.warnings[0]).toContain("engine 0.0.9");
  });

  test("a missing ev or ckpt line, a truncated log, a fatal line and a line after the end are divergences", () => {
    const rec = sample();
    const evIndex = rec.lines.findIndex((l) => l.k === "ev" && l.e.type === "fixture_opened");
    const noEv = cloneLines(rec.lines).filter((_, i) => i !== evIndex);
    expect(verify(noEv).divergence).toMatchObject({
      kind: "event",
      t: 7200,
      expected: "the ckpt line of hour 2",
    });
    expect(verify(noEv, { compareEvents: false }).ok).toBe(true);
    const ckIndex = rec.lines.findIndex((l) => l.k === "ckpt" && l.hour === 3);
    const noCk = cloneLines(rec.lines).filter((_, i) => i !== ckIndex);
    expect(verify(noCk).divergence).toMatchObject({ kind: "checkpoint", hour: 3 });
    const truncated = cloneLines(rec.lines).slice(0, -1);
    expect(verify(truncated).divergence).toMatchObject({ kind: "end", expected: "an end line" });
    const fatal = cloneLines(rec.lines).slice(0, -1);
    fatal.push({ k: "fatal", t: 86400, error: { kind: "agent", message: "boom" } });
    expect(verify(fatal).divergence?.actual).toContain("a fatal line (agent): boom");
    const extra = cloneLines(rec.lines);
    extra.push({ k: "defer", t: 86400, seat: "p1", to: 86401 });
    expect(verify(extra).divergence).toMatchObject({ kind: "order" });
    const result = cloneLines(rec.lines);
    const end = result.at(-1);
    if (end?.k === "end") end.result.reason = "domination";
    expect(verify(result).divergence).toMatchObject({ kind: "result", t: 86400 });
    const final = cloneLines(rec.lines);
    const end2 = final.at(-1);
    if (end2?.k === "end") end2.h = "0123456789abcdef";
    expect(verify(final).divergence).toMatchObject({ kind: "end", expected: "0123456789abcdef" });
  });

  test("time going backwards and repeated n are order divergences", () => {
    const rec = sample();
    const late = cloneLines(rec.lines);
    const lastAct = late.findLastIndex((l) => l.k === "act");
    const act = late[lastAct];
    if (act?.k === "act") late.splice(lastAct + 1, 0, { ...act, t: 0, n: act.n + 1 });
    expect(verify(late).divergence).toMatchObject({ kind: "order" });
    const dup = cloneLines(rec.lines);
    const firstAct = dup.findIndex((l) => l.k === "act");
    const a = dup[firstAct];
    if (a?.k === "act") dup.splice(firstAct + 1, 0, { ...a });
    expect(verify(dup).divergence).toMatchObject({ kind: "order", n: a?.k === "act" ? a.n : -1 });
  });

  test("a non-integer number in any line is a divergence, never a thrown error", () => {
    const rec = sample();
    const tampered = (edit: (lines: LogLine[]) => void): ReplayDivergence | undefined => {
      const lines = cloneLines(rec.lines);
      edit(lines);
      const report = verify(lines);
      expect(report.ok).toBe(false);
      return report.divergence;
    };

    const config = tampered((l) => void (headerOf(l).config["extra"] = 1.5));
    expect(config).toMatchObject({
      kind: "config",
      t: 0,
      expected: "the header's config in canonical JSON",
    });
    expect(config?.actual).toContain("1.5 is not a safe integer at $.extra");
    const override = tampered((l) => void (headerOf(l).setup.overrides["time.travel"] = 5400.5));
    expect(override).toMatchObject({ kind: "config", t: 0 });

    const act = rec.lines[firstActIndex(rec.lines)];
    if (act?.k !== "act") throw new Error("no act line");
    const action = tampered((l) => {
      const line = l[firstActIndex(l)];
      if (line?.k === "act") {
        line.a = { type: "attack", from: "c1", to: "c2", units: { soldier: 0.5 } };
      }
    });
    expect(action).toMatchObject({ kind: "result", t: act.t, n: act.n });
    expect(action?.actual).toContain("EngineMisuse");
    const event = tampered((l) => {
      const ev = l[firstActIndex(l) + 1];
      if (ev?.k === "ev") ev.e.data["x"] = 1.5;
    });
    expect(event).toMatchObject({ kind: "event", t: act.t, n: act.n });
    expect(event?.actual).toContain("1.5 is not a safe integer at $.data.x");
    const result = tampered((l) => {
      const end = l.at(-1);
      const row = end?.k === "end" ? end.result.standings[0] : undefined;
      if (row !== undefined) row.score = 0.5;
    });
    expect(result).toMatchObject({
      kind: "result",
      t: 86400,
      expected: "the end line's result in canonical JSON",
    });

    const snap = rec.snapshots.find((s) => s.hour === 8);
    if (snap === undefined) throw new Error("no snapshot at hour 8");
    const odd = structuredClone(snap);
    odd.setup.overrides["x"] = 0.5;
    expect(verify(rec.lines, { from: odd }).divergence).toMatchObject({
      kind: "snapshot",
      expected: "the snapshot's setup in canonical JSON",
    });
  });

  test("an ev line the engine did not produce is attributed to the act line it follows", () => {
    const lines = cloneLines(sample().lines);
    const i = lines.findIndex((l) => l.k === "act" && l.a.type === "attack");
    const act = lines[i];
    const ev = lines[i + 1];
    if (act?.k !== "act" || ev?.k !== "ev") throw new Error("no attack followed by its event");
    lines.splice(i + 2, 0, structuredClone(ev));
    expect(verify(lines).divergence).toMatchObject({
      kind: "event",
      t: act.t,
      n: act.n,
      actual: "no event",
    });
  });

  test("an engine error while replaying is a divergence; a callback's error propagates", () => {
    const rec = sample();
    const failing: Ruleset<FixtureConfig, FixtureExt> = {
      ...fixtureRuleset,
      hooks: {
        ...fixtureRuleset.hooks,
        on: {
          fixture_open: () => {
            throw new RangeError("bad maths");
          },
        },
      },
    };
    const d = verifyLog(rec.lines, () => failing, fakeDomain).divergence;
    expect(d).toMatchObject({ kind: "event", t: 7200, expected: "no engine error" });
    expect(d?.actual).toContain("fixture_open handler threw RangeError: bad maths");
    expect(() => verify(rec.lines, { onCheckpoint: pacingBug })).toThrow(TypeError);
    expect(() => verify(rec.lines, { onCheckpoint: pacingBug })).toThrow("pacing bug");
    expect(() => verify(rec.lines, { onLine: foldBug })).toThrow(RangeError);
  });
});

function headerOf(lines: readonly LogLine[]): HeaderLine {
  const h = lines[0];
  if (h?.k !== "header") throw new Error("no header");
  return h;
}

function firstActIndex(lines: readonly LogLine[]): number {
  return lines.findIndex((l) => l.k === "act");
}

function pacingBug(): void {
  throw new TypeError("pacing bug");
}

function foldBug(): void {
  throw new RangeError("fold bug");
}

/** A state's canonical JSON without its `now`. */
function withoutNow(state: string): string {
  return state.replace(/"now":[0-9]+/, "");
}

function pushAll(replay: Replay, lines: readonly LogLine[]): ReplayStep[] {
  return lines.slice(1).map((l) => replay.push(l));
}

describe("createReplay", () => {
  test("pushing every line gives verifyLog's report and onLine sequence, whatever is read in between", () => {
    fc.assert(
      fc.property(runArb, fc.array(fc.nat({ max: 3 }), { maxLength: 400 }), (run, reads) => {
        const rec = record(run.seed, run.players, run.steps);
        const seenA: string[] = [];
        const seenB: string[] = [];
        const expected = verifyLog(rec.lines, resolve, fakeDomain, {
          onLine: (l, r, a) => seenA.push(canonicalJson({ l, now: r.now, a: a?.ok ?? null })),
        });
        const replay = createReplay(headerOf(rec.lines), resolve, fakeDomain, {
          onLine: (l, r, a) => seenB.push(canonicalJson({ l, now: r.now, a: a?.ok ?? null })),
        });
        for (const [i, line] of rec.lines.slice(1).entries()) {
          const step = replay.push(line);
          expect(step.ok).toBe(true);
          if (line.k === "act") expect(step.applied?.ok).toBe(line.r.ok);
          else expect(step.applied).toBeUndefined();
          // Reading in between changes nothing.
          const what = reads[i] ?? 0;
          if (what === 1) replay.read();
          if (what === 2) expect(replay.finish({ requireEnd: false }).ok).toBe(true);
        }
        expect(replay.ended).toBe(true);
        expect(replay.lines).toBe(rec.lines.length);
        expect(canonicalJson(replay.finish())).toBe(canonicalJson(expected));
        expect(seenB).toEqual(seenA);
      }),
      { numRuns: SLOW ? 40 : 15 },
    );
  });

  test("every prefix of a log being written holds up without an end line; finish() latches the end divergence", () => {
    fc.assert(
      fc.property(runArb, fc.nat(), (run, cut) => {
        const rec = record(run.seed, run.players, run.steps);
        const n = 1 + (cut % rec.lines.length);
        const replay = createReplay(headerOf(rec.lines), resolve, fakeDomain);
        const steps = pushAll(replay, rec.lines.slice(0, n));
        expect(steps.every((s) => s.ok)).toBe(true);
        const live = replay.finish({ requireEnd: false });
        expect(live.ok).toBe(true);
        expect(live.divergence).toBeUndefined();
        if (n < rec.lines.length) {
          const report = replay.finish();
          expect(report.ok).toBe(false);
          expect(report.divergence?.kind).toBe("end");
          expect(replay.push(rec.lines[n] ?? rec.lines[0]!).ok).toBe(false);
        }
      }),
      { numRuns: SLOW ? 40 : 15 },
    );
  });

  test("changed: every applied act and every line where scheduled events ran; never a line that only reads", () => {
    fc.assert(
      fc.property(runArb, (run) => {
        const rec = record(run.seed, run.players, run.steps);
        const replay = createReplay(headerOf(rec.lines), resolve, fakeDomain);
        let prevT = 0;
        for (const line of rec.lines.slice(1)) {
          if (line.k === "header") continue;
          const before = canonicalJson(replay.read().state);
          const step = replay.push(line);
          const after = canonicalJson(replay.read().state);
          if (step.applied?.ok === true) expect(step.changed).toBe(true);
          if (step.events.length > 0) expect(step.changed).toBe(true);
          if (line.k === "obs" || line.k === "gw" || line.k === "note" || line.k === "turn") {
            if (line.t === prevT) expect(step.changed).toBe(false);
          }
          // A line that changed nothing but the time leaves the state as it was, `now` aside.
          if (!step.changed) expect(withoutNow(after)).toBe(withoutNow(before));
          prevT = line.t;
        }
      }),
      { numRuns: SLOW ? 30 : 12 },
    );
  });

  test("the events of a push are those of the ev lines from that line on", () => {
    const rec = sample();
    const replay = createReplay(headerOf(rec.lines), resolve, fakeDomain);
    const queued: string[] = [];
    for (const line of rec.lines.slice(1)) {
      const step = replay.push(line);
      queued.push(...step.events.map((e) => canonicalJson(e)));
      if (line.k === "ev") expect(canonicalJson(line.e)).toBe(queued.shift() ?? "none");
    }
    expect(queued).toEqual([]);
  });

  test("a snapshot taken right after a ckpt line resumes a later replay of the same log", () => {
    const rec = sample();
    const replay = createReplay(headerOf(rec.lines), resolve, fakeDomain);
    const header = headerOf(rec.lines);
    expect(canonicalJson(replay.snapshot().state)).toBe(
      canonicalJson(createReplay(header, resolve, fakeDomain).snapshot().state),
    );
    let snap = null;
    let at = -1;
    for (const [i, line] of rec.lines.slice(1).entries()) {
      replay.push(line);
      if (line.k === "ckpt" && line.hour === 5) {
        snap = replay.snapshot();
        at = i + 1;
      } else if (line.k !== "ckpt") {
        expect(() => replay.snapshot()).toThrow(EngineMisuse);
      }
    }
    if (snap === null) throw new Error("no ckpt line of hour 5");
    const seen: LogLine[] = [];
    const resumed = createReplay(header, resolve, fakeDomain, {
      from: snap,
      onLine: (l) => seen.push(l),
    });
    pushAll(resumed, rec.lines);
    expect(seen).toEqual(rec.lines.slice(at + 1));
    expect(resumed.finish().finalHash).toBe(replay.finish().finalHash);
  });

  test("a bad header starts the replay diverged: no push replays, read throws, the report names it", () => {
    const rec = sample();
    const header = structuredClone(headerOf(rec.lines));
    header.initialHash = "0123456789abcdef";
    const replay = createReplay(header, resolve, fakeDomain);
    expect(replay.divergence?.kind).toBe("initial");
    expect(replay.push(rec.lines[1] ?? header)).toEqual({ ok: false, changed: false, events: [] });
    const unknown = createReplay(headerOf(rec.lines), () => undefined, fakeDomain);
    expect(unknown.divergence?.kind).toBe("header");
    expect(() => unknown.read()).toThrow(EngineMisuse);
    expect(unknown.finish().divergence?.kind).toBe("header");
  });
});

describe("createReplay on perfidia-1@1.1.0", () => {
  test("the silent domination_open timer is a change at the line that crosses dominationStart", () => {
    const ruleset = findRuleset("perfidia-1@1.1.0");
    if (ruleset === undefined) throw new Error("no perfidia-1@1.1.0");
    const setup = {
      ruleset: ruleset.ref,
      overrides: {},
      seed: 5,
      idKey: idKeyFromSeed(5),
      seats: [1, 2, 3, 4, 5, 6].map((i) => ({ id: `p${i}` as const })),
    };
    const rec = new LogRecorder(createMatch(setup, ruleset, domain, { invariants: "off" }));
    const start = rec.match.rules.time.matchEnd > 259200 ? 259200 : 0;
    rec.advanceTo(start + 7200);
    const replay = createReplay(headerOf(rec.lines), () => ruleset, domain, {
      invariants: "off",
    });
    const open = (): boolean => {
      const ext: unknown = replay.read().ext();
      const d: unknown =
        ext !== null && typeof ext === "object" ? Reflect.get(ext, "domination") : null;
      return d !== null && typeof d === "object" && Reflect.get(d, "open") === true;
    };
    let flipped: { line: LogLine; step: ReplayStep } | null = null;
    for (const line of rec.lines.slice(1)) {
      const was = open();
      const step = replay.push(line);
      expect(step.ok).toBe(true);
      if (!was && open()) flipped = { line, step };
      else if (line.k === "ckpt" && step.events.length === 0) expect(step.changed).toBe(false);
    }
    expect(flipped?.line).toMatchObject({ k: "ckpt", t: 259200 });
    expect(flipped?.step.events).toEqual([]);
    expect(flipped?.step.changed).toBe(true);
    const applied: ApplyOutput | undefined = flipped?.step.applied;
    expect(applied).toBeUndefined();
  });
});
