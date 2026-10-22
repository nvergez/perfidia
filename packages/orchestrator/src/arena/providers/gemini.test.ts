// Phase 4 Pass 2, Gemini end to end (design §8.5): a real `arena run` (no `--fake`) of one lockstep
// game day with two Gemini seats (4 Argon at medium, 3.8 Flash at low) and four bots, through the
// real adapter and transport, against the local wire stub (`model/gemini-stub.test.ts`) on
// 127.0.0.1, driven by the bots. The stub injects one MAX_TOKENS truncation and one 429 with a
// RetryInfo delay. Checks: Level E; the start preflight; every attempt one request, priced at the
// Google card of its wall-clock start (thoughts as output); the retry at 65,536 tokens; the rate
// limit retried; the budget block; the seats' channel, cadence and transformed tools. Also
// `arena smoke --provider google` against the stub: its bound printed before anything is sent.
// The 1-day match against the wire stub runs in the slow suite (PERFIDIA_SLOW=1,
// docs/architecture.md §13.8: `bun run test:slow`, run by `bun run test:exit`).

import { afterAll, describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "@perfidia/engine/core";
import { memoryIo } from "@perfidia/sim";
import type { LlmCallLine, LlmLogLine } from "../../log/schema.ts";
import {
  errorBody,
  sse,
  startGeminiStub,
  STUB_KEY,
  type StubCall,
} from "../../model/gemini-stub.test.ts";
import { cardAt, costOf } from "../../model/prices.ts";
import { main as arenaMain } from "../cli.ts";
import { arenaEnv, planArena } from "../plan.ts";
import { toolsFor } from "../providers.ts";
import { RULESET, play, runDir } from "../rig.test.ts";
import { runGeminiSmoke } from "./gemini-smoke.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

/** `arena` as the CLI runs it, with no calibration profile unless a test passes `--profiles`. */
const main = (...[argv, io, env, o]: Parameters<typeof arenaMain>) =>
  arenaMain(argv, io, env, { profilesDir: "off", ...o });

const LONG = 180_000;

/** An expectation on a value as `unknown` (a tuple of mixed types). */
const expectLoose = (v: unknown) => expect(v);

const usageOf = (l: LlmCallLine) =>
  l.usage.map((u) => ({
    model: u.model,
    kind: u.kind,
    estimated: u.estimated,
    tokens: {
      input: u.input,
      cacheWrite5m: u.cacheWrite5m,
      cacheWrite1h: u.cacheWrite1h,
      cacheRead: u.cacheRead,
      output: u.output,
    },
  }));

describe("arena run with Gemini seats against the wire stub (one lockstep day)", () => {
  const injected: { max: StubCall | null; limit: StubCall | null } = { max: null, limit: null };
  const stub = startGeminiStub({
    seed: 7,
    // Gemini 3.8 Flash's calls carry no id: the responses are matched by order.
    noIds: new Set(["gemini-3.8-flash"]),
    inject: (c) => {
      if (injected.max === null && c.seat === "p1" && c.turn >= 2 && c.round === 0) {
        injected.max = c;
        return sse([
          {
            candidates: [
              {
                content: { role: "model", parts: [{ text: "Thinking long", thought: true }] },
                finishReason: "MAX_TOKENS",
                index: 0,
              },
            ],
            usageMetadata: {
              promptTokenCount: 9000,
              thoughtsTokenCount: c.maxOutputTokens,
              totalTokenCount: 9000 + c.maxOutputTokens,
            },
            modelVersion: c.model,
          },
        ]);
      }
      if (injected.limit === null && c.seat === "p2" && c.turn >= 2 && c.round === 0) {
        injected.limit = c;
        return new Response(
          JSON.stringify(
            errorBody(429, "RESOURCE_EXHAUSTED", "quota", [
              { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.05s" },
            ]),
          ),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      return null;
    },
  });
  afterAll(() => stub.stop());

  xtest(
    "Level E, every attempt one request priced at its Google card, the retries, the budget held",
    async () => {
      const env = arenaEnv({
        PERFIDIA_GOOGLE_API_KEY: STUB_KEY,
        PERFIDIA_GOOGLE_BASE_URL: stub.url,
      });
      const plan = planArena(
        {
          ruleset: RULESET,
          seed: 7,
          idKey: "seed",
          days: 1,
          seats: [
            "p1=google:gemini-4-argon:medium:odysseus",
            "p2=google:gemini-3.8-flash:low:achilles",
            "p3=bot:expander@2",
            "p4=bot:turtle@3",
          ],
          budgetUsd: "30",
        },
        env,
      );
      expect([plan.fake, plan.time, plan.maxTokens, plan.reminders]).toEqual([
        false,
        "system",
        32_768,
        "last-round",
      ]);
      const t0 = performance.now();
      const run = await play(plan, { dir: runDir("gemini-wire") });
      const ms = Math.round(performance.now() - t0);
      console.log(
        `gemini wire-stub day: ${ms} ms, ${run.llm.length} attempts, ${stub.records.length} requests`,
      );
      expect(stub.problems).toEqual([]);
      expect([run.outcome.status, run.report.levelE?.ok]).toEqual(["ended", true]);

      // The seats: the envelope channel, the comparison cadence, Gemini's tool subset.
      const neutral = sha256Hex(canonicalJson(plan.texts.tools));
      const gemini = sha256Hex(canonicalJson(toolsFor("google", plan.texts.tools)));
      expect(gemini).not.toBe(neutral);
      const seats = run.seats.seats.flatMap((s) => (s.kind === "llm" ? [s] : []));
      expect(
        seats.map((s) => [s.seat, s.label, s.promptVariant, s.reminders, s.toolsHash]),
      ).toEqual([
        [
          "p1",
          "llm:google/gemini-4-argon/medium:odysseus@1:p3-env",
          "envelope",
          "last-round",
          gemini,
        ],
        [
          "p2",
          "llm:google/gemini-3.8-flash/low:achilles@1:p3-env",
          "envelope",
          "last-round",
          gemini,
        ],
      ]);

      // The start preflight: models.get and the shape check per group, priced at the card.
      const pre = run.calls.flatMap((l: LlmLogLine) => (l.k === "preflight" ? [l] : []));
      expect(pre.map((l) => [l.phase, l.provider, l.model, l.ok])).toEqual([
        ["start", "google", "gemini-4-argon", true],
        ["start", "google", "gemini-3.8-flash", true],
      ]);
      for (const l of pre) {
        expect(l.usage[0]?.output).toBe(16);
        const at = l.wallStart ?? "";
        expect(l.priceCard).toBe(cardAt("google", l.model, null, at)?.id ?? "?");
      }

      // One request per attempt: the stub saw exactly the attempts the log lists.
      const streamed = stub.records.filter((r) => r.streamed);
      expect(streamed.length).toBe(run.llm.length);
      expect(stub.records.filter((r) => r.path.endsWith(":generateContent")).length).toBe(2);
      expect(stub.records.filter((r) => r.method === "GET").length).toBe(2);
      for (const r of stub.records) {
        expect(r.headers["x-goog-api-key"]).toBe(STUB_KEY);
        expect(`${r.path}${r.search}`).not.toContain(STUB_KEY);
      }

      // Every attempt priced at the Google card of its wall-clock start, thoughts as output.
      let logged = 0;
      for (const l of run.llm) {
        // An attempt that failed has no reply, so no reasoning kind.
        expect([l.provider, l.reasoningKind ?? "none"]).toEqual([
          "google",
          l.error === null ? "summary" : "none",
        ]);
        const at = l.wallStart ?? "";
        const cost = costOf(usageOf(l), { provider: "google", endpoint: null, at });
        expect([l.seat, l.costNanoUsd, l.priceCard ?? null]).toEqual([
          l.seat,
          cost.nanoUsd,
          l.usage.length === 0 ? null : (cardAt("google", l.model, null, at)?.id ?? "?"),
        ]);
        expect(cost.unpriced).toEqual([]);
        if (l.stop === "tool_use" || l.stop === "end_turn") {
          expect(l.usage[0]?.reasoning).toBe(64);
          expect(l.usage[0]?.output).toBeGreaterThan(64);
        }
      }
      for (const l of run.calls) {
        if (l.k === "llm_call" || l.k === "preflight") logged += l.costNanoUsd;
      }

      // The MAX_TOKENS truncation, retried once at 65,536 output tokens; the 429, retried.
      const max = injected.max;
      const limit = injected.limit;
      if (max === null || limit === null) throw new Error("the stub injected nothing");
      const turn = (seat: string, t: number, round: number) =>
        run.llm.filter((l) => l.seat === seat && l.turn === t && l.round === round);
      expectLoose(turn("p1", max.turn, 0).map((l) => [l.attempt, l.stop, l.maxTokens])).toEqual([
        [1, "max_tokens", 32_768],
        [2, turn("p1", max.turn, 0)[1]?.stop, 65_536],
      ]);
      expect(turn("p1", max.turn, 0)[1]?.stop).toMatch(/^(tool_use|end_turn)$/);
      expect(turn("p1", max.turn, 0)[0]?.usage[0]?.output).toBe(32_768);
      const limited = turn("p2", limit.turn, 0);
      expectLoose(
        limited.map((l) => [l.attempt, l.stop, l.error?.kind ?? null, l.costNanoUsd]),
      ).toEqual([
        [1, "error", "rate_limit", 0],
        [2, limited[1]?.stop, null, limited[1]?.costNanoUsd],
      ]);
      expect(
        streamed
          .filter((r) => r.call?.seat === "p1" && r.call.turn === max.turn && r.call.round === 0)
          .map((r) => r.call?.maxOutputTokens),
      ).toEqual([32_768, 65_536]);

      // The budget block: every figure a sum of logged lines, the budget held.
      expect(run.report.budget.actualNanoUsd).toBe(logged);
      expect([run.report.budget.under, run.report.budget.killSwitch]).toEqual([true, null]);
      expect(run.report.budget.feesNanoUsd).toBe(0);
      expect(logged).toBeGreaterThan(0);
    },
    LONG,
  );
});

describe("arena smoke --provider google (against the wire stub)", () => {
  const stub = startGeminiStub({ seed: 1 });
  afterAll(() => stub.stop());
  const NOW = Date.parse("2026-10-20T12:00:00Z");

  test("prints its bound before sending; the spend stays under it; refused without a key, nothing sent", async () => {
    const io = memoryIo();
    let seenAtFirstLine: number | null = null;
    const out = io.out.bind(io);
    const watched = {
      ...io,
      out: (text: string) => {
        seenAtFirstLine ??= stub.records.length;
        out(text);
      },
    };
    const env = arenaEnv({ PERFIDIA_GOOGLE_API_KEY: STUB_KEY, PERFIDIA_GOOGLE_BASE_URL: stub.url });
    const r = await runGeminiSmoke({
      env,
      io: watched,
      model: "gemini-4-argon",
      effort: "low",
      now: () => NOW,
    });
    expect([r.code, io.stderr()]).toEqual([0, ""]);
    expectLoose(seenAtFirstLine).toBe(0);
    const lines = io.stdout().split("\n");
    expect(lines[0]).toMatch(
      /^smoke: google\/gemini-4-argon\/low on http:\/\/127\.0\.0\.1:\d+, at most \$0\.\d+$/,
    );
    expect(lines.slice(1, 4).map((l) => l.slice(0, 16))).toEqual([
      "1. preflight: ok",
      "2. countTokens: ",
      "3. one call: fin",
    ]);
    expect(r.spentNanoUsd).toBeGreaterThan(0);
    expect(r.spentNanoUsd).toBeLessThanOrEqual(r.boundNano);
    // models.get, the shape check, countTokens and the call: four requests, one stream.
    expect(stub.records.map((x) => x.path.split(":")[1] ?? x.method)).toEqual([
      "GET",
      "generateContent",
      "countTokens",
      "streamGenerateContent",
    ]);
    expect(stub.problems).toEqual([]);

    // Without the key: the bound and the variable named, exit 3, nothing sent.
    const before = stub.records.length;
    const cli = memoryIo();
    const code = await main(["smoke", "--provider", "gemini", "--model", "gemini-3.8-flash"], cli, {
      PERFIDIA_GOOGLE_BASE_URL: stub.url,
    });
    expect(code).toBe(3);
    expect(cli.stderr()).toMatch(
      /arena smoke: the google smoke makes one live API call \(at most \$0\.\d+ on gemini-3\.8-flash\): set PERFIDIA_GOOGLE_API_KEY first\. Nothing was sent\./,
    );
    expect(stub.records.length).toBe(before);
    // An effort the model does not take, and another provider's smoke: usage errors.
    const bad = memoryIo();
    expect(await main(["smoke", "--provider", "google", "--effort", "max"], bad, {})).toBe(3);
    expect(bad.stderr()).toContain(
      "--effort: gemini-3.8-flash takes the efforts low, medium, high",
    );
    const other = memoryIo();
    expect(await main(["smoke", "--provider", "mistral"], other, {})).toBe(3);
    expect(other.stderr()).toContain(
      '--provider must be anthropic, openai, google (gemini) or openrouter, got "mistral"',
    );
  });
});
