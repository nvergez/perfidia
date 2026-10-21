import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMatch, type AnyRuleset } from "@perfidia/engine";
import { canonicalJson, sha256Hex } from "@perfidia/engine/core";
import { rulesInfo } from "@perfidia/gateway/present";
import { toolDefinitions } from "@perfidia/gateway/runtime";
import type { PlayerId, PromptVariant, ReminderCadence } from "@perfidia/protocol";
import { EstimateFileSchema, SeatsFileSchema, type SeatsFile } from "../../log/schema.ts";
import {
  DEFAULT_PROMPT_CAP_TOKENS,
  type CacheTtl,
  type ChatRequest,
  type ChatResult,
  type ModelAdapter,
  type ModelCapabilities,
  type ModelSpec,
  type ModelTool,
  type PreflightReport,
  type StablePrompt,
} from "../../model/adapter.ts";
import { AnthropicAdapter, AnthropicClient } from "../../model/anthropic.ts";
import { FakeAdapter } from "../../model/fake.ts";
import { modelTools } from "../../model/tools.ts";
import type { Profile } from "../../seat/personalities.ts";
import { PROMPT_VERSION, seatPrompt, sharedPrompt } from "../../seat/prompt.ts";
import { toolsFor } from "../providers.ts";
import { operatorHashOf } from "../run.ts";
import { PlaytestError, type RunLog } from "./fork.ts";

// The playtested seat as its run set it up (`seats.json`): its model, its two system blocks, its
// tools, its operator channel and reminder cadence, rebuilt with this build's texts and checked
// against the run's hashes, so the material a playtest shows is what the run's seat received. The
// requests are built by the seat's provider's request builder: the Anthropic adapter's own
// `build()` for an Anthropic seat (a client with no key that never sends anything), the fake
// adapter's neutral layout, mirroring the provider's operator channel, for any other provider.

/** An LLM seat entry of `seats.json`. */
export type LlmSeatEntry = Extract<SeatsFile["seats"][number], { readonly kind: "llm" }>;

export interface SeatSetup {
  readonly seat: PlayerId;
  readonly entry: LlmSeatEntry;
  /** The provider the seat's model is served by (a fake seat's intended one). */
  readonly provider: string;
  readonly spec: ModelSpec;
  readonly prompt: StablePrompt;
  readonly tools: readonly ModelTool[];
  readonly profile: Profile;
  readonly variant: PromptVariant;
  readonly reminders: ReminderCadence;
  readonly promptCapTokens: number;
  /** Builds the requests: `exact` when it is the provider's own builder (Anthropic). */
  readonly builder: ModelAdapter;
  readonly exact: boolean;
}

export function readSeats(dir: string): { readonly file: SeatsFile; readonly sha256: string } {
  let text: string;
  try {
    text = readFileSync(join(dir, "seats.json"), "utf8");
  } catch {
    throw new PlaytestError(`${dir}: no seats.json (not an arena run directory)`);
  }
  const parsed = SeatsFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new PlaytestError(`${dir}/seats.json is not a seats file`);
  return { file: parsed.data, sha256: sha256Hex(text) };
}

/** The run's cache TTL (`estimate.json`), which the Anthropic request's cache markers carry. */
export function cacheTtlOf(dir: string): CacheTtl {
  try {
    const parsed = EstimateFileSchema.safeParse(
      JSON.parse(readFileSync(join(dir, "estimate.json"), "utf8")),
    );
    return parsed.success ? parsed.data.cacheTtl : "5m";
  } catch {
    return "5m";
  }
}

/** A request builder that never sends: an Anthropic client with a placeholder key and a dead URL. */
function offlineAnthropic(spec: ModelSpec): AnthropicAdapter {
  return new AnthropicAdapter(
    spec,
    new AnthropicClient({ apiKey: "playtest-no-key", baseURL: "http://127.0.0.1:9" }),
  );
}

const never = (): never => {
  throw new Error("the playtest builder never answers");
};

function check(what: string, recorded: string | undefined, rebuilt: string): void {
  if (recorded !== undefined && recorded !== rebuilt) {
    throw new PlaytestError(
      `the run's ${what} (sha256 ${recorded.slice(0, 12)}…) is not this build's (${rebuilt.slice(0, 12)}…): the run was played with other prompt bytes, so a playtest here would not show what its seat received`,
    );
  }
}

/** The seat's setup, rebuilt and checked against the run's `seats.json`; throws a `PlaytestError`. */
export function seatSetup(
  run: RunLog,
  seats: SeatsFile,
  ruleset: AnyRuleset,
  seat: PlayerId,
  cacheTtl: CacheTtl,
): SeatSetup {
  const entry = seats.seats.find((s): s is LlmSeatEntry => s.seat === seat && s.kind === "llm");
  if (entry === undefined) {
    const llm = seats.seats.filter((s) => s.kind === "llm").map((s) => s.seat);
    throw new PlaytestError(
      `${seat} is not an LLM seat of this run (LLM seats: ${llm.length === 0 ? "none" : llm.join(", ")})`,
    );
  }
  if (seats.promptVersion !== PROMPT_VERSION) {
    throw new PlaytestError(
      `the run used prompt version ${seats.promptVersion}; this build writes version ${PROMPT_VERSION}`,
    );
  }
  const variant = entry.promptVariant ?? "system";
  const reminders = entry.reminders ?? "every-round";
  const setup = run.header.setup;
  const info = rulesInfo(createMatch(setup, ruleset));
  const shared = sharedPrompt(info, setup.seats.length, variant);
  const profile: Profile = { ...entry.profile };
  const seatText = seatPrompt(seat, profile);
  const intended = entry.intended ?? null;
  // A phase-2 fake seat stands in for the Claude model of its spec.
  const provider = intended?.provider ?? (entry.provider === "fake" ? "anthropic" : entry.provider);
  const model = intended?.model ?? entry.model;
  const endpoint = intended?.endpoint ?? entry.endpoint ?? null;
  const neutral = modelTools(toolDefinitions(ruleset));
  const tools = toolsFor(provider, neutral);
  check("seat block", entry.prompt, sha256Hex(seatText));
  if (entry.sharedHash === undefined)
    check("shared block", seats.prompts.shared, sha256Hex(shared));
  else check("shared block", entry.sharedHash, sha256Hex(shared));
  if (entry.toolsHash === undefined) {
    check("tool list", seats.prompts.tools, sha256Hex(canonicalJson(neutral)));
  } else check("tool list", entry.toolsHash, sha256Hex(canonicalJson(tools)));
  check("operator templates", entry.operatorHash, operatorHashOf(variant));
  const spec: ModelSpec = {
    provider: provider === "anthropic" ? "anthropic" : "fake",
    model,
    ...(endpoint === null ? {} : { endpoint }),
    effort: entry.effort,
    maxOutputTokens: entry.maxTokens,
    cacheTtl,
    fallbacks: entry.fallbacks ?? "default",
    ...(entry.reasoningContext === undefined ? {} : { reasoningContext: entry.reasoningContext }),
  };
  const builder: ModelAdapter =
    provider === "anthropic"
      ? offlineAnthropic(spec)
      : new FakeAdapter(spec, never, { intended: { provider, model, endpoint } });
  return {
    seat,
    entry,
    provider,
    spec,
    prompt: { shared, seat: seatText },
    tools,
    profile,
    variant,
    reminders,
    promptCapTokens: seats.promptCapTokens ?? DEFAULT_PROMPT_CAP_TOKENS,
    builder,
    exact: provider === "anthropic",
  };
}

/**
 * The model of a playtest: the outside player. `build` is the seat's request builder; `chat` asks
 * `answer`, which replies from the session's steps or never settles (the turn waits for a reply).
 */
export class PlaytestAdapter implements ModelAdapter {
  readonly spec: ModelSpec;
  readonly label: string;
  readonly capabilities: ModelCapabilities;
  private readonly builder: ModelAdapter;
  private readonly answer: (req: ChatRequest) => Promise<ChatResult>;

  constructor(builder: ModelAdapter, answer: (req: ChatRequest) => Promise<ChatResult>) {
    this.builder = builder;
    this.answer = answer;
    this.spec = builder.spec;
    this.label = builder.label;
    this.capabilities = builder.capabilities;
  }

  build(req: ChatRequest): unknown {
    return this.builder.build(req);
  }

  chat(req: ChatRequest): Promise<ChatResult> {
    return this.answer(req);
  }

  preflight(_sample: ChatRequest): Promise<PreflightReport> {
    return Promise.resolve({ model: this.spec.model, allowedFallbackModels: [], usage: [] });
  }
}
