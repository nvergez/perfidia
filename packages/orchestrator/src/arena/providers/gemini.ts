import type { TimeSource } from "@perfidia/protocol";
import type { ModelAdapter, ModelSpec } from "../../model/adapter.ts";
import { GeminiAdapter, GeminiClient } from "../../model/gemini.ts";
import type { HttpFetch } from "../../model/http.ts";

// The Google entry of the provider registry (phase-4 Pass 2): how `arena run` builds a real Gemini
// seat: its own client (the key, the base URL, the guarded transport) and adapter.

/** What a provider's adapter factory gets (`arena/providers.ts`). */
export interface AdapterFactoryOptions {
  /** The provider's key (the plan refuses a real seat without it). */
  readonly apiKey: string | null;
  /** The provider's base URL, checked by the plan (`https:`, or `http:` on loopback). */
  readonly baseURL: string;
  /** The run's time source (backstop timers, latencies). */
  readonly time: TimeSource;
  /** Tests: a stub `fetch` (the guard still applies). */
  readonly fetch?: HttpFetch;
}

/** A real Gemini seat (`google` provider). */
export function geminiAdapter(spec: ModelSpec, o: AdapterFactoryOptions): ModelAdapter {
  if (o.apiKey === null) {
    throw new Error("PERFIDIA_GOOGLE_API_KEY is not set: the plan should have refused the run");
  }
  const client = new GeminiClient({
    apiKey: o.apiKey,
    baseURL: o.baseURL,
    time: o.time,
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
  return new GeminiAdapter(spec, client);
}
