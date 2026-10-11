// Run directories and log files (docs/architecture.md §10.1): the streaming reader across chunk
// boundaries and line numbers of bad lines, the run directory's file sink and its snapshot names,
// `--from` names and fresh run directories.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  RunDirSink,
  freeRunDir,
  listSnapshots,
  locateLog,
  readFirstLine,
  readLog,
  readLogLines,
  readSnapshotFile,
  snapshotPathFor,
} from "./index.ts";

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

describe("the streaming reader", () => {
  test("reads a log larger than its chunk exactly, plain or gzip, with or without a final newline", async () => {
    const { lines } = await runBots({
      ruleset: "sandbox-1",
      seed: 3,
      players: 6,
      days: 1,
      clock: { kind: "lockstep" },
    });
    const text = jsonlText(lines);
    expect(text.length).toBeGreaterThan(2 * 65536);
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
      expect(locateLog(dir).log).toBe(plain);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("a corrupt line, an invalid line or an empty row reports its 1-based line number", async () => {
    const { lines } = await runBots({
      ruleset: "sandbox-1",
      seed: 3,
      players: 3,
      overrides: { "time.matchEnd": 21600 },
      clock: { kind: "lockstep" },
    });
    const rows = jsonlText(lines).split("\n");
    const dir = tempDir();
    const path = join(dir, "match.jsonl");
    const lineError = (r: string[]): JsonlError => {
      writeFileSync(path, r.join("\n"));
      const error = errorOf(() => [...readLogLines(path)]);
      if (!(error instanceof JsonlError))
        throw new Error(`expected a JsonlError, got ${String(error)}`);
      return error;
    };
    try {
      const at = Math.floor(rows.length / 2);
      expect(lineError(rows.with(at - 1, (rows[at - 1] ?? "").slice(0, -3))).line).toBe(at);
      const invalid = lineError(rows.with(7, '{"k":"defer","t":-1,"seat":"p1","to":0}'));
      expect(invalid.line).toBe(8);
      expect(invalid.message).toBe("line 8: t: Too small: expected number to be >=0");
      expect(lineError(rows.with(2, "")).line).toBe(3);
      // A reader stopped early closes the file and never reaches the bad line.
      expect(readFirstLine(path)).toEqual(lines[0]);
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
      for (const s of snaps.slice(0, 2)) {
        const snap = readSnapshotFile(s.path);
        const ck = lines.find((l) => l.k === "ckpt" && l.hour === s.hour);
        expect(ck?.k === "ckpt" ? ck.h : null).toBe(snap.hash);
      }
      const final = readSnapshotFile(snaps.at(-1)?.path ?? "");
      const end = lines.at(-1);
      expect(end?.k === "end" ? end.h : null).toBe(final.hash);
      expect(readFileSync(sink.paths.log, "utf8")).toBe(jsonlText(lines));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--from names, missing logs and snapshots, and fresh run directories", () => {
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

      const base = join(dir, "r");
      expect(freeRunDir(base)).toBe(base);
      mkdirSync(base);
      expect(freeRunDir(base)).toBe(base);
      writeFileSync(join(base, "match.jsonl"), "");
      expect(freeRunDir(base)).toBe(`${base}-2`);
      mkdirSync(`${base}-2`);
      writeFileSync(join(`${base}-2`, "match.jsonl"), "");
      expect(freeRunDir(base)).toBe(`${base}-3`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
