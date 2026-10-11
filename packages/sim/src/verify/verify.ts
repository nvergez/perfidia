import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RULESETS,
  findRuleset,
  verifyLog,
  type InvariantLevel,
  type ReplayDivergence,
  type ReplayReport,
  type VerifyOptions,
} from "@perfidia/engine";
import { canonicalJson, fmtTime } from "@perfidia/engine/core";
import type { LogLine, Snapshot } from "@perfidia/protocol";
import { EXIT, UsageError, errorText, type CliIo, type ExitCode } from "../args.ts";
import { normalisedText, resimProblem, resimulate } from "../harness/index.ts";
import {
  checkpointSnapshotName,
  isCorruptLog,
  listSnapshots,
  locateLog,
  readFirstLine,
  readLog,
  readLogLines,
  readSnapshotFile,
  snapshotPathFor,
  writeFileAtomic,
  type LocatedLog,
} from "../io/index.ts";
import { jsonDiff } from "./diff.ts";

// `sim verify` (docs/architecture.md §10.4, §12.1): Level E through the engine's `verifyLog`
// (streaming the log), resuming after a snapshot's checkpoint with `--from`; `--dump` writes the
// replay's state at the first divergent checkpoint and prints a structural diff against the
// nearest saved snapshot; `--resim` re-simulates the match through the harness (Level G) and
// compares the normalised logs line by line. A corrupt log file is a failed verification (exit 1,
// naming the line); a header whose ruleset this build lacks is a usage error (exit 3, §3.5).

export interface VerifyRequest {
  /** A run directory or a log file. */
  readonly target: string;
  /** `h72`, `72` or a snapshot file: resume after that snapshot's checkpoint. */
  readonly from?: string | undefined;
  readonly resim?: boolean | undefined;
  readonly dump?: boolean | undefined;
  readonly invariants?: InvariantLevel | undefined;
}

const MAX_TEXT = 400;
const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

/** `checkpoint divergence at t = 3600 (D1 01:00), hour 1, n 17`, then the two sides. */
export function describeDivergence(d: ReplayDivergence): string {
  const where = [
    `t = ${d.t} (${fmtTime(d.t)})`,
    ...(d.hour === undefined ? [] : [`hour ${d.hour}`]),
    ...(d.n === undefined ? [] : [`n ${d.n}`]),
  ].join(", ");
  return `${d.kind} divergence at ${where}\n  expected: ${clip(d.expected)}\n  actual:   ${clip(d.actual)}`;
}

function options(req: VerifyRequest, from: Snapshot | undefined): VerifyOptions {
  return {
    ...(from === undefined ? {} : { from }),
    ...(req.invariants === undefined ? {} : { invariants: req.invariants }),
  };
}

/**
 * The replay's state at the first divergent checkpoint, found by replaying again and keeping the
 * states of the checkpoints produced but not yet matched by a `ckpt` line. An event divergence is
 * replayed without event comparison, so it surfaces at the checkpoint its effect first changes.
 * Null when the replay stops before any checkpoint differs (a result or order divergence, say).
 */
export function divergentCheckpoint(
  log: string,
  base: VerifyOptions,
  first: ReplayDivergence,
): { readonly hour: number; readonly t: number; readonly state: string } | null {
  const produced = new Map<number, { t: number; state: string }>();
  const report = verifyLog(readLogLines(log), {
    ...base,
    compareEvents: first.kind !== "event",
    onCheckpoint(hour, r) {
      produced.set(hour, { t: r.now, state: canonicalJson(r.state) });
    },
    onLine(line) {
      if (line.k !== "ckpt") return;
      for (const hour of produced.keys()) if (hour <= line.hour) produced.delete(hour);
    },
  });
  const d = report.divergence;
  if (d?.kind !== "checkpoint" || d.hour === undefined) return null;
  const got = produced.get(d.hour);
  return got === undefined ? null : { hour: d.hour, ...got };
}

/**
 * `--dump`: writes the divergent checkpoint's state and prints its diff against the nearest
 * snapshot. The dump goes into the run directory when the target was one; for a log file (a
 * committed golden, say) it goes into a fresh temporary directory, never next to the file.
 */
function dump(io: CliIo, located: LocatedLog, base: VerifyOptions, first: ReplayDivergence): void {
  const { log, dir } = located;
  const ck = divergentCheckpoint(log, base, first);
  if (ck === null) {
    io.out(
      `--dump: no checkpoint differs before the replay stops (${first.kind} divergence), so there is no state to dump\n`,
    );
    return;
  }
  const into = located.isRunDir ? dir : mkdtempSync(join(tmpdir(), "perfidia-dump-"));
  const path = join(into, `dump-${checkpointSnapshotName(ck.hour)}`);
  writeFileAtomic(path, ck.state);
  io.out(`--dump: the replay's state at hour ${ck.hour} (${fmtTime(ck.t)}) is in ${path}\n`);
  const snaps = listSnapshots(dir).filter((s) => s.hour !== null);
  const nearest = snaps.toSorted(
    (a, b) =>
      Math.abs((a.hour ?? 0) - ck.hour) - Math.abs((b.hour ?? 0) - ck.hour) ||
      (a.hour ?? 0) - (b.hour ?? 0),
  )[0];
  if (nearest === undefined || nearest.hour === null) {
    io.out("--dump: the run has no checkpoint snapshot to compare with\n");
    return;
  }
  const snap = readSnapshotFile(nearest.path);
  const actual: unknown = JSON.parse(ck.state);
  const diff = jsonDiff(snap.state, actual, 20);
  const note =
    nearest.hour === ck.hour
      ? "the recorded state of that hour"
      : `hour ${nearest.hour}, so the diff also shows the game's progress between the two hours`;
  io.out(
    `--dump: structural diff, snapshot ${nearest.path} (${note}) → replay, ${diff.entries.length}${diff.truncated ? "+" : ""} path(s):\n`,
  );
  for (const e of diff.entries) io.out(`  ${e.path}: ${e.expected} → ${e.actual}\n`);
  if (diff.truncated) io.out("  … (first 20 paths only)\n");
}

/** The first line where two texts differ, 1-based, or null when they are equal. */
export function firstDifferentLine(
  a: string,
  b: string,
): { readonly line: number; readonly a: string; readonly b: string } | null {
  if (a === b) return null;
  const la = a.split("\n");
  const lb = b.split("\n");
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i += 1) {
    if (la[i] !== lb[i]) return { line: i + 1, a: la[i] ?? "(end)", b: lb[i] ?? "(end)" };
  }
  return null;
}

/** Level G (§10.4): re-simulates the log's match and compares the normalised logs. */
async function levelG(
  io: CliIo,
  log: string,
  invariants: InvariantLevel | undefined,
): Promise<ExitCode> {
  const lines: LogLine[] = readLog(log);
  const header = lines[0];
  if (header?.k !== "header") throw new UsageError(`${log}: no header line`);
  const problem = resimProblem(header, lines);
  if (problem !== null) throw new UsageError(`--resim: ${problem}`);
  let again: LogLine[];
  try {
    again = (await resimulate(lines, invariants === undefined ? {} : { invariants })).lines;
  } catch (error) {
    io.err(`Level G: the re-simulation failed: ${errorText(error)}\n`);
    return EXIT.fatal;
  }
  const diff = firstDifferentLine(normalisedText(lines), normalisedText(again));
  if (diff === null) {
    io.out(`Level G: identical · ${lines.length} lines (normalised)\n`);
    return EXIT.ok;
  }
  io.out(
    `Level G: DIVERGENCE at line ${diff.line}\n  log:   ${clip(diff.a)}\n  resim: ${clip(diff.b)}\n`,
  );
  return EXIT.divergence;
}

/**
 * The header's ruleset must be in this build (§3.5): an unknown ref is a usage error (exit 3)
 * naming the refs the build contains, not a replay divergence. Anything else wrong with the first
 * line is left to the replay.
 */
function checkHeaderRuleset(header: LogLine | undefined): void {
  if (header?.k !== "header") return;
  const ref = header.setup.ruleset;
  if (findRuleset(ref) === undefined) {
    throw new UsageError(
      `the log's ruleset ${ref} is not in this build; it contains ${RULESETS.map((r) => r.ref).join(", ")}`,
    );
  }
}

/** Verifies a run (§12.1); returns the exit code. */
export async function verifyRun(req: VerifyRequest, io: CliIo): Promise<ExitCode> {
  const located = locateLog(req.target);
  const { log, dir } = located;
  let report: ReplayReport;
  let base: VerifyOptions;
  let from: Snapshot | undefined;
  try {
    checkHeaderRuleset(readFirstLine(log));
    from = req.from === undefined ? undefined : readSnapshotFile(snapshotPathFor(dir, req.from));
    base = options(req, from);
    report = verifyLog(readLogLines(log), base);
  } catch (error) {
    if (isCorruptLog(error)) {
      io.out(`Level E: ${log}: ${error.message}\n`);
      return EXIT.divergence;
    }
    throw error;
  }
  for (const w of report.warnings) io.out(`warning: ${w}\n`);
  const start =
    from === undefined ? "" : ` · from the snapshot of hour ${from.hour} (${fmtTime(from.t)})`;
  if (!report.ok || report.divergence !== undefined) {
    const d = report.divergence;
    io.out(`Level E: ${d === undefined ? "FAILED" : `DIVERGENCE: ${describeDivergence(d)}`}\n`);
    if (req.dump === true && d !== undefined) dump(io, located, base, d);
    if (req.resim === true) io.out("Level G: skipped (Level E failed)\n");
    return EXIT.divergence;
  }
  io.out(
    `Level E: ok${start} · ${report.actions} actions · ${report.checkpoints} checkpoints · final hash ${report.finalHash ?? "?"}\n`,
  );
  if (req.dump === true) io.out("--dump: no divergence, nothing to dump\n");
  if (req.resim === true) return levelG(io, log, req.invariants);
  return EXIT.ok;
}
