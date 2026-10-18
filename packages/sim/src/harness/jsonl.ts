import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "@perfidia/engine/core";
import type { LogSink } from "@perfidia/gateway";
import type { LogLine, Snapshot } from "@perfidia/protocol";
import { isGzip, parseLogLine } from "./reader.ts";

// The canonical JSONL writer of the harness (docs/architecture.md §10.1, §12.1): one canonical
// JSON object per line, `\n` after each, gzip for `.jsonl.gz`. A file written here is
// byte-identical to a `MemorySink`'s `text()` for the same lines. Files are read back with
// `reader.ts` (`readLog`).

/** The JSONL text of `lines`: each line's canonical JSON (a string is taken as already canonical), then `\n`. */
export function jsonlText(lines: readonly (LogLine | string)[]): string {
  return lines.map((l) => `${typeof l === "string" ? l : canonicalJson(l)}\n`).join("");
}

/** Parses a JSONL text into validated log lines; throws `JsonlError` naming the first bad line. */
export function parseJsonl(text: string): LogLine[] {
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows.map((row, i) => parseLogLine(row, i + 1));
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
 * When a file sink writes its lines: at the host's flushes (`checkpoint`, the default), or each line
 * at once (`line`: a reader tailing the file, the spectator server, sees every line as it is
 * written). The bytes are the same.
 */
export type FlushMode = "checkpoint" | "line";

export interface JsonlFileSinkOptions {
  readonly snapshotsDir?: string;
  readonly flush?: FlushMode;
}

/**
 * A `LogSink` that appends to a `.jsonl` file (§10.1): each line is serialised at `write` and
 * buffered, and the buffer is appended at every `flush`. The host flushes after every engine step
 * that wrote checkpoint lines (so before the snapshot of that hour), after the end line and after
 * a fatal line: a killed run keeps its log up to its last checkpoint, and no snapshot file exists
 * without its `ckpt` line on disk. Snapshots go to `snapshotsDir` when one is given, written at
 * once. The file is created empty at construction. With `flush: "line"` every line is written at
 * `write` through a file descriptor kept open (closed after the end or fatal line, or by `close`):
 * more lines are durable earlier, the order of lines and snapshots is unchanged, and a crash can
 * still leave a partial last line.
 */
export class JsonlFileSink implements LogSink {
  readonly path: string;
  private readonly snapshotsDir: string | null;
  private readonly mode: FlushMode;
  private buffer: string[] = [];
  private fd: number | null = null;
  private closed = false;

  constructor(path: string, o: JsonlFileSinkOptions = {}) {
    if (isGzip(path))
      throw new Error("JsonlFileSink appends plain .jsonl; gzip whole files with writeJsonl");
    this.path = path;
    this.snapshotsDir = o.snapshotsDir ?? null;
    this.mode = o.flush ?? "checkpoint";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }

  write(line: LogLine): void {
    const text = `${canonicalJson(line)}\n`;
    if (this.mode === "checkpoint") {
      this.buffer.push(text);
      return;
    }
    if (this.closed) throw new Error(`${this.path}: the sink is closed`);
    this.fd ??= openSync(this.path, "a");
    const bytes = new TextEncoder().encode(text);
    let done = 0;
    while (done < bytes.length) done += writeSync(this.fd, bytes, done, bytes.length - done);
    if (line.k === "end" || line.k === "fatal") this.close();
  }

  /** Writes what is buffered and closes the kept-open file descriptor, if any. */
  close(): void {
    this.flush();
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    this.closed = this.mode === "line";
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
