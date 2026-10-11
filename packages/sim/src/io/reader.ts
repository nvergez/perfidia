import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { LogLineSchema, type LogLine } from "@perfidia/protocol";
import { JsonlError, isGzip } from "../harness/index.ts";

// The streaming log reader (docs/architecture.md §10.1, §12.1): a run's `match.jsonl` is read in
// chunks and yielded line by line, each validated with the log schema, so `verify` replays a log of
// any size without holding it whole. Lines are split on the byte 0x0A, which never occurs inside a
// multi-byte UTF-8 sequence, and each line is decoded on its own with a fatal decoder: invalid
// UTF-8, a cut multi-byte character, bad JSON or a schema failure all throw `JsonlError` with the
// 1-based number of the line that holds them. Gzip goldens (`.jsonl.gz`) are decompressed whole
// first (they are small by construction), then split the same way.
//
// The file is opened for each chunk read and closed before anything is yielded, so an iteration
// that is abandoned midway (the engine's `verifyLog` and `summarize` stop pulling lines when they
// throw) leaves no file descriptor open.

const CHUNK = 1 << 16;
const NEWLINE = 0x0a;

/** A log file that cannot be read as a whole, such as a corrupt gzip stream: no line to name. */
export class LogFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogFileError";
  }
}

/** Whether `error` says that a log file is corrupt (a bad line, or an unreadable file). */
export function isCorruptLog(error: unknown): error is JsonlError | LogFileError {
  return error instanceof JsonlError || error instanceof LogFileError;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One row of a log file, validated; throws `JsonlError` naming `lineNo`. */
export function parseLogLine(row: string, lineNo: number): LogLine {
  let value: unknown;
  try {
    value = JSON.parse(row);
  } catch (error) {
    throw new JsonlError(lineNo, `not JSON (${reason(error)})`);
  }
  const parsed = LogLineSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join(".") ?? "";
    throw new JsonlError(
      lineNo,
      `${path === "" ? "" : `${path}: `}${issue?.message ?? "invalid line"}`,
    );
  }
  return parsed.data;
}

/** The bytes of one row (without its `\n`), decoded strictly (a whole decode, never streamed). */
function parseLogBytes(decoder: TextDecoder, bytes: Uint8Array, lineNo: number): LogLine {
  let row: string;
  try {
    row = decoder.decode(bytes);
  } catch (error) {
    throw new JsonlError(lineNo, `not UTF-8 (${reason(error)})`);
  }
  return parseLogLine(row, lineNo);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The validated lines of a byte stream given in chunks. A row may span chunks; a final row without
 * `\n` is read too; an empty row is an error. Each chunk must stay unchanged once yielded.
 */
function* linesOfChunks(chunks: Iterable<Uint8Array>): Generator<LogLine, void, undefined> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending: Uint8Array[] = [];
  let lineNo = 0;
  for (const chunk of chunks) {
    let start = 0;
    for (let nl = chunk.indexOf(NEWLINE); nl >= 0; nl = chunk.indexOf(NEWLINE, start)) {
      lineNo += 1;
      pending.push(chunk.subarray(start, nl));
      const row = concat(pending);
      pending = [];
      yield parseLogBytes(decoder, row, lineNo);
      start = nl + 1;
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  }
  if (pending.length > 0) yield parseLogBytes(decoder, concat(pending), lineNo + 1);
}

/** The chunks of a plain file, each read through its own open and close (see the header comment). */
function* chunksOf(path: string): Generator<Uint8Array, void, undefined> {
  let position = 0;
  for (;;) {
    const buffer = new Uint8Array(CHUNK);
    const fd = openSync(path, "r");
    let n: number;
    try {
      n = readSync(fd, buffer, 0, CHUNK, position);
    } finally {
      closeSync(fd);
    }
    if (n === 0) return;
    position += n;
    yield buffer.subarray(0, n);
  }
}

/** The decompressed bytes of a `.jsonl.gz` file; throws `LogFileError` on a corrupt stream. */
function gunzipped(path: string): Uint8Array {
  const bytes = readFileSync(path);
  try {
    return Bun.gunzipSync(bytes);
  } catch (error) {
    throw new LogFileError(`not a valid gzip file (${reason(error)})`);
  }
}

/**
 * The validated lines of a log file, read lazily in 64 KiB chunks (`.jsonl`) or from the
 * decompressed bytes (`.jsonl.gz`). Throws `JsonlError` naming the first bad line, and
 * `LogFileError` for a gzip file that does not decompress.
 */
export function* readLogLines(path: string): Generator<LogLine, void, undefined> {
  yield* linesOfChunks(isGzip(path) ? [gunzipped(path)] : chunksOf(path));
}

/** Every validated line of a log file. */
export function readLog(path: string): LogLine[] {
  return [...readLogLines(path)];
}

/** The first line of a log file (its header, in a valid log), without reading the rest. */
export function readFirstLine(path: string): LogLine | undefined {
  for (const line of readLogLines(path)) return line;
  return undefined;
}
