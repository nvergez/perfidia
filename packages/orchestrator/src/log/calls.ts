import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  JsonSchema,
  REPLY_REASONING_MAX_CHARS,
  REPLY_TEXT_MAX_CHARS,
  type Json,
  type PlayerId,
} from "@perfidia/protocol";
import type { ChatResult, Entry } from "../model/adapter.ts";
import { LlmLogLineSchema, ReplyLineSchema, type LlmLogLine, type ReplyLine } from "./schema.ts";

// The LLM logs of a run directory (phase-2 design §5.1, §4.5): `llm_calls.jsonl`, one validated
// line per API attempt (and per hand-off, pause and wake cap), appended with a synchronous write so
// a crash loses nothing already paid; `replies.jsonl` (phase 3), one validated line per model reply
// that arrived, the provider-agnostic reasoning summaries, text and calls of the reply for the
// spectators, written right after the `llm_call` line of its attempt whatever `--transcripts` says;
// `transcripts/<seat>/t<turn>.jsonl`, every request (the new entries only, the conversation being
// append-only; the stable prefix by sha256) and every raw response; `prompts/`, the exact texts
// every agent saw.

/** What the agent hands the transcript writer. */
export type TranscriptRecord =
  | {
      readonly k: "request";
      readonly seat: PlayerId;
      readonly turn: number;
      readonly round: number;
      readonly attempt: number;
      readonly kind: "round" | "thought_call";
      /** sha256 of the stable prefix: the shared block, the seat block and the tools. */
      readonly prefix: { readonly shared: string; readonly seat: string; readonly tools: string };
      /** Index of the first entry below in the turn's conversation. */
      readonly from: number;
      readonly entries: readonly Entry[];
      readonly maxOutputTokens: number;
    }
  | {
      readonly k: "response";
      readonly seat: PlayerId;
      readonly turn: number;
      readonly round: number;
      readonly attempt: number;
      readonly raw: unknown;
    }
  | {
      readonly k: "error";
      readonly seat: PlayerId;
      readonly turn: number;
      readonly round: number;
      readonly attempt: number;
      readonly error: { readonly kind: string; readonly message: string };
    };

export interface CallLog {
  /** One line of `llm_calls.jsonl`; throws when the line does not match its schema. */
  write(line: LlmLogLine): void;
  /** One line of `replies.jsonl`; throws when the line does not match its schema. */
  reply(line: ReplyLine): void;
  transcript(record: TranscriptRecord): void;
}

function checked(line: LlmLogLine): LlmLogLine {
  const parsed = LlmLogLineSchema.safeParse(line);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `invalid ${line.k} line: ${issue?.path.map(String).join(".") ?? ""} ${issue?.message ?? ""}`,
    );
  }
  return parsed.data;
}

function checkedReply(line: ReplyLine): ReplyLine {
  const parsed = ReplyLineSchema.safeParse(line);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `invalid reply line: ${issue?.path.map(String).join(".") ?? ""} ${issue?.message ?? ""}`,
    );
  }
  return parsed.data;
}

/**
 * `parts` cut to `max` characters in total: whole parts while they fit, then the first that does
 * not, cut and ended with "…" (never inside a surrogate pair) when there is room, then nothing.
 */
export function cutParts(parts: readonly string[], max: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const p of parts) {
    if (used + p.length <= max) {
      out.push(p);
      used += p.length;
      continue;
    }
    // Room for the ellipsis at least: the total never exceeds `max`.
    if (used < max) {
      let keep = max - used - 1;
      const last = p.charCodeAt(keep - 1);
      if (keep > 0 && last >= 0xd800 && last <= 0xdbff) keep -= 1;
      out.push(`${p.slice(0, keep)}…`);
    }
    break;
  }
  return out;
}

/**
 * A tool call's arguments as JSON (the adapter parsed them from the reply); arguments JSON cannot
 * hold as they are (an own `__proto__` key) are kept as their JSON text.
 */
function jsonOf(value: unknown): Json {
  const text: string | undefined = JSON.stringify(value ?? null);
  if (text === undefined) return null;
  const parsed = JsonSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : text;
}

/** Where a reply was made: the round (or thought call) and attempt, and the game time of its request. */
export interface ReplyWhere {
  readonly seat: PlayerId;
  readonly turn: number;
  readonly round: number;
  readonly attempt: number;
  readonly kind: "round" | "thought_call";
  readonly t: number;
}

/**
 * The `replies.jsonl` line of a reply that arrived, or `null` for one the conversation never keeps
 * (refused, truncated, or any stop but `end_turn` and `tool_use`). Reasoning and text are cut to
 * `REPLY_REASONING_MAX_CHARS` and `REPLY_TEXT_MAX_CHARS`.
 */
export function replyLine(w: ReplyWhere, res: ChatResult): ReplyLine | null {
  if (res.stop !== "end_turn" && res.stop !== "tool_use") return null;
  return {
    k: "reply",
    seat: w.seat,
    turn: w.turn,
    round: w.round,
    attempt: w.attempt,
    kind: w.kind,
    t: w.t,
    stop: res.stop,
    reasoning: cutParts(res.reply.reasoning, REPLY_REASONING_MAX_CHARS),
    text: cutParts(res.reply.text, REPLY_TEXT_MAX_CHARS),
    calls: res.reply.calls.map((c) => ({ name: c.name, args: jsonOf(c.args) })),
  };
}

/** In memory (tests, `--fake` runs that keep no files). */
export class MemoryCallLog implements CallLog {
  readonly lines: LlmLogLine[] = [];
  readonly replies: ReplyLine[] = [];
  readonly transcripts: TranscriptRecord[] = [];
  private readonly keepTranscripts: boolean;

  constructor(o: { readonly transcripts?: boolean } = {}) {
    this.keepTranscripts = o.transcripts ?? true;
  }

  write(line: LlmLogLine): void {
    this.lines.push(checked(line));
  }

  reply(line: ReplyLine): void {
    this.replies.push(checkedReply(line));
  }

  transcript(record: TranscriptRecord): void {
    if (this.keepTranscripts) this.transcripts.push(record);
  }
}

/** The run directory's files; `transcripts: false` is `--transcripts off`. */
export class FileCallLog implements CallLog {
  readonly path: string;
  readonly repliesPath: string;
  private readonly dir: string;
  private readonly keepTranscripts: boolean;
  private readonly madeDirs = new Set<string>();

  constructor(dir: string, o: { readonly transcripts: boolean }) {
    this.dir = dir;
    this.path = join(dir, "llm_calls.jsonl");
    this.repliesPath = join(dir, "replies.jsonl");
    this.keepTranscripts = o.transcripts;
    mkdirSync(dir, { recursive: true });
  }

  write(line: LlmLogLine): void {
    appendFileSync(this.path, `${JSON.stringify(checked(line))}\n`);
  }

  reply(line: ReplyLine): void {
    appendFileSync(this.repliesPath, `${JSON.stringify(checkedReply(line))}\n`);
  }

  transcript(record: TranscriptRecord): void {
    if (!this.keepTranscripts) return;
    const dir = join(this.dir, "transcripts", record.seat);
    if (!this.madeDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      this.madeDirs.add(dir);
    }
    appendFileSync(join(dir, `t${record.turn}.jsonl`), `${JSON.stringify(record)}\n`);
  }
}

/** The exact agent-visible texts of a match, as written to `prompts/`. */
export interface PromptFiles {
  readonly shared: string;
  /** Seat block per LLM seat. */
  readonly seats: Readonly<Record<PlayerId, string>>;
  /** The operator texts (turn header and round reminder templates, thought call). */
  readonly operator: Readonly<Record<string, string>>;
  /** The transformed tools, as sent. */
  readonly tools: unknown;
}

/** Writes `prompts/shared.txt`, `prompts/<seat>.txt`, `operator.json` and `tools.json`. */
export function writePrompts(dir: string, p: PromptFiles): void {
  const out = join(dir, "prompts");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "shared.txt"), p.shared);
  for (const [seat, text] of Object.entries(p.seats)) writeFileSync(join(out, `${seat}.txt`), text);
  writeFileSync(join(out, "operator.json"), `${JSON.stringify(p.operator, null, 2)}\n`);
  writeFileSync(join(out, "tools.json"), `${JSON.stringify(p.tools, null, 2)}\n`);
}
