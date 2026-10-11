import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "@perfidia/engine/core";
import type { LogSink } from "@perfidia/gateway";
import { LogLineSchema, type LogLine, type Snapshot } from "@perfidia/protocol";

// The canonical JSONL reader and writer of the harness (docs/architecture.md §10.1, §12.1): one
// canonical JSON object per line, `\n` after each, gzip for `.jsonl.gz`. A file written here is
// byte-identical to a `MemorySink`'s `text()` for the same lines.

/** Whether `path` names a gzip-compressed log. */
export function isGzip(path: string): boolean {
  return path.endsWith(".gz");
}

/** The JSONL text of `lines`: each line's canonical JSON (a string is taken as already canonical), then `\n`. */
export function jsonlText(lines: readonly (LogLine | string)[]): string {
  return lines.map((l) => `${typeof l === "string" ? l : canonicalJson(l)}\n`).join("");
}

/** A line of a JSONL text that is not a valid log line, with its 1-based line number. */
export class JsonlError extends Error {
  readonly line: number;

  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = "JsonlError";
    this.line = line;
  }
}

/** Parses a JSONL text into validated log lines; throws `JsonlError` naming the first bad line. */
export function parseJsonl(text: string): LogLine[] {
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows.map((row, i) => {
    let value: unknown;
    try {
      value = JSON.parse(row);
    } catch (error) {
      throw new JsonlError(
        i + 1,
        `not JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const parsed = LogLineSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.map(String).join(".") ?? "";
      throw new JsonlError(
        i + 1,
        `${path === "" ? "" : `${path}: `}${issue?.message ?? "invalid line"}`,
      );
    }
    return parsed.data;
  });
}

/** The raw text of a log file (decompressed for `.jsonl.gz`). */
export function readJsonlText(path: string): string {
  const bytes = readFileSync(path);
  return isGzip(path) ? new TextDecoder().decode(Bun.gunzipSync(bytes)) : bytes.toString("utf8");
}

/** Reads and validates a log file. */
export function readJsonl(path: string): LogLine[] {
  return parseJsonl(readJsonlText(path));
}

/** Writes `lines` as a whole file (gzip for `.jsonl.gz`), creating its directory. */
export function writeJsonl(path: string, lines: readonly (LogLine | string)[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = jsonlText(lines);
  writeFileSync(path, isGzip(path) ? Bun.gzipSync(new TextEncoder().encode(text)) : text);
}

/** `h0024.json` for a checkpoint snapshot, `final.json` for the one taken after the end line. */
export function snapshotFileName(snap: Snapshot): string {
  return snap.t === snap.hour * 3600 ? `h${String(snap.hour).padStart(4, "0")}.json` : "final.json";
}

/**
 * A `LogSink` that appends to a `.jsonl` file: each line is serialised at `write` and buffered,
 * and the buffer is appended at every `flush` (the host flushes at the end and on a fatal error).
 * Snapshots go to `snapshotsDir` when one is given. The file is created empty at construction.
 */
export class JsonlFileSink implements LogSink {
  readonly path: string;
  private readonly snapshotsDir: string | null;
  private buffer: string[] = [];

  constructor(path: string, o: { readonly snapshotsDir?: string } = {}) {
    if (isGzip(path))
      throw new Error("JsonlFileSink appends plain .jsonl; gzip whole files with writeJsonl");
    this.path = path;
    this.snapshotsDir = o.snapshotsDir ?? null;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }

  write(line: LogLine): void {
    this.buffer.push(`${canonicalJson(line)}\n`);
  }

  snapshot(snap: Snapshot): void {
    if (this.snapshotsDir === null) return;
    mkdirSync(this.snapshotsDir, { recursive: true });
    writeFileSync(join(this.snapshotsDir, snapshotFileName(snap)), canonicalJson(snap));
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    appendFileSync(this.path, this.buffer.join(""));
    this.buffer = [];
  }
}
