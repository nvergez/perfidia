import { canonicalJson } from "@perfidia/engine/core";
import { LogLineSchema, SnapshotSchema, type LogLine, type Snapshot } from "@perfidia/protocol";

// Log sinks (docs/architecture.md §8.7, §10.1): synchronous, and each serialises at `write`, so
// what a sink holds can never change afterwards (§6.6), whatever the host or an agent later does
// with the objects it wrote. Lines and snapshots are canonical JSON (§6.3), one per line.

export interface LogSink {
  /** Synchronous; serialises the line at once (canonical JSON). */
  write(line: LogLine): void;
  /** Serialises at once. */
  snapshot?(snap: Snapshot): void;
  flush?(): void;
}

/**
 * A sink that keeps the canonical text in memory, for tests and in-process runs: `lines` holds one
 * canonical JSON object per line, byte-identical to what a file sink writes.
 */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  readonly snapshots: string[] = [];

  write(line: LogLine): void {
    this.lines.push(canonicalJson(line));
  }

  snapshot(snap: Snapshot): void {
    this.snapshots.push(canonicalJson(snap));
  }

  /** The log as a JSONL file holds it: every line followed by `\n`. */
  text(): string {
    return this.lines.map((l) => `${l}\n`).join("");
  }

  /** Fresh parsed lines, validated with the log schema. */
  parsed(): LogLine[] {
    return this.lines.map((l) => LogLineSchema.parse(JSON.parse(l)));
  }

  /** Fresh parsed snapshots, validated with the snapshot schema. */
  parsedSnapshots(): Snapshot[] {
    return this.snapshots.map((s) => SnapshotSchema.parse(JSON.parse(s)));
  }
}

/** Writes every line and snapshot to each of `sinks`, in order (e.g. a file sink and a memory sink). */
export function teeSink(...sinks: readonly LogSink[]): LogSink {
  return {
    write(line) {
      for (const s of sinks) s.write(line);
    },
    snapshot(snap) {
      for (const s of sinks) s.snapshot?.(snap);
    },
    flush() {
      for (const s of sinks) s.flush?.();
    },
  };
}
