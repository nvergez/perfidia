// P16 at match scale (docs/architecture.md §6.6, §13.2), through the harness for both rulesets,
// under lockstep and real time with `VirtualTime`: the default bots play 1-game-day matches while
// every object the gateway hands them (round inputs: briefings and tool results) is vandalised once
// the bot has read its own copy, and again a round later; and the log sink vandalises every line and
// snapshot it receives once it has stored them. The log, the snapshots, the final hash, the final
// gateway state and every seat's inputs are byte-identical to the same match without vandalism, and
// both logs pass Level E.

import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@perfidia/engine/core";
import { MemorySink, copyOf, type GatewayState, type LogSink } from "@perfidia/gateway";
import type { LogLine, PlayerId, RoundInput, SeatAgent, Snapshot } from "@perfidia/protocol";
import { normalisedText, prepareBotRun, runPrepared, type ClockChoice } from "../harness/index.ts";
import { LOCKSTEP, REFS, VIRTUAL, daySpec, levelE } from "./kit.ts";

/**
 * The slow suite only (`PERFIDIA_SLOW=1`: `bun run test:slow`, run by `bun run test:exit`; docs/
 * architecture.md §13.8), on every ruleset of `REFS` under both clocks; the default suite has P16
 * with the chaos agent (`gateway/src/runtime/chaos.test.ts`).
 */
const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Changes every value reachable from `value` in place (frozen objects are left alone). */
function vandalise(value: unknown, depth = 0): void {
  if (value === null || typeof value !== "object" || depth > 64) return;
  if (Object.isFrozen(value)) return;
  if (Array.isArray(value)) {
    for (const v of value) vandalise(v, depth + 1);
    value.reverse();
    value.push({ vandal: true }, 31337);
    return;
  }
  if (!isRecord(value)) return;
  const record = value;
  for (const [k, v] of Object.entries(record)) {
    vandalise(v, depth + 1);
    if (typeof v === "number") record[k] = v + 7919;
    else if (typeof v === "string") record[k] = `${v}!`;
    else if (typeof v === "boolean") record[k] = !v;
    else if (v === null) record[k] = { vandal: true };
  }
  const first = Object.keys(record)[0];
  if (first !== undefined) delete record[first];
  record["vandal"] = [1, 2, 3];
}

/** `agent` playing on its own copy of each input; the gateway's input is vandalised afterwards. */
function vandal(agent: SeatAgent, seen: string[], destroy: boolean): SeatAgent {
  let previous: RoundInput | null = null;
  return {
    label: agent.label,
    async round(input: RoundInput) {
      seen.push(canonicalJson(input));
      const own = copyOf(input);
      const out = await agent.round(own);
      if (destroy) {
        if (previous !== null) vandalise(previous);
        vandalise(input);
        previous = input;
      }
      return out;
    },
  };
}

/** A memory sink that vandalises every line and snapshot after storing it. */
function vandalSink(inner: MemorySink): LogSink {
  return {
    write(line: LogLine) {
      inner.write(line);
      vandalise(line);
    },
    snapshot(snap: Snapshot) {
      inner.snapshot(snap);
      vandalise(snap);
    },
  };
}

interface Outcome {
  log: string;
  /** The stored log passes Level E (§13.4). */
  levelE: boolean;
  snapshots: string[];
  hash: string;
  gateway: GatewayState;
  inputs: Record<string, string[]>;
}

async function play(ref: string, clock: ClockChoice, destroy: boolean): Promise<Outcome> {
  const prepared = prepareBotRun({ ...daySpec(ref, clock, 13), snapshotEvery: 6 });
  const inputs: Record<string, string[]> = {};
  const agents = new Map<PlayerId, SeatAgent>(
    [...prepared.options.agents].map(([seat, agent]) => {
      const seen: string[] = [];
      inputs[seat] = seen;
      return [seat, vandal(agent, seen, destroy)];
    }),
  );
  const memory = new MemorySink();
  const sink = destroy ? vandalSink(memory) : memory;
  const run = await runPrepared({ ...prepared, options: { ...prepared.options, agents } }, sink);
  const lines = memory.parsed();
  return {
    log: normalisedText(lines),
    levelE: levelE(lines).ok,
    snapshots: [...memory.snapshots],
    hash: run.finalHash,
    gateway: run.gateway,
    inputs,
  };
}

describe("P16 at match scale: vandalising what the gateway hands out changes nothing", () => {
  for (const ref of REFS) {
    for (const clock of [LOCKSTEP, VIRTUAL]) {
      xtest(`${ref}, ${clock.kind}`, async () => {
        const clean = await play(ref, clock, false);
        const vandalised = await play(ref, clock, true);
        expect(clean.levelE).toBe(true);
        expect(vandalised.levelE).toBe(true);
        expect(vandalised.log).toBe(clean.log);
        expect(vandalised.snapshots).toEqual(clean.snapshots);
        expect(vandalised.hash).toBe(clean.hash);
        expect(canonicalJson(vandalised.gateway)).toBe(canonicalJson(clean.gateway));
        for (const seat of Object.keys(clean.inputs)) {
          expect([seat, vandalised.inputs[seat]]).toEqual([seat, clean.inputs[seat]]);
        }
        // Not vacuous: the seats received many inputs, with results in them.
        const all = Object.values(clean.inputs).flat();
        expect(all.length).toBeGreaterThan(100);
        expect(all.some((i) => i.includes('"results":[{'))).toBe(true);
      }, 60000);
    }
  }

  test("the vandal really changes what it is given", () => {
    const value = { a: 1, b: "x", c: [1, { d: true }], e: null };
    const before = canonicalJson(value);
    vandalise(value);
    expect(canonicalJson(value)).not.toBe(before);
  });
});
