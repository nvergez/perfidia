// The phase-4 review's fixes (docs/phase4.md §25), end to end where the finding was end to end:
// - the kill switch is fail-safe: a kill line that cannot be written (ENOSPC) still halts every
//   seat, and no attempt starts after the kill;
// - a crashed run's carry includes what it may have had in flight; operator signals are taken from
//   before the start preflight (a signal there writes nothing), SIGHUP counts, and a third signal
//   writes an `operator` line before the CLI exits;
// - a key an upstream echoes in an error body never reaches a message, a log or stderr.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryIo } from "@perfidia/sim";
import { canonicalJson, sha256Hex } from "@perfidia/engine/core";
import {
  ArenaReportSchema,
  EstimateFileSchema,
  LineupSchema,
  SeatsFileSchema,
  type LlmLogLine,
} from "../log/schema.ts";
import { IDENTITY_TRANSFORM, toolTransformOf } from "../model/tools.ts";
import { operatorTemplates } from "../seat/prompt.ts";
import type { EndpointInfo } from "../model/catalog.ts";
import { FileCallLog } from "../log/calls.ts";
import { ModelError, type ChatRequest, type UsageEntry } from "../model/adapter.ts";
import { AnthropicAdapter, AnthropicClient, type HttpFetch } from "../model/anthropic.ts";
import { LEGACY_AT, costOf } from "../model/prices.ts";
import { FakeAdapter, type Brain } from "../model/fake.ts";
import { botBrain } from "./brain.ts";
import { main as arenaMain, processSignalsOf } from "./cli.ts";
import { LINEUPS_DIR } from "./lineup.ts";
import { arenaEnv, planArena, type ArenaRequest, type LlmSeatPlan } from "./plan.ts";
import { SNAPSHOT_ENDPOINTS, toolsFor, type EndpointSource } from "./providers.ts";
import { seatAttemptBound } from "./estimate.ts";
import { PreflightError, preflight, type PreflightGroup } from "./preflight.ts";
import { ledgerOf, reconcileDir, reconcileRun, tokensWithin } from "./reconcile.ts";
import { exit4Met } from "./report.ts";
import { operatorHashOf, runArena, type AdapterContext, type SignalSource } from "./run.ts";
import { RULESET, readCalls, runDir } from "./rig.test.ts";

/** `arena` as the CLI runs it, with no calibration profile unless a test passes `--profiles`. */
const main = (...[argv, io, env, o]: Parameters<typeof arenaMain>) =>
  arenaMain(argv, io, env, { profilesDir: "off", ...o });

const LONG = 120_000;
const FAKE = ["--fake", "--lineup", "claude-duo", "--seed", "1", "--id-key", "seed", "--quiet"];

async function cli(argv: readonly string[], env: Record<string, string> = {}) {
  const io = memoryIo();
  const code = await main(argv, io, env);
  return { code, out: io.stdout(), err: io.stderr() };
}

const centsText = (c: number): string =>
  `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

type Call = Extract<LlmLogLine, { k: "llm_call" }>;

describe("the kill switch is fail-safe (review: money, major)", () => {
  test(
    "the kill_switch line fails with ENOSPC: every seat is still halted, no attempt starts after the kill, under budget",
    async () => {
      const base = {
        ruleset: RULESET,
        fake: true,
        seed: 1,
        idKey: "seed",
        lineup: "claude-duo",
        days: 4,
      };
      const probe = planArena({ ...base, budgetUsd: "1000" }, arenaEnv({}));
      const threshold = probe.prediction.match.low + probe.prediction.reserve.reserveNanoUsd;
      const cents = Math.ceil(threshold / 10_000_000) + 1;
      let failed = 0;
      // The disk fills up exactly when the kill_switch line is appended.
      const spy = spyOn(FileCallLog.prototype, "write").mockImplementation(function write(
        this: FileCallLog,
        line: LlmLogLine,
      ): void {
        if (line.k === "kill_switch" && failed === 0) {
          failed += 1;
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
            code: "ENOSPC",
          });
        }
        appendFileSync(this.path, `${JSON.stringify(line)}\n`);
      });
      const dir = runDir();
      const r = await cli([
        "run",
        ...FAKE,
        "--days",
        "4",
        "--budget-usd",
        centsText(cents),
        "--transcripts",
        "off",
        "--out",
        dir,
      ]).finally(() => spy.mockRestore());
      expect(r.code).toBe(0);
      expect(failed).toBe(1);
      expect(r.err).toContain("ALERT: the match budget's kill switch fired");
      expect(r.err).toContain("ALERT: the kill hook failed (ENOSPC");
      const calls = readCalls(dir);
      // The line was lost; the halt was not.
      expect(calls.some((l) => l.k === "kill_switch")).toBe(false);
      const handoffs = calls.filter((l) => l.k === "handoff");
      expect(handoffs.map((h) => h.k === "handoff" && [h.seat, h.reason])).toEqual([
        ["p1", "match_budget"],
        ["p2", "match_budget"],
        ["p3", "match_budget"],
        ["p4", "match_budget"],
      ]);
      const killT = handoffs[0]?.k === "handoff" ? handoffs[0].t : -1;
      const llm = calls.filter((l): l is Call => l.k === "llm_call");
      expect(llm.every((l) => l.t <= killT)).toBe(true);
      // Spend never passed the budget: the logged lines, every one of them.
      const spent = calls.reduce(
        (n, l) => n + (l.k === "llm_call" || l.k === "preflight" ? l.costNanoUsd : 0),
        0,
      );
      expect(spent).toBeLessThanOrEqual(cents * 10_000_000);
      const rep = ArenaReportSchema.parse(
        JSON.parse(readFileSync(join(dir, "arena.json"), "utf8")),
      );
      expect([rep.status, rep.budget.under]).toEqual(["ended", true]);
    },
    LONG,
  );
});

/** A signal source the test fires. */
function signals(): { source: SignalSource; emit: (s: string) => void } {
  let handler: ((s: string) => void) | null = null;
  return {
    source: {
      subscribe: (h) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
    },
    emit: (s) => handler?.(s),
  };
}

/** The budget of a 1-day claude-duo plan of $10 carrying `dir`. */
const carried = (dir: string) =>
  planArena(
    {
      ruleset: RULESET,
      fake: true,
      seed: 1,
      idKey: "seed",
      lineup: "claude-duo",
      days: 1,
      budgetUsd: "10",
      budgetCarry: dir,
    },
    arenaEnv({}),
  ).budget;

const duo = (days: number) =>
  planArena(
    { ruleset: RULESET, fake: true, seed: 1, idKey: "seed", lineup: "claude-duo", days },
    arenaEnv({}),
  );

describe("crashes and operator signals (review: money, major)", () => {
  test(
    "--budget-carry of a run that did not end carries its reserve for what it had in flight",
    async () => {
      const first = runDir("first");
      expect(
        (await cli(["run", ...FAKE, "--days", "1", "--budget-usd", "10", "--out", first])).code,
      ).toBe(0);
      const logged = readCalls(first).reduce(
        (n, l) => n + (l.k === "llm_call" || l.k === "preflight" ? l.costNanoUsd : 0),
        0,
      );
      const reserve = EstimateFileSchema.parse(
        JSON.parse(readFileSync(join(first, "estimate.json"), "utf8")),
      ).reserve.reserveNanoUsd;
      // It ended: its lines are all of it.
      expect(carried(first)).toMatchObject({ carryNanoUsd: logged, carryInFlightNanoUsd: 0 });
      // The same run as a crash leaves it (arena.json still "running"; or no arena.json at all).
      const arenaPath = join(first, "arena.json");
      const arena = ArenaReportSchema.parse(JSON.parse(readFileSync(arenaPath, "utf8")));
      writeFileSync(arenaPath, JSON.stringify({ ...arena, status: "running" }));
      expect(carried(first)).toMatchObject({
        carryNanoUsd: logged + reserve,
        carryInFlightNanoUsd: reserve,
      });
      // The carry line says which part was in flight.
      const second = runDir("second");
      expect(
        (
          await cli([
            "run",
            ...FAKE,
            "--days",
            "1",
            "--budget-usd",
            "10",
            "--budget-carry",
            first,
            "--out",
            second,
          ])
        ).code,
      ).toBe(0);
      const line = readCalls(second)[0];
      expect(line?.k === "carry" && [line.costNanoUsd, line.inFlightNanoUsd]).toEqual([
        logged + reserve,
        reserve,
      ]);
      // Without an estimate.json, what it had in flight has no bound: refused.
      writeFileSync(join(first, "estimate.json"), "{}");
      expect(() => carried(first)).toThrow(
        "the run did not end (arena.json status running) and has no readable estimate.json",
      );
    },
    LONG,
  );

  test("a signal during the start preflight stops it between groups: nothing is written", async () => {
    const sig = signals();
    const checked: string[] = [];
    const adapterFor = (
      s: LlmSeatPlan,
      spec: ConstructorParameters<typeof FakeAdapter>[0],
      ctx: AdapterContext,
    ) => {
      const inner = botBrain({ label: s.brain, seat: s.seat, seed: ctx.seed, model: s.model });
      return new (class extends FakeAdapter {
        override preflight(sample: Parameters<FakeAdapter["preflight"]>[0]) {
          checked.push(spec.model);
          sig.emit("SIGINT");
          return super.preflight(sample);
        }
      })(spec, inner);
    };
    const dir = runDir();
    const err = await runArena(duo(1), {
      dir,
      io: memoryIo(),
      quiet: true,
      signals: sig.source,
      adapterFor,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreflightError);
    expect(err instanceof Error ? err.message : "").toContain(
      "SIGINT during the start preflight: the run stops before anything is written",
    );
    // Sonnet's group was checked; Haiku's never was.
    expect(checked).toEqual(["claude-sonnet-5-5"]);
    expect(existsSync(dir)).toBe(false);
  });

  test(
    "three signals: hand-off, abort, then an operator line just before the CLI exits",
    async () => {
      const sig = signals();
      let n = 0;
      const adapterFor = (
        s: LlmSeatPlan,
        spec: ConstructorParameters<typeof FakeAdapter>[0],
        ctx: AdapterContext,
      ) => {
        const inner = botBrain({ label: s.brain, seat: s.seat, seed: ctx.seed, model: s.model });
        const brain: Brain = (req, k) => {
          n += 1;
          if (n === 30) for (let i = 0; i < 3; i += 1) sig.emit("SIGTERM");
          return inner(req, k);
        };
        return new FakeAdapter(spec, brain);
      };
      const dir = runDir();
      const out = await runArena(duo(2), {
        dir,
        io: memoryIo(),
        quiet: true,
        signals: sig.source,
        adapterFor,
      });
      expect(out.status).toBe("aborted");
      expect(
        readCalls(dir).flatMap((l) => (l.k === "operator" ? [[l.signal, l.action]] : [])),
      ).toEqual([
        ["SIGTERM", "handoff"],
        ["SIGTERM", "abort"],
        ["SIGTERM", "exit"],
      ]);
    },
    LONG,
  );

  test("the process source takes SIGINT, SIGTERM and SIGHUP; the third is handed over, then exits", () => {
    const exits: number[] = [];
    const got: string[] = [];
    const before = process.listenerCount("SIGHUP");
    const off = processSignalsOf((code) => exits.push(code)).subscribe((s) => got.push(s));
    expect(process.listenerCount("SIGHUP")).toBe(before + 1);
    process.emit("SIGHUP", "SIGHUP");
    process.emit("SIGTERM", "SIGTERM");
    expect(exits).toEqual([]);
    process.emit("SIGINT", "SIGINT");
    expect([got, exits]).toEqual([["SIGHUP", "SIGTERM", "SIGINT"], [130]]);
    off();
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });
});

/** A one-message request of the adapter tests. */
const REQUEST: ChatRequest = {
  prompt: { shared: "s", seat: "p" },
  tools: [],
  entries: [{ role: "user", parts: [{ kind: "text", text: "{}" }] }],
  meta: { seat: "p1", turn: 1, round: 0, maxRounds: 1, maxCalls: 1, kind: "round" },
};

const KEY = "sk-ant-api03-PLANTED/SECRET+0123456789";
const echo =
  (status: number): HttpFetch =>
  (_input, init) => {
    const key = new Headers(init?.headers).get("x-api-key") ?? "";
    return Promise.resolve(
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: status === 401 ? "authentication_error" : "api_error",
            message: `invalid x-api-key: ${key} (or ${encodeURIComponent(key)})`,
          },
        }),
        { status, headers: { "content-type": "application/json" } },
      ),
    );
  };

/** Claude Haiku 5.5 behind an upstream that echoes the key with `status`. */
const echoing = (status: number) =>
  new AnthropicAdapter(
    {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      effort: "low",
      maxOutputTokens: 1000,
      cacheTtl: "5m",
      fallbacks: "off",
    },
    new AnthropicClient({
      apiKey: KEY,
      baseURL: "https://api.test.invalid",
      fetch: echo(status),
    }),
  );

describe("a key echoed by the upstream is redacted (review: money, minor)", () => {
  test("the adapter's errors (preflight, a call) carry [redacted], never the key", async () => {
    for (const [status, call] of [
      [401, (a: AnthropicAdapter) => a.preflight(REQUEST)],
      [500, (a: AnthropicAdapter) => a.chat(REQUEST)],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- two statuses, one at a time
      const e = await call(echoing(status)).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ModelError);
      const message = e instanceof Error ? e.message : "";
      expect(message).toContain("[redacted]");
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(encodeURIComponent(KEY));
    }
  });

  const servers: { stop(force?: boolean): void }[] = [];
  afterEach(() => {
    for (const x of servers.splice(0)) x.stop(true);
  });

  test("arena run against an upstream echoing the key (401): exit 3, nothing written, no key on stdout or stderr", async () => {
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => echo(401)(req.url, { headers: req.headers }),
    });
    servers.push(stub);
    const dir = runDir();
    const r = await cli(
      ["run", "--lineup", "claude-duo", "--days", "1", "--seed", "1", "--out", dir, "--quiet"],
      {
        PERFIDIA_ANTHROPIC_API_KEY: KEY,
        PERFIDIA_ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
      },
    );
    expect(r.code).toBe(3);
    expect(r.err).toContain("preflight of anthropic/claude-sonnet-5-5/medium: auth (401)");
    expect(r.err).toContain("[redacted]");
    expect(`${r.out}${r.err}`).not.toContain(KEY);
    expect(`${r.out}${r.err}`).not.toContain(encodeURIComponent(KEY));
    expect(existsSync(dir)).toBe(false);
  });
});

/** A stub of the two preflight requests: the model's info, then the shape check's message. */
const preflightStub =
  (message: Record<string, unknown>): HttpFetch =>
  (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = url.includes("/v1/models/")
      ? { id: "claude-haiku-5-5", type: "model", allowed_fallback_models: [] }
      : {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [],
          stop_reason: "max_tokens",
          stop_sequence: null,
          stop_details: null,
          usage: { input_tokens: 3, output_tokens: 0, cache_creation_input_tokens: 9000 },
          ...message,
        };
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    );
  };
const group = (fetch: HttpFetch): PreflightGroup => ({
  seat: "p1",
  adapter: new AnthropicAdapter(
    {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      effort: "medium",
      maxOutputTokens: 16_000,
      cacheTtl: "5m",
      fallbacks: "off",
    },
    new AnthropicClient({ apiKey: "sk-test", baseURL: "https://api.test.invalid", fetch }),
  ),
  prompt: { shared: "shared", seat: "seat" },
  tools: [],
});

/** A body of server-sent `events`, then its end. */
const sse =
  (events: readonly Record<string, unknown>[]): HttpFetch =>
  () =>
    Promise.resolve(
      new Response(
        events.map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );

/** Claude Opus 5.5 with its server-side fallbacks on, on `fetch`. */
const opus = (fetch: HttpFetch) =>
  new AnthropicAdapter(
    {
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "medium",
      maxOutputTokens: 16_000,
      cacheTtl: "5m",
      fallbacks: "default",
    },
    new AnthropicClient({ apiKey: "sk-test", baseURL: "https://api.test.invalid", fetch }),
  );

/** What a call of Opus 5.5 whose stream ends after `events` is charged. */
const spentAfter = async (events: readonly Record<string, unknown>[]) => {
  const e = await opus(sse(events))
    .chat(REQUEST)
    .catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ModelError);
  return e instanceof ModelError ? e.spent : [];
};

describe("what the provider bills is what the ledger charges (review: money)", () => {
  test("US-only inference: read from usage.inference_geo, charged 1.1×, and refused at the preflight", async () => {
    const us = {
      usage: {
        input_tokens: 3,
        output_tokens: 0,
        cache_creation_input_tokens: 9000,
        inference_geo: "us",
      },
    };
    const lines: string[] = [];
    const err = await preflight([group(preflightStub(us))], {
      onGroup: (g) => lines.push(`${g.nanoUsd} ${g.cards.join(",")} ${g.error?.kind ?? ""}`),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreflightError);
    expect(err instanceof PreflightError ? err.kind : "").toBe("geo");
    expect(err instanceof Error ? err.message : "").toContain(
      'inference ran in "us", not "global"',
    );
    // The check itself is charged at the US prices: (3 × $0.10 + 9000 × $0.125) × 1.1 per MTok.
    expect(lines).toEqual([
      `${Math.ceil(((3 * 100_000 + 9000 * 125_000) * 11) / 10 / 1000)} anthropic:claude-haiku-5-5@2026-10-20+us geo`,
    ]);
    // A global answer passes.
    const ok = await preflight([group(preflightStub({}))]);
    expect(ok.reports).toHaveLength(1);
  });

  test("a check served under a model id no card prices is refused (it would bill at MAX_CARD)", async () => {
    const err = await preflight([
      group(preflightStub({ model: "claude-haiku-5-5-20261101" })),
    ]).catch((e: unknown) => e);
    expect(err instanceof PreflightError ? err.kind : "").toBe("price");
    expect(err instanceof Error ? err.message : "").toContain(
      "the API served claude-haiku-5-5-20261101 for claude-haiku-5-5, and no price card lists it",
    );
  });

  test("a stream broken after a server-side fallback switch is charged the target's cold iteration too, within the bound", async () => {
    // message_start (the refused iteration's prompt), a `fallback` block to Claude Opus 5, then the
    // body ends: no message_delta, so no iteration usage.
    const start = {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: 2_000,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 150_000,
        },
      },
    };
    const fallback = {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "fallback",
        from: { model: "claude-opus-5-5" },
        to: { model: "claude-opus-5" },
        trigger: { type: "refusal" },
      },
    };
    const before = await spentAfter([start]);
    const after = await spentAfter([start, fallback]);
    expect(before).toHaveLength(1);
    expect(after.map((u) => [u.model, u.kind, u.tokens.cacheWrite5m, u.tokens.output])).toEqual([
      ["claude-opus-5-5", "message", 0, 16_000],
      ["claude-opus-5", "fallback", 152_000, 16_000],
    ]);
    // Opus 5: 152,000 × $6.25 + 16,000 × $25 per MTok on top.
    expect(costOf(after).nanoUsd - costOf(before).nanoUsd).toBe(950_000_000 + 400_000_000);
    expect(costOf(after).nanoUsd).toBeLessThanOrEqual(
      seatAttemptBound("claude-opus-5-5", "default", 16_000, 160_000),
    );
  });
});

/** An `llm_call` line with one usage entry (defaults: Sonnet 5.5, nothing billed). */
function callLine(
  usage: Partial<Call["usage"][number]>,
  o: Partial<Omit<Call, "usage">> = {},
): Call {
  const u = {
    model: "claude-sonnet-5-5",
    kind: "message" as const,
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    estimated: false,
    ...usage,
  };
  const ctx = { provider: o.provider ?? "anthropic", endpoint: null, at: o.wallStart ?? LEGACY_AT };
  const cost = costOf(
    [
      {
        model: u.model,
        kind: u.kind,
        tokens: u,
        estimated: u.estimated,
      },
    ],
    ctx,
  ).nanoUsd;
  return {
    k: "llm_call",
    seat: "p1",
    turn: 1,
    round: 0,
    attempt: 1,
    kind: "round",
    t: 0,
    latencyMs: 1,
    ttftMs: null,
    provider: "anthropic",
    model: u.model,
    servedBy: u.model,
    effort: "medium",
    maxTokens: 16_000,
    stop: "end_turn",
    rawStop: "end_turn",
    refusal: null,
    fallback: false,
    cacheMiss: false,
    usage: [u],
    costNanoUsd: cost,
    seatSpentNanoUsd: 0,
    capNanoUsd: 1,
    wakeSpentNanoUsd: 0,
    unpriced: [],
    calls: 0,
    textChars: 0,
    reasoningChars: 0,
    requestId: null,
    error: null,
    ...o,
  };
}

const WALL = { start: "2026-10-20T08:00:00.000Z", end: "2026-10-20T20:00:00.000Z" };
const LATE = Date.parse("2026-10-23T20:00:00.000Z");
const usdText = (nano: number): string =>
  `${Math.floor(nano / 1e9)}.${String(nano % 1e9).padStart(9, "0")}`;

/** 100,000 input and output tokens of Gemini 4 Argon started at `wallStart`. */
const argon = (wallStart: string) =>
  callLine(
    { model: "gemini-4-argon", input: 100_000, output: 100_000 },
    { provider: "google", wallStart },
  );

/** Google's usage page saying `usd` (nano-dollars). */
const google = (usd: number) => ({
  format: "perfidia-reconcile-input/1" as const,
  providers: [{ provider: "google", usd: usdText(usd) }],
});

describe("arena reconcile (review: money and correctness)", () => {
  test("tokens: estimated (broken-stream) output may be missing from the provider's count, nothing else", () => {
    // A 7-day Sonnet seat: 651,000 real output tokens, and one stream that broke after 1,000 tokens
    // and was charged its 16,000.
    const lines = [
      callLine({ output: 651_000 }),
      callLine({ input: 1_000, output: 16_000, estimated: true }, { stop: "error" }),
    ];
    const ledger = lines.reduce((n, l) => n + l.costNanoUsd, 0);
    const excess = 15_000 * 10_000;
    const input = (output: number) => ({
      format: "perfidia-reconcile-input/1" as const,
      providers: [
        {
          provider: "anthropic",
          usd: usdText(ledger - excess),
          tokens: [{ model: "claude-sonnet-5-5", output }],
        },
      ],
    });
    const ok = reconcileRun(lines, input(652_000), WALL, LATE);
    const row = ok.providers[0]?.tokens[0];
    expect([row?.ledger, row?.estimated, row?.ok, ok.ok]).toEqual([667_000, 16_000, true, true]);
    // Down to ledger − estimated − 2%, and up to ledger + 2%: no further.
    expect(tokensWithin(667_000, 651_000 - 13_340, 16_000)).toBe(true);
    expect(tokensWithin(667_000, 651_000 - 13_341, 16_000)).toBe(false);
    expect(tokensWithin(667_000, 680_340, 16_000)).toBe(true);
    expect(tokensWithin(667_000, 680_341, 16_000)).toBe(false);
    // Without estimated output the ±2% rule is phase 4's.
    expect(reconcileRun(lines, input(600_000), WALL, LATE).ok).toBe(false);
  });

  test("dollars: a report between ledger − excess − tol and ledger − tol is accepted (the excess counts)", () => {
    // $20 of real output, and one broken stream charged $5 of output that never ran.
    const lines = [
      callLine({ output: 2_000_000 }),
      callLine({ output: 500_000, estimated: true }, { stop: "error" }),
    ];
    const ledger = lines.reduce((n, l) => n + l.costNanoUsd, 0);
    expect(ledger).toBe(25_000_000_000);
    const at = (usd: number) =>
      reconcileRun(
        lines,
        {
          format: "perfidia-reconcile-input/1",
          providers: [{ provider: "anthropic", usd: usdText(usd) }],
        },
        WALL,
        LATE,
      );
    const r = at(20_000_000_000);
    const p = r.providers[0];
    expect([p?.estimatedExcessNanoUsd, p?.toleranceNanoUsd, p?.lowNanoUsd]).toEqual([
      5_000_000_000, 750_000_000, 19_250_000_000,
    ]);
    // $20 is under ledger − tol ($24.25): only the excess accepts it.
    expect(r.ok).toBe(true);
    expect(at(19_249_999_999).ok).toBe(false);
  });

  test("a dated card inside its uncertain change window: what it charged over the card before is excess", () => {
    // Gemini 4 Argon: "$2 through November 30" (no timezone) is charged $4 from 2026-11-30T00:00Z;
    // Google may bill $2 until 2026-12-01T12:00Z (UTC−12's end of the day).
    const inside = argon("2026-11-30T09:00:00.000Z");
    const after = argon("2026-12-01T13:00:00.000Z");
    expect([inside.costNanoUsd, after.costNanoUsd]).toEqual([2_400_000_000, 2_400_000_000]);
    const billedAtTwo = 1_200_000_000;
    const wall = { start: "2026-11-30T08:00:00.000Z", end: "2026-11-30T20:00:00.000Z" };
    const r = reconcileRun([inside], google(billedAtTwo), wall, Date.parse("2026-12-03T00:00:00Z"));
    expect([r.providers[0]?.estimatedExcessNanoUsd, r.ok]).toEqual([1_200_000_000, true]);
    // After the window there is no doubt left, and no excess.
    expect(ledgerOf([after]).get("google")?.excess).toBe(0);
  });

  test(
    "under 48 hours, exit4.reconciled stays null unless --force; a fake run is never met",
    async () => {
      const dir = runDir();
      expect(
        (await cli(["run", ...FAKE, "--days", "1", "--budget-usd", "10", "--out", dir])).code,
      ).toBe(0);
      // Pretend the run had real wall times, ended 24 hours before the check.
      const path = join(dir, "arena.json");
      const arena = ArenaReportSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      writeFileSync(path, JSON.stringify({ ...arena, budget: { ...arena.budget, wall: WALL } }));
      const ledger = readCalls(dir).reduce(
        (n, l) => n + (l.k === "llm_call" || l.k === "preflight" ? l.costNanoUsd : 0),
        0,
      );
      const input = {
        format: "perfidia-reconcile-input/1" as const,
        providers: [{ provider: "fake", usd: usdText(ledger) }],
      };
      const now = Date.parse("2026-10-21T20:00:00.000Z");
      const file = reconcileDir(dir, input, now);
      expect([file.early, file.ok]).toEqual([true, true]);
      const read = () => ArenaReportSchema.parse(JSON.parse(readFileSync(path, "utf8"))).exit4;
      expect(read().reconciled).toBeNull();
      reconcileDir(dir, input, now, { force: true });
      expect([read().reconciled, read().met]).toEqual([true, false]);
      const cliRun = await cli(["reconcile", dir, "--usd", `fake=${usdText(ledger)}`]);
      expect(cliRun.err).toContain("exit4.reconciled stays null until then; --force fills it now");
    },
    LONG,
  );
});

describe("exit4.met (review: correctness)", () => {
  const all = {
    models: 2,
    ended: true,
    estimateStored: true,
    noHandoff: true,
    withinPrediction: true,
    under: true,
    levelE: true,
    reconciled: true,
  };

  test("every part is needed, each on its own; a fake run never meets it", () => {
    expect(exit4Met(all, { fake: false })).toBe(true);
    expect(exit4Met(all, { fake: true })).toBe(false);
    const flips: [string, Partial<typeof all> | { reconciled: null }][] = [
      ["models", { models: 1 }],
      ["ended", { ended: false }],
      ["estimateStored", { estimateStored: false }],
      ["noHandoff", { noHandoff: false }],
      ["withinPrediction", { withinPrediction: false }],
      ["under", { under: false }],
      ["levelE", { levelE: false }],
      ["reconciled false", { reconciled: false }],
      ["reconciled null", { reconciled: null }],
    ];
    for (const [name, flip] of flips) {
      expect([name, exit4Met({ ...all, ...flip }, { fake: false })]).toEqual([name, false]);
    }
  });
});

/** The plan's refusal (or "planned") of a fake request, with an endpoint-metadata hook. */
function planOutcome(req: ArenaRequest, o: { readonly endpoints?: EndpointSource } = {}): string {
  try {
    planArena(
      { fake: true, seed: 1, idKey: "seed", priceDate: "2026-10-20", ...req },
      arenaEnv({}),
      o,
    );
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "planned";
}

/** The snapshot's GLM-5.3 endpoint with `over` on top (the plan's endpoint-metadata hook). */
const glm =
  (over: Partial<EndpointInfo>): EndpointSource =>
  (model, endpoint) => {
    const e = SNAPSHOT_ENDPOINTS(model, endpoint);
    return e === undefined ? undefined : { ...e, ...over };
  };

/** A pin `z-ai` that resolves while `z-ai/fp8` is one of its siblings. */
const ambiguous: EndpointSource = (model, endpoint) => {
  const e = SNAPSHOT_ENDPOINTS(model, "z-ai/fp8");
  return endpoint === "z-ai" && e !== undefined
    ? { ...e, tag: "z-ai", siblings: [...e.siblings, "z-ai/fp8"] }
    : undefined;
};

describe("seat checks (review: correctness)", () => {
  test("a --seat override in a comparison lineup takes its defaults.fallbacks; fallbacks on are refused there", () => {
    const plan = planArena(
      {
        fake: true,
        seed: 2,
        idKey: "seed",
        days: 1,
        priceDate: "2026-10-20",
        lineup: "mid-tier",
        seats: ["p1=claude:opus-5-5:medium:odysseus"],
      },
      arenaEnv({}),
    );
    const p1 = plan.seats.find((s) => s.seat === "p1");
    expect(p1?.kind === "llm" && [p1.model, p1.fallbacks]).toEqual(["claude-opus-5-5", "off"]);
    // Priced without the fallback targets: $2.85 at 32,768 tokens, not $9.97.
    expect(plan.prediction.seats[0]?.priceCards).toEqual([
      "anthropic:claude-opus-5-5@2026-10-20",
      "anthropic:claude-opus-5-5@2026-10-20+us",
    ]);
    // Outside a lineup, Opus 5.5 keeps its default (fallbacks on).
    const alone = planArena(
      {
        fake: true,
        seed: 2,
        idKey: "seed",
        days: 1,
        seats: ["p1=claude:opus-5-5:medium:odysseus"],
      },
      arenaEnv({}),
    ).seats.find((s) => s.seat === "p1");
    expect(alone?.kind === "llm" && alone.fallbacks).toBe("default");
    // A comparison lineup whose seat asks for fallbacks is refused.
    const dir = runDir("lineup");
    const file = join(dir, "..", "fallbacks.json");
    const lineup = LineupSchema.parse(
      JSON.parse(readFileSync(join(LINEUPS_DIR, "mid-tier.json"), "utf8")),
    );
    lineup.seats[0] = {
      seat: "p1",
      kind: "llm",
      provider: "anthropic",
      model: "claude-opus-5-5",
      profile: "odysseus@1",
      fallbacks: "default",
    };
    writeFileSync(file, JSON.stringify(lineup));
    expect(planOutcome({ lineup: file })).toContain(
      "is a comparison lineup, but p1 (claude-opus-5-5) would run with server-side fallbacks on",
    );
  });

  test("OpenRouter: zero data retention, the required parameters and full slugs are checked (the metadata hook)", () => {
    const seat = ["p4=openrouter:z-ai/glm-5.3@z-ai/fp8:medium:agamemnon"];
    expect(planOutcome({ seats: seat })).toBe("planned");
    expect(planOutcome({ seats: seat }, { endpoints: glm({ zdr: false }) })).toContain(
      "p4: z-ai/glm-5.3@z-ai/fp8 is not in OpenRouter's zero-data-retention list while the lineup asks zdr",
    );
    const noToolChoice = SNAPSHOT_ENDPOINTS("z-ai/glm-5.3", "z-ai/fp8")?.supportedParams.filter(
      (x) => x !== "tool_choice",
    );
    expect(
      planOutcome({ seats: seat }, { endpoints: glm({ supportedParams: noToolChoice ?? [] }) }),
    ).toContain("does not list tool_choice in its supported parameters");
    // A pin `x` that resolved while a sibling `x/y` exists matches both.
    expect(
      planOutcome(
        { seats: ["p4=openrouter:z-ai/glm-5.3@z-ai:medium:agamemnon"] },
        { endpoints: ambiguous },
      ),
    ).toContain("z-ai is not a full endpoint slug: it also matches z-ai/fp8; pin one of them");
    // A provider slug alone, with the snapshot: the full-slug message, not "not an endpoint".
    expect(planOutcome({ seats: ["p4=openrouter:z-ai/glm-5.3@z-ai:medium:agamemnon"] })).toContain(
      "p4: z-ai is not a full endpoint slug: it matches z-ai/fp8, so routing could change the model's endpoint",
    );
  });

  test("GLM-5.3's effort warning says what medium is sent as (C9, Pass 2: the nearest listed level)", () => {
    // Outside a comparison lineup the nearest listed level is sent, with this warning.
    const plan = planArena(
      {
        fake: true,
        seed: 1,
        idKey: "seed",
        priceDate: "2026-10-20",
        seats: ["p4=openrouter:z-ai/glm-5.3@z-ai/fp8:medium:agamemnon"],
      },
      arenaEnv({}),
    );
    expect(plan.warnings.join("\n")).toContain(
      "p4: OpenRouter lists z-ai/glm-5.3's efforts as max, high, low, default max (models list, 2026-10-20): medium is sent as low, the nearest listed level",
    );
    expect(plan.warnings.join("\n")).toContain(
      "the prediction keeps medium's output factor 1 against low's 0.6, an upper bound; unverified until a smoke records the reasoning tokens",
    );
  });

  test("a comparison lineup refuses an effort the model does not list; the presets name GLM's level (review)", () => {
    expect(
      planOutcome({
        lineup: "mid-tier",
        seats: ["p4=openrouter:z-ai/glm-5.3@z-ai/fp8:medium:agamemnon"],
      }),
    ).toBe(
      "--lineup mid-tier is a comparison lineup, but p4 (z-ai/glm-5.3) would run at medium, an effort the model does not list (max, high, low): its requests would carry low under a medium label; set the seat's effort to one of max, high, low",
    );
    for (const lineup of ["budget-mix", "mid-tier", "mid-tier-flash", "frontier"]) {
      const plan = planArena(
        { fake: true, seed: 1, idKey: "seed", priceDate: "2026-10-20", lineup },
        arenaEnv({}),
      );
      const p4 = plan.seats.find((s) => s.seat === "p4");
      expect([lineup, p4?.kind === "llm" ? p4.effort : null]).toEqual([lineup, "low"]);
      expect(plan.warnings.join("\n")).not.toContain("is sent as");
    }
  });

  test("a compat seat names the card file it needs, which exists", () => {
    expect(planOutcome({ seats: ["p2=compat:llama-4:medium:achilles"] })).toContain(
      "p2: no price card for compat:llama-4 valid at 2026-10-20T00:00Z; add it to packages/orchestrator/src/model/prices/compat.ts",
    );
    expect(existsSync(join(import.meta.dir, "..", "model", "prices", "compat.ts"))).toBe(true);
  });
});

describe("per-seat prompt hashes (review: correctness)", () => {
  test(
    "seats.json hashes each seat's own tools and its channel's rendering of the operator texts",
    async () => {
      const dir = runDir();
      const plan = planArena(
        {
          fake: true,
          seed: 1,
          idKey: "seed",
          days: 1,
          priceDate: "2026-10-20",
          lineup: "mid-tier",
        },
        arenaEnv({}),
      );
      await runArena(plan, { dir, io: memoryIo(), quiet: true });
      const seats = SeatsFileSchema.parse(
        JSON.parse(readFileSync(join(dir, "seats.json"), "utf8")),
      );
      const llm = seats.seats.flatMap((s) => (s.kind === "llm" ? [s] : []));
      expect(llm.map((s) => s.promptVariant)).toEqual([
        "system",
        "developer",
        "envelope",
        "envelope",
      ]);
      const neutral = sha256Hex(canonicalJson(plan.texts.tools));
      for (const s of llm) {
        const provider = s.intended?.provider ?? s.provider;
        expect(s.toolsHash).toBe(sha256Hex(canonicalJson(toolsFor(provider, plan.texts.tools))));
        // Pass 2: Gemini's schema subset (`gemini@1`) shows; the other transforms are the identity.
        if (provider === "google") expect(s.toolsHash).not.toBe(neutral);
        else expect(s.toolsHash).toBe(neutral);
      }
      // The system channel keeps phase 2's hash (prompts.operator); the others differ.
      expect(llm[0]?.operatorHash).toBe(seats.prompts.operator);
      expect(new Set(llm.map((s) => s.operatorHash)).size).toBe(3);
      expect(llm[2]?.operatorHash).toBe(operatorHashOf("envelope"));
      expect(operatorHashOf("system")).toBe(sha256Hex(canonicalJson(operatorTemplates())));
      // The envelope turn header points at the text part above, not at a distinct user turn.
      expect(operatorTemplates("envelope")["turnHeader"]).toContain(
        "The text part above is your briefing",
      );
      expect(operatorTemplates("system")["turnHeader"]).toContain(
        "The user turn above is your briefing",
      );
      expect(toolTransformOf("none")).toBe(IDENTITY_TRANSFORM);
      expect(() => toolTransformOf("gemini@9")).toThrow('no tool transform named "gemini@9"');
    },
    LONG,
  );
});

describe("a usage the ledger cannot price (review: money, nit)", () => {
  test(
    "is charged its seat's attempt bound and logged on a valid line, flagged estimated; the turn goes on",
    async () => {
      const plan = duo(1);
      const bound = plan.prediction.seats.find((p) => p.seat === "p2")?.attemptBoundNanoUsd ?? 0;
      let n = 0;
      const adapterFor = (
        s: LlmSeatPlan,
        spec: ConstructorParameters<typeof FakeAdapter>[0],
        ctx: AdapterContext,
      ) => {
        const inner = botBrain({ label: s.brain, seat: s.seat, seed: ctx.seed, model: s.model });
        return new (class extends FakeAdapter {
          override async chat(req: Parameters<FakeAdapter["chat"]>[0]) {
            const res = await super.chat(req);
            if (s.seat !== "p2") return res;
            n += 1;
            if (n !== 3) return res;
            // A proxy's absurd usage: a missing field (NaN) and an unsafe count.
            const usage: UsageEntry[] = [];
            for (const u of res.usage) {
              usage.push({ ...u, tokens: { ...u.tokens, input: Number.NaN, output: 1e300 } });
            }
            return { ...res, usage };
          }
        })(spec, inner);
      };
      const dir = runDir();
      const out = await runArena(plan, { dir, io: memoryIo(), quiet: true, adapterFor });
      expect(out.status).toBe("ended");
      // Every line parses (readCalls validates it), and the bad attempt's carries the bound.
      const p2 = readCalls(dir).filter((l): l is Call => l.k === "llm_call" && l.seat === "p2");
      const bad = p2.filter((l) => l.costNanoUsd === bound);
      expect(bad).toHaveLength(1);
      expect(bad[0]?.usage.map((u) => [u.input, u.output, u.estimated])).toEqual([[0, 0, true]]);
      expect(bad[0]?.stop).not.toBe("error");
      expect(out.report.budget.estimatedNanoUsd).toBeGreaterThanOrEqual(bound);
    },
    LONG,
  );
});
