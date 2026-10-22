import { createMatch, getRuleset, type AnyRuleset } from "@perfidia/engine";
import { canonicalJson, idKeyFromSeed } from "@perfidia/engine/core";
import { MemorySink, runMatch, toolDefinitions } from "@perfidia/gateway/runtime";
import type { PlayerId, RoundInput, SeatAgent, TimeSource } from "@perfidia/protocol";
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
} from "../model/adapter.ts";
import {
  AnthropicAdapter,
  AnthropicClient,
  DEFAULT_BASE_URL,
  type HttpFetch,
} from "../model/anthropic.ts";
import { modelInfo, seatModels } from "../model/catalog.ts";
import { cardAt, costOf, formatUsd, requirePrice } from "../model/prices.ts";
import { anthropicTools } from "../model/tools.ts";
import { ENTRY_OVERHEAD_TOKENS, entryTokensUpper } from "../seat/agent.ts";
import { PROFILES } from "../seat/personalities.ts";
import { seatPrompt, sharedPrompt, turnHeader } from "../seat/prompt.ts";
import { promptInfo } from "./prompt-info.ts";
import { defaultFallbacks } from "./lineup.ts";
import { callBound } from "./estimate.ts";
import {
  PREFLIGHT_OUTPUT_TOKENS,
  PreflightError,
  preflight,
  sampleTokensUpper,
} from "./preflight.ts";
import {
  DEFAULT_ARENA_DAYS,
  MIXED_ATTEMPT_TIMEOUT_MS,
  MODEL_ALIASES,
  checkedBaseUrl,
  providerEnv,
  type ArenaEnv,
} from "./plan.ts";
import { PROVIDERS, providerInfo, toolsFor } from "./providers.ts";

// `arena smoke` (phase-2 design §8, §9.2 step 5): one live check of the key, the model and the
// exact request shape, at most `smokeBoundNano` (printed before anything is sent; the call's output
// is capped at `SMOKE_MAX_TOKENS`, with no retry). It refuses to run without
// PERFIDIA_ANTHROPIC_API_KEY, and checks the base URL as `arena run` does. Steps:
// 1. the preflight: `models.retrieve` (with `allowed_fallback_models`) and the production shape at
//    `max_tokens: 0`, which also writes the stable prefix to the cache;
// 2. `count_tokens` of the prefix and a real round-0 briefing (p1 of a fresh perfidia-1 match);
// 3. one real streamed call with that briefing and the turn header: its stop reason, served model,
//    usage and cost are printed; a cache read of 0 after the pre-warm is reported as a warning.

export interface SmokeOptions {
  readonly env: ArenaEnv;
  readonly io: CliIo;
  /** An alias (`haiku-5-5`) or a full id; default `haiku-5-5` (another provider: its smoke model). */
  readonly model?: string;
  readonly effort?: Effort;
  readonly ruleset?: string;
  /** Tests: a stub. */
  readonly fetch?: HttpFetch;
  readonly baseURL?: string;
  /** Pass 2: a provider of the registry with an adapter factory (`openai`); default Anthropic. */
  readonly provider?: string;
  /** Pass 2: the clock of a registry adapter (tests: virtual time); default the system's. */
  readonly time?: TimeSource;
}

/** The smoke call's output limit: room for a first reply, and a small bound on the bill. */
export const SMOKE_MAX_TOKENS = 4_000;

/**
 * An upper bound of what `arena smoke` costs on `model` (phase-4 review: the bound of its real
 * requests, as the arena's attempt bound is): the preflight's shape check (its sample prompt at one
 * token per UTF-8 byte, cold, and the check's output) and the call (its whole prompt, the tools,
 * both system blocks, the briefing and the turn header at one token per byte, cold, and
 * `SMOKE_MAX_TOKENS` of output, no retry), each once more per fallback target, cold, when the
 * model's fallbacks are on (`callBound`). Every price kind the 5-minute request can be billed at
 * counts, US-only inference (1.1×) included. `count_tokens` is free.
 */
export function smokeBoundNano(
  model: string,
  fallbacks: "default" | "off",
  tokens: { readonly sample: number; readonly call: number },
): number {
  return (
    callBound(model, fallbacks, tokens.sample, PREFLIGHT_OUTPUT_TOKENS, {}, { ttl: "5m" }) +
    callBound(model, fallbacks, tokens.call, SMOKE_MAX_TOKENS, {}, { ttl: "5m" })
  );
}

/** The smoke's texts and request, built without the network, and what they can cost. */
export async function smokePlan(
  model: string,
  effort: Effort,
  rulesetRef = "perfidia-1",
): Promise<{
  readonly prompt: StablePrompt;
  readonly tools: readonly ModelTool[];
  readonly input: RoundInput;
  readonly spec: ModelSpec;
  readonly boundNano: number;
}> {
  requirePrice(model);
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
  const tools = anthropicTools(toolDefinitions(ruleset));
  const profile = PROFILES[0];
  if (profile === undefined) throw new Error("no profile");
  const prompt = { shared: sharedPrompt(info, 6), seat: seatPrompt("p1", profile) };
  const spec: ModelSpec = {
    provider: "anthropic",
    model,
    effort,
    maxOutputTokens: SMOKE_MAX_TOKENS,
    cacheTtl: "5m",
    // As the arena plans it (phase 4): Claude Sonnet 5.5 without server-side fallbacks.
    fallbacks: defaultFallbacks(model),
  };
  const input = await firstRoundInput(ruleset, "p1");
  const sample = sampleTokensUpper({ seat: "p1", prompt, tools });
  const call =
    utf8Length(prompt.shared) +
    utf8Length(prompt.seat) +
    utf8Length(JSON.stringify(tools)) +
    3 * ENTRY_OVERHEAD_TOKENS +
    entryTokensUpper(briefingEntry(input)) +
    entryTokensUpper({ role: "operator", text: turnHeader(input) });
  return {
    prompt,
    tools,
    input,
    spec,
    boundNano: smokeBoundNano(model, spec.fallbacks ?? "off", { sample, call }),
  };
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** The round-0 user entry of `input`: its briefing. */
function briefingEntry(input: RoundInput): Entry {
  return { role: "user", parts: [{ kind: "text", text: canonicalJson(input.briefing) }] };
}

/** The first round input of `seat` in a fresh match: what its first wake's request is built from. */
export async function firstRoundInput(ruleset: AnyRuleset, seat: PlayerId): Promise<RoundInput> {
  const setup = harness.setupFor(ruleset, {
    seed: 1,
    players: 6,
    overrides: { "time.matchEnd": 60 },
    idKey: idKeyFromSeed(1),
  });
  let captured: RoundInput | null = null;
  const capture: SeatAgent = {
    label: "smoke:capture@1",
    round(input) {
      captured ??= input;
      return Promise.resolve({ calls: [] });
    },
  };
  const agents = harness.botAgents(setup, ["turtle@3"]);
  agents.set(seat, capture);
  await runMatch({ setup, ruleset, agents, clock: { kind: "lockstep" }, sink: new MemorySink() });
  if (captured === null) throw new Error(`${seat} had no wake in the first minute`);
  return captured;
}

export async function smokeCommand(o: SmokeOptions): Promise<number> {
  if (o.provider !== undefined && o.provider !== "anthropic") return providerSmoke(o, o.provider);
  const io = o.io;
  const alias = o.model ?? "haiku-5-5";
  const model = Object.hasOwn(MODEL_ALIASES, alias) ? (MODEL_ALIASES[alias] ?? alias) : alias;
  const effort: Effort = o.effort ?? "low";
  try {
    requirePrice(model);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const {
    prompt,
    tools,
    input,
    spec,
    boundNano: bound,
  } = await smokePlan(model, effort, o.ruleset ?? "perfidia-1");
  if (o.env.apiKey === null) {
    throw new UsageError(
      `this smoke makes one live API call (at most ${formatUsd(bound)} on ${model}): set PERFIDIA_ANTHROPIC_API_KEY first. Nothing was sent.`,
    );
  }
  // The same check as arena run's (exit 3): no key over http:// off loopback.
  const baseURL = checkedBaseUrl(o.baseURL ?? o.env.baseURL ?? DEFAULT_BASE_URL);
  const client = new AnthropicClient({
    apiKey: o.env.apiKey,
    baseURL,
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
  const adapter = new AnthropicAdapter(spec, client);
  io.out(`smoke: ${adapter.label} on ${client.baseURL}, at most ${formatUsd(bound)}\n`);

  try {
    const pre = await preflight([{ seat: "p1", adapter, prompt, tools }]);
    const r = pre.reports[0];
    io.out(
      `1. preflight: ok; allowed fallbacks: ${r === undefined || r.allowedFallbackModels.length === 0 ? "none" : r.allowedFallbackModels.join(", ")}; shape check and pre-warm cost ${formatUsd(pre.nanoUsd)}\n`,
    );

    const briefing = briefingEntry(input);
    const meta = {
      seat: input.seat,
      turn: input.turn,
      round: 0,
      maxRounds: input.maxRounds,
      maxCalls: input.maxCalls,
      kind: "round" as const,
    };
    const counted = await adapter.countTokens({ prompt, tools, entries: [briefing], meta });
    io.out(
      `2. count_tokens: ${counted} input tokens for the tools, both system blocks and the briefing\n`,
    );

    const req: ChatRequest = {
      prompt,
      tools,
      entries: [briefing, { role: "operator", text: turnHeader(input) }],
      meta,
    };
    const res = await adapter.chat(req);
    const served = servedTokens(res.usage);
    const cost = costOf(res.usage);
    io.out(
      `3. one call: stop ${res.rawStop}, served by ${res.servedBy}${res.fallback ? " (fallback)" : ""}, ${res.latencyMs} ms (first token ${res.ttftMs ?? "?"} ms), request ${res.requestId ?? "?"}\n`,
    );
    io.out(
      `   usage: input ${served.input}, cache write ${served.cacheWrite5m + served.cacheWrite1h}, cache read ${served.cacheRead}, output ${served.output} (prompt ${promptTokens(served)}); cost ${formatUsd(cost.nanoUsd)}\n`,
    );
    io.out(
      `   reply: ${res.reply.calls.length} tool call(s)${res.reply.calls.length === 0 ? "" : ` (${res.reply.calls.map((c) => c.name).join(", ")})`}; text: ${JSON.stringify(res.reply.text.join(" ").slice(0, 200))}\n`,
    );
    if (res.stop === "refusal") {
      io.err(`smoke: the call was refused (${res.refusal?.category ?? "uncategorised"})\n`);
      return EXIT.fatal;
    }
    if (served.cacheRead === 0) {
      io.err(
        "smoke: warning: no cache read after the pre-warm: the stable prefix was not cached (check cache_control and the prompt size)\n",
      );
    }
    io.out("smoke: ok\n");
    return EXIT.ok;
  } catch (e) {
    if (e instanceof PreflightError) {
      io.err(`smoke: ${e.message}\n`);
      return EXIT.usage;
    }
    if (e instanceof ModelError) {
      const status = e.status === null ? "" : ` (${e.status})`;
      io.err(`smoke: ${e.kind}${status}: ${e.message}\n`);
      return EXIT.fatal;
    }
    throw e;
  }
}

/**
 * `arena smoke --provider <p>` (phase 4 Pass 2): the same three steps on a provider whose adapter
 * the registry builds (`create`): the preflight (the model's access, then the production shape at
 * 16 output tokens, charged), the provider's input-token count when it has one, and one streamed
 * call of a real round-0 request (the provider's operator channel) capped at `SMOKE_MAX_TOKENS`,
 * with no retry. Its bound is printed before anything is sent: both requests' prompts at one token
 * per UTF-8 byte, cold, at the dearest prompt-side price of every card valid from now, and their
 * output limits. It needs `PERFIDIA_<PROVIDER>_API_KEY` and checks the base URL as `arena run` does.
 */
async function providerSmoke(o: SmokeOptions, provider: string): Promise<number> {
  const io = o.io;
  const p = providerInfo(provider);
  const smoke = p?.smoke;
  if (p?.create === undefined || smoke === undefined) {
    const known = Object.values(PROVIDERS)
      .filter((x) => x.create !== undefined)
      .map((x) => x.id);
    throw new UsageError(
      `arena smoke --provider ${provider}: this build has no ${provider} adapter (providers: ${["anthropic", ...known].join(", ")})`,
    );
  }
  const model = o.model ?? smoke.model;
  const info = modelInfo(provider, model);
  if (info?.seat !== true) {
    throw new UsageError(
      `--model ${model} is not a ${provider} seat model; a seat runs on ${seatModels(provider)
        .map((m) => m.model)
        .join(", ")}`,
    );
  }
  const effort = o.effort ?? smoke.effort;
  if (!info.capabilities.efforts.includes(effort)) {
    throw new UsageError(
      `--effort: ${model} accepts effort ${info.capabilities.efforts.join(", ")}; got ${effort}`,
    );
  }
  const at = new Date().toISOString();
  if (cardAt(provider, model, null, at) === null) {
    throw new UsageError(
      `no price card for ${provider}:${model} valid at ${at.slice(0, 16)}Z; add it to ${p.pricesFile}`,
    );
  }
  const variant = info.capabilities.operatorChannel;
  const ruleset = getRuleset(o.ruleset ?? "perfidia-1");
  const rules = promptInfo(
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
  const tools = toolsFor(provider, anthropicTools(toolDefinitions(ruleset)));
  const profile = PROFILES[0];
  if (profile === undefined) throw new Error("no profile");
  const prompt = { shared: sharedPrompt(rules, 6, variant), seat: seatPrompt("p1", profile) };
  const input = await firstRoundInput(ruleset, "p1");
  const briefing = briefingEntry(input);
  const header: Entry = { role: "operator", text: turnHeader(input, variant) };
  const sample = sampleTokensUpper({ seat: "p1", prompt, tools }, variant);
  const call =
    utf8Length(prompt.shared) +
    utf8Length(prompt.seat) +
    utf8Length(JSON.stringify(tools)) +
    3 * ENTRY_OVERHEAD_TOKENS +
    entryTokensUpper(briefing) +
    entryTokensUpper(header);
  const k = { provider, endpoint: null, from: at };
  const bound =
    callBound(model, "off", sample, PREFLIGHT_OUTPUT_TOKENS, k) +
    callBound(model, "off", call, SMOKE_MAX_TOKENS, k);
  const pe = providerEnv(o.env, provider);
  if (pe.apiKey === null) {
    throw new UsageError(
      `the ${provider} smoke makes one live API call (at most ${formatUsd(bound)} on ${model}): set ${p.keyVar} first. Nothing was sent.`,
    );
  }
  const base = o.baseURL ?? pe.baseURL ?? p.defaultBaseUrl;
  if (base === null) throw new UsageError(`${p.baseUrlVar} is not set: nothing was sent`);
  const baseURL = checkedBaseUrl(base, p.baseUrlVar);
  const problem = p.baseUrlProblem?.(baseURL) ?? null;
  if (problem !== null) throw new UsageError(problem);
  const spec: ModelSpec = {
    provider,
    model,
    effort,
    maxOutputTokens: SMOKE_MAX_TOKENS,
    cacheTtl: "5m",
    fallbacks: "off",
    ...(info.reasoningContext === null ? {} : { reasoningContext: info.reasoningContext }),
  };
  const adapter = p.create(spec, {
    apiKey: pe.apiKey,
    baseURL,
    time: o.time ?? new harness.SystemTime(),
    timeoutMs: MIXED_ATTEMPT_TIMEOUT_MS,
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
  io.out(`smoke: ${adapter.label} on ${baseURL}, at most ${formatUsd(bound)}\n`);
  const price = (usage: Parameters<typeof costOf>[0]) =>
    costOf(usage, { provider, endpoint: null, at });

  try {
    const pre = await preflight([{ seat: "p1", adapter, prompt, tools }], {
      price: (_g, usage) => price(usage),
    });
    io.out(`1. preflight: ok; model access and shape check cost ${formatUsd(pre.nanoUsd)}\n`);
    const meta = {
      seat: input.seat,
      turn: input.turn,
      round: 0,
      maxRounds: input.maxRounds,
      maxCalls: input.maxCalls,
      kind: "round" as const,
    };
    if (adapter.countTokens === undefined) {
      io.out("2. input tokens: the provider has no count endpoint (skipped)\n");
    } else {
      const counted = await adapter.countTokens({ prompt, tools, entries: [briefing], meta });
      io.out(`2. input tokens: ${counted} for the tools, both stable blocks and the briefing\n`);
    }
    const res = await adapter.chat({ prompt, tools, entries: [briefing, header], meta });
    const served = servedTokens(res.usage);
    const cost = price(res.usage);
    io.out(
      `3. one call: stop ${res.rawStop}, served by ${res.servedBy}, ${res.latencyMs} ms (first token ${res.ttftMs ?? "?"} ms), request ${res.requestId ?? "?"}\n`,
    );
    io.out(
      `   usage: input ${served.input}, cache write ${served.cacheWrite5m + served.cacheWrite1h}, cache read ${served.cacheRead}, output ${served.output}${served.reasoning === undefined ? "" : ` (reasoning ${served.reasoning})`} (prompt ${promptTokens(served)}); cost ${formatUsd(cost.nanoUsd)} at ${cost.cards.join(", ")}\n`,
    );
    io.out(
      `   reply: ${res.reply.calls.length} tool call(s)${res.reply.calls.length === 0 ? "" : ` (${res.reply.calls.map((c) => c.name).join(", ")})`}; ${res.reply.reasoning.length} reasoning summar${res.reply.reasoning.length === 1 ? "y" : "ies"}; text: ${JSON.stringify(res.reply.text.join(" ").slice(0, 200))}\n`,
    );
    if (res.stop === "refusal") {
      io.err(`smoke: the call was refused (${res.refusal?.category ?? "uncategorised"})\n`);
      return EXIT.fatal;
    }
    if (res.stop === "max_tokens") {
      io.err(
        `smoke: warning: the call stopped at its ${SMOKE_MAX_TOKENS}-token limit (no retry in a smoke)\n`,
      );
    }
    if (served.cacheRead === 0) {
      io.err(
        "smoke: warning: no cache read after the preflight: the stable prefix was not cached (check the breakpoint and the prompt size)\n",
      );
    }
    io.out("smoke: ok\n");
    return EXIT.ok;
  } catch (e) {
    if (e instanceof PreflightError) {
      io.err(`smoke: ${e.message}\n`);
      return EXIT.usage;
    }
    if (e instanceof ModelError) {
      const status = e.status === null ? "" : ` (${e.status})`;
      io.err(`smoke: ${e.kind}${status}: ${e.message}\n`);
      return EXIT.fatal;
    }
    throw e;
  }
}
