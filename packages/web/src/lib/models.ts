import type { SeatInfo } from "@perfidia/protocol/spectator";

// Model names for display (phase-3 design §4.5; phase-4 design §6.3): the badge's short name
// ("Opus 5.5", "GPT-6.1 Sol", "Gemini 4 Argon", "GLM-5.3"), the full name with its route
// ("Claude Opus 5.5", "GLM-5.3 (Z.AI via OpenRouter)"), the effort in the vendor's own terms
// ("effort", "reasoning effort", "thinking level") and what a seat's reasoning is (a provider's
// summary, a raw chain of thought, or none). An unknown model id shows as it is. A fake seat
// (provider `fake`, or a `--fake` run: a bot behind the LLM pipe) always reads "Fake", never the
// model it stands in for; where a rehearsal says which seat it rehearses, it says so in words.

/** A model as the protocol names it (`SeatInfo.model`, `StatsModel`). */
export interface ModelRef {
  readonly provider: string;
  readonly model: string;
  readonly endpoint?: string | null | undefined;
  /** A fake seat's intended provider, when known (`StatsModel.intended`). */
  readonly intended?: string | null | undefined;
}

export type ReasoningKind = "summary" | "raw" | "none";

/**
 * A table lookup that never reads an inherited member: a model, provider or host id is the
 * operator's string (`__proto__`, `constructor` and `toString` are ids like any other).
 */
export function own(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Names no family pattern gives. */
const KNOWN: Readonly<Record<string, string>> = Object.freeze({
  "claude-opus-5-5": "Opus 5.5",
  "z-ai/glm-5.3": "GLM-5.3",
  "z-ai/glm-5.3-flash": "GLM-5.3 Flash",
  "moonshotai/kimi-k3": "Kimi K3",
  "deepseek/deepseek-v4.1-flash-1017": "DeepSeek V4.1 Flash",
});

const CLAUDE = /^claude-(opus|sonnet|haiku|fable)-([0-9]+)(?:-([0-9]+))?(?:-[0-9]{8})?$/;
const GPT = /^gpt-([0-9]+(?:\.[0-9]+)?)(?:-([a-z][a-z0-9]*))?$/;
const GEMINI = /^gemini-([0-9]+(?:\.[0-9]+)?)-([a-z]+(?:-[a-z]+)*)$/;

const cap = (w: string): string => `${w.charAt(0).toUpperCase()}${w.slice(1)}`;

/** A Claude model's family name ("Opus 5.5"), or null. */
function claudeName(model: string): string | null {
  const m = CLAUDE.exec(model);
  if (m === null) return null;
  const version = m[3] === undefined ? (m[2] ?? "") : `${m[2] ?? ""}.${m[3]}`;
  return `${cap(m[1] ?? "")} ${version}`;
}

/**
 * A model id's short display name: "Opus 5.5" (`claude-opus-5-5`), "GPT-6.1 Sol"
 * (`gpt-6.1-sol`), "Gemini 3.5 Flash-Lite" (`gemini-3.5-flash-lite`), "GLM-5.3"
 * (`z-ai/glm-5.3`); an unknown id as it is.
 */
export function modelName(model: string): string {
  const known = own(KNOWN, model);
  if (known !== undefined) return known;
  const claude = claudeName(model);
  if (claude !== null) return claude;
  const gpt = GPT.exec(model);
  if (gpt !== null) return `GPT-${gpt[1] ?? ""}${gpt[2] === undefined ? "" : ` ${cap(gpt[2])}`}`;
  const gemini = GEMINI.exec(model);
  if (gemini !== null) {
    return `Gemini ${gemini[1] ?? ""} ${(gemini[2] ?? "").split("-").map(cap).join("-")}`;
  }
  return model;
}

const PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
  compat: "OpenAI-compatible endpoint",
  fake: "Fake",
});

/** A provider's name: "Anthropic", "OpenAI", "Google", "OpenRouter"; an unknown one as it is. */
export function providerName(provider: string): string {
  return own(PROVIDERS, provider) ?? provider;
}

/** Who serves an OpenRouter endpoint (its slug's first part), as the vendor writes its name. */
const HOSTS: Readonly<Record<string, string>> = Object.freeze({
  "z-ai": "Z.AI",
  moonshotai: "Moonshot AI",
  deepseek: "DeepSeek",
  together: "Together AI",
  fireworks: "Fireworks",
  deepinfra: "DeepInfra",
  novita: "Novita",
  parasail: "Parasail",
  baseten: "Baseten",
  siliconflow: "SiliconFlow",
  alibaba: "Alibaba Cloud",
  mistral: "Mistral",
  cloudflare: "Cloudflare",
  "amazon-bedrock": "Amazon Bedrock",
  chutes: "Chutes",
  groq: "Groq",
  cerebras: "Cerebras",
});

/** The host of an endpoint slug: `z-ai/fp8` → "Z.AI"; an unknown host as its slug says. */
export function hostName(endpoint: string): string {
  const head = endpoint.split("/")[0] ?? endpoint;
  return own(HOSTS, head) ?? head;
}

/** The variant an endpoint slug pins after its host (`z-ai/fp8` → "fp8"), or null. */
export function endpointVariant(endpoint: string): string | null {
  const rest = endpoint.split("/").slice(1).join("/");
  return rest === "" ? null : rest;
}

/** The provider a model id belongs to, from its shape (a fake seat names its intended model). */
export function providerOfModel(model: string): string | null {
  if (model.startsWith("claude-")) return "anthropic";
  if (GPT.test(model)) return "openai";
  if (model.startsWith("gemini-")) return "google";
  if (model.includes("/")) return "openrouter";
  return null;
}

/** The provider whose model a seat runs, or (fake) rehearses. */
export function servingProvider(m: ModelRef): string {
  if (m.provider !== "fake") return m.provider;
  return m.intended ?? providerOfModel(m.model) ?? "fake";
}

/** How a seat reaches its model: "Anthropic", "Z.AI via OpenRouter", "via OpenRouter". */
export function routeWords(m: ModelRef): string {
  const provider = servingProvider(m);
  if (provider === "openrouter") {
    const ep = m.endpoint ?? null;
    return ep === null || ep === "" ? "via OpenRouter" : `${hostName(ep)} via OpenRouter`;
  }
  return providerName(provider);
}

/**
 * A model's full display name: "Claude Opus 5.5", "GPT-6.1 Sol", "Gemini 4 Argon"; a routed
 * model with its route: "GLM-5.3 (Z.AI via OpenRouter)", "my-model (OpenAI-compatible endpoint)".
 */
export function fullModelName(m: ModelRef): string {
  const provider = servingProvider(m);
  const short = modelName(m.model);
  if (provider === "anthropic") return claudeName(m.model) === null ? short : `Claude ${short}`;
  if (provider === "openai" || provider === "google" || provider === "fake") return short;
  return `${short} (${routeWords(m)})`;
}

/** The full name with who serves it: "GPT-6.1 Sol (OpenAI)", "GLM-5.3 (Z.AI via OpenRouter)". */
export function modelWithRoute(m: ModelRef): string {
  const provider = servingProvider(m);
  const full = fullModelName(m);
  if (provider === "openrouter" || provider === "compat" || provider === "fake") return full;
  return `${full} (${providerName(provider)})`;
}

/**
 * An effort in the vendor's own terms: Anthropic's `effort`, OpenAI's and OpenRouter's
 * `reasoning.effort`, Gemini's `thinkingLevel`: "effort medium", "reasoning effort low",
 * "thinking level high".
 */
export function effortWords(provider: string, effort: string): string {
  if (provider === "google") return `thinking level ${effort}`;
  if (provider === "openai" || provider === "openrouter" || provider === "compat") {
    return `reasoning effort ${effort}`;
  }
  return `effort ${effort}`;
}

/** The reasoning a provider shows spectators (phase-4 design §3.2 item 4). */
export function providerReasoning(provider: string): ReasoningKind | null {
  if (provider === "anthropic" || provider === "openai" || provider === "google") return "summary";
  if (provider === "openrouter" || provider === "compat") return "raw";
  return null;
}

type SeatKind = Pick<SeatInfo, "kind" | "fake" | "model">;

/**
 * The kind a reasoning text is labelled with: the one its line logged (a round's
 * `reasoningKind`), else the one its seat is expected to show. The logged kind always wins.
 */
export function shownReasoningKind(
  logged: ReasoningKind | null | undefined,
  expected: ReasoningKind | null,
): ReasoningKind | null {
  return logged ?? expected;
}

/**
 * What a seat's reasoning is expected to be, from its model (the logged kind of a round wins):
 * a summary from Anthropic, OpenAI and Google, raw text from open models; null for a bot.
 */
export function seatReasoningKind(seat: SeatKind): ReasoningKind | null {
  if (seat.kind === "bot" || seat.model === null) return null;
  return providerReasoning(servingProvider(seat.model));
}

const KIND_LABEL: Readonly<Record<ReasoningKind, string>> = Object.freeze({
  summary: "summary",
  raw: "raw chain of thought",
  none: "none",
});

/** "summary", "raw chain of thought", "none": what a reasoning text is. */
export function reasoningKindWords(kind: ReasoningKind): string {
  return KIND_LABEL[kind];
}

const KIND_TITLE: Readonly<Record<ReasoningKind, string>> = Object.freeze({
  summary: "Reasoning summary",
  raw: "Raw chain of thought",
  none: "No reasoning shown",
});

/** A heading for reasoning text: "Reasoning summary", "Raw chain of thought". */
export function reasoningKindTitle(kind: ReasoningKind): string {
  return KIND_TITLE[kind];
}

const KIND_HINT: Readonly<Record<ReasoningKind, string>> = Object.freeze({
  summary:
    "A summary the provider writes of the model's hidden reasoning, not the reasoning itself.",
  raw: "The model's own reasoning text, as it produced it: unedited, and not written for readers.",
  none: "The model returned no reasoning to show.",
});

/** One sentence on what a reasoning kind means, for a tooltip. */
export function reasoningKindHint(kind: ReasoningKind): string {
  return KIND_HINT[kind];
}

/** A logged reasoning kind, or null for anything else. */
export function asReasoningKind(v: string | null | undefined): ReasoningKind | null {
  return v === "summary" || v === "raw" || v === "none" ? v : null;
}

/** A seat played by a bot behind the LLM pipe: never shown as the model. */
export function isFakeSeat(seat: SeatKind): boolean {
  return seat.fake || seat.model?.provider === "fake";
}

/** The model badge of a seat: "Opus 5.5 · medium", "GLM-5.3 · low", "Bot" or "Fake". */
export function modelLabel(seat: SeatKind): string {
  if (isFakeSeat(seat)) return "Fake";
  if (seat.kind === "bot") return "Bot";
  if (seat.model === null) return "LLM";
  return `${modelName(seat.model.model)} · ${seat.model.effort}`;
}

/** A longer description of who plays a seat, for tooltips and the dossier. */
export function playedBy(seat: SeatKind): string {
  if (isFakeSeat(seat)) return "Fake model: a scripted bot behind the LLM pipe";
  if (seat.kind === "bot") return "Scripted bot";
  if (seat.model === null) return "Language model";
  return `${modelWithRoute(seat.model)}, ${effortWords(seat.model.provider, seat.model.effort)}`;
}

/**
 * What a fake seat rehearses, in words that never call it the model: "stands in for GPT-6 Luna
 * (OpenAI)"; null when the seat is not fake or names no model.
 */
export function rehearsalOf(seat: {
  readonly fake: boolean;
  readonly model: ModelRef | null;
}): string | null {
  const m = seat.model;
  if (m === null || !(seat.fake || m.provider === "fake")) return null;
  return `stands in for ${modelWithRoute(m)}`;
}
