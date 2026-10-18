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
  type ModelSpec,
} from "../model/adapter.ts";
import {
  AnthropicAdapter,
  AnthropicClient,
  DEFAULT_BASE_URL,
  type HttpFetch,
} from "../model/anthropic.ts";
import { costOf, formatUsd, requirePrice } from "../model/prices.ts";
import { BRIEFING_TOKENS, PREFIX_TOKENS } from "./cost.ts";
import { anthropicTools } from "../model/tools.ts";
import { PROFILES } from "../seat/personalities.ts";
import { seatPrompt, sharedPrompt, turnHeader } from "../seat/prompt.ts";
import { PreflightError, preflight } from "./preflight.ts";
import { DEFAULT_ARENA_DAYS, MODEL_ALIASES, type ArenaEnv } from "./plan.ts";

// `arena smoke` (phase-2 design §8, §9.2 step 5): one live check of the key, the model and the
// exact request shape, at most `smokeBoundNano` (about $0.20 on Opus 5.5, under a cent on Haiku
// 5.5: the call's output is capped at `SMOKE_MAX_TOKENS`). It refuses to run without
// PERFIDIA_ANTHROPIC_API_KEY. Steps:
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
 * An upper bound of what `arena smoke` costs on `model`, in nano-dollars: the stable prefix and the
 * briefing written to the cache twice at a 25% margin (the pre-warm, then the call as if it read
 * nothing back), and `SMOKE_MAX_TOKENS` of output. `count_tokens` is free.
 */
export function smokeBoundNano(model: string): number {
  const p = requirePrice(model);
  const prompt = Math.ceil(((PREFIX_TOKENS + BRIEFING_TOKENS) * 5) / 4);
  return 2 * prompt * p.write5m + SMOKE_MAX_TOKENS * p.output;
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
  let bound: number;
  try {
    bound = smokeBoundNano(model);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  if (o.env.apiKey === null) {
    throw new UsageError(
      `arena smoke makes one live API call (at most ${formatUsd(bound)} on ${model}): set PERFIDIA_ANTHROPIC_API_KEY first. Nothing was sent.`,
    );
  }
  const effort: Effort = o.effort ?? "low";
  const ruleset = getRuleset(o.ruleset ?? "perfidia-1");
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
  };
  const client = new AnthropicClient({
    apiKey: o.env.apiKey,
    baseURL: o.baseURL ?? o.env.baseURL ?? DEFAULT_BASE_URL,
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

    const input = await firstRoundInput(ruleset, "p1");
    const briefing = {
      role: "user" as const,
      parts: [{ kind: "text" as const, text: canonicalJson(input.briefing) }],
    };
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
