import { createMatch, getRuleset } from "@perfidia/engine";
import { canonicalJson, idKeyFromSeed } from "@perfidia/engine/core";
import { rulesInfo } from "@perfidia/gateway/present";
import { toolDefinitions } from "@perfidia/gateway/runtime";
import type { Effort, TimeSource } from "@perfidia/protocol";
import { EXIT, UsageError, harness, type CliIo } from "@perfidia/sim";
import {
  ModelError,
  promptTokens,
  servedTokens,
  type ChatRequest,
  type Entry,
  type ModelSpec,
} from "../../model/adapter.ts";
import {
  CATALOG_CHECKED,
  capabilitiesFor,
  endpointInfo,
  modelInfo,
  seatModels,
  type EndpointInfo,
} from "../../model/catalog.ts";
import { CompatAdapter, effortSent, sentParams } from "../../model/compat.ts";
import {
  fetchWithTimeout,
  guardedFetch,
  transportError,
  type HttpFetch,
} from "../../model/http.ts";
import { cardAt, costOf, effectivePrices, formatUsd } from "../../model/prices.ts";
import { modelTools } from "../../model/tools.ts";
import {
  EndpointsResponseSchema,
  ZdrResponseSchema,
  type EndpointPricing,
  type PublicEndpoint,
} from "../../model/wire/compat.ts";
import { ENTRY_OVERHEAD_TOKENS, entryTokensUpper } from "../../seat/agent.ts";
import { PROFILES } from "../../seat/personalities.ts";
import { seatPrompt, sharedPrompt, turnHeader } from "../../seat/prompt.ts";
import { callBound } from "../estimate.ts";
import {
  MIN_CONTEXT_TOKENS,
  checkedBaseUrl,
  llmSeatsOf,
  planArena,
  providerEnv,
  type ArenaEnv,
  type ArenaPlan,
  type ArenaRequest,
  type PlanOptions,
} from "../plan.ts";
import {
  PREFLIGHT_OUTPUT_TOKENS,
  PreflightError,
  preflight,
  sampleTokensUpper,
} from "../preflight.ts";
import { PROVIDERS, REQUIRED_PARAMS, toolsFor, type EndpointSource } from "../providers.ts";
import { SMOKE_MAX_TOKENS, firstRoundInput } from "../smoke.ts";
import { ENDPOINT_PROVIDERS, ENDPOINT_PROVIDERS_CHECKED, openrouterPin } from "./compat.ts";

// OpenRouter in the arena (phase-4 design §2.5, Pass 2):
//
// - `planLive`: `arena run` plans a real run with OpenRouter seats on OpenRouter's live metadata,
//   fetched at plan time behind the plan's `EndpointSource` hook (the 2026-10-20 snapshot of
//   `model/catalog.ts` stays the source of `arena estimate`, `--fake` and the tests): each pinned
//   endpoint's `/models/{id}/endpoints` record and the public ZDR list. On top of the plan's own
//   checks (full slug, needed parameters, ZDR), the live record must not bill more than the seat's
//   price card (else the run is refused: the ledger would under-charge), list every parameter the
//   request sends and `tool_choice: auto`, keep the limits, and name the provider the served-endpoint
//   check expects. Nothing is sent to a model; a metadata request that fails refuses the run.
// - `openrouterPin` (in `./compat.ts`): what the adapter knows of a seat's endpoint (`ENDPOINT_PROVIDERS` names the
//   provider the routing metadata must show).
// - `smokeOpenRouter`: `arena smoke --provider openrouter`, one live check printed with its bound
//   before anything is sent.

export { ENDPOINT_PROVIDERS, ENDPOINT_PROVIDERS_CHECKED, openrouterPin };

/** The OpenRouter base URL of an environment, checked (https, or http on loopback). */
export function openrouterBase(env: ArenaEnv): string {
  const p = PROVIDERS.openrouter;
  return checkedBaseUrl(
    providerEnv(env, "openrouter").baseURL ?? p.defaultBaseUrl ?? "",
    p.baseUrlVar,
  );
}

/** A model id as URL path segments (`z-ai/glm-5.3` stays two segments, each encoded). */
export const modelPath = (model: string): string =>
  model.split("/").map(encodeURIComponent).join("/");

// Live metadata --------------------------------------------------------------------------------

/** What OpenRouter says of one pinned endpoint at plan time. */
export interface LiveEndpoint {
  /** For the plan's hook. */
  readonly info: EndpointInfo;
  readonly providerName: string;
  readonly pricing: EndpointPricing;
  readonly toolChoiceAuto: boolean | null;
  readonly status: number | null;
  readonly uptime30m: number | null;
}

export interface LiveMetadata {
  /** By `model@tag`. */
  readonly endpoints: ReadonlyMap<string, LiveEndpoint>;
  readonly source: EndpointSource;
}

export interface LiveOptions {
  /** The OpenRouter base URL (checked). */
  readonly baseURL: string;
  /** Tests: a stub (through the guarded transport). */
  readonly fetch?: HttpFetch;
  readonly time?: TimeSource;
  readonly timeoutMs?: number;
  /** The UTC date the records are stamped with (`checked`). */
  readonly checked: string;
}

const pinKey = (model: string, tag: string): string => `${model}@${tag}`;

/** One public JSON document of OpenRouter (no key is sent: the metadata is public). */
async function getJson(f: HttpFetch, url: string, o: LiveOptions): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      f,
      url,
      { method: "GET", headers: { accept: "application/json" } },
      { time: o.time ?? new harness.SystemTime(), timeoutMs: o.timeoutMs ?? 60_000 },
    );
  } catch (e) {
    throw new UsageError(
      `OpenRouter's metadata could not be read (${url}): ${transportError(e).message}; nothing was sent to a model`,
    );
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new UsageError(
      `OpenRouter's metadata answered HTTP ${res.status} (${url}); nothing was sent to a model`,
    );
  }
  try {
    const v: unknown = JSON.parse(text);
    return v;
  } catch {
    throw new UsageError(`OpenRouter's metadata is not JSON (${url}); nothing was sent to a model`);
  }
}

/**
 * The live records of `pins` (`/models/{id}/endpoints` once per model) and the public ZDR list
 * (`/endpoints/zdr`), as the plan's `EndpointSource` and per-endpoint details.
 */
export async function fetchLiveEndpoints(
  pins: readonly { readonly model: string; readonly endpoint: string }[],
  o: LiveOptions,
): Promise<LiveMetadata> {
  const base = o.baseURL.replace(/\/+$/, "");
  const f = guardedFetch({
    baseURL: base,
    auth: null,
    allowHeaders: /^accept$/,
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
  const zdrUrl = `${base}/endpoints/zdr`;
  const zdr = ZdrResponseSchema.safeParse(await getJson(f, zdrUrl, o));
  if (!zdr.success) {
    throw new UsageError(`OpenRouter's ZDR list does not match its schema (${zdrUrl})`);
  }
  const zdrSet = new Set(zdr.data.data.map((e) => pinKey(e.model_id, e.tag)));
  const endpoints = new Map<string, LiveEndpoint>();
  for (const model of new Set(pins.map((p) => p.model))) {
    const url = `${base}/models/${modelPath(model)}/endpoints`;
    // oxlint-disable-next-line no-await-in-loop -- a few models, one request each
    const parsed = EndpointsResponseSchema.safeParse(await getJson(f, url, o));
    if (!parsed.success) {
      throw new UsageError(`OpenRouter's endpoints of ${model} do not match their schema (${url})`);
    }
    const all: readonly PublicEndpoint[] = parsed.data.data.endpoints;
    for (const e of all) {
      endpoints.set(pinKey(model, e.tag), {
        info: {
          tag: e.tag,
          quantization: e.quantization ?? "unknown",
          contextTokens: e.context_length,
          maxCompletionTokens: e.max_completion_tokens ?? e.context_length,
          supportedParams: e.supported_parameters,
          implicitCaching: e.supports_implicit_caching === true,
          zdr: zdrSet.has(pinKey(model, e.tag)),
          siblings: all.filter((x) => x.tag !== e.tag).map((x) => x.tag),
          source: `${url} and ${zdrUrl}`,
          checked: o.checked,
        },
        providerName: e.provider_name,
        pricing: e.pricing,
        toolChoiceAuto: e.supports_tool_choice?.auto ?? null,
        status: e.status ?? null,
        uptime30m: e.uptime_last_30m ?? null,
      });
    }
  }
  return {
    endpoints,
    source: (model, endpoint) => endpoints.get(pinKey(model, endpoint))?.info,
  };
}

/**
 * USD per token as the endpoints JSON writes it, in integer pico-dollars per token, rounded up
 * (a comparison with a card then errs on the side of refusing).
 */
export function usdPerTokenToPico(text: string): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null) throw new Error(`not a price: ${JSON.stringify(text)}`);
  const frac = m[2] ?? "";
  const head = Number(frac.slice(0, 12).padEnd(12, "0"));
  const rest = /[1-9]/.test(frac.slice(12)) ? 1 : 0;
  return Number(m[1]) * 1e12 + head + rest;
}

/**
 * The endpoint pricing keys OpenRouter documents (the endpoints list's `pricing` schema, read
 * 2026-10-20) that a seat's requests can never be billed: no image, audio or web search is sent.
 * Any other key with a price is one the plan cannot compare with a card: refused.
 */
const UNUSED_PRICE_KEYS: ReadonlySet<string> = new Set([
  "image",
  "image_token",
  "image_output",
  "audio",
  "audio_output",
  "input_audio_cache",
  "web_search",
]);

/** The keys a card is compared with (`livePrices`), and the ones that are not prices. */
const COMPARED_KEYS: ReadonlySet<string> = new Set([
  "prompt",
  "completion",
  "input_cache_read",
  "input_cache_write",
  "input_cache_write_1h",
  "internal_reasoning",
  "request",
  "discount",
  "overrides",
]);

/** Priced keys of an endpoint the plan neither compares nor knows unused (zero prices ignored). */
export function unknownPriceKeys(p: EndpointPricing): string[] {
  const out: string[] = [];
  const check = (record: Readonly<Record<string, unknown>>): void => {
    for (const [k, v] of Object.entries(record)) {
      if (COMPARED_KEYS.has(k) || UNUSED_PRICE_KEYS.has(k) || out.includes(k)) continue;
      // Override conditions are not prices.
      if (typeof v !== "string" || !/^\d+(?:\.\d+)?$/.test(v)) continue;
      if (usdPerTokenToPico(v) > 0) out.push(k);
    }
  };
  check(p);
  for (const o of p.overrides ?? []) check(o);
  return out;
}

/** Per price kind, the highest of the base price and every override (pico-dollars per token). */
function livePrices(p: EndpointPricing): Readonly<Record<string, number>> {
  const kinds = [
    "prompt",
    "completion",
    "input_cache_read",
    "input_cache_write",
    "input_cache_write_1h",
    "internal_reasoning",
  ] as const;
  const out: Record<string, number> = {};
  for (const k of kinds) {
    let v = p[k] === undefined ? 0 : usdPerTokenToPico(p[k]);
    for (const o of p.overrides ?? []) {
      const x: unknown = o[k];
      if (typeof x === "string") v = Math.max(v, usdPerTokenToPico(x));
    }
    out[k] = v;
  }
  out["request"] = p.request === undefined ? 0 : usdPerTokenToPico(p.request);
  return out;
}

const perM = (pico: number): string => `$${(pico / 1e6).toFixed(6).replace(/\.?0+$/, "")}/M`;

/**
 * The plan-time checks of a real run's OpenRouter seats against the live records (the plan's own
 * checks have run on them): refusals throw `UsageError` (exit 3, nothing written); warnings are
 * returned.
 */
export function liveChecks(plan: ArenaPlan, live: LiveMetadata): string[] {
  const warnings: string[] = [];
  for (const s of llmSeatsOf(plan)) {
    if (s.provider !== "openrouter" || s.endpoint === null) continue;
    const at = `${s.seat}: ${s.model}@${s.endpoint}`;
    const e = live.endpoints.get(pinKey(s.model, s.endpoint));
    if (e === undefined) throw new UsageError(`${at} is not in OpenRouter's live /endpoints list`);
    const expected = ENDPOINT_PROVIDERS[s.endpoint];
    if (expected === undefined || expected.toLowerCase() !== e.providerName.toLowerCase()) {
      throw new UsageError(
        `${at}: OpenRouter names its provider "${e.providerName}"${expected === undefined ? ", and no provider name is recorded for this endpoint" : `, not "${expected}"`}: the served-endpoint check compares the routing metadata with it; set ENDPOINT_PROVIDERS in packages/orchestrator/src/arena/providers/compat.ts`,
      );
    }
    const sent = sentParams(
      "openrouter",
      capabilitiesFor("openrouter", s.model, s.endpoint).supportedParams,
    );
    const missing = [...new Set([...REQUIRED_PARAMS, ...sent])].filter(
      (p) => !e.info.supportedParams.includes(p),
    );
    if (missing.length > 0) {
      throw new UsageError(
        `${at} no longer lists ${missing.join(", ")} in its supported parameters (live /endpoints): the request sends them with require_parameters, so OpenRouter would refuse every call`,
      );
    }
    if (e.toolChoiceAuto === false) {
      throw new UsageError(`${at} does not take tool_choice "auto" (live /endpoints)`);
    }
    if (e.info.contextTokens < MIN_CONTEXT_TOKENS) {
      throw new UsageError(
        `${at} has a context of ${e.info.contextTokens} tokens, under ${MIN_CONTEXT_TOKENS}`,
      );
    }
    if (e.info.maxCompletionTokens < 2 * plan.maxTokens) {
      throw new UsageError(
        `${at} returns at most ${e.info.maxCompletionTokens} output tokens (live /endpoints), under twice maxTokens ${plan.maxTokens} (the max_tokens retry): lower maxTokens`,
      );
    }
    const card = cardAt("openrouter", s.model, s.endpoint, plan.priceAt);
    if (card === null) throw new UsageError(`${at}: no price card valid at ${plan.priceAt}`);
    const c = effectivePrices(card);
    const p = livePrices(e.pricing);
    const pairs: readonly (readonly [string, number, number])[] = [
      ["prompt", p["prompt"] ?? 0, c.input],
      ["completion", p["completion"] ?? 0, c.output],
      ["cache read", p["input_cache_read"] ?? 0, c.cacheRead],
      ["cache write", p["input_cache_write"] ?? 0, c.write5m],
      ["1-hour cache write", p["input_cache_write_1h"] ?? 0, c.write1h],
      // Reasoning tokens are billed as output by the cards: a dearer reasoning price is not covered.
      ["internal reasoning", p["internal_reasoning"] ?? 0, c.output],
    ];
    const dearer = pairs.filter(([, liveP, cardP]) => liveP > cardP);
    const unknown = unknownPriceKeys(e.pricing);
    if (dearer.length > 0 || (p["request"] ?? 0) > 0 || unknown.length > 0) {
      const what = [
        ...dearer.map(([k, liveP, cardP]) => `${k} ${perM(liveP)} (the card: ${perM(cardP)})`),
        ...((p["request"] ?? 0) > 0 ? ["a per-request price (no card has one)"] : []),
        ...unknown.map((k) => `a price "${k}" no card knows`),
      ];
      throw new UsageError(
        `${at}: OpenRouter now bills ${what.join(", ")}, over the card ${card.id}: the ledger would charge less than the bill; update packages/orchestrator/src/model/prices/openrouter.ts with its source and date (nothing was sent)`,
      );
    }
    const cheaper = pairs.filter(([, liveP, cardP]) => liveP < cardP && liveP > 0);
    if (cheaper.length > 0) {
      warnings.push(
        `${at}: OpenRouter now bills less than the card ${card.id} (${cheaper.map(([k, liveP, cardP]) => `${k} ${perM(liveP)} < ${perM(cardP)}`).join(", ")}): the ledger over-charges, and arena reconcile shows by how much`,
      );
    }
    if (e.status !== null && e.status < 0) {
      warnings.push(
        `${at}: OpenRouter reports the endpoint's status ${e.status} (uptime over the last 30 min: ${e.uptime30m ?? "?"}%): it may be down, and the pin allows no other endpoint`,
      );
    }
    const snap = endpointInfo(s.model, s.endpoint);
    if (snap !== undefined && snap.quantization !== e.info.quantization) {
      warnings.push(
        `${at}: the live quantization is ${e.info.quantization}, the ${snap.checked} snapshot's ${snap.quantization}`,
      );
    }
  }
  return warnings;
}

/** An endpoint record that passes every plan check: the first plan only collects the pins. */
function permissive(model: string, endpoint: string): EndpointInfo {
  return {
    tag: endpoint,
    quantization: "unknown",
    contextTokens: Number.MAX_SAFE_INTEGER,
    maxCompletionTokens: Number.MAX_SAFE_INTEGER,
    supportedParams: [...REQUIRED_PARAMS, "parallel_tool_calls"],
    implicitCaching: true,
    zdr: true,
    siblings: [],
    source: `plan-time placeholder for ${model}@${endpoint}`,
    checked: CATALOG_CHECKED,
  };
}

export interface PlanLiveOptions extends PlanOptions {
  readonly fetch?: HttpFetch;
  readonly time?: TimeSource;
}

/**
 * `planArena` for `arena run`: a real run with OpenRouter seats is planned on OpenRouter's live
 * metadata (the endpoints of each pinned model and the ZDR list), then checked against it
 * (`liveChecks`); any other plan is `planArena`'s (the snapshot). Base URLs of OpenRouter and compat
 * seats are checked like Anthropic's (https, or http on loopback): exit 3.
 */
export async function planLive(
  req: ArenaRequest,
  env: ArenaEnv,
  o: PlanLiveOptions = {},
): Promise<ArenaPlan> {
  const pins: { model: string; endpoint: string }[] = [];
  const check = (): void => {
    if (req.fake === true || o.requireKey === false) return;
    for (const s of llmSeatsOf(first)) {
      if (s.provider !== "compat") continue;
      checkedBaseUrl(providerEnv(env, "compat").baseURL ?? "", PROVIDERS.compat.baseUrlVar);
    }
  };
  const first = planArena(req, env, {
    ...o,
    endpoints: (model, endpoint) => {
      pins.push({ model, endpoint });
      return permissive(model, endpoint);
    },
  });
  check();
  if (pins.length === 0) return first;
  // A fake run, or an estimate: the snapshot (no network).
  if (first.fake || o.requireKey === false) return planArena(req, env, o);
  const now = (o.now ?? Date.now)();
  const live = await fetchLiveEndpoints(pins, {
    baseURL: openrouterBase(env),
    checked: new Date(now).toISOString().slice(0, 10),
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    ...(o.time === undefined ? {} : { time: o.time }),
  });
  const plan = planArena(req, env, { ...o, endpoints: live.source });
  return { ...plan, warnings: [...plan.warnings, ...liveChecks(plan, live)] };
}

// The smoke ------------------------------------------------------------------------------------

export interface OpenRouterSmokeOptions {
  readonly env: ArenaEnv;
  readonly io: CliIo;
  /** Default `z-ai/glm-5.3-flash` (the cheapest seat model). */
  readonly model?: string;
  /** Default the model's catalogued endpoint. */
  readonly endpoint?: string;
  readonly effort?: Effort;
  readonly ruleset?: string;
  readonly fetch?: HttpFetch;
  readonly time?: TimeSource;
  /** The wall clock in ms (the price instant); default `Date.now`. */
  readonly now?: () => number;
}

export const OPENROUTER_SMOKE_MODEL = "z-ai/glm-5.3-flash";

const utf8 = new TextEncoder();
const bytes = (t: string): number => utf8.encode(t).length;

/**
 * The smoke's request and its bound: the preflight's shape check (the sample prompt at one token
 * per byte, cold, its output) and one call of the briefing and the turn header at
 * `SMOKE_MAX_TOKENS`, no retry, each at the highest price of every card valid now, with the fee.
 */
export async function openrouterSmokePlan(o: {
  readonly model: string;
  readonly endpoint: string;
  readonly effort: Effort;
  readonly ruleset: string;
  readonly at: string;
}): Promise<{
  readonly spec: ModelSpec;
  readonly prompt: { readonly shared: string; readonly seat: string };
  readonly tools: ReturnType<typeof toolsFor>;
  readonly entries: readonly Entry[];
  readonly meta: ChatRequest["meta"];
  readonly boundNano: number;
}> {
  const ruleset = getRuleset(o.ruleset);
  const info = rulesInfo(
    createMatch(
      harness.setupFor(ruleset, { seed: 1, players: 6, days: 7, idKey: idKeyFromSeed(1) }),
      ruleset,
    ),
  );
  const tools = toolsFor("openrouter", modelTools(toolDefinitions(ruleset)));
  const profile = PROFILES[0];
  if (profile === undefined) throw new Error("no profile");
  const prompt = { shared: sharedPrompt(info, 6, "envelope"), seat: seatPrompt("p1", profile) };
  const input = await firstRoundInput(ruleset, "p1");
  const entries: Entry[] = [
    { role: "user", parts: [{ kind: "text", text: canonicalJson(input.briefing) }] },
    { role: "operator", text: turnHeader(input, "envelope") },
  ];
  const k = { provider: "openrouter", endpoint: o.endpoint, from: o.at };
  const sample = sampleTokensUpper({ seat: "p1", prompt, tools }, "envelope");
  const call =
    bytes(prompt.shared) +
    bytes(prompt.seat) +
    bytes(JSON.stringify(tools)) +
    3 * ENTRY_OVERHEAD_TOKENS +
    entries.reduce((n, e) => n + entryTokensUpper(e), 0);
  return {
    spec: {
      provider: "openrouter",
      model: o.model,
      endpoint: o.endpoint,
      effort: o.effort,
      maxOutputTokens: SMOKE_MAX_TOKENS,
      cacheTtl: "5m",
      fallbacks: "off",
    },
    prompt,
    tools,
    entries,
    meta: {
      seat: input.seat,
      turn: input.turn,
      round: 0,
      maxRounds: input.maxRounds,
      maxCalls: input.maxCalls,
      kind: "round",
    },
    boundNano:
      callBound(o.model, "off", sample, PREFLIGHT_OUTPUT_TOKENS, k, { ttl: "5m" }) +
      callBound(o.model, "off", call, SMOKE_MAX_TOKENS, k, { ttl: "5m" }),
  };
}

/** `arena smoke --provider openrouter`: one live check, its bound printed before anything is sent. */
export async function smokeOpenRouter(o: OpenRouterSmokeOptions): Promise<number> {
  const io = o.io;
  const model = o.model ?? OPENROUTER_SMOKE_MODEL;
  const info = modelInfo("openrouter", model);
  if (info?.seat !== true) {
    throw new UsageError(
      `--model ${model} is not an OpenRouter seat model; the seat models are ${seatModels(
        "openrouter",
      )
        .map((m) => m.model)
        .join(", ")}`,
    );
  }
  const endpoint = o.endpoint ?? info.endpoints[0]?.tag ?? "";
  if (endpointInfo(model, endpoint) === undefined) {
    throw new UsageError(
      `--endpoint ${endpoint} is not a pinnable endpoint of ${model}: ${info.endpoints.map((e) => e.tag).join(", ")}`,
    );
  }
  const effort = o.effort ?? "medium";
  if (!info.capabilities.efforts.includes(effort)) {
    throw new UsageError(
      `--effort must be one of ${info.capabilities.efforts.join(", ")} for ${model}, got "${effort}"`,
    );
  }
  const at = new Date((o.now ?? Date.now)()).toISOString();
  const plan = await openrouterSmokePlan({
    model,
    endpoint,
    effort,
    ruleset: o.ruleset ?? "perfidia-1",
    at,
  });
  const key = providerEnv(o.env, "openrouter").apiKey;
  const baseURL = openrouterBase(o.env);
  const sent = effortSent("openrouter", model, effort);
  io.out(
    `smoke: openrouter ${model}@${endpoint} at ${effort}${sent === effort ? "" : ` (sent as ${sent}, the nearest level the model lists; unverified)`} on ${baseURL}, at most ${formatUsd(plan.boundNano)} (OpenRouter's 5.5% credit fee included)\n`,
  );
  if (key === null) {
    throw new UsageError(
      `arena smoke --provider openrouter makes one live API call (at most ${formatUsd(plan.boundNano)} on ${model}@${endpoint}): set PERFIDIA_OPENROUTER_API_KEY first. Nothing was sent.`,
    );
  }
  const adapter = new CompatAdapter(plan.spec, {
    mode: "openrouter",
    baseURL,
    apiKey: key,
    time: o.time ?? new harness.SystemTime(),
    endpoint: openrouterPin(model, endpoint),
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
  const price = (usage: Parameters<typeof costOf>[0]) =>
    costOf(usage, { provider: "openrouter", endpoint, at });
  try {
    const pre = await preflight([{ seat: "p1", adapter, prompt: plan.prompt, tools: plan.tools }], {
      price: (_g, usage) => price(usage),
    });
    io.out(
      `1. preflight: ok; ${endpoint} listed, shape check served by the pinned endpoint; it cost ${formatUsd(pre.nanoUsd)}\n`,
    );
    const res = await adapter.chat({
      prompt: plan.prompt,
      tools: plan.tools,
      entries: plan.entries,
      meta: plan.meta,
    });
    const served = servedTokens(res.usage);
    const cost = price(res.usage);
    io.out(
      `2. one call: stop ${res.rawStop}, served by ${res.servedBy} on ${res.endpoint ?? "?"}, ${res.latencyMs} ms (first token ${res.ttftMs ?? "?"} ms), request ${res.requestId ?? "?"}\n`,
    );
    io.out(
      `   usage: input ${served.input}, cache write ${served.cacheWrite5m}, cache read ${served.cacheRead}, output ${served.output} (reasoning ${served.reasoning ?? "?"}; prompt ${promptTokens(served)}); cost ${formatUsd(cost.nanoUsd)} (fee ${formatUsd(cost.feeNanoUsd)}), OpenRouter reports ${res.reportedCostNanoUsd === null || res.reportedCostNanoUsd === undefined ? "no cost" : formatUsd(res.reportedCostNanoUsd)}\n`,
    );
    io.out(
      `   reply: ${res.reply.calls.length} tool call(s)${res.reply.calls.length === 0 ? "" : ` (${res.reply.calls.map((c) => c.name).join(", ")})`}; reasoning ${res.reply.reasoningKind ?? "?"}, ${res.reply.reasoning.reduce((n, r) => n + r.length, 0)} chars; text: ${JSON.stringify(res.reply.text.join(" ").slice(0, 200))}\n`,
    );
    if (res.stop === "refusal") {
      io.err(`smoke: the call was refused (${res.refusal?.category ?? "uncategorised"})\n`);
      return EXIT.fatal;
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
