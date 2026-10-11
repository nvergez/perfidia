import { closeSync, openSync, readSync } from "node:fs";
import { LogLineSchema, type LogLine } from "@perfidia/protocol";
import { JsonlError, isGzip, readJsonlText } from "../harness/index.ts";

// The streaming log reader (docs/architecture.md §10.1, §12.1): a run's `match.jsonl` is read in
// chunks and yielded line by line, each validated with the log schema, so `verify` replays a log of
// any size without holding it whole. A bad line throws `JsonlError` with its 1-based line number.
// Gzip goldens (`.jsonl.gz`) are decompressed whole first: they are small enough by construction.

const CHUNK = 1 << 16;

/** One row of a log file, validated; throws `JsonlError` naming `lineNo`. */
export function parseLogLine(row: string, lineNo: number): LogLine {
  let value: unknown;
  try {
    value = JSON.parse(row);
  } catch (error) {
    throw new JsonlError(
      lineNo,
      `not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
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

function* rowsOfText(text: string): Generator<LogLine, void, undefined> {
  let start = 0;
  let lineNo = 0;
  for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
    lineNo += 1;
    yield parseLogLine(text.slice(start, nl), lineNo);
    start = nl + 1;
  }
  if (start < text.length) yield parseLogLine(text.slice(start), lineNo + 1);
}

/**
 * The validated lines of a log file, read lazily in 64 KiB chunks (`.jsonl`) or from the
 * decompressed text (`.jsonl.gz`). A final line without `\n` is read too; an empty row is an error.
 * The file is closed when the iteration ends, completes or throws.
 */
export function* readLogLines(path: string): Generator<LogLine, void, undefined> {
  if (isGzip(path)) {
    yield* rowsOfText(readJsonlText(path));
    return;
  }
  const fd = openSync(path, "r");
  try {
    const buffer = new Uint8Array(CHUNK);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let rest = "";
    let lineNo = 0;
    for (;;) {
      const n = readSync(fd, buffer, 0, CHUNK, null);
      if (n === 0) break;
      let text: string;
      try {
        text = rest + decoder.decode(buffer.subarray(0, n), { stream: true });
      } catch (error) {
        throw new JsonlError(
          lineNo + 1,
          `not UTF-8 (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      let start = 0;
      for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
        lineNo += 1;
        yield parseLogLine(text.slice(start, nl), lineNo);
        start = nl + 1;
      }
      rest = text.slice(start);
    }
    rest += decoder.decode();
    if (rest !== "") yield parseLogLine(rest, lineNo + 1);
  } finally {
    closeSync(fd);
  }
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
