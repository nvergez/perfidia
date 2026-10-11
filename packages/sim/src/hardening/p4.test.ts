// P4 at scale (docs/architecture.md §13.2), for both rulesets: from a staged start of up to 12
// seats (the maximum), random sequences of hundreds of action intents by every seat, resolved
// against the current state so most are valid, plus junk, interleaved with random time advances to
// the end of a game day, never throw (except `EngineMisuse` on purpose, which changes nothing) and
// keep every step invariant. The intents reach alliances between pact partners (the pact ends as
// superseded) and recalls from cities holding the seat's groups from several homes. And through the
// gateway at the maximum of 12 seats: the four bots with chaos agents on a third of the seats,
// under step invariants, lockstep and real time with `VirtualTime`, end without a fatal line or an
// INTERNAL result and replay at Level E.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { sortedIds } from "@perfidia/engine";
import { randInt, streamRng } from "@perfidia/engine/core";
import { EngineMisuse, type Match } from "@perfidia/engine/kernel";
import { ChaosAgent, MemorySink } from "@perfidia/gateway";
import type { Json, PlayerId, SeatAgent } from "@perfidia/protocol";
import { prepareBotRun, runPrepared } from "../harness/index.ts";
import { LOCKSTEP, REFS, VIRTUAL, daySpec, levelE, rulesetOf, type Ref } from "./kit.ts";
import { intent, percent, pick, stagedStart } from "./intents.ts";

interface Tally {
  accepted: Record<string, number>;
  rejected: number;
  misuse: number;
  superseded: number;
  multiRecall: number;
  steps: number;
  /** Emitted events by type. */
  events: Record<string, number>;
}

function count(tally: Tally, events: readonly { type: string }[]): void {
  for (const e of events) tally.events[e.type] = (tally.events[e.type] ?? 0) + 1;
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

/** One random run: `steps` intents and advances on `match`, to the end of the match. */
function randomRun(match: Match, seed: number, steps: number, tally: Tally): void {
  const rng = streamRng(seed, "p4");
  const end = match.rules.time.matchEnd;
  for (let i = 0; i < steps && !match.ended; i += 1) {
    tally.steps += 1;
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
    const a = intent(r, seat, rng);
    const multi =
      a.type === "recall_stationed" &&
      new Set(r.state.cities[a.at]?.stationed.filter((g) => g.owner === seat).map((g) => g.home))
        .size > 1;
    const before = match.hash();
    const out = match.apply(seat, a);
    if (out.ok) {
      count(tally, out.events);
      tally.accepted[a.type] = (tally.accepted[a.type] ?? 0) + 1;
      if (multi) tally.multiRecall += 1;
      tally.superseded += out.events.filter(
        (e) => e.type === "pact_ended" && e.data["cause"] === "superseded",
      ).length;
    } else {
      tally.rejected += 1;
      expect(match.hash()).toBe(before);
    }
    // Keep answering: a pending proposal to someone gets answered soon, as agents would.
    if (percent(rng, 30)) {
      const open = sortedIds(match.read().state.proposals);
      const q = pick(rng, open);
      const p = q === undefined ? undefined : match.read().state.proposals[q];
      if (q !== undefined && p !== undefined) {
        const ans = match.apply(p.to, { type: "answer", proposal: q, accept: percent(rng, 85) });
        if (ans.ok) {
          tally.accepted["answer"] = (tally.accepted["answer"] ?? 0) + 1;
          tally.superseded += ans.events.filter(
            (e) => e.type === "pact_ended" && e.data["cause"] === "superseded",
          ).length;
        }
      }
    }
  }
  if (!match.ended) count(tally, match.advanceTo(end).events);
  expect(match.ended).toBe(true);
  expect(match.result).not.toBeNull();
  match.checkInvariants("step");
}

/**
 * Configs to run: the defaults, and for perfidia-1 time-compressing overrides (numbers only, so the
 * code paths are the defaults'), so that one game day reaches battles, sieges, conquests of
 * capitals and the domination evaluation.
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

describe("P4 at scale: random intents and time advances", () => {
  for (const ref of REFS) {
    test(`${ref}: 6 to 12 seats, hundreds of steps, step invariants`, () => {
      const ruleset = rulesetOf(ref);
      const tally: Tally = {
        accepted: {},
        rejected: 0,
        misuse: 0,
        superseded: 0,
        multiRecall: 0,
        steps: 0,
        events: {},
      };
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.integer({ min: 6, max: 12 }),
          fc.integer({ min: 300, max: 900 }),
          fc.constantFrom(...CONFIGS[ref]),
          fc.integer({ min: 0, max: 3 }),
          (seed, players, steps, overrides, levels) => {
            const match = stagedStart(ruleset, seed, players, { overrides, levels });
            randomRun(match, seed, steps, tally);
          },
        ),
        { numRuns: 10, examples: [[7, 12, 900, CONFIGS[ref].at(-1) ?? {}, 3]] },
      );
      // The runs reached the mechanics P4 names, and were mostly valid.
      for (const type of ["build", "recruit", "attack", "support", "recall_stationed", "propose"]) {
        expect([type, (tally.accepted[type] ?? 0) > 0]).toEqual([type, true]);
      }
      expect(tally.accepted["answer"] ?? 0).toBeGreaterThan(10);
      expect(tally.superseded).toBeGreaterThan(0);
      expect(tally.multiRecall).toBeGreaterThan(0);
      expect(tally.misuse).toBeGreaterThan(0);
      expect(tally.events["battle"] ?? 0).toBeGreaterThan(0);
      expect(tally.events["shipment_delivered"] ?? 0).toBeGreaterThan(0);
      const accepted = Object.values(tally.accepted).reduce((a, b) => a + b, 0);
      expect(accepted).toBeGreaterThan(tally.steps / 5);
    }, 60000);
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
