import { createMatch, getRuleset, type AnyRuleset } from "@perfidia/engine";
import { canonicalJson, idKeyFromSeed } from "@perfidia/engine/core";
import { rulesInfo } from "@perfidia/gateway/present";
import { MemorySink, runMatch, toolDefinitions } from "@perfidia/gateway/runtime";
import type { PlayerId, RoundInput, SeatAgent } from "@perfidia/protocol";
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
import { costOf, formatUsd, requirePrice } from "../model/prices.ts";
import { anthropicTools } from "../model/tools.ts";
import { ENTRY_OVERHEAD_TOKENS, entryTokensUpper } from "../seat/agent.ts";
import { PROFILES } from "../seat/personalities.ts";
import { seatPrompt, sharedPrompt, turnHeader } from "../seat/prompt.ts";
import { defaultFallbacks } from "./lineup.ts";
import { callBound } from "./estimate.ts";
import {
  PREFLIGHT_OUTPUT_TOKENS,
  PreflightError,
  preflight,
  sampleTokensUpper,
} from "./preflight.ts";
import { DEFAULT_ARENA_DAYS, MODEL_ALIASES, checkedBaseUrl, type ArenaEnv } from "./plan.ts";

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
  /** An alias (`haiku-5-5`) or a full id; default `haiku-5-5`. */
  readonly model?: string;
  readonly effort?: Effort;
  readonly ruleset?: string;
  /** Tests: a stub. */
  readonly fetch?: HttpFetch;
  readonly baseURL?: string;
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
  const info = rulesInfo(
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
      `arena smoke makes one live API call (at most ${formatUsd(bound)} on ${model}): set PERFIDIA_ANTHROPIC_API_KEY first. Nothing was sent.`,
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
