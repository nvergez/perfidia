// Run directories and log files (docs/architecture.md §10.1): the streaming reader across chunk
// boundaries, the line numbers of bad lines (bad JSON, schema failures, empty rows, invalid UTF-8
// anywhere in the file and a cut multi-byte character, plain or gzip), corrupt gzip files, no file
// left open by an abandoned iteration, the run directory's file sink and its snapshot names,
// `--from` names, and run directories that are never written over.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyLog } from "@perfidia/engine";
import type { LogLine } from "@perfidia/protocol";
import {
  JsonlError,
  jsonlText,
  prepareBotRun,
  runBots,
  runPrepared,
  writeJsonl,
} from "../harness/index.ts";
import {
  FINAL_SNAPSHOT,
  LogFileError,
  RunDirSink,
  freeRunDir,
  isCorruptLog,
  listSnapshots,
  locateLog,
  readFirstLine,
  readLog,
  readLogLines,
  readSnapshotFile,
  runDirContents,
  snapshotPathFor,
} from "./index.ts";

const CHUNK = 65536;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perfidia-sim-io-"));
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

/** The `JsonlError` that reading `path` whole throws. */
function lineErrorOf(path: string): JsonlError {
  const error = errorOf(() => readLog(path));
  if (!(error instanceof JsonlError))
    throw new Error(`expected a JsonlError, got ${String(error)}`);
  return error;
}

/** The byte offset at which each row of `text` starts. */
function rowOffsets(text: string): number[] {
  const out: number[] = [];
  let at = 0;
  for (const row of text.split("\n")) {
    out.push(at);
    at += Buffer.byteLength(row) + 1;
  }
  return out;
}

/** Open file descriptors of this process (macOS and Linux). */
const openFds = (): number => readdirSync("/dev/fd").length;

describe("the streaming reader", () => {
  let lines: LogLine[] = [];
  let text = "";

  beforeAll(async () => {
    lines = (
      await runBots({
        ruleset: "sandbox-1",
        seed: 3,
        players: 6,
        days: 1,
        clock: { kind: "lockstep" },
      })
    ).lines;
    text = jsonlText(lines);
  });

  test("reads a log larger than its chunk exactly, plain or gzip, with or without a final newline", () => {
    expect(verifyLog(lines).ok).toBe(true);
    expect(text.length).toBeGreaterThan(2 * CHUNK);
    const dir = tempDir();
    try {
      const plain = join(dir, "match.jsonl");
      writeFileSync(plain, text);
      expect(readLog(plain)).toEqual(lines);
      writeFileSync(plain, text.slice(0, -1));
      expect(readLog(plain)).toEqual(lines);
      const gz = join(dir, "match.jsonl.gz");
      writeJsonl(gz, lines);
      expect(readLog(gz)).toEqual(lines);
      expect(readFirstLine(plain)).toEqual(lines[0]);
      expect(locateLog(dir)).toEqual({ log: plain, dir, isRunDir: true });
      expect(locateLog(gz)).toEqual({ log: gz, dir, isRunDir: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt line, an invalid line or an empty row reports its 1-based line number", () => {
    const rows = text.split("\n");
    const dir = tempDir();
    const path = join(dir, "match.jsonl");
    const lineError = (r: string[]): JsonlError => {
      writeFileSync(path, r.join("\n"));
      return lineErrorOf(path);
    };
    try {
      const at = Math.floor(rows.length / 2);
      expect(lineError(rows.with(at - 1, (rows[at - 1] ?? "").slice(0, -3))).line).toBe(at);
      const invalid = lineError(rows.with(7, '{"k":"defer","t":-1,"seat":"p1","to":0}'));
      expect(invalid.line).toBe(8);
      expect(invalid.message).toBe("line 8: t: Too small: expected number to be >=0");
      expect(lineError(rows.with(2, "")).line).toBe(3);
      // A reader stopped early never reaches the bad line.
      expect(readFirstLine(path)).toEqual(lines[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid UTF-8 past the first chunk and a cut multi-byte character name their own line, plain or gzip", () => {
    const bytes = Buffer.from(text);
    const offsets = rowOffsets(text);
    // The row that holds byte 2.5 chunks in: the bad byte is far from the first line of its chunk.
    const index = offsets.findIndex((o, i) => (offsets[i + 1] ?? Infinity) > 2.5 * CHUNK && o > 0);
    const start = offsets[index] ?? 0;
    expect(start).toBeGreaterThan(2 * CHUNK);
    const badByte = Buffer.concat([
      bytes.subarray(0, start + 10),
      Buffer.from([0xff]),
      bytes.subarray(start + 10),
    ]);
    // A log cut inside "✓" (e2 9c 93) after its last full line.
    const cut = Buffer.concat([
      bytes,
      Buffer.from('{"k":"note","n":1,"t":0,"seat":"p1","turn":1,"mode":"append","text":"ok '),
      Buffer.from([0xe2, 0x9c]),
    ]);
    const dir = tempDir();
    try {
      for (const [name, data, line] of [
        ["bad-byte", badByte, index + 1],
        ["cut", cut, lines.length + 1],
      ] as const) {
        const plain = join(dir, `${name}.jsonl`);
        writeFileSync(plain, data);
        const gz = join(dir, `${name}.jsonl.gz`);
        writeFileSync(gz, Bun.gzipSync(data));
        for (const path of [plain, gz]) {
          const error = lineErrorOf(path);
          expect({ path, line: error.line }).toEqual({ path, line });
          expect(error.message).toStartWith(`line ${line}: not UTF-8 (`);
          expect(isCorruptLog(error)).toBe(true);
        }
      }
      // Every line before the bad one is read.
      const read: LogLine[] = [];
      const plain = join(dir, "bad-byte.jsonl");
      expect(
        errorOf(() => {
          for (const l of readLogLines(plain)) read.push(l);
        }),
      ).toBeInstanceOf(JsonlError);
      expect(read).toEqual(lines.slice(0, index));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a gzip file that does not decompress is a LogFileError", () => {
    const dir = tempDir();
    try {
      const gz = join(dir, "match.jsonl.gz");
      writeFileSync(gz, "not gzip at all");
      const garbage = errorOf(() => readLog(gz));
      expect(garbage).toBeInstanceOf(LogFileError);
      expect(String(garbage)).toContain("not a valid gzip file");
      const whole = Bun.gzipSync(new TextEncoder().encode(text));
      writeFileSync(gz, whole.subarray(0, whole.length - 64));
      expect(isCorruptLog(errorOf(() => readLog(gz)))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!existsSync("/dev/fd"))("an iteration abandoned midway leaves no file open", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "match.jsonl");
      writeFileSync(path, text);
      const before = openFds();
      const its = Array.from({ length: 20 }, () => {
        const it = readLogLines(path);
        it.next();
        return it;
      });
      expect(openFds()).toBeLessThanOrEqual(before + 1);
      expect(its).toHaveLength(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run directories", () => {
  test("the file sink names checkpoint snapshots by hour and the one after the end line final.json", async () => {
    const dir = tempDir();
    try {
      const sink = new RunDirSink(join(dir, "run"));
      await runPrepared(
        prepareBotRun({
          ruleset: "sandbox-1",
          seed: 2,
          players: 3,
          overrides: { "time.matchEnd": 6 * 3600 },
          clock: { kind: "lockstep" },
          snapshotEvery: 2,
        }),
        sink,
      );
      const snaps = listSnapshots(join(dir, "run"));
      expect(snaps.map((s) => s.hour)).toEqual([2, 4, null]);
      expect(snaps.at(-1)?.path.endsWith(FINAL_SNAPSHOT)).toBe(true);
      const lines = readLog(sink.paths.log);
      expect(verifyLog(lines).ok).toBe(true);
      for (const s of snaps.slice(0, 2)) {
        const snap = readSnapshotFile(s.path);
        const ck = lines.find((l) => l.k === "ckpt" && l.hour === s.hour);
        expect(ck?.k === "ckpt" ? ck.h : null).toBe(snap.hash);
      }
      const final = readSnapshotFile(snaps.at(-1)?.path ?? "");
      const end = lines.at(-1);
      expect(end?.k === "end" ? end.h : null).toBe(final.hash);
      expect(readFileSync(sink.paths.log, "utf8")).toBe(jsonlText(lines));
      // The directory now holds a run: a second sink there is refused and truncates nothing.
      const log = readFileSync(sink.paths.log, "utf8");
      expect(() => new RunDirSink(join(dir, "run"))).toThrow("runs are never overwritten");
      expect(readFileSync(sink.paths.log, "utf8")).toBe(log);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--from names, missing logs and snapshots", () => {
    const dir = tempDir();
    try {
      for (const from of ["h72", "h072", "h0072", "72"]) {
        expect(snapshotPathFor(dir, from)).toBe(join(dir, "snapshots", "h0072.json"));
      }
      expect(snapshotPathFor(dir, "/x/y.json")).toBe("/x/y.json");
      expect(() => snapshotPathFor(dir, "final")).toThrow("checkpoint snapshot");
      expect(() => locateLog(join(dir, "nope"))).toThrow("no such run directory");
      expect(() => locateLog(dir)).toThrow("not a run directory");
      expect(() => readSnapshotFile(join(dir, "x.json"))).toThrow("no such snapshot file");
      writeFileSync(join(dir, "x.json"), '{"format":"perfidia-snapshot/1"}');
      expect(() => readSnapshotFile(join(dir, "x.json"))).toThrow("not a valid snapshot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory holding any part of a run is taken: fresh run directories skip it and sinks refuse it", () => {
    const dir = tempDir();
    try {
      const base = join(dir, "r");
      expect([runDirContents(base), freeRunDir(base)]).toEqual([null, base]);
      mkdirSync(join(base, "snapshots"), { recursive: true });
      writeFileSync(join(base, "notes.txt"), "mine");
      // An empty snapshots/ or unrelated files do not make a run.
      expect([runDirContents(base), freeRunDir(base)]).toEqual([null, base]);
      const parts: [string, string][] = [
        ["match.jsonl", "match.jsonl"],
        ["match.jsonl.gz", "match.jsonl.gz"],
        ["summary.json", "summary.json"],
        ["trace.jsonl", "trace.jsonl"],
        ["snapshots/h0024.json", "snapshots/"],
      ];
      for (const [i, [file, found]] of parts.entries()) {
        const d = join(dir, `p${i}`);
        mkdirSync(join(d, "snapshots"), { recursive: true });
        writeFileSync(join(d, file), "{}");
        expect(runDirContents(d)).toBe(found);
        expect(freeRunDir(d)).toBe(`${d}-2`);
        expect(() => new RunDirSink(d)).toThrow(`${d} already holds a run (${found})`);
        expect(readFileSync(join(d, file), "utf8")).toBe("{}");
      }
      const taken = join(dir, "p0");
      mkdirSync(`${taken}-2`);
      writeFileSync(join(`${taken}-2`, "summary.json"), "{}");
      expect(freeRunDir(taken)).toBe(`${taken}-3`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
