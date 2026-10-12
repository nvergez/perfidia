// Performance printout of the 1-game-day runs (docs/architecture.md §13.8, §15 T16): for both
// rulesets, 6 and 12 seats of the default bots, under lockstep and real time with `VirtualTime`, the
// wall time of the run, of its Level E replay and of the gateway rebuild, with the log size, turns,
// calls and engine events; and the time of a full state hash and of a briefing at the end. Printed,
// never asserted (the 7-day budgets of §13.8 are the exit suite's); only completion is checked.

import { expect, test } from "bun:test";
import { buildBriefing, rebuildGatewayState } from "@perfidia/gateway";
import { runBots, type ClockChoice } from "../harness/index.ts";
import { LOCKSTEP, REFS, VIRTUAL, daySpec, levelE, loadChecked, resolve } from "./kit.ts";

const ms = (from: number): number => Math.round((performance.now() - from) * 10) / 10;

interface Row {
  run: string;
  seats: number;
  clock: string;
  lines: number;
  turns: number;
  calls: number;
  events: number;
  runMs: number;
  levelEMs: number;
  rebuildMs: number;
  hashMs: number;
  briefingP95Ms: number;
}

async function measure(ref: string, players: number, clock: ClockChoice): Promise<Row> {
  let t = performance.now();
  const out = await runBots({ ...daySpec(ref, clock, 41, { players }), snapshotEvery: 0 });
  const runMs = ms(t);
  t = performance.now();
  const report = levelE(out.lines);
  const levelEMs = ms(t);
  expect(report.ok).toBe(true);
  t = performance.now();
  const rebuilt = rebuildGatewayState(out.lines, resolve);
  const rebuildMs = ms(t);
  expect(rebuilt.ok).toBe(true);
  const final = out.sink.parsedSnapshots().at(-1);
  if (final === undefined) throw new Error("no final snapshot");
  const match = loadChecked(final, "off");
  t = performance.now();
  const hash = match.hash();
  const hashMs = ms(t);
  expect(hash).toBe(out.run.finalHash);
  const times: number[] = [];
  const r = match.read();
  for (const seat of Object.values(out.run.gateway.seats).map((s) => s.seat)) {
    for (let i = 0; i < 20; i += 1) {
      const b = performance.now();
      buildBriefing(r, seat, out.run.gateway, {
        reasons: ["safety"],
        urgent: false,
        charge: null,
        day: 0,
        used: { own: 0, social: 0 },
      });
      times.push(performance.now() - b);
    }
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
  return {
    run: ref,
    seats: players,
    clock: clock.kind,
    lines: out.lines.length,
    turns: out.run.stats.turns,
    calls: out.run.stats.calls,
    events: out.run.stats.engineEvents,
    runMs,
    levelEMs,
    rebuildMs,
    hashMs,
    briefingP95Ms: Math.round(p95 * 1000) / 1000,
  };
}

test("performance of the 1-game-day runs (printed, not asserted)", async () => {
  const rows: Row[] = [];
  for (const ref of REFS) {
    for (const players of [6, 12]) {
      for (const clock of [LOCKSTEP, VIRTUAL]) {
        // oxlint-disable-next-line no-await-in-loop -- runs are timed one at a time
        rows.push(await measure(ref, players, clock));
      }
    }
  }
  console.log("\nT16 performance, 1 game day, default bots (ms of wall time):");
  console.table(rows);
  expect(rows).toHaveLength(8);
}, 60000);
