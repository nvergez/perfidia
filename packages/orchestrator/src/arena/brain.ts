import { botFromLabel } from "@perfidia/bots";
import {
  BriefingSchema,
  ToolResultSchema,
  type Briefing,
  type PlayerId,
  type RoundInput,
  type SeatAgent,
  type TimeSource,
  type ToolResult,
} from "@perfidia/protocol";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  ModelError,
  brokenStreamOutput,
  type ChatRequest,
  type UsageEntry,
} from "../model/adapter.ts";
import { seededRandom, sleepMs } from "../model/clock.ts";
import type { Brain, FakeReply } from "../model/fake.ts";

// The bot-backed brain of `FakeAdapter` (phase-2 design §2.7): the integration tests and
// `arena run --fake` play the whole LLM pipe (prompts, mapping, results, ledger, logs, hand-offs,
// gates) with real game play and no network. It keeps ONE bot instance per seat for the whole
// match (bots keep a per-turn state and per-match caches), rebuilds the bot's `RoundInput` from the
// request (the briefing is the round-0 user text, the results are the `tool_result` contents, the
// rest comes from `meta`) and replies with the bot's calls as tool calls. The thought goes out as
// text on a terminal reply, as the prompt asks a model to do. Every reply also carries one
// deterministic reasoning summary ("Fake reasoning: …", the calls and the bot's thought), so the
// spectator path of reasoning (`replies.jsonl`) is exercised with no network; it is left out of the
// usage, so fake costs are those of a reply without it. In real time it can add a seeded latency on
// the run's time source; an attempt aborted while it "thinks" is charged as the Anthropic adapter
// charges a broken stream (`brokenStreamOutput`, from the time it streamed).

export interface BrainLatency {
  readonly time: TimeSource;
  /** Inclusive range in ms; drawn per call from the seed, seat, turn and round. */
  readonly rangeMs: readonly [number, number];
}

export interface BotBrainOptions {
  /** `bot:<strategy>@<n>`. */
  readonly label: string;
  readonly seat: PlayerId;
  readonly seed: number;
  readonly latency?: BrainLatency;
  /** The model the usage is reported for (and an aborted attempt's estimate priced at). */
  readonly model?: string;
  /** The seat's `max_tokens` (default 16 000): an aborted attempt is charged at most this. */
  readonly maxOutputTokens?: number;
  /**
   * Characters of the stable prefix (tools, both system blocks). When given, the brain reports a
   * usage shaped like the API's with automatic caching: the prefix is written on the seat's first
   * call and read afterwards; within a turn, the previous request's messages are read and only
   * what was appended is written. Without it, `FakeAdapter` derives a flat usage.
   */
  readonly prefixChars?: number;
}

/**
 * The JSON length of a request's entries as if its replies carried no reasoning (empty summaries,
 * no thinking blocks): the fake usage leaves the fake reasoning out.
 */
function entriesChars(req: ChatRequest): number {
  return JSON.stringify(req.entries, (key, value: unknown) => {
    if (key === "reasoning") return [];
    if (Array.isArray(value)) {
      const blocks: readonly unknown[] = value;
      return blocks.filter(
        (b) => !(b !== null && typeof b === "object" && Reflect.get(b, "type") === "thinking"),
      );
    }
    return value;
  }).length;
}

/** The fake reasoning summary of a reply: what the bot called and thought, deterministic. */
export function fakeReasoning(
  label: string,
  turn: number,
  round: number,
  calls: readonly { readonly name: string }[],
  thought: string | undefined,
): string {
  const what = calls.length === 0 ? "no call" : calls.map((c) => c.name).join(", ");
  return `Fake reasoning: ${label} plays turn ${turn}, round ${round}: ${what}.${thought === undefined ? "" : ` ${thought}`}`;
}

/** The text of the round-0 briefing entry. */
function briefingOf(req: ChatRequest): Briefing {
  const first = req.entries[0];
  const part = first?.role === "user" ? first.parts[0] : undefined;
  if (part?.kind !== "text") throw new Error("bot brain: the conversation has no briefing");
  return BriefingSchema.parse(JSON.parse(part.text));
}

/** The tool results of the latest user entry (none in round 0). */
function resultsOf(req: ChatRequest): ToolResult[] {
  if (req.meta.round === 0) return [];
  for (let i = req.entries.length - 1; i >= 0; i -= 1) {
    const e = req.entries[i];
    if (e?.role !== "user") continue;
    return e.parts.flatMap((p) =>
      p.kind === "result" ? [ToolResultSchema.parse(JSON.parse(p.content))] : [],
    );
  }
  return [];
}

/** The bot's `RoundInput` rebuilt from a request. */
export function roundInputOf(req: ChatRequest): RoundInput {
  const m = req.meta;
  return {
    seat: m.seat,
    turn: m.turn,
    round: m.round,
    maxRounds: m.maxRounds,
    maxCalls: m.maxCalls,
    briefing: briefingOf(req),
    results: resultsOf(req),
  };
}

/** A per-call draw in `[lo, hi]`, a pure function of its inputs. */
function latencyOf(seed: number, seat: PlayerId, turn: number, round: number, r: BrainLatency) {
  const [lo, hi] = r.rangeMs;
  let h = seed >>> 0;
  for (const c of `${seat}:${turn}:${round}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return lo + Math.floor(seededRandom(h)() * (hi - lo + 1));
}

/** The bot-backed brain of one seat. */
export function botBrain(o: BotBrainOptions): Brain {
  const bot: SeatAgent | null = botFromLabel(o.label, { seat: o.seat, seed: o.seed });
  if (bot === null) throw new Error(`no bot named ${o.label} in this build`);
  let lastThought: { readonly turn: number; readonly text: string } | null = null;
  let warm = false;
  let last: { readonly turn: number; readonly chars: number } | null = null;
  const usageOf = (req: ChatRequest, reply: unknown): UsageEntry[] | undefined => {
    if (o.prefixChars === undefined || o.model === undefined) return undefined;
    const prefix = Math.ceil(o.prefixChars / 4);
    const chars = entriesChars(req);
    const prev = last?.turn === req.meta.turn ? last.chars : 0;
    const first = !warm;
    warm = true;
    last = { turn: req.meta.turn, chars };
    return [
      {
        model: o.model,
        kind: "message",
        tokens: {
          input: 0,
          cacheWrite5m: Math.ceil((chars - prev) / 4) + (first ? prefix : 0),
          cacheWrite1h: 0,
          cacheRead: Math.ceil(prev / 4) + (first ? 0 : prefix),
          output: 300 + Math.ceil(JSON.stringify(reply).length / 4),
        },
        estimated: false,
      },
    ];
  };
  return async (req: ChatRequest): Promise<FakeReply | ModelError> => {
    const m = req.meta;
    if (m.kind === "thought") {
      // The out-of-band thought call: the turn's last thought, never a tool call.
      const text = lastThought?.turn === m.turn ? lastThought.text : "Holding course.";
      return { text: [text], reasoning: [fakeReasoning(o.label, m.turn, m.round, [], text)] };
    }
    let latencyMs = 0;
    if (o.latency !== undefined) {
      const ms = latencyOf(o.seed, o.seat, m.turn, m.round, o.latency);
      latencyMs = ms;
      const time = o.latency.time;
      const start = time.nowMs();
      try {
        await sleepMs(time, ms, req.signal);
      } catch (e) {
        if (req.signal?.aborted !== true) throw e;
        const maxTokens = req.maxOutputTokens ?? o.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
        const spent = estimate(req, o.model, maxTokens, time.nowMs() - start);
        return new ModelError("aborted", "request aborted", { spent });
      }
    }
    const out = await bot.round(roundInputOf(req));
    if (out.thought !== undefined) lastThought = { turn: m.turn, text: out.thought };
    const calls = out.calls.map((c) => ({ name: c.tool, args: c.args }));
    const terminal =
      calls.length === 0 || calls.some((c) => c.name === "end_turn") || m.round >= m.maxRounds - 1;
    const thought =
      out.thought ?? (terminal && lastThought?.turn === m.turn ? lastThought.text : undefined);
    const text = thought === undefined ? [] : [thought];
    const usage = usageOf(req, { text, calls });
    const reasoning = [fakeReasoning(o.label, m.turn, m.round, calls, out.thought)];
    return { text, calls, reasoning, latencyMs, ...(usage === undefined ? {} : { usage }) };
  };
}

/** What an aborted fake attempt is charged: its input, and the broken-stream output estimate. */
function estimate(
  req: ChatRequest,
  model: string | undefined,
  maxTokens: number,
  streamedMs: number,
): UsageEntry[] {
  if (model === undefined) return [];
  return [
    {
      model,
      kind: "message",
      tokens: {
        input: Math.ceil(JSON.stringify(req.entries).length / 4),
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: brokenStreamOutput({ observed: 0, maxTokens, streamedMs }),
      },
      estimated: true,
    },
  ];
}
