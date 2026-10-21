// The four-provider wire-stub match (phase-4 design §8.5, the Pass 2 integration): `budget-mix`
// (Claude Haiku 5.5, GPT-6 Luna, Gemini 3.8 Flash, GLM-5.3 Flash pinned to z-ai/fp8, and two bots)
// played for 2 game days in lockstep with every LLM seat on its REAL adapter, each against its
// provider's wire stub on 127.0.0.1 (`model/wire-stubs.test.ts`), driven by the bot-backed brain.
// The plan is `arena run`'s (`planLive`: OpenRouter's metadata comes from its stub); the keys and
// base URLs are the plan's environment, nothing else.
//
// Checked: Level E and the gateway rebuild; each seat's costs from its own provider's card (every
// line re-priced from its usage at its wall start); the budget block under, its total the sum of
// the logged lines; `exit4` computed with every part, not met (a stub run is not reconciled);
// each key only in its own stub's header, never in the run directory; two runs byte-identical
// apart from the wall fields (and `summary.json`, the run's wall duration). Then the same match
// with a budget just above the plan's refusal threshold and replies that spend fast: the kill
// switch fires, every LLM seat is handed off `match_budget`, the spend stays under the budget, no
// attempt starts after the kill, and the match ends with the bots.
// The 2-day byte-identical runs through the four adapters run in the slow suite (PERFIDIA_SLOW=1,
// docs/architecture.md §13.8: `bun run test:slow`, run by `bun run test:exit`).

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findRuleset, verifyLog } from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import { rebuildGatewayState } from "@perfidia/gateway/runtime";
import { memoryIo, readLog } from "@perfidia/sim";
import {
  ArenaReportSchema,
  type ArenaReport,
  type LlmCallLine,
  type LlmLogLine,
} from "../log/schema.ts";
import { costOf } from "../model/prices.ts";
import {
  WIRE_KEYS,
  WIRE_PROVIDERS,
  botScript,
  startWireStub,
  wireEnv,
  type WireStub,
} from "../model/wire-stubs.test.ts";
import { arenaEnv, llmSeatsOf, planArena, type ArenaPlan, type ArenaRequest } from "./plan.ts";
import { planLive } from "./providers/openrouter.ts";
import { readCalls, runDir } from "./rig.test.ts";
import { runArena, type ArenaOutcome } from "./run.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

const LONG = 300_000;
const RULESET = "perfidia-1@1.1.0";
const REQUEST: ArenaRequest = {
  ruleset: RULESET,
  lineup: "budget-mix",
  days: 2,
  seed: 1,
  idKey: "seed",
};
const resolve = (ref: string) => findRuleset(ref);

let live: WireStub[] = [];
afterEach(() => {
  for (const s of live) s.stop();
  live = [];
});

/** Fresh stubs of the four providers, driven by the seats' bots. */
function stubs(plan: ArenaPlan, extraOutput = 0): WireStub[] {
  const bots = Object.fromEntries(llmSeatsOf(plan).map((s) => [s.seat, s.brain]));
  const script = botScript({ bots, seed: 1, extraOutput });
  live = WIRE_PROVIDERS.map((p) => startWireStub(p, script));
  return live;
}

interface Played {
  readonly dir: string;
  readonly plan: ArenaPlan;
  readonly outcome: ArenaOutcome;
  readonly stubs: readonly WireStub[];
  readonly ms: number;
  /** What the run printed (stdout and stderr). */
  readonly printed: string;
}

/** One real run of `budget-mix` against fresh stubs. */
async function play(req: ArenaRequest = {}, extraOutput = 0): Promise<Played> {
  const fakePlan = planArena({ ...REQUEST, ...req, fake: true }, arenaEnv({}));
  const s = stubs(fakePlan, extraOutput);
  const env = arenaEnv(wireEnv(s));
  const plan = await planLive({ ...REQUEST, ...req }, env);
  expect(plan.fake).toBe(false);
  const dir = runDir(`wire-${req.budgetUsd ?? "default"}`);
  const t0 = performance.now();
  const io = memoryIo();
  const outcome = await runArena(plan, { dir, io, quiet: true });
  const ms = Math.round(performance.now() - t0);
  return { dir, plan, outcome, stubs: s, ms, printed: `${io.stdout()}${io.stderr()}` };
}

/** Every file of a run directory, by relative path. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).toSorted((x, y) => (x < y ? -1 : 1))) {
      const p = join(d, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      if (statSync(p).isDirectory()) walk(p, r);
      else out.set(r, readFileSync(p, "utf8"));
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Wall-clock fields, left out of determinism comparisons: the log schema's wall fields, the price
 * instant of a real run (its start), the think times and the speed derived from them, the run's
 * wall window, and the estimate's sha (`estimate.json` holds the price instant).
 */
const WALL = new Set([
  "wallStart",
  "latencyMs",
  "ttftMs",
  "wallMs",
  "priceAt",
  "thinkMs",
  "recommendedSpeed",
  "wall",
  "estimateSha256",
  "sha256",
]);

const scrub = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(scrub);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, WALL.has(k) ? "<wall>" : scrub(x)]),
  );
};

/**
 * A run file with its wall-clock fields blanked. The per-seat logs (`llm_calls.jsonl`,
 * `replies.jsonl`) are compared seat by seat: two seats' attempts at the same game time finish in
 * the order the network answers, so only each seat's own sequence is deterministic.
 */
function steady(name: string, text: string): unknown {
  if (!name.endsWith(".jsonl")) {
    try {
      return scrub(JSON.parse(text));
    } catch {
      return text;
    }
  }
  const lines = text
    .split("\n")
    .filter((l) => l !== "")
    .map((l): unknown => {
      const parsed: unknown = JSON.parse(l);
      return scrub(parsed);
    });
  if (name !== "llm_calls.jsonl" && name !== "replies.jsonl") return lines;
  const bySeat = new Map<string, unknown[]>();
  for (const l of lines) {
    const seat: unknown = typeof l === "object" && l !== null ? Reflect.get(l, "seat") : undefined;
    const key = typeof seat === "string" ? seat : "-";
    bySeat.set(key, [...(bySeat.get(key) ?? []), l]);
  }
  return Object.fromEntries([...bySeat.entries()].toSorted(([x], [y]) => (x < y ? -1 : 1)));
}

const report = (dir: string): ArenaReport =>
  ArenaReportSchema.parse(JSON.parse(readFileSync(join(dir, "arena.json"), "utf8")));

const llmCalls = (lines: readonly LlmLogLine[]): LlmCallLine[] =>
  lines.filter((l): l is LlmCallLine => l.k === "llm_call");

describe("budget-mix for 2 game days through the four real adapters and their wire stubs", () => {
  xtest(
    "Level E, the gateway rebuild, each seat's costs from its card, the budget block, exit4; byte-identical runs",
    async () => {
      const a = await play();
      const { outcome, dir, plan } = a;
      expect([outcome.code, outcome.status, outcome.error]).toEqual([0, "ended", null]);
      const r = report(dir);
      // Level E and the rebuild of the live gateway state.
      const lines = readLog(join(dir, "match.jsonl"));
      expect(verifyLog(lines).ok).toBe(true);
      expect(r.levelE?.ok).toBe(true);
      const rebuilt = rebuildGatewayState(lines, resolve);
      expect([rebuilt.ok, rebuilt.inTurn, rebuilt.drift]).toEqual([true, false, null]);
      expect(canonicalJson(rebuilt.gw)).toBe(canonicalJson(outcome.result?.gateway ?? null));
      expect(lines.at(-1)?.k).toBe("end");

      // Every LLM seat played on its own provider's adapter, through its stub, priced at its card.
      const calls = readCalls(dir);
      const llm = llmCalls(calls);
      const seats = llmSeatsOf(plan);
      expect(seats.map((s) => [s.seat, s.provider])).toEqual([
        ["p1", "anthropic"],
        ["p2", "openai"],
        ["p3", "google"],
        ["p4", "openrouter"],
      ]);
      for (const s of seats) {
        const mine = llm.filter((l) => l.seat === s.seat);
        expect([s.seat, mine.length > 10]).toEqual([s.seat, true]);
        expect([s.seat, mine.every((l) => l.provider === s.provider && l.error === null)]).toEqual([
          s.seat,
          true,
        ]);
        expect([s.seat, [...new Set(mine.map((l) => l.priceCard?.split(":")[0]))]]).toEqual([
          s.seat,
          [s.provider],
        ]);
        for (const l of mine) {
          const usage = l.usage.map((u) => ({
            model: u.model,
            kind: u.kind,
            tokens: {
              input: u.input,
              cacheWrite5m: u.cacheWrite5m,
              cacheWrite1h: u.cacheWrite1h,
              cacheRead: u.cacheRead,
              output: u.output,
              ...(u.reasoning === undefined ? {} : { reasoning: u.reasoning }),
            },
            estimated: u.estimated,
          }));
          const cost = costOf(usage, {
            provider: s.provider,
            endpoint: s.endpoint,
            at: l.wallStart ?? "",
          });
          expect([s.seat, l.turn, l.round, l.attempt, l.costNanoUsd]).toEqual([
            s.seat,
            l.turn,
            l.round,
            l.attempt,
            cost.nanoUsd,
          ]);
        }
        // Each stub served its seat only (preflight included), with nothing it found wrong.
        const stub = a.stubs.find((x) => x.provider === s.provider);
        expect([s.provider, stub?.problems]).toEqual([s.provider, []]);
        expect([s.provider, (stub?.chats.length ?? 0) >= mine.length]).toEqual([s.provider, true]);
      }
      // OpenRouter: the pinned endpoint served, its reported cost recorded, the 5.5% fee charged.
      const p4 = llm.filter((l) => l.seat === "p4");
      expect(p4.every((l) => l.endpoint === "z-ai/fp8" && (l.feeNanoUsd ?? 0) > 0)).toBe(true);
      expect(p4.every((l) => (l.reportedCostNanoUsd ?? 0) > 0)).toBe(true);

      // The budget block: the total is the sum of the logged lines, under the budget, no kill.
      const logged = calls.reduce(
        (n, l) => n + (l.k === "llm_call" || l.k === "preflight" ? l.costNanoUsd : 0),
        0,
      );
      expect(r.budget.actualNanoUsd).toBe(logged);
      expect(r.budget.under).toBe(true);
      expect(r.budget.killSwitch).toBeNull();
      expect(r.budget.budgetNanoUsd).toBe(40_000_000_000);
      expect(calls.filter((l) => l.k === "preflight").length).toBe(4);
      // exit4: every part computed; not met, since a stub run is never reconciled.
      expect(r.exit4).toEqual({
        models: 4,
        ended: true,
        estimateStored: true,
        noHandoff: true,
        withinPrediction: r.exit4.withinPrediction,
        under: true,
        levelE: true,
        reconciled: null,
        met: false,
      });

      // Each key reached its own stub only, in its own header, and is nowhere in the run.
      const files = tree(dir);
      for (const s of a.stubs) {
        for (const h of s.hits) {
          for (const p of WIRE_PROVIDERS) {
            if (p === s.provider) continue;
            expect(JSON.stringify(h).includes(WIRE_KEYS[p])).toBe(false);
          }
          expect(h.path.includes(s.key)).toBe(false);
        }
      }
      for (const [name, text] of [...files, ["(printed)", a.printed] as const]) {
        for (const key of Object.values(WIRE_KEYS)) {
          expect([name, text.includes(key)]).toEqual([name, false]);
        }
      }

      // A second run against fresh stubs: byte-identical apart from the wall fields.
      const b = await play();
      expect(b.outcome.code).toBe(0);
      const other = tree(b.dir);
      expect([...other.keys()]).toEqual([...files.keys()]);
      for (const [name, text] of files) {
        if (name === "summary.json") continue;
        expect([name, steady(name, other.get(name) ?? "")]).toEqual([name, steady(name, text)]);
      }
      console.log(
        `wire-stub budget-mix, 2 days: ${a.ms} ms and ${b.ms} ms; ${llm.length} attempts; ${a.stubs.map((s) => `${s.provider} ${s.chats.length}`).join(", ")} requests; spent $${(logged / 1e9).toFixed(6)}`,
      );
    },
    LONG,
  );

  test(
    "a budget just above the refusal threshold: the kill switch fires, every LLM seat handed off match_budget, under budget, the match ends",
    async () => {
      const probe = planArena({ ...REQUEST, fake: true, budgetUsd: "1000" }, arenaEnv({}));
      const threshold = probe.prediction.match.low + probe.prediction.reserve.reserveNanoUsd;
      const cents = Math.ceil(threshold / 10_000_000) + 1;
      const budgetUsd = (cents / 100).toFixed(2);
      // The replies spend fast: 20,000 output tokens more each.
      const k = await play({ budgetUsd, transcripts: "off" }, 20_000);
      expect([k.outcome.code, k.outcome.status]).toEqual([0, "ended"]);
      const calls = readCalls(k.dir);
      const handoffs = calls.filter((l) => l.k === "handoff");
      const seatsOff = handoffs.flatMap((h) => (h.k === "handoff" ? [[h.seat, h.reason]] : []));
      expect(seatsOff.toSorted((x, y) => ((x[0] ?? "") < (y[0] ?? "") ? -1 : 1))).toEqual([
        ["p1", "match_budget"],
        ["p2", "match_budget"],
        ["p3", "match_budget"],
        ["p4", "match_budget"],
      ]);
      const kill = calls.find((l) => l.k === "kill_switch");
      const killT = kill?.k === "kill_switch" ? kill.t : -1;
      expect(killT).toBeGreaterThanOrEqual(0);
      expect(llmCalls(calls).every((l) => l.t <= killT)).toBe(true);
      const r = report(k.dir);
      expect(r.levelE?.ok).toBe(true);
      expect(r.budget.killSwitch?.fired).toBe(true);
      expect(r.budget.under).toBe(true);
      expect(r.budget.actualNanoUsd).toBeLessThanOrEqual(cents * 10_000_000);
      expect(r.budget.actualNanoUsd).toBeGreaterThanOrEqual(r.budget.killAtNanoUsd ?? 0);
      expect([r.exit4.noHandoff, r.exit4.met]).toEqual([false, false]);
      const lines = readLog(join(k.dir, "match.jsonl"));
      expect(lines.at(-1)?.k).toBe("end");
      expect(rebuildGatewayState(lines, resolve).ok).toBe(true);
      console.log(
        `wire-stub kill switch: budget $${budgetUsd}, spent $${(r.budget.actualNanoUsd / 1e9).toFixed(6)}, kill at t = ${killT}, ${k.ms} ms`,
      );
    },
    LONG,
  );
});
