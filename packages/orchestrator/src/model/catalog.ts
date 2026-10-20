import type { Effort, Provider } from "@perfidia/protocol";

// The models the arena may plan (phase-4 design §2.1, §3.3, §3.4, Pass 1b): what each accepts and
// how it behaves, read from the providers' own pages and checked on 2026-10-20 (sources per entry).
// Pure data: the plan validates seats against it, adapters report it as `capabilities`, and the
// fake model mirrors the intended model's operator channel and reasoning kind. Prices live apart
// (`model/prices/`), one card per window.

export type OperatorChannel = "system" | "developer" | "envelope";
export type ReasoningKind = "summary" | "raw" | "none";

/** What a model accepts and how it behaves (design §2.1 `ModelCapabilities`). */
export interface ModelCapabilities {
  /** The efforts the model accepts, in the vendor's own terms. */
  readonly efforts: readonly Effort[];
  /** How harness text reaches it (the prompt variant). */
  readonly operatorChannel: OperatorChannel;
  /** What its reasoning shows spectators: a provider-written summary, raw text, or nothing. */
  readonly reasoning: ReasoningKind;
  readonly cache: "explicit" | "implicit" | "none";
  /** The output limit of one synchronous request (it bounds the `max_tokens` retry). */
  readonly maxOutputTokens: number;
  readonly contextTokens: number;
  /** The provider's minimum attempt timeout (Gemini 4 Argon: 15 minutes). */
  readonly minAttemptTimeoutMs: number;
  /** OpenRouter: the pinned endpoint's `supported_parameters`; null elsewhere. */
  readonly supportedParams: readonly string[] | null;
}

/** A pinned OpenRouter endpoint as `/api/v1/models/{id}/endpoints` described it. */
export interface EndpointInfo {
  /** The full slug (`tag`), e.g. `z-ai/fp8`. */
  readonly tag: string;
  readonly quantization: string;
  readonly contextTokens: number;
  readonly maxCompletionTokens: number;
  readonly supportedParams: readonly string[];
  readonly implicitCaching: boolean;
  /** Listed in OpenRouter's zero-data-retention endpoints (`/api/v1/endpoints/zdr`). */
  readonly zdr: boolean;
  /** The model's other endpoint tags (a pin that prefixes one of them is ambiguous). */
  readonly siblings: readonly string[];
  readonly source: string;
  readonly checked: string;
}

export interface ModelInfo {
  readonly provider: Exclude<Provider, "fake">;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  /** The vendor's default effort (recorded; the arena always sends one explicitly). */
  readonly defaultEffort: Effort;
  /** A seat may play on it; the others are fallback targets only. */
  readonly seat: boolean;
  /**
   * Anthropic server-side refusal fallbacks: the models a refused attempt may continue on; null
   * when this build plans no fallbacks for the model (Claude Haiku 5.5 has none; Claude Fable
   * 5.1's targets are not planned, so its seats run with fallbacks `off`).
   */
  readonly fallbackTargets: readonly string[] | null;
  /** OpenAI `reasoning.context` pinned for the model; null elsewhere. */
  readonly reasoningContext: "all_turns" | null;
  /** OpenRouter: the efforts the models list advertises when narrower than the gateway's. */
  readonly advertisedEfforts: readonly Effort[] | null;
  /** OpenRouter: the pinnable endpoints; empty elsewhere. */
  readonly endpoints: readonly EndpointInfo[];
  /** Plan warnings that always apply (retention, monitoring). */
  readonly notes: readonly string[];
  readonly source: string;
  readonly checked: string;
}

export const CATALOG_CHECKED = "2026-10-20";
const MIN = 60_000;
const ANTHROPIC_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_SOURCE =
  "claude-api skill (Claude Code 2.1.304: model table, thinking and effort, mid-conversation system messages) and https://platform.claude.com/docs/en/about-claude/pricing.md";

function claude(
  model: string,
  o: {
    readonly defaultEffort: Effort;
    readonly seat: boolean;
    readonly fallbackTargets: readonly string[] | null;
    readonly notes?: readonly string[];
  },
): ModelInfo {
  return {
    provider: "anthropic",
    model,
    capabilities: {
      efforts: ANTHROPIC_EFFORTS,
      operatorChannel: "system",
      reasoning: "summary",
      cache: "explicit",
      maxOutputTokens: 128_000,
      contextTokens: 1_000_000,
      minAttemptTimeoutMs: 0,
      supportedParams: null,
    },
    defaultEffort: o.defaultEffort,
    seat: o.seat,
    fallbackTargets: o.fallbackTargets,
    reasoningContext: null,
    advertisedEfforts: null,
    endpoints: [],
    notes: o.notes ?? [],
    source: CLAUDE_SOURCE,
    checked: CATALOG_CHECKED,
  };
}

function gpt(
  model: string,
  efforts: readonly Effort[],
  o: { readonly reasoningContext?: "all_turns"; readonly notes?: readonly string[] } = {},
): ModelInfo {
  return {
    provider: "openai",
    model,
    capabilities: {
      efforts,
      operatorChannel: "developer",
      reasoning: "summary",
      cache: "explicit",
      maxOutputTokens: 128_000,
      contextTokens: 1_050_000,
      minAttemptTimeoutMs: 0,
      supportedParams: null,
    },
    defaultEffort: "medium",
    seat: true,
    fallbackTargets: null,
    reasoningContext: o.reasoningContext ?? null,
    advertisedEfforts: null,
    endpoints: [],
    notes: o.notes ?? [],
    source: `https://developers.openai.com/api/docs/models/${model}.md`,
    checked: CATALOG_CHECKED,
  };
}

function gemini(model: string, minAttemptTimeoutMs: number): ModelInfo {
  return {
    provider: "google",
    model,
    capabilities: {
      efforts: ["low", "medium", "high"],
      operatorChannel: "envelope",
      reasoning: "summary",
      cache: "implicit",
      maxOutputTokens: 65_536,
      contextTokens: 1_048_576,
      minAttemptTimeoutMs,
      supportedParams: null,
    },
    defaultEffort: "medium",
    seat: true,
    fallbackTargets: null,
    reasoningContext: null,
    advertisedEfforts: null,
    endpoints: [],
    notes: [],
    source: `https://ai.google.dev/gemini-api/docs/models/${model}.md.txt (and latest-model.md.txt for the timeout)`,
    checked: CATALOG_CHECKED,
  };
}

/** Every effort OpenRouter's gateway takes (`reasoning.effort`). */
const GATEWAY_EFFORTS: readonly Effort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function routed(
  model: string,
  o: {
    readonly advertised: readonly Effort[];
    /** The models list's `reasoning.default_effort`: what an effort OpenRouter drops falls to. */
    readonly defaultEffort: Effort;
    /** Reasoning cannot be turned off (`reasoning.mandatory`): `none` is refused. */
    readonly mandatory: boolean;
    readonly endpoint: Omit<EndpointInfo, "source" | "checked">;
    readonly notes?: readonly string[];
  },
): ModelInfo {
  const source = `https://openrouter.ai/api/v1/models/${model}/endpoints, https://openrouter.ai/api/v1/models and https://openrouter.ai/api/v1/endpoints/zdr`;
  return {
    provider: "openrouter",
    model,
    capabilities: {
      efforts: o.mandatory ? GATEWAY_EFFORTS.filter((e) => e !== "none") : GATEWAY_EFFORTS,
      operatorChannel: "envelope",
      // Open models return their reasoning text (`reasoning_details`): raw until a smoke says
      // otherwise (design §2.5, unverified).
      reasoning: "raw",
      cache: "implicit",
      maxOutputTokens: o.endpoint.maxCompletionTokens,
      contextTokens: o.endpoint.contextTokens,
      minAttemptTimeoutMs: 0,
      supportedParams: o.endpoint.supportedParams,
    },
    defaultEffort: o.defaultEffort,
    seat: true,
    fallbackTargets: null,
    reasoningContext: null,
    advertisedEfforts: o.advertised,
    endpoints: [{ ...o.endpoint, source, checked: CATALOG_CHECKED }],
    notes: o.notes ?? [],
    source,
    checked: CATALOG_CHECKED,
  };
}

const ZAI_PARAMS: readonly string[] = [
  "reasoning",
  "include_reasoning",
  "max_tokens",
  "temperature",
  "top_p",
  "tools",
  "tool_choice",
  "top_k",
  "response_format",
  "reasoning_effort",
];

export const MODELS: readonly ModelInfo[] = Object.freeze([
  claude("claude-opus-5-5", {
    defaultEffort: "medium",
    seat: true,
    fallbackTargets: ["claude-opus-5", "claude-opus-4-8"],
  }),
  claude("claude-sonnet-5-5", {
    defaultEffort: "high",
    seat: true,
    fallbackTargets: ["claude-sonnet-5"],
  }),
  claude("claude-haiku-5-5", { defaultEffort: "medium", seat: true, fallbackTargets: null }),
  claude("claude-fable-5-1", {
    defaultEffort: "high",
    seat: true,
    fallbackTargets: null,
    notes: [
      "claude-fable-5-1 needs 30-day data retention: an organisation under zero data retention gets a 400 (claude-api skill)",
    ],
  }),
  claude("claude-opus-5", { defaultEffort: "high", seat: false, fallbackTargets: null }),
  claude("claude-opus-4-8", { defaultEffort: "high", seat: false, fallbackTargets: null }),
  claude("claude-sonnet-5", { defaultEffort: "high", seat: false, fallbackTargets: null }),
  gpt("gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"], { reasoningContext: "all_turns" }),
  gpt("gpt-6-sol", ["none", "low", "medium", "high", "xhigh", "max"]),
  gpt("gpt-6-luna", ["none", "low", "medium", "high", "xhigh", "max"]),
  gpt("gpt-6-astra", ["low", "medium", "high", "xhigh", "max"], {
    notes: [
      "gpt-6-astra is under OpenAI's misalignment monitoring: a flagged request is blocked with a 403 that must not be retried, and replayed reasoning is monitored too",
    ],
  }),
  gemini("gemini-4-argon", 15 * MIN),
  gemini("gemini-3.8-flash", 0),
  routed("z-ai/glm-5.3", {
    advertised: ["max", "high", "low"],
    defaultEffort: "max",
    mandatory: true,
    endpoint: {
      tag: "z-ai/fp8",
      quantization: "fp8",
      contextTokens: 1_048_576,
      maxCompletionTokens: 131_072,
      supportedParams: ZAI_PARAMS,
      implicitCaching: true,
      zdr: true,
      siblings: [
        "wafer/us",
        "inference-net/fp4",
        "reka",
        "makora/fp4",
        "wafer/fp4",
        "morph/fp8",
        "dekallm",
        "akashml/fp8",
        "io-net/fp8",
        "sail-research/us",
        "sail-research/fp8",
        "inceptron/fp4",
        "deepinfra/fp4",
        "tenstorrent/fp8",
        "novita/fp8",
        "siliconflow/fp8",
        "gmicloud/fp8",
        "relace",
        "phala",
        "decart/fp4",
        "digitalocean",
        "alibaba",
        "coreweave/fp8",
        "friendli",
        "mistral/zdr",
        "baidu/fp8",
        "baseten/fp4/us",
        "mistral/nvfp4",
        "nebius/fp4",
        "crusoe/fp4",
        "primeintellect",
        "venice",
        "together",
        "parasail/fp8",
        "modal",
        "baseten/fp4",
        "fireworks",
        "cloudflare",
        "atlas-cloud/fp8",
        "mistral/nvfp4/eu",
        "modelrun/fp4",
        "fireworks/fast",
        "baseten/us/fast",
        "baseten/fast",
        "alibaba/prime",
      ],
    },
  }),
  routed("z-ai/glm-5.3-flash", {
    advertised: ["max", "high", "low"],
    defaultEffort: "max",
    mandatory: true,
    endpoint: {
      tag: "z-ai/fp8",
      quantization: "fp8",
      contextTokens: 1_048_576,
      maxCompletionTokens: 131_072,
      supportedParams: ZAI_PARAMS,
      implicitCaching: true,
      zdr: true,
      siblings: [
        "open-inference/fp4",
        "streamlake/fp8",
        "wafer/nvfp4",
        "reka",
        "gmicloud/fp8",
        "deepinfra/fp4",
        "relace",
        "sail-research/us",
        "sail-research/fp4",
        "near-ai/fp8",
        "novita/fp8",
        "inceptron/fp8",
        "inference-net/fp4",
        "nextbit/fp4",
        "phala/nvfp4",
        "digitalocean",
        "makora",
        "morph/fp8",
        "primeintellect",
        "modal/nvfp4",
        "baseten/fp8/us",
        "crusoe/fp4",
        "coreweave/nvfp4",
        "atlas-cloud/fp8",
        "fireworks",
        "friendli",
        "siliconflow/fp8",
        "together",
        "parasail/fp4",
        "baseten/fp8",
        "venice",
        "parasail/fast",
        "fireworks/us",
      ],
    },
  }),
  routed("moonshotai/kimi-k3", {
    advertised: ["max", "high", "low", "none"],
    defaultEffort: "max",
    mandatory: false,
    endpoint: {
      tag: "moonshotai/mxfp4",
      quantization: "mxfp4",
      contextTokens: 1_048_576,
      maxCompletionTokens: 943_718,
      supportedParams: [
        "reasoning",
        "include_reasoning",
        "max_tokens",
        "stop",
        "frequency_penalty",
        "presence_penalty",
        "structured_outputs",
        "response_format",
        "tool_choice",
        "tools",
        "reasoning_effort",
      ],
      implicitCaching: true,
      zdr: true,
      siblings: [
        "wafer",
        "inference-net/fp4",
        "wafer/us",
        "makora/fp4",
        "relace/fp4",
        "morph/fp8",
        "sail-research/fp4/us",
        "sail-research/fp4",
        "akashml/fp4",
        "decart/mxfp4",
        "chutes/mxfp4",
        "fireworks/flex",
        "inference-net/fast",
        "phala",
        "digitalocean",
        "deepinfra/mxfp4",
        "parasail/fast",
        "amazon-bedrock/us-east-2",
        "parasail/fp4",
        "modal/mxfp4",
        "together",
        "fireworks",
        "baseten/fp8",
        "alibaba",
        "fireworks/us",
        "fireworks/fast",
      ],
    },
  }),
  routed("deepseek/deepseek-v4.1-flash-1017", {
    advertised: ["max", "high", "low", "none"],
    defaultEffort: "high",
    mandatory: false,
    endpoint: {
      tag: "together",
      quantization: "unknown",
      contextTokens: 1_048_576,
      maxCompletionTokens: 943_718,
      supportedParams: [
        "reasoning",
        "include_reasoning",
        "max_tokens",
        "temperature",
        "top_p",
        "stop",
        "frequency_penalty",
        "presence_penalty",
        "top_k",
        "repetition_penalty",
        "logit_bias",
        "min_p",
        "response_format",
        "structured_outputs",
        "tools",
        "tool_choice",
        "logprobs",
        "top_logprobs",
        "reasoning_effort",
      ],
      implicitCaching: true,
      zdr: true,
      siblings: [
        "relace",
        "deepinfra/fp8/flex",
        "inference-net/fp8",
        "decart/fp4",
        "deepinfra/fp8",
        "morph/fp8",
        "cloudflare",
        "deepinfra/fp8/priority",
        "deepseek",
        "wafer/mxfp4",
        "crusoe/fp8",
        "siliconflow/fp8",
        "gmicloud/fp8",
        "atlas-cloud/fp8",
        "fireworks",
        "primeintellect",
        "baseten",
        "parasail/fp8",
        "alibaba",
      ],
    },
  }),
]);

/** The model of `provider` named `model`, or undefined. */
export function modelInfo(provider: string, model: string): ModelInfo | undefined {
  return MODELS.find((m) => m.provider === provider && m.model === model);
}

/** The models of a provider a seat may play on. */
export function seatModels(provider: string): ModelInfo[] {
  return MODELS.filter((m) => m.provider === provider && m.seat);
}

/** The pinned endpoint `tag` of an OpenRouter model, or undefined. */
export function endpointInfo(model: string, tag: string): EndpointInfo | undefined {
  return modelInfo("openrouter", model)?.endpoints.find((e) => e.tag === tag);
}

/** The models whose Anthropic server-side fallbacks this build plans (and their targets). */
export const FALLBACK_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    MODELS.flatMap((m) =>
      m.provider === "anthropic" && m.fallbackTargets !== null
        ? [[m.model, Object.freeze([...m.fallbackTargets])]]
        : [],
    ),
  ),
);

/** What each provider's models do when the catalog does not list the model (tests, smoke). */
const PROVIDER_DEFAULTS: Readonly<Record<string, ModelCapabilities>> = Object.freeze({
  anthropic: {
    efforts: ANTHROPIC_EFFORTS,
    operatorChannel: "system",
    reasoning: "summary",
    cache: "explicit",
    maxOutputTokens: 128_000,
    contextTokens: 1_000_000,
    minAttemptTimeoutMs: 0,
    supportedParams: null,
  },
  openai: {
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    operatorChannel: "developer",
    reasoning: "summary",
    cache: "explicit",
    maxOutputTokens: 128_000,
    contextTokens: 1_050_000,
    minAttemptTimeoutMs: 0,
    supportedParams: null,
  },
  google: {
    efforts: ["low", "medium", "high"],
    operatorChannel: "envelope",
    reasoning: "summary",
    cache: "implicit",
    maxOutputTokens: 65_536,
    contextTokens: 1_048_576,
    minAttemptTimeoutMs: 0,
    supportedParams: null,
  },
  openrouter: {
    efforts: GATEWAY_EFFORTS,
    operatorChannel: "envelope",
    reasoning: "raw",
    cache: "implicit",
    maxOutputTokens: 128_000,
    contextTokens: 1_000_000,
    minAttemptTimeoutMs: 0,
    supportedParams: null,
  },
  compat: {
    efforts: GATEWAY_EFFORTS,
    operatorChannel: "envelope",
    reasoning: "raw",
    cache: "none",
    maxOutputTokens: 128_000,
    contextTokens: 1_000_000,
    minAttemptTimeoutMs: 0,
    supportedParams: null,
  },
});

/**
 * The capabilities of `model` on `provider` (`endpoint` for OpenRouter): the catalog's, with an
 * OpenRouter endpoint's own limits and parameters; else the provider's defaults (Anthropic's for
 * an unknown provider: phase 2's request shape).
 */
export function capabilitiesFor(
  provider: string,
  model: string,
  endpoint: string | null = null,
): ModelCapabilities {
  const info = modelInfo(provider, model);
  const base = info?.capabilities ?? PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS["anthropic"];
  if (base === undefined) throw new Error("no default capabilities");
  const e = endpoint === null ? undefined : info?.endpoints.find((x) => x.tag === endpoint);
  if (e === undefined) return base;
  return {
    ...base,
    maxOutputTokens: e.maxCompletionTokens,
    contextTokens: e.contextTokens,
    supportedParams: e.supportedParams,
  };
}
