import type { ModelAdapter, ModelSpec } from "../../model/adapter.ts";
import { endpointInfo } from "../../model/catalog.ts";
import { CompatAdapter, type CompatMode, type PinnedEndpoint } from "../../model/compat.ts";
import type { AdapterEnv } from "../providers.ts";

// The adapters of the OpenAI-compatible providers (phase-4 design §2.5, Pass 2): an `openrouter`
// seat pinned to its endpoint (`openrouterPin`: the snapshot's parameters and the provider name the
// served-endpoint check expects), a `compat` seat on `PERFIDIA_COMPAT_BASE_URL` (a key only off
// loopback). The registry's `create` (`arena/providers.ts`) gets the plan's key and checked base URL
// (`PERFIDIA_<PROVIDER>_*`, read once by `arenaEnv`), never the process's. This module imports
// nothing of the plan or the registry at run time, so the registry can import it.

/** Whether `provider` runs on the OpenAI-compatible adapter. */
export const isCompatProvider = (provider: string): provider is CompatMode =>
  provider === "openrouter" || provider === "compat";

/**
 * The serving provider of each pinnable endpoint as OpenRouter's routing metadata names it
 * (`provider_name` of `/models/{id}/endpoints`, read 2026-10-20): the adapter refuses a reply whose
 * selected endpoint shows another provider.
 */
export const ENDPOINT_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  "z-ai/fp8": "Z.AI",
  "moonshotai/mxfp4": "Moonshot AI",
  together: "Together",
});
export const ENDPOINT_PROVIDERS_CHECKED = "2026-10-20";

/** The pinned endpoint of an OpenRouter seat as the adapter needs it (the snapshot's parameters). */
export function openrouterPin(model: string, tag: string): PinnedEndpoint {
  const e = endpointInfo(model, tag);
  return {
    tag,
    providerName: ENDPOINT_PROVIDERS[tag] ?? null,
    supportedParams: e?.supportedParams ?? [],
    zdr: e?.zdr ?? false,
  };
}

/** The adapter of an `openrouter` or `compat` seat (the registry's `create` for both). */
export function createCompatAdapter(spec: ModelSpec, env: AdapterEnv): ModelAdapter {
  const mode = spec.provider;
  if (!isCompatProvider(mode)) throw new Error(`not an OpenAI-compatible provider: ${mode}`);
  if (mode === "openrouter" && env.apiKey === null) {
    throw new Error("PERFIDIA_OPENROUTER_API_KEY is not set: the plan should have refused the run");
  }
  const endpoint = spec.endpoint ?? null;
  return new CompatAdapter(spec, {
    mode,
    baseURL: env.baseURL,
    apiKey: env.apiKey,
    time: env.time,
    timeoutMs: env.timeoutMs,
    ...(mode === "openrouter" && endpoint !== null
      ? { endpoint: openrouterPin(spec.model, endpoint) }
      : {}),
    ...(env.fetch === undefined ? {} : { fetch: env.fetch }),
  });
}
