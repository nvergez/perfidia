import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalJson } from "@perfidia/engine/core";
import type { LogSink } from "@perfidia/gateway";
import { SnapshotSchema, type LogLine, type Snapshot } from "@perfidia/protocol";
import { UsageError } from "../args.ts";
import { JsonlFileSink, type FlushMode } from "../harness/index.ts";

// The run directory (docs/architecture.md §10.1): `match.jsonl` (authoritative, append-only),
// `snapshots/h0024.json` at checkpoint hours plus `snapshots/final.json` after the end line, and
// `summary.json`. The file sink buffers lines and appends them at each flush (the harness's
// `JsonlFileSink`); snapshots are written whole, through a temporary file and a rename, so a killed
// run never leaves a truncated snapshot behind.

export const LOG_FILE = "match.jsonl";
export const SUMMARY_FILE = "summary.json";
export const SNAPSHOTS_DIR = "snapshots";
export const TRACE_FILE = "trace.jsonl";
export const FINAL_SNAPSHOT = "final.json";

export interface RunPaths {
  readonly dir: string;
  readonly log: string;
  readonly snapshots: string;
  readonly summary: string;
  readonly trace: string;
}

export function runPaths(dir: string): RunPaths {
  return {
    dir,
    log: join(dir, LOG_FILE),
    snapshots: join(dir, SNAPSHOTS_DIR),
    summary: join(dir, SUMMARY_FILE),
    trace: join(dir, TRACE_FILE),
  };
}

/** `h0024.json`: the file of the checkpoint snapshot of `hour`. */
export function checkpointSnapshotName(hour: number): string {
  return `h${String(hour).padStart(4, "0")}.json`;
}

export interface LocatedLog {
  readonly log: string;
  /** Where the run's snapshots and summary live: the run directory, or the log file's directory. */
  readonly dir: string;
  /** Whether the target named a run directory (rather than a log file). */
  readonly isRunDir: boolean;
}

/**
 * The log of `<run-dir | match.jsonl>`: a directory gives its `match.jsonl` (or `match.jsonl.gz`),
 * a file is taken as is. Throws `UsageError` when there is no such log.
 */
export function locateLog(target: string): LocatedLog {
  if (!existsSync(target)) throw new UsageError(`${target}: no such run directory or log file`);
  if (statSync(target).isDirectory()) {
    for (const name of [LOG_FILE, `${LOG_FILE}.gz`]) {
      const log = join(target, name);
      if (existsSync(log)) return { log, dir: target, isRunDir: true };
    }
    throw new UsageError(`${target}: not a run directory (no ${LOG_FILE} in it)`);
  }
  return { log: target, dir: dirname(target), isRunDir: false };
}

/**
 * What already makes `dir` hold a run, or null when a new run may be written there: a log
 * (`match.jsonl` or `match.jsonl.gz`), a `summary.json`, a `trace.jsonl` or a non-empty
 * `snapshots/`. A missing or empty directory, or one with other files only, is free.
 */
export function runDirContents(dir: string): string | null {
  for (const name of [LOG_FILE, `${LOG_FILE}.gz`, SUMMARY_FILE, TRACE_FILE]) {
    if (existsSync(join(dir, name))) return name;
  }
  const snapshots = join(dir, SNAPSHOTS_DIR);
  if (!existsSync(snapshots)) return null;
  if (!statSync(snapshots).isDirectory() || readdirSync(snapshots).length > 0) {
    return `${SNAPSHOTS_DIR}/`;
  }
  return null;
}

/** Throws `UsageError` when `dir` already holds a run (`runDirContents`): runs are never overwritten. */
export function assertFreeRunDir(dir: string): void {
  const found = runDirContents(dir);
  if (found !== null) {
    throw new UsageError(
      `${dir} already holds a run (${found}): runs are never overwritten, choose another --out`,
    );
  }
}

/**
 * A directory for a new run: `base` when it holds no run (`runDirContents`), else `base-2`,
 * `base-3`, … A run is never written over another one.
 */
export function freeRunDir(base: string): string {
  for (let i = 1; ; i += 1) {
    const dir = i === 1 ? base : `${base}-${i}`;
    if (runDirContents(dir) === null) return dir;
  }
}

/** Writes `text` to `path` through a temporary file and a rename. */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * The file sink of a run directory (§10.1): lines are serialised at `write`, buffered, and appended
 * to `match.jsonl` at every `flush` (the host flushes after each step that wrote checkpoint lines,
 * after the end line and after a fatal line); with `flush: "line"` each line is written at once
 * (`JsonlFileSink`), for a reader tailing the log. Snapshots go to `snapshots/`: a checkpoint
 * snapshot as `h0024.json`, the one taken after the end line as `final.json`. `match.jsonl` is
 * created empty at construction, and a directory that already holds a run is refused
 * (`UsageError`), so a log is never truncated and a run directory never mixes the files of two
 * matches.
 */
export class RunDirSink implements LogSink {
  readonly paths: RunPaths;
  private readonly file: JsonlFileSink;
  private ended = false;

  constructor(dir: string, o: { readonly flush?: FlushMode } = {}) {
    assertFreeRunDir(dir);
    this.paths = runPaths(dir);
    mkdirSync(dir, { recursive: true });
    this.file = new JsonlFileSink(this.paths.log, o.flush === undefined ? {} : { flush: o.flush });
  }

  write(line: LogLine): void {
    this.file.write(line);
    if (line.k === "end") this.ended = true;
  }

  snapshot(snap: Snapshot): void {
    const name = this.ended ? FINAL_SNAPSHOT : checkpointSnapshotName(snap.hour);
    writeFileAtomic(join(this.paths.snapshots, name), canonicalJson(snap));
  }

  flush(): void {
    this.file.flush();
  }

  /** Flushes and closes the log's kept-open file descriptor (`flush: "line"`), if any. */
  close(): void {
    this.file.close();
  }
}

/** A snapshot file, validated; throws `UsageError` naming the file when it is missing or invalid. */
export function readSnapshotFile(path: string): Snapshot {
  if (!existsSync(path)) throw new UsageError(`${path}: no such snapshot file`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(
      `${path}: not a JSON snapshot (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const parsed = SnapshotSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.map(String).join(".") ?? "";
    throw new UsageError(
      `${path}: not a valid snapshot: ${where === "" ? "" : `${where}: `}${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

export interface SnapshotFile {
  /** The checkpoint hour of an `hNNNN.json` file; null for `final.json`. */
  readonly hour: number | null;
  readonly path: string;
}

/** The snapshot files of a run directory, checkpoint ones by hour, then `final.json`. */
export function listSnapshots(dir: string): SnapshotFile[] {
  const sdir = join(dir, SNAPSHOTS_DIR);
  if (!existsSync(sdir)) return [];
  const out: SnapshotFile[] = [];
  let final: SnapshotFile | null = null;
  for (const name of readdirSync(sdir)) {
    const m = /^h([0-9]{4,})\.json$/.exec(name);
    if (m?.[1] !== undefined) out.push({ hour: Number(m[1]), path: join(sdir, name) });
    else if (name === FINAL_SNAPSHOT) final = { hour: null, path: join(sdir, name) };
  }
  out.sort((a, b) => (a.hour ?? 0) - (b.hour ?? 0));
  if (final !== null) out.push(final);
  return out;
}

/**
 * The snapshot file `--from` names: `h72`, `h072`, `h0072` or `72` (the checkpoint snapshot of hour
 * 72 in the run's `snapshots/`), or a path to a snapshot file.
 */
export function snapshotPathFor(dir: string, from: string): string {
  const m = /^h?([0-9]+)$/.exec(from);
  if (m?.[1] !== undefined) {
    const hour = Number(m[1]);
    if (!Number.isSafeInteger(hour)) throw new UsageError(`--from ${from}: not an hour`);
    return join(dir, SNAPSHOTS_DIR, checkpointSnapshotName(hour));
  }
  if (from === "final" || basename(from) === FINAL_SNAPSHOT) {
    throw new UsageError(
      "--from needs a checkpoint snapshot (hNNNN.json): the final snapshot is taken after the end line, so no checkpoint line follows it",
    );
  }
  return from;
}
