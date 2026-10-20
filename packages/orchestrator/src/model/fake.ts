import {
  adapterLabel,
  ModelError,
  type ChatRequest,
  type ChatResult,
  type ModelAdapter,
  type ModelCall,
  type ModelCapabilities,
  type ModelSpec,
  type PreflightReport,
  type Refusal,
  type StopReason,
  type UsageEntry,
} from "./adapter.ts";
import { capabilitiesFor } from "./catalog.ts";

// `FakeAdapter` (phase-2 design §2.7): a model with no network. A brain answers each request with a
// result or a `ModelError`; replies carry Anthropic-shaped `native` content, so the recorded
// requests also go through `AnthropicAdapter.build()` in the cache-prefix tests. Without usage
// from the brain, usage is derived deterministically from byte lengths: the stable prefix is a
// cache write on a seat's first call and a cache read afterwards.
//
// Phase 4 (Pass 1b): a fake seat mirrors its intended model (`intended`, priced at that model's
// cards by the arena): its capabilities, its reasoning kind, and in `build()` the way the intended
// provider receives harness text: a `system` message (Anthropic), a `developer` message (OpenAI), or
// a `[harness] ` text part appended to the user turn (Gemini, OpenRouter, compat).

/** What a brain answers: a reply to build, or an error to throw. */
export interface FakeReply {
  readonly text?: readonly string[];
  readonly calls?: readonly { readonly name: string; readonly args: unknown }[];
  readonly reasoning?: readonly string[];
  /** Default: `tool_use` when there are calls, else `end_turn`. */
  readonly stop?: StopReason;
  readonly rawStop?: string;
  readonly refusal?: Refusal;
  readonly usage?: readonly UsageEntry[];
  readonly servedBy?: string;
  readonly fallback?: boolean;
  readonly latencyMs?: number;
}

export type Brain = (
  req: ChatRequest,
  n: number,
) => FakeReply | ModelError | Promise<FakeReply | ModelError>;

/** One step of a scripted brain: a reply, an error, or a function of the request. */
export type FakeStep =
  | FakeReply
  | ModelError
  | ((req: ChatRequest) => FakeReply | ModelError | Promise<FakeReply | ModelError>);

/** A scripted brain: the steps in order, then an error. A function step answers from the request. */
export function scripted(steps: readonly FakeStep[]): Brain {
  let i = 0;
  return (req) => {
    const step = steps[i];
    i += 1;
    if (step === undefined) throw new Error(`scripted brain: no step ${i} (${steps.length} given)`);
    return typeof step === "function" ? step(req) : step;
  };
}

const chars = (v: unknown): number => JSON.stringify(v ?? null).length;

/** The call id of the `i`-th call of a fake reply: stable, so runs are byte-identical. */
export function fakeCallId(req: ChatRequest, i: number, attempt: number): string {
  const m = req.meta;
  return `fk-${m.seat}-${m.turn}-${m.round}-${attempt}-${i}`;
}

/** The model a fake seat stands in for: priced at its cards, its channel mirrored. */
export interface IntendedModel {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string | null;
}

/** The prefix of harness text inside a user turn (the `envelope` channel, design §3.2). */
export const HARNESS_PREFIX = "[harness] ";

export class FakeAdapter implements ModelAdapter {
  readonly spec: ModelSpec;
  readonly label: string;
  readonly capabilities: ModelCapabilities;
  /** The intended model (Pass 1b); phase 2's fakes stand in for the Claude model of their spec. */
  readonly intended: IntendedModel;
  /** Every request received, in order (entries copied: later appends do not show). */
  readonly requests: ChatRequest[] = [];
  private readonly brain: Brain;
  private readonly warm = new Set<string>();

  constructor(spec: ModelSpec, brain: Brain, o: { readonly intended?: IntendedModel } = {}) {
    this.spec = spec;
    this.label = adapterLabel(spec);
    this.brain = brain;
    this.intended = o.intended ?? {
      provider: "anthropic",
      model: spec.model,
      endpoint: spec.endpoint ?? null,
    };
    this.capabilities = capabilitiesFor(
      this.intended.provider,
      this.intended.model,
      this.intended.endpoint,
    );
  }

  /**
   * A provider-agnostic layout like the Anthropic request (tools, two system blocks, messages),
   * with harness text rendered as the intended provider receives it.
   */
  build(req: ChatRequest): unknown {
    const channel = this.capabilities.operatorChannel;
    const messages: { readonly role: string; readonly content: unknown }[] = [];
    /** The parts of the last message when it is a user turn (an envelope note joins it). */
    let userParts: unknown[] | null = null;
    for (const e of req.entries) {
      if (e.role === "user") {
        userParts = [...e.parts];
        messages.push({ role: "user", content: userParts });
        continue;
      }
      if (e.role === "operator" && channel === "envelope") {
        const part = { kind: "text", text: `${HARNESS_PREFIX}${e.text}` };
        if (userParts !== null) userParts.push(part);
        else {
          userParts = [part];
          messages.push({ role: "user", content: userParts });
        }
        continue;
      }
      userParts = null;
      if (e.role === "assistant") messages.push({ role: "assistant", content: e.reply.native });
      else
        messages.push({ role: channel === "developer" ? "developer" : "system", content: e.text });
    }
    return {
      model: this.spec.model,
      max_tokens: req.maxOutputTokens ?? this.spec.maxOutputTokens,
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
      system: [
        { type: "text", text: req.prompt.shared },
        { type: "text", text: req.prompt.seat },
      ],
      messages,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push({ ...req, entries: [...req.entries] });
    const n = this.requests.length;
    const aborted = (): boolean => req.signal?.aborted === true;
    if (aborted()) throw new ModelError("aborted", "request aborted");
    const answer = await this.brain(req, n);
    // A brain's own error first: an aborted brain may carry what the attempt cost.
    if (answer instanceof ModelError) throw answer;
    if (aborted()) throw new ModelError("aborted", "request aborted");
    return this.resultOf(req, answer, n);
  }

  private resultOf(req: ChatRequest, r: FakeReply, attempt: number): ChatResult {
    const text = r.text ?? [];
    const reasoning = r.reasoning ?? [];
    const calls: ModelCall[] = (r.calls ?? []).map((c, i) => ({
      callId: fakeCallId(req, i, attempt),
      name: c.name,
      args: c.args,
    }));
    const native = [
      ...reasoning.map((t) => ({ type: "thinking", thinking: t, signature: "fake" })),
      ...text.map((t) => ({ type: "text", text: t })),
      ...calls.map((c) => ({ type: "tool_use", id: c.callId, name: c.name, input: c.args })),
    ];
    const stop: StopReason = r.stop ?? (calls.length > 0 ? "tool_use" : "end_turn");
    const refused = stop === "refusal";
    const reasoningKind = this.capabilities.reasoning;
    const reply = refused
      ? { native: [], text: [], calls: [], reasoning: [], reasoningKind }
      : { native, text, calls, reasoning, reasoningKind };
    const servedBy = r.servedBy ?? this.spec.model;
    return {
      reply,
      stop,
      rawStop: r.rawStop ?? stop,
      refusal: refused
        ? (r.refusal ?? { category: null, explanation: null, recommendedModel: null })
        : null,
      servedBy,
      fallback: r.fallback ?? false,
      usage: r.usage ?? this.usageOf(req, native, servedBy),
      requestId: `fake-${attempt}`,
      latencyMs: r.latencyMs ?? 0,
      ttftMs: null,
      raw: { model: servedBy, stop_reason: stop, content: native },
    };
  }

  private usageOf(req: ChatRequest, native: readonly unknown[], model: string): UsageEntry[] {
    const prefix = Math.ceil(
      (req.prompt.shared.length + req.prompt.seat.length + chars(req.tools)) / 4,
    );
    const first = !this.warm.has(req.meta.seat);
    this.warm.add(req.meta.seat);
    return [
      {
        model,
        kind: "message",
        tokens: {
          input: Math.ceil(chars(req.entries) / 4),
          cacheWrite5m: first ? prefix : 0,
          cacheWrite1h: 0,
          cacheRead: first ? 0 : prefix,
          output: 300 + Math.ceil(chars(native) / 4),
        },
        estimated: false,
      },
    ];
  }

  preflight(_sample: ChatRequest): Promise<PreflightReport> {
    return Promise.resolve({ model: this.spec.model, allowedFallbackModels: [], usage: [] });
  }
}
