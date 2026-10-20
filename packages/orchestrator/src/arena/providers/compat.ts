import type { TimeSource } from "@perfidia/protocol";
import type { ModelSpec } from "../../model/adapter.ts";
import { CompatAdapter, type CompatMode } from "../../model/compat.ts";
import type { HttpFetch } from "../../model/http.ts";
import { checkedBaseUrl, providerEnv, type ArenaEnv } from "../plan.ts";
import { PROVIDERS } from "../providers.ts";
import { openrouterPin } from "./openrouter.ts";

// The adapters of the OpenAI-compatible providers (phase-4 design §2.5, Pass 2): an `openrouter`
// seat pinned to its endpoint (`openrouterPin`: the snapshot's parameters and the provider name the
// served-endpoint check expects), a `compat` seat on `PERFIDIA_COMPAT_BASE_URL` (a key only off
// loopback). Both read their key and base URL from the plan's environment (`PERFIDIA_<PROVIDER>_*`,
// read once by `arenaEnv`), never from the process.

/** Whether `provider` runs on the OpenAI-compatible adapter. */
export const isCompatProvider = (provider: string): provider is CompatMode =>
  provider === "openrouter" || provider === "compat";

export interface CompatFactoryOptions {
  readonly env: ArenaEnv;
  readonly time: TimeSource;
  /** Tests: a stub (through the guarded transport). */
  readonly fetch?: HttpFetch;
  readonly timeoutMs?: number;
}

/** The adapter of an `openrouter` or `compat` seat. */
export function compatAdapterFor(spec: ModelSpec, o: CompatFactoryOptions): CompatAdapter {
  const mode = spec.provider;
  if (!isCompatProvider(mode)) throw new Error(`not an OpenAI-compatible provider: ${mode}`);
  const p = PROVIDERS[mode];
  const pe = providerEnv(o.env, mode);
  const base = pe.baseURL ?? p.defaultBaseUrl;
  if (base === null) throw new Error(`${p.baseUrlVar} is not set`);
  const endpoint = spec.endpoint ?? null;
  return new CompatAdapter(spec, {
    mode,
    baseURL: checkedBaseUrl(base, p.baseUrlVar),
    apiKey: pe.apiKey,
    time: o.time,
    ...(mode === "openrouter" && endpoint !== null
      ? { endpoint: openrouterPin(spec.model, endpoint) }
      : {}),
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
  });
}
