import type { Provider, TimeSource } from "@perfidia/protocol";
import type { Effort, ModelAdapter, ModelSpec, ModelTool } from "../model/adapter.ts";
import { endpointInfo as catalogEndpoint, type EndpointInfo } from "../model/catalog.ts";
import type { HttpFetch } from "../model/http.ts";
import { toolTransformOf, transformTools } from "../model/tools.ts";
import { OPENAI_SMOKE, createOpenAIAdapter, openaiBaseUrlProblem } from "./providers/openai.ts";

/** What a provider's adapter factory gets from the arena (Pass 2): the plan's key and URL. */
export interface AdapterEnv {
  readonly apiKey: string;
  /** The checked base URL (`PERFIDIA_<PROVIDER>_BASE_URL` or the provider's default). */
  readonly baseURL: string;
  /** The harness clock (latency, the attempt backstop). */
  readonly time: TimeSource;
  /** The backstop of one attempt (the plan's attempt timeout). */
  readonly timeoutMs: number;
  /** Tests: a stub fetch. */
  readonly fetch?: HttpFetch;
}

/** Builds a seat's adapter (Pass 2: one per provider with a raw-fetch adapter). */
export type AdapterFactory = (spec: ModelSpec, env: AdapterEnv) => ModelAdapter;

// The provider registry of the arena (phase-4 design §2.8, Pass 1b): for each provider, the
// environment variables the harness reads (`PERFIDIA_<PROVIDER>_*` only, read once by `arenaEnv`),
// its default base URL, its auth header, whether this build has its adapter, where its price cards
// live, and how a seat pins it (OpenRouter needs a full endpoint slug). Anthropic and (Pass 2)
// OpenAI have adapters (`create`: the factory of a raw-fetch adapter); every other provider plans
// and runs on the fake path, which mirrors it (Pass 2 adds the Gemini and OpenAI-compatible ones).

export interface ProviderInfo {
  readonly id: Exclude<Provider, "fake">;
  /** The variable holding the key. */
  readonly keyVar: string;
  /** The variable holding a base URL. */
  readonly baseUrlVar: string;
  /** The API's base URL; null when the base URL is required (`compat`). */
  readonly defaultBaseUrl: string | null;
  /** `always`: a key is needed; `remote`: only when the base URL is not loopback (`compat`). */
  readonly key: "always" | "remote";
  /** The header the key travels in. */
  readonly authHeader: "x-api-key" | "authorization" | "x-goog-api-key";
  /** This build can call the provider (else: `--fake` only). */
  readonly adapter: boolean;
  /** Where its price cards are added. */
  readonly pricesFile: string;
  /** A seat must pin a full endpoint slug. */
  readonly needsEndpoint: boolean;
  /** The tool transform its adapter applies (`none`, or Gemini's, planned for Pass 2). */
  readonly toolTransform: string;
  /** Pass 2: builds a seat's adapter (Anthropic's is built by the arena on its shared SDK client). */
  readonly create?: AdapterFactory;
  /** Pass 2: why a base URL cannot carry the provider's seats (exit 3), or null. */
  readonly baseUrlProblem?: (base: string) => string | null;
  /** Pass 2: what `arena smoke --provider <id>` calls by default. */
  readonly smoke?: { readonly model: string; readonly effort: Effort };
}

const PRICES_DIR = "packages/orchestrator/src/model/prices";

export const PROVIDERS: Readonly<Record<Exclude<Provider, "fake">, ProviderInfo>> = Object.freeze({
  anthropic: {
    id: "anthropic",
    keyVar: "PERFIDIA_ANTHROPIC_API_KEY",
    baseUrlVar: "PERFIDIA_ANTHROPIC_BASE_URL",
    defaultBaseUrl: "https://api.anthropic.com",
    key: "always",
    authHeader: "x-api-key",
    adapter: true,
    pricesFile: `${PRICES_DIR}/anthropic.ts`,
    needsEndpoint: false,
    toolTransform: "none",
  },
  openai: {
    id: "openai",
    keyVar: "PERFIDIA_OPENAI_API_KEY",
    baseUrlVar: "PERFIDIA_OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
    key: "always",
    authHeader: "authorization",
    adapter: true,
    pricesFile: `${PRICES_DIR}/openai.ts`,
    needsEndpoint: false,
    toolTransform: "none",
    create: createOpenAIAdapter,
    baseUrlProblem: openaiBaseUrlProblem,
    smoke: OPENAI_SMOKE,
  },
  google: {
    id: "google",
    keyVar: "PERFIDIA_GOOGLE_API_KEY",
    baseUrlVar: "PERFIDIA_GOOGLE_BASE_URL",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    key: "always",
    authHeader: "x-goog-api-key",
    adapter: false,
    pricesFile: `${PRICES_DIR}/google.ts`,
    needsEndpoint: false,
    // The Gemini schema transform (design §2.4) is built with its adapter (Pass 2): until then the
    // fake path sends the neutral list, and `toolsHash` shows it.
    toolTransform: "none",
  },
  openrouter: {
    id: "openrouter",
    keyVar: "PERFIDIA_OPENROUTER_API_KEY",
    baseUrlVar: "PERFIDIA_OPENROUTER_BASE_URL",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    key: "always",
    authHeader: "authorization",
    adapter: false,
    pricesFile: `${PRICES_DIR}/openrouter.ts`,
    needsEndpoint: true,
    toolTransform: "none",
  },
  compat: {
    id: "compat",
    keyVar: "PERFIDIA_COMPAT_API_KEY",
    baseUrlVar: "PERFIDIA_COMPAT_BASE_URL",
    defaultBaseUrl: null,
    key: "remote",
    authHeader: "authorization",
    adapter: false,
    pricesFile: `${PRICES_DIR}/compat.ts`,
    needsEndpoint: false,
    toolTransform: "none",
  },
});

/** The provider of `id`, or undefined (`fake` is not a provider seats are planned on). */
export function providerInfo(id: string): ProviderInfo | undefined {
  return Object.values(PROVIDERS).find((p) => p.id === id);
}

/**
 * The tools a seat of `provider` gets: the neutral list through its provider's transform (the same
 * list for every provider of this build). `arena run` hashes each seat's list into `seats.json`.
 */
export function toolsFor(provider: string, tools: readonly ModelTool[]): readonly ModelTool[] {
  return transformTools(tools, toolTransformOf(providerInfo(provider)?.toolTransform ?? "none"));
}

/** Every environment variable the harness reads (the architecture test checks the names). */
export const ENV_VARS: readonly string[] = Object.freeze([
  ...Object.values(PROVIDERS).flatMap((p) => [p.keyVar, p.baseUrlVar]),
  "PERFIDIA_LIVE",
]);

/**
 * The plan's endpoint-metadata hook (design §2.5): what OpenRouter's `/models/{id}/endpoints` says
 * of a pinned endpoint (prices aside), with its ZDR listing. This build reads the snapshot checked
 * on 2026-10-20 (`model/catalog.ts`); Pass 2's OpenRouter adapter fetches it live at plan time.
 */
export type EndpointSource = (model: string, endpoint: string) => EndpointInfo | undefined;

export const SNAPSHOT_ENDPOINTS: EndpointSource = (model, endpoint) =>
  catalogEndpoint(model, endpoint);

/** Parameters an OpenRouter endpoint must list for a seat to be planned on it (design §2.5). */
export const REQUIRED_PARAMS: readonly string[] = Object.freeze([
  "tools",
  "tool_choice",
  "max_tokens",
  "reasoning",
]);
