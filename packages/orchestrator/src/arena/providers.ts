import type { Provider } from "@perfidia/protocol";
import type { ModelAdapter, ModelSpec, ModelTool } from "../model/adapter.ts";
import { endpointInfo as catalogEndpoint, type EndpointInfo } from "../model/catalog.ts";
import { GEMINI_TOOL_TRANSFORM_ID } from "../model/gemini-tools.ts";
import { toolTransformOf, transformTools } from "../model/tools.ts";
import { geminiAdapter, type AdapterFactoryOptions } from "./providers/gemini.ts";

// The provider registry of the arena (phase-4 design §2.8, Pass 1b): for each provider, the
// environment variables the harness reads (`PERFIDIA_<PROVIDER>_*` only, read once by `arenaEnv`),
// its default base URL, its auth header, whether this build has its adapter, where its price cards
// live, and how a seat pins it (OpenRouter needs a full endpoint slug). Anthropic and Google (Pass 2,
// `ADAPTER_FACTORIES`) have adapters; every other provider plans and runs on the fake path, which
// mirrors it.

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
    adapter: false,
    pricesFile: `${PRICES_DIR}/openai.ts`,
    needsEndpoint: false,
    toolTransform: "none",
  },
  google: {
    id: "google",
    keyVar: "PERFIDIA_GOOGLE_API_KEY",
    baseUrlVar: "PERFIDIA_GOOGLE_BASE_URL",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    key: "always",
    authHeader: "x-goog-api-key",
    adapter: true,
    pricesFile: `${PRICES_DIR}/google.ts`,
    needsEndpoint: false,
    // Gemini's JSON Schema subset (design §2.4, Pass 2): every Google seat, real or fake, gets the
    // neutral list through it, and `toolsHash` shows it.
    toolTransform: GEMINI_TOOL_TRANSFORM_ID,
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

export type { AdapterFactoryOptions };

/** Builds a real seat's adapter of a provider other than Anthropic (Pass 2). */
export type AdapterFactory = (spec: ModelSpec, o: AdapterFactoryOptions) => ModelAdapter;

/** The factories of the providers whose adapters this build has (Anthropic's is `arena/run.ts`'s). */
export const ADAPTER_FACTORIES: Readonly<Partial<Record<ProviderInfo["id"], AdapterFactory>>> =
  Object.freeze({ google: geminiAdapter });

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
