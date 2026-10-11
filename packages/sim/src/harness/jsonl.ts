import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
 * A `LogSink` that appends to a `.jsonl` file (§10.1): each line is serialised at `write` and
 * buffered, and the buffer is appended at every `flush`. The host flushes after every engine step
 * that wrote checkpoint lines (so before the snapshot of that hour), after the end line and after
 * a fatal line: a killed run keeps its log up to its last checkpoint, and no snapshot file exists
 * without its `ckpt` line on disk. Snapshots go to `snapshotsDir` when one is given, written at
 * once. The file is created empty at construction.
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
