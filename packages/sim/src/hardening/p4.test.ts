// P4 at scale (docs/architecture.md §13.2), for both rulesets: from a staged start of up to 12
// seats (the maximum), random sequences of hundreds of action intents by every seat, resolved
// against the current state so most are valid, plus near misses and junk, interleaved with random
// time advances to the end of a game day, never throw (except `EngineMisuse` on purpose, which
// changes nothing) and keep every step invariant. Every intent kind the ruleset allows is accepted
// at least once, and more than three intents in four are accepted; the near misses and junk are
// rejected with the state unchanged. The intents reach alliances between pact partners (the pact
// ends as superseded), recalls from cities holding the seat's groups from several homes, and, under
// perfidia-1's time-compressing overrides, sieges, conquests and eliminations. And through the
// gateway at the maximum of 12 seats: the four bots with chaos agents on a third of the seats,
// under step invariants, lockstep and real time with `VirtualTime`, end without a fatal line or an
// INTERNAL result and replay at Level E.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { sortedIds } from "@perfidia/engine";
import { canonicalJson, randInt, streamRng } from "@perfidia/engine/core";
import { EngineMisuse, type Match } from "@perfidia/engine/kernel";
import { ChaosAgent, MemorySink } from "@perfidia/gateway";
import type { Action, Json, PlayerId, SeatAgent } from "@perfidia/protocol";
import { prepareBotRun, runPrepared } from "../harness/index.ts";
import { LOCKSTEP, REFS, VIRTUAL, daySpec, levelE, rulesetOf, type Ref } from "./kit.ts";
import {
  FAILING_KINDS,
  drawIntent,
  percent,
  pick,
  possibleKinds,
  resolveIntent,
  stagedStart,
  type IntentKind,
} from "./intents.ts";

interface Tally {
  attempted: Record<string, number>;
  accepted: Record<string, number>;
  /** Rejection codes by intent kind (shown when an assertion fails). */
  codes: Record<string, Record<string, number>>;
  misuse: number;
  superseded: number;
  multiRecall: number;
  /** Emitted events by type. */
  events: Record<string, number>;
}

const newTally = (): Tally => ({
  attempted: {},
  accepted: {},
  codes: {},
  misuse: 0,
  superseded: 0,
  multiRecall: 0,
  events: {},
});

const add = (rec: Record<string, number>, key: string, n = 1): void => {
  rec[key] = (rec[key] ?? 0) + n;
};

function count(tally: Tally, events: readonly { type: string }[]): void {
  for (const e of events) add(tally.events, e.type);
}

function throwsMisuse(fn: () => unknown): boolean {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineMisuse) return true;
    throw e;
  }
  return false;
}

/** Applies `seat`'s intent of `kind`, tallies it; a rejection must leave the hash unchanged. */
function submit(match: Match, tally: Tally, seat: PlayerId, kind: IntentKind, a: Action): void {
  const r = match.read();
  const multi =
    a.type === "recall_stationed" &&
    new Set(r.state.cities[a.at]?.stationed.filter((g) => g.owner === seat).map((g) => g.home))
      .size > 1;
  const before = match.hash();
  const out = match.apply(seat, a);
  add(tally.attempted, kind);
  if (out.ok) {
    count(tally, out.events);
    add(tally.accepted, kind);
    if (multi) tally.multiRecall += 1;
    tally.superseded += out.events.filter(
      (e) => e.type === "pact_ended" && e.data["cause"] === "superseded",
    ).length;
  } else {
    add((tally.codes[kind] ??= {}), out.violation.code);
    expect(match.hash()).toBe(before);
  }
}

/** One random run: `steps` intents and advances on `match`, to the end of the match. */
function randomRun(match: Match, seed: number, steps: number, tally: Tally): void {
  const rng = streamRng(seed, "p4");
  const end = match.rules.time.matchEnd;
  for (let i = 0; i < steps && !match.ended; i += 1) {
    const roll = randInt(rng, 0, 99);
    if (roll < 12) {
      // A time advance: to the next event, a little, or a lot.
      const next = match.nextEventTime() ?? end;
      const choice = randInt(rng, 0, 2);
      const t =
        choice === 0
          ? next
          : choice === 1
            ? match.now + randInt(rng, 1, 600)
            : match.now + randInt(rng, 600, 3600);
      count(tally, match.advanceTo(Math.min(t, end)).events);
      continue;
    }
    if (roll < 14) {
      // EngineMisuse on purpose: time going backwards, and an action by a seat that does not exist.
      const before = match.hash();
      if (match.now > 0) expect(throwsMisuse(() => match.advanceTo(match.now - 1))).toBe(true);
      expect(throwsMisuse(() => match.apply("p99", { type: "leave", with: null }))).toBe(true);
      expect(match.hash()).toBe(before);
      tally.misuse += 1;
      continue;
    }
    const r = match.read();
    const alive = sortedIds(r.state.players).filter((p) => r.state.players[p]?.alive === true);
    const seat = pick(rng, alive);
    if (seat === undefined) break;
    const { kind, action } = drawIntent(r, seat, rng);
    submit(match, tally, seat, kind, action);
    // Keep answering: a pending proposal gets answered soon by its recipient, as agents would.
    if (percent(rng, 30)) {
      const q = pick(rng, sortedIds(match.read().state.proposals));
      const to = q === undefined ? undefined : match.read().state.proposals[q]?.to;
      const answer = to === undefined ? null : resolveIntent("answer", match.read(), to, rng);
      if (to !== undefined && answer !== null) submit(match, tally, to, "answer", answer);
    }
  }
  if (!match.ended) count(tally, match.advanceTo(end).events);
  expect(match.ended).toBe(true);
  expect(match.result).not.toBeNull();
  match.checkInvariants("step");
}

/**
 * Configs to run: the defaults, and for perfidia-1 time-compressing overrides (numbers only, so the
 * code paths are the defaults'): attacks from the start, capitals besiegeable after one hour,
 * sieges of one hour and the domination timer at two hours, so that one game day reaches sieges,
 * conquests of capitals and eliminations (asserted below).
 */
const CONFIGS: Readonly<Record<Ref, readonly Readonly<Record<string, Json>>[]>> = {
  "perfidia-1@1.0.0": [
    {},
    {
      "time.protectionEnd": 0,
      "time.capitalImmunityEnd": 3600,
      "time.siegeDuration": 3600,
      "time.dominationStart": 7200,
    },
  ],
  "sandbox-1@1.0.0": [{}],
};

const sum = (rec: Record<string, number>, keys: readonly string[]): number =>
  keys.reduce((n, k) => n + (rec[k] ?? 0), 0);

describe("P4 at scale: random intents and time advances", () => {
  for (const ref of REFS) {
    test(`${ref}: 6 to 12 seats, hundreds of steps, step invariants`, () => {
      const ruleset = rulesetOf(ref);
      const configs = CONFIGS[ref];
      const last = configs.length - 1;
      const tallies = configs.map(newTally);
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.integer({ min: 6, max: 12 }),
          fc.integer({ min: 300, max: 900 }),
          fc.integer({ min: 0, max: last }),
          fc.integer({ min: 0, max: 3 }),
          (seed, players, steps, config, levels) => {
            const overrides = configs[config] ?? {};
            const match = stagedStart(ruleset, seed, players, { overrides, levels });
            randomRun(match, seed, steps, tallies[config] ?? newTally());
          },
        ),
        { numRuns: 10, examples: [[7, 12, 900, last, 3]] },
      );
      const all = newTally();
      for (const t of tallies) {
        for (const [k, n] of Object.entries(t.attempted)) add(all.attempted, k, n);
        for (const [k, n] of Object.entries(t.accepted)) add(all.accepted, k, n);
        for (const [k, n] of Object.entries(t.events)) add(all.events, k, n);
        all.misuse += t.misuse;
        all.superseded += t.superseded;
        all.multiRecall += t.multiRecall;
      }
      const why = canonicalJson(tallies.map((t) => t.codes));

      // Every kind the ruleset allows was accepted at least once.
      const rules = stagedStart(ruleset, 1, 6).rules;
      for (const kind of possibleKinds(rules, ruleset)) {
        expect([kind, (all.accepted[kind] ?? 0) > 0, why]).toEqual([kind, true, why]);
      }
      // Most intents are valid: more than three in four of all of them, failing kinds included,
      // and nearly every resolved one; the failing kinds never pass.
      const kinds = Object.keys(all.attempted);
      const resolved = kinds.filter((k) => !FAILING_KINDS.some((f) => f === k));
      const attempted = sum(all.attempted, kinds);
      expect(sum(all.accepted, kinds) * 4).toBeGreaterThan(attempted * 3);
      expect(sum(all.accepted, resolved) * 100).toBeGreaterThan(sum(all.attempted, resolved) * 95);
      expect(sum(all.accepted, FAILING_KINDS)).toBe(0);
      expect(sum(all.attempted, FAILING_KINDS) * 10).toBeGreaterThan(attempted);

      expect(all.superseded).toBeGreaterThan(0);
      expect(all.multiRecall).toBeGreaterThan(0);
      expect(all.misuse).toBeGreaterThan(0);
      expect(all.events["battle"] ?? 0).toBeGreaterThan(0);
      expect(all.events["shipment_delivered"] ?? 0).toBeGreaterThan(0);
      expect(all.events["city_founded"] ?? 0).toBeGreaterThan(0);
      expect(all.events["city_conquered"] ?? 0).toBeGreaterThan(0);
      if (ref === "perfidia-1@1.0.0") {
        // The compressed config (the explicit example among its runs) reaches the late game.
        const late = tallies[last]?.events ?? {};
        for (const type of ["siege_started", "city_conquered", "player_eliminated"]) {
          expect([type, (late[type] ?? 0) > 0]).toEqual([type, true]);
        }
      }
    }, 90000);
  }
});

describe("P4 at scale through the gateway: 12 seats, bots and chaos agents", () => {
  for (const ref of REFS) {
    for (const clock of [LOCKSTEP, VIRTUAL]) {
      test(`${ref}, ${clock.kind}: no fatal, no INTERNAL, step invariants, Level E`, async () => {
        const prepared = prepareBotRun({
          ...daySpec(ref, clock, 29, { players: 12 }),
          invariants: "step",
        });
        const agents = new Map<PlayerId, SeatAgent>(prepared.options.agents);
        for (const seat of ["p3", "p6", "p9", "p12"] as const) {
          agents.set(seat, new ChaosAgent({ seat, seed: 101 + seat.length }));
        }
        const sink = new MemorySink();
        await runPrepared({ ...prepared, options: { ...prepared.options, agents } }, sink);
        const lines = sink.parsed();
        expect(lines.some((l) => l.k === "fatal")).toBe(false);
        expect(lines.at(-1)?.k).toBe("end");
        expect(lines.filter((l) => l.k === "gw" && l.r.code === "INTERNAL")).toEqual([]);
        expect(lines.filter((l) => l.k === "act").length).toBeGreaterThan(200);
        expect(levelE(lines).ok).toBe(true);
      }, 30000);
    }
  }
});
