import { createMatch, getRuleset } from "@perfidia/engine";
import { canonicalJson, idKeyFromSeed } from "@perfidia/engine/core";
import { toolDefinitions } from "@perfidia/gateway/runtime";
import type { RoundInput, TimeSource } from "@perfidia/protocol";
import { EXIT, UsageError, harness, type CliIo } from "@perfidia/sim";
import {
  ModelError,
  promptTokens,
  servedTokens,
  type ChatRequest,
  type Effort,
  type Entry,
  type ModelSpec,
  type ModelTool,
  type StablePrompt,
} from "../../model/adapter.ts";
import { capabilitiesFor, seatModels } from "../../model/catalog.ts";
import {
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_PREFLIGHT_OUTPUT_TOKENS,
  GeminiAdapter,
  GeminiClient,
} from "../../model/gemini.ts";
import type { HttpFetch } from "../../model/http.ts";
import { cardAt, costOf, formatUsd } from "../../model/prices.ts";
import { modelTools } from "../../model/tools.ts";
import { ENTRY_OVERHEAD_TOKENS } from "../../seat/agent.ts";
import { PROFILES } from "../../seat/personalities.ts";
import { seatPrompt, sharedPrompt, turnHeader } from "../../seat/prompt.ts";
import { promptInfo } from "../prompt-info.ts";
import { callBound } from "../estimate.ts";
import { PreflightError, preflight, sampleRequest } from "../preflight.ts";
import { DEFAULT_ARENA_DAYS, checkedBaseUrl, providerEnv, type ArenaEnv } from "../plan.ts";
import { toolsFor } from "../providers.ts";
import { SMOKE_MAX_TOKENS, firstRoundInput } from "../smoke.ts";

// `arena smoke --provider google` (phase-4 design §5.7, Pass 2): one live check of the Gemini key,
// the model and the exact request shape, at most `boundNano` (printed before anything is sent):
// 1. the preflight: `models.get` and the production shape at 16 output tokens (tools in Gemini's
//    schema subset, thinking config, a `[harness]` part);
// 2. `models.countTokens` of the tools, both system blocks and a real round-0 briefing (p1 of a
//    fresh perfidia-1 match);
// 3. one real streamed call with that briefing and the turn header, at most `maxTokens` of output
//    (thinking included), no retry: its finish reason, served model, usage and cost are printed.
// Refused without PERFIDIA_GOOGLE_API_KEY (nothing is sent); the base URL is checked as `arena run`
// checks it.

/** The cheapest Gemini seat model: the smoke's default. */
export const GEMINI_SMOKE_MODEL = "gemini-3.8-flash";

const utf8 = new TextEncoder();
const bytes = (v: unknown): number => utf8.encode(JSON.stringify(v)).length;

/** The round-0 user entry of `input`: its briefing. */
const briefingEntry = (input: RoundInput): Entry => ({
  role: "user",
  parts: [{ kind: "text", text: canonicalJson(input.briefing) }],
});

/**
 * An upper bound of a request's prompt tokens: one token per UTF-8 byte of the body Gemini gets
 * (its JSON syntax included), plus a part overhead per content part.
 */
export function requestTokensUpper(adapter: GeminiAdapter, req: ChatRequest): number {
  const body = adapter.build(req);
  const parts = body.contents.reduce((n, c) => n + c.parts.length, 0) + 2;
  return bytes(body) + parts * ENTRY_OVERHEAD_TOKENS;
}

export interface GeminiSmokePlan {
  readonly prompt: StablePrompt;
  readonly tools: readonly ModelTool[];
  readonly input: RoundInput;
  readonly spec: ModelSpec;
  /** The call's request (briefing and turn header). */
  readonly call: ChatRequest;
  /** The preflight's shape check. */
  readonly sample: ChatRequest;
}

/** The smoke's texts and requests, built without the network. */
export async function geminiSmokePlan(
  model: string,
  effort: Effort,
  maxTokens: number,
  rulesetRef = "perfidia-1",
): Promise<GeminiSmokePlan> {
  const ruleset = getRuleset(rulesetRef);
  const info = promptInfo(
    createMatch(
      harness.setupFor(ruleset, {
        seed: 1,
        players: 6,
        days: DEFAULT_ARENA_DAYS,
        idKey: idKeyFromSeed(1),
      }),
      ruleset,
    ),
  );
  const tools = toolsFor("google", modelTools(toolDefinitions(ruleset)));
  const profile = PROFILES[0];
  if (profile === undefined) throw new Error("no profile");
  const variant = capabilitiesFor("google", model).operatorChannel;
  const prompt = { shared: sharedPrompt(info, 6, variant), seat: seatPrompt("p1", profile) };
  const spec: ModelSpec = {
    provider: "google",
    model,
    effort,
    maxOutputTokens: maxTokens,
    cacheTtl: "5m",
    fallbacks: "off",
  };
  const input = await firstRoundInput(ruleset, "p1");
  const meta = {
    seat: input.seat,
    turn: input.turn,
    round: 0,
    maxRounds: input.maxRounds,
    maxCalls: input.maxCalls,
    kind: "round" as const,
  };
  const call: ChatRequest = {
    prompt,
    tools,
    entries: [briefingEntry(input), { role: "operator", text: turnHeader(input, variant) }],
    meta,
  };
  return {
    prompt,
    tools,
    input,
    spec,
    call,
    sample: sampleRequest({ seat: "p1", prompt, tools }, variant),
  };
}

/**
 * The most the smoke can cost on `model` from `at` on: the shape check (its body's bytes, cold, 16
 * output tokens), the count (not billed, the billing page says; counted anyway, as input) and the
 * call (its body's bytes, cold, `maxTokens` of output, no retry), every price kind of every card
 * valid from `at` on.
 */
export function geminiSmokeBoundNano(
  adapter: GeminiAdapter,
  plan: GeminiSmokePlan,
  at: string,
): number {
  const k = { provider: "google", endpoint: null, from: at };
  const model = plan.spec.model;
  const sample = { ...plan.sample, maxOutputTokens: GEMINI_PREFLIGHT_OUTPUT_TOKENS };
  const call = requestTokensUpper(adapter, plan.call);
  return (
    callBound(
      model,
      "off",
      requestTokensUpper(adapter, sample),
      GEMINI_PREFLIGHT_OUTPUT_TOKENS,
      k,
    ) +
    callBound(model, "off", call, 0, k) +
    callBound(model, "off", call, plan.spec.maxOutputTokens, k)
  );
}

export interface GeminiSmokeOptions {
  readonly env: ArenaEnv;
  readonly io: CliIo;
  /** A Gemini seat model; default `gemini-3.8-flash`. */
  readonly model?: string;
  /** Default `low`. */
  readonly effort?: Effort;
  readonly ruleset?: string;
  /** The call's output limit (thinking included); default `SMOKE_MAX_TOKENS`. */
  readonly maxTokens?: number;
  /** Tests: a stub (the guard still applies). */
  readonly fetch?: HttpFetch;
  /** Default the system clock. */
  readonly time?: TimeSource;
  /** The wall clock in ms (the price instant); default `Date.now`. */
  readonly now?: () => number;
}

export interface GeminiSmokeOutcome {
  readonly code: number;
  /** What the smoke cost (the preflight and the call, at the cards of `now`). */
  readonly spentNanoUsd: number;
  readonly boundNano: number;
}

/** `arena smoke --provider google`: the exit code. */
export async function geminiSmokeCommand(o: GeminiSmokeOptions): Promise<number> {
  return (await runGeminiSmoke(o)).code;
}

export async function runGeminiSmoke(o: GeminiSmokeOptions): Promise<GeminiSmokeOutcome> {
  const io = o.io;
  const model = o.model ?? GEMINI_SMOKE_MODEL;
  const effort: Effort = o.effort ?? "low";
  const maxTokens = o.maxTokens ?? SMOKE_MAX_TOKENS;
  const at = new Date((o.now ?? Date.now)()).toISOString();
  const models = seatModels("google").map((m) => m.model);
  if (!models.includes(model)) {
    throw new UsageError(
      `--model: ${model} is not a Gemini seat model; one of ${models.join(", ")}`,
    );
  }
  if (cardAt("google", model, null, at) === null) {
    throw new UsageError(
      `no price card for google:${model} valid at ${at.slice(0, 16)}Z; add it to packages/orchestrator/src/model/prices/google.ts`,
    );
  }
  const accepted = capabilitiesFor("google", model).efforts;
  if (!accepted.includes(effort)) {
    throw new UsageError(
      `--effort: ${model} takes the efforts ${accepted.join(", ")} (Gemini's thinkingLevel), got "${effort}"`,
    );
  }
  const pe = providerEnv(o.env, "google");
  // The same check as arena run's (exit 3): no key over http:// off loopback.
  const baseURL = checkedBaseUrl(pe.baseURL ?? GEMINI_DEFAULT_BASE_URL, "PERFIDIA_GOOGLE_BASE_URL");
  const plan = await geminiSmokePlan(model, effort, maxTokens, o.ruleset ?? "perfidia-1");
  const time = o.time ?? new harness.SystemTime();
  // The bound needs only the request bytes: a client with a placeholder key builds them.
  const builder = new GeminiAdapter(
    plan.spec,
    new GeminiClient({ apiKey: "unused", baseURL, time }),
  );
  const boundNano = geminiSmokeBoundNano(builder, plan, at);
  if (pe.apiKey === null) {
    throw new UsageError(
      `the google smoke makes one live API call (at most ${formatUsd(boundNano)} on ${model}): set PERFIDIA_GOOGLE_API_KEY first. Nothing was sent.`,
    );
  }
  const client = new GeminiClient({
    apiKey: pe.apiKey,
    baseURL,
    time,
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
  const adapter = new GeminiAdapter(plan.spec, client);
  io.out(`smoke: ${adapter.label} on ${client.origin}, at most ${formatUsd(boundNano)}\n`);
  const price = (usage: Parameters<typeof costOf>[0]) =>
    costOf(usage, { provider: "google", endpoint: null, at });
  let spent = 0;
  try {
    const pre = await preflight([{ seat: "p1", adapter, prompt: plan.prompt, tools: plan.tools }], {
      price: (_g, usage) => price(usage),
      // Counted as soon as known, a failed check included.
      onGroup: (g) => {
        spent += g.nanoUsd;
      },
    });
    io.out(
      `1. preflight: ok (models.get, shape check at ${GEMINI_PREFLIGHT_OUTPUT_TOKENS} output tokens); cost ${formatUsd(pre.nanoUsd)}\n`,
    );
    const counted = await adapter.countTokens({
      ...plan.call,
      entries: [plan.call.entries[0] ?? briefingEntry(plan.input)],
    });
    io.out(
      `2. countTokens: ${counted} input tokens for the tools, both system blocks and the briefing\n`,
    );
    const res = await adapter.chat(plan.call);
    const cost = price(res.usage);
    spent += cost.nanoUsd;
    const served = servedTokens(res.usage);
    io.out(
      `3. one call: finish ${res.rawStop}, served by ${res.servedBy}, ${res.latencyMs} ms (first part ${res.ttftMs ?? "?"} ms), response ${res.requestId ?? "?"}\n`,
    );
    io.out(
      `   usage: input ${served.input}, cache read ${served.cacheRead}, output ${served.output} (thoughts ${served.reasoning ?? 0}; prompt ${promptTokens(served)})${res.usage.some((u) => u.estimated) ? ", estimated" : ""}; cost ${formatUsd(cost.nanoUsd)} (${cost.cards.join(", ")})\n`,
    );
    io.out(
      `   reply: ${res.reply.calls.length} tool call(s)${res.reply.calls.length === 0 ? "" : ` (${res.reply.calls.map((c) => c.name).join(", ")})`}; ${res.reply.reasoning.length} thought summary block(s); text: ${JSON.stringify(res.reply.text.join(" ").slice(0, 200))}\n`,
    );
    if (res.stop === "refusal") {
      io.err(`smoke: the call was refused (${res.refusal?.category ?? "uncategorised"})\n`);
      return { code: EXIT.fatal, spentNanoUsd: spent, boundNano };
    }
    if (cost.unpriced.length > 0) {
      io.err(`smoke: served as ${cost.unpriced.join(", ")}, which no card prices: add its card\n`);
      return { code: EXIT.fatal, spentNanoUsd: spent, boundNano };
    }
    io.out(`smoke: ok (spent ${formatUsd(spent)} of at most ${formatUsd(boundNano)})\n`);
    return { code: EXIT.ok, spentNanoUsd: spent, boundNano };
  } catch (e) {
    if (e instanceof PreflightError) {
      io.err(`smoke: ${e.message}\n`);
      return { code: EXIT.usage, spentNanoUsd: spent, boundNano };
    }
    if (e instanceof ModelError) {
      const status = e.status === null ? "" : ` (${e.status})`;
      spent += price(e.spent).nanoUsd;
      io.err(`smoke: ${e.kind}${status}: ${e.message}\n`);
      return { code: EXIT.fatal, spentNanoUsd: spent, boundNano };
    }
    throw e;
  }
}
