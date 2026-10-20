import type { ModelAdapter, ModelSpec } from "../../model/adapter.ts";
import { OpenAIAdapter, OpenAIClient } from "../../model/openai.ts";
import type { AdapterEnv } from "../providers.ts";

// The OpenAI entry of the provider registry (phase-4 design §2.3, §2.8, Pass 2): how the arena
// builds an OpenAI seat's adapter from the plan's environment (`PERFIDIA_OPENAI_API_KEY`,
// `PERFIDIA_OPENAI_BASE_URL`), which base URLs it refuses, and what `arena smoke --provider openai`
// calls by default.

/** The smoke's default model and effort: the cheapest GPT-6 model at low effort. */
export const OPENAI_SMOKE = Object.freeze({ model: "gpt-6-luna", effort: "low" as const });

/** An OpenAI seat's adapter: its own client (the guarded transport) on the plan's key and URL. */
export function createOpenAIAdapter(spec: ModelSpec, env: AdapterEnv): ModelAdapter {
  if (env.apiKey === null) {
    throw new Error("PERFIDIA_OPENAI_API_KEY is not set: the plan should have refused the run");
  }
  return new OpenAIAdapter(
    spec,
    new OpenAIClient({
      apiKey: env.apiKey,
      baseURL: env.baseURL,
      time: env.time,
      timeoutMs: env.timeoutMs,
      ...(env.fetch === undefined ? {} : { fetch: env.fetch }),
    }),
  );
}

/**
 * Why a base URL cannot carry OpenAI seats, or null. OpenAI's regional-processing hosts
 * (`us.api.openai.com`, `eu.api.openai.com`) bill a 10% uplift on the models of the cards (pricing
 * page and "Your data" guide, read 2026-10-20), and every card of this build is the global one: the
 * ledger would undercount, so the plan refuses them until regional cards exist.
 */
export function openaiBaseUrlProblem(base: string): string | null {
  let host: string;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host !== "api.openai.com" && host.endsWith(".api.openai.com")) {
    return `PERFIDIA_OPENAI_BASE_URL names ${host}, a regional-processing host: OpenAI bills it 10% over the global prices, and this build has only the global cards (packages/orchestrator/src/model/prices/openai.ts); use https://api.openai.com/v1 or add regional cards first`;
  }
  return null;
}
