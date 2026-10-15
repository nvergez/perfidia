import {
  adapterLabel,
  ModelError,
  type ChatRequest,
  type ChatResult,
  type Entry,
  type ModelAdapter,
  type ModelCall,
  type ModelSpec,
  type PreflightReport,
  type Refusal,
  type StopReason,
  type UsageEntry,
} from "./adapter.ts";

// `FakeAdapter` (phase-2 design §2.7): a model with no network. A brain answers each request with a
// result or a `ModelError`; replies carry Anthropic-shaped `native` content, so the recorded
// requests also go through `AnthropicAdapter.build()` in the cache-prefix tests. Without usage
// from the brain, usage is derived deterministically from byte lengths: the stable prefix is a
// cache write on a seat's first call and a cache read afterwards.

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

export class FakeAdapter implements ModelAdapter {
  readonly spec: ModelSpec;
  readonly label: string;
  /** Every request received, in order (entries copied: later appends do not show). */
  readonly requests: ChatRequest[] = [];
  private readonly brain: Brain;
  private readonly warm = new Set<string>();

  constructor(spec: ModelSpec, brain: Brain) {
    this.spec = spec;
    this.label = adapterLabel(spec);
    this.brain = brain;
  }

  /** A provider-agnostic layout like the Anthropic request: tools, two system blocks, messages. */
  build(req: ChatRequest): unknown {
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
      messages: req.entries.map((e: Entry) =>
        e.role === "assistant"
          ? { role: "assistant", content: e.reply.native }
          : e.role === "operator"
            ? { role: "system", content: e.text }
            : { role: "user", content: e.parts },
      ),
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
    const reply = refused
      ? { native: [], text: [], calls: [], reasoning: [] }
      : { native, text, calls, reasoning };
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
