// The phase-2 exit suite (phase-2 design §7, item 9): full 7-day arena matches on fake models, in
// lockstep and in real time under virtual time, each replayed at Level E, with the exit criterion
// reported for each (alliance_formed and a betrayal, overall and with an LLM seat). Fake brains are
// bots, so the criterion is reported, never asserted: the real criterion is the first match with
// Claude seats. Exit suite only: skipped unless PERFIDIA_EXIT=1 (`bun run test:exit`).

import { afterAll, describe, expect, test } from "bun:test";
import { verifyLog } from "@perfidia/engine";
import type { ArenaRequest } from "./plan.ts";
import { fakePlan, play } from "./rig.test.ts";

const ENABLED = process.env["PERFIDIA_EXIT"] === "1";
const suite = ENABLED ? describe : describe.skip;
const LONG = 300_000;

interface Row {
  readonly run: string;
  readonly status: string;
  readonly alliances: number;
  readonly betrayals: number;
  readonly met: boolean;
  readonly llmBetrayals: number;
  readonly llmMet: boolean;
  readonly calls: number;
  readonly fakeCost: string;
  readonly ms: number;
}
const rows: Row[] = [];

afterAll(() => {
  if (rows.length > 0) console.table(rows);
});

async function week(name: string, req: ArenaRequest, latency?: readonly [number, number]) {
  const t0 = performance.now();
  const run = await play(fakePlan({ days: 7, transcripts: "off", ...req }), {
    ...(latency === undefined ? {} : { brainLatencyMs: latency }),
    quiet: true,
  });
  const ms = Math.round(performance.now() - t0);
  expect(run.outcome.status).toBe("ended");
  expect(run.lines.at(-1)?.k).toBe("end");
  const e = verifyLog(run.lines);
  expect(e.divergence).toBeUndefined();
  expect(e.ok).toBe(true);
  expect(run.lines.some((l) => l.k === "gw" && l.r.code === "INTERNAL")).toBe(false);
  const x = run.report.exit;
  rows.push({
    run: name,
    status: run.report.status,
    alliances: x.alliancesFormed,
    betrayals: x.betrayals,
    met: x.met,
    llmBetrayals: x.llm.betrayals,
    llmMet: x.llm.met,
    calls: run.llm.length,
    fakeCost: `$${(run.report.totals.costNanoUsd / 1e9).toFixed(2)}`,
    ms,
  });
}

suite("phase-2 exit suite: 7-day arena matches on fake models", () => {
  test("lockstep, seed 2", () => week("lockstep s2", { seed: 2 }), LONG);
  test("lockstep, seed 3", () => week("lockstep s3", { seed: 3 }), LONG);
  test(
    "lockstep, seed 1, the default fake brains (each profile's hand-off bot)",
    () => week("lockstep s1 default brains", { seed: 1, brains: [] }),
    LONG,
  );
  test(
    "real time (virtual), seed 1, think time 20–90 s",
    () => week("realtime s1", { seed: 1, clock: "realtime" }, [20_000, 90_000]),
    LONG,
  );
});
