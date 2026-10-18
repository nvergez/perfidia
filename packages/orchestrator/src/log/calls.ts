import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlayerId } from "@perfidia/protocol";
import type { Entry } from "../model/adapter.ts";
import { LlmLogLineSchema, type LlmLogLine } from "./schema.ts";

// The LLM logs of a run directory (phase-2 design §5.1, §4.5): `llm_calls.jsonl`, one validated
// line per API attempt (and per hand-off, pause and wake cap), appended with a synchronous write so
// a crash loses nothing already paid; `transcripts/<seat>/t<turn>.jsonl`, every request (the new
// entries only, the conversation being append-only; the stable prefix by sha256) and every raw
// response; `prompts/`, the exact texts every agent saw.

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

/** In memory (tests, `--fake` runs that keep no files). */
export class MemoryCallLog implements CallLog {
  readonly lines: LlmLogLine[] = [];
  readonly transcripts: TranscriptRecord[] = [];
  private readonly keepTranscripts: boolean;

  constructor(o: { readonly transcripts?: boolean } = {}) {
    this.keepTranscripts = o.transcripts ?? true;
  }

  write(line: LlmLogLine): void {
    this.lines.push(checked(line));
  }

  transcript(record: TranscriptRecord): void {
    if (this.keepTranscripts) this.transcripts.push(record);
  }
}

/** The run directory's files; `transcripts: false` is `--transcripts off`. */
export class FileCallLog implements CallLog {
  readonly path: string;
  private readonly dir: string;
  private readonly keepTranscripts: boolean;
  private readonly madeDirs = new Set<string>();

  constructor(dir: string, o: { readonly transcripts: boolean }) {
    this.dir = dir;
    this.path = join(dir, "llm_calls.jsonl");
    this.keepTranscripts = o.transcripts;
    mkdirSync(dir, { recursive: true });
  }

  write(line: LlmLogLine): void {
    appendFileSync(this.path, `${JSON.stringify(checked(line))}\n`);
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
