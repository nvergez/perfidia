// `sim run` (docs/architecture.md §12.1, §15 T15): a run that `verify` and `summary` accept and that
// repeats identically, a random id key in the header that `verify --resim` reproduces, the config
// and usage errors (exit 3) that leave nothing behind, run directories never written over (even
// partial ones), `--trace-hashes` equal to the engine's own trace and kept for a fatal run, a
// system-clock run at very high speed, and the plan's defaults. The CLI runs in-process.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMatch, getRuleset, verifyLog } from "@perfidia/engine";
import { idKeyFromSeed } from "@perfidia/engine/core";
import type { LogLine } from "@perfidia/protocol";
import { EXIT, memoryIo } from "../args.ts";
import { main } from "../cli.ts";
import { jsonlText, normalisedText, runBots } from "../harness/index.ts";
import { readLog, readLogLines } from "../io/index.ts";
import { DEFAULT_VIRTUAL_LATENCY_MS, defaultRunDir, planRun, writeTrace } from "./index.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perfidia-sim-run-"));
}

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo();
  const code = await main(argv, io);
  return { code, out: io.stdout(), err: io.stderr() };
}

describe("sim run --live-flush", () => {
  test("writes the same log as without the flag (wall keys aside)", async () => {
    const dir = tempDir();
    try {
      const args = ["run", "--ruleset", "sandbox-1", "--allow-test", "--players", "3"];
      const short = ["--override", "time.matchEnd=21600", "--seed", "5"];
      const live = await cli(...args, ...short, "--live-flush", "--out", join(dir, "live"));
      const plain = await cli(...args, ...short, "--out", join(dir, "plain"));
      expect([live.code, plain.code]).toEqual([EXIT.ok, EXIT.ok]);
      const a = readLog(join(dir, "live", "match.jsonl"));
      const b = readLog(join(dir, "plain", "match.jsonl"));
      expect(a.at(-1)?.k).toBe("end");
      expect(normalisedText(a)).toBe(normalisedText(b));
      expect(existsSync(join(dir, "live", "snapshots", "final.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sim run", () => {
  test("writes a run that verify and summary accept, and running it twice gives the same log", async () => {
    const dir = tempDir();
    try {
      const a = join(dir, "a");
      const b = join(dir, "b");
      const args = [
        "run",
        "--ruleset",
        "perfidia-1@1.0.0",
        "--seed",
        "1",
        "--players",
        "6",
        "--days",
        "1",
      ];
      const first = await cli(...args, "--out", a);
      expect(first.err).toBe("");
      expect(first.code).toBe(EXIT.ok);
      expect(first.out).toContain(`run directory: ${a}`);
      expect(first.out).toContain("perfidia-1@1.0.0 · seed 1 · 6 seats · lockstep");
      expect(first.out).toContain("INTERNAL failures: 0");
      expect((await cli(...args, "--out", b, "--quiet")).out).toBe("");

      const verified = await cli("verify", a);
      expect(verified.code).toBe(EXIT.ok);
      expect(verified.out).toMatch(
        /^Level E: ok · \d+ actions · \d+ checkpoints · final hash [0-9a-f]{16}\n$/,
      );
      expect(verifyLog(readLogLines(join(b, "match.jsonl"))).ok).toBe(true);
      const summary = await cli("summary", join(a, "match.jsonl"), "--json");
      expect(summary.code).toBe(EXIT.ok);
      const parsed: unknown = JSON.parse(summary.out);
      expect(parsed).toMatchObject({ ruleset: "perfidia-1@1.0.0", status: "ended", players: 6 });
      const recorded: unknown = JSON.parse(readFileSync(join(a, "summary.json"), "utf8"));
      expect(recorded).toEqual(parsed);
      const wallMs =
        typeof recorded === "object" && recorded !== null && "wallMs" in recorded
          ? recorded.wallMs
          : null;
      expect(typeof wallMs).toBe("number");

      const la = readLog(join(a, "match.jsonl"));
      const lb = readLog(join(b, "match.jsonl"));
      expect(normalisedText(la)).toBe(normalisedText(lb));
      // The logs carry informational wall keys, the only bytes in which two runs differ.
      const header = la[0];
      expect(header?.k === "header" ? typeof header.wallStart : null).toBe("string");
      expect(existsSync(join(a, "snapshots", "final.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("--id-key random writes the key into the header, and verify --resim reproduces the run", async () => {
    const dir = tempDir();
    try {
      const keys: string[] = [];
      for (const name of ["a", "b"]) {
        const out = join(dir, name);
        // oxlint-disable-next-line no-await-in-loop -- sequential runs
        const r = await cli(
          "run",
          "--ruleset",
          "sandbox-1",
          "--allow-test",
          "--players",
          "3",
          "--override",
          "time.matchEnd=43200",
          "--id-key",
          "random",
          "--clock",
          "realtime",
          "--out",
          out,
          "--quiet",
        );
        expect(r.code).toBe(EXIT.ok);
        const header = readLog(join(out, "match.jsonl"))[0];
        if (header?.k !== "header") throw new Error("no header");
        expect(header.setup.idKey).toMatch(/^[0-9a-f]{32}$/);
        expect(header.setup.idKey).not.toBe(idKeyFromSeed(1));
        expect(header.clock).toEqual({
          kind: "realtime",
          speed: [3, 1],
          time: "virtual",
          latencyMs: [...DEFAULT_VIRTUAL_LATENCY_MS],
        });
        keys.push(header.setup.idKey);
      }
      expect(keys[0]).not.toBe(keys[1]);
      const resim = await cli("verify", join(dir, "a"), "--resim");
      expect(resim.code).toBe(EXIT.ok);
      expect(resim.out).toContain("Level G: identical");
      expect((await cli("verify", join(dir, "b"))).code).toBe(EXIT.ok);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("config and usage errors exit 3 with what to change, and write nothing", async () => {
    const dir = tempDir();
    try {
      const out = join(dir, "never");
      const cases: [string[], string][] = [
        [
          ["--override", "time.nope=3"],
          'unknown config path "time.nope": "time" has no key "nope" (valid keys: ',
        ],
        [["--override", "time.matchEnd=1.5"], "time.matchEnd: "],
        // The default ruleset is the latest published perfidia-1, 1.1.0; 1.0.0 by its exact ref.
        [["--override", "time.day=3600"], "time.day: this field is fixed by perfidia-1@1.1.0"],
        [
          ["--ruleset", "perfidia-1@1.0.0", "--override", "time.day=3600"],
          "time.day: this field is fixed by perfidia-1@1.0.0",
        ],
        [
          ["--override", "victory.dominationMinPerPlayer=0"],
          "victory.dominationMinPerPlayer is the floor of the threshold in cities per player",
        ],
        [["--override", "time.minTravel=60"], "gateway.urgentMinGap"],
        [["--override", "nonsense"], 'override "nonsense" has no "="'],
        [["--players", "3"], "outside the player range of perfidia-1@1.1.0: 6..12"],
        [["--players", "13"], "6..12"],
        [
          ["--ruleset", "nope-1"],
          'unknown ruleset "nope-1"; this build contains perfidia-1@1.0.0, perfidia-1@1.1.0, sandbox-1@1.0.0',
        ],
        [["--ruleset", "sandbox-1"], "sandbox-1@1.0.0 is a test ruleset"],
        [["--ruleset", "sandbox-1", "--allow-test", "--players", "13"], "sandbox-1@1.0.0: 2..12"],
        [["--days", "1", "--override", "time.matchEnd=3600"], "keep one"],
        [["--bots", "expander,ninja"], 'unknown bot "ninja"'],
        [["--seat", "p7=rusher"], "seats p1..p6"],
        [["--seat", "p2=ninja"], 'unknown bot "ninja"'],
        [["--bots", "rusher@9"], 'unknown bot "rusher@9": rusher has rusher@1, rusher@2, rusher@3'],
        [["--seat", "p2=turtle@0"], '--seat p2=turtle@0: unknown bot "turtle@0"'],
        [["--id-key", "ABC"], "--id-key must be 32 lowercase hex characters"],
        [["--clock", "lockstep", "--speed", "3"], "--speed applies to --clock realtime only"],
        [["--clock", "realtime", "--time", "atomic"], "--time must be virtual or system"],
        [["--invariants", "sometimes"], "--invariants must be one of off, checkpoint, step"],
        [["--seed", "-1"], ""],
        [["--frobnicate"], "Unknown option '--frobnicate'"],
      ];
      for (const [args, message] of cases) {
        // oxlint-disable-next-line no-await-in-loop -- sequential, each is fast
        const r = await cli("run", ...args, "--out", out);
        expect({ args, code: r.code }).toEqual({ args, code: EXIT.usage });
        expect(r.err).toContain(message);
        expect(r.out).toBe("");
      }
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an existing run is never overwritten; --trace-hashes traces every action as the engine's own trace", async () => {
    const dir = tempDir();
    try {
      const out = join(dir, "t");
      const args = ["run", "--ruleset", "sandbox-1", "--allow-test", "--players", "3"];
      const traced = await cli(
        ...args,
        "--override",
        "time.matchEnd=21600",
        "--trace-hashes",
        "--out",
        out,
      );
      expect(traced.code).toBe(EXIT.ok);
      const lines = readLog(join(out, "match.jsonl"));
      const acts = lines.flatMap((l) => (l.k === "act" ? [l] : []));
      const trace = readFileSync(join(out, "trace.jsonl"), "utf8")
        .trimEnd()
        .split("\n")
        .map((l): unknown => JSON.parse(l));
      expect(trace.length).toBe(acts.length);
      expect(trace.length).toBeGreaterThan(0);
      expect(traced.out).toContain(`trace: ${acts.length} actions`);

      // The engine's own trace (`MatchOptions.traceHashes`, `ApplyOutput.h`), replaying the acts:
      // the replay trace equals it entry by entry.
      const header = lines[0];
      if (header?.k !== "header") throw new Error("no header");
      const m = createMatch(header.setup, getRuleset(header.setup.ruleset), { traceHashes: true });
      const engine = acts.map((act) => {
        m.advanceTo(act.t);
        const o = m.apply(act.seat, act.a);
        expect(o.ok).toBe(act.r.ok);
        return { n: act.n, t: act.t, seat: act.seat, ok: o.ok, h: o.ok ? o.h : m.hash() };
      });
      expect(engine.some((e) => e.ok)).toBe(true);
      expect(trace).toEqual(engine);

      const before = readFileSync(join(out, "match.jsonl"), "utf8");
      const again = await cli(...args, "--out", out);
      expect(again.code).toBe(EXIT.usage);
      expect(again.err).toContain("runs are never overwritten");
      expect(readFileSync(join(out, "match.jsonl"), "utf8")).toBe(before);
      // A directory holding only part of a run (snapshots, a summary) is refused too.
      for (const part of ["snapshots/h0024.json", "summary.json"]) {
        const partial = join(dir, `partial-${part.length}`);
        mkdirSync(join(partial, "snapshots"), { recursive: true });
        writeFileSync(join(partial, part), "{}");
        // oxlint-disable-next-line no-await-in-loop -- sequential, each is fast
        const r = await cli(...args, "--out", partial);
        expect(r.code).toBe(EXIT.usage);
        expect(r.err).toContain(`${partial} already holds a run`);
        expect(existsSync(join(partial, "match.jsonl"))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the trace of a run that stopped on a fatal line covers every action before it", async () => {
    const dir = tempDir();
    try {
      const { lines } = await runBots({
        ruleset: "sandbox-1",
        seed: 5,
        players: 3,
        overrides: { "time.matchEnd": 21600 },
        clock: { kind: "lockstep" },
      });
      expect(verifyLog(lines).ok).toBe(true);
      // The log of a run that died right after its 10th action, ending with the host's fatal line.
      const actIndexes = lines.flatMap((l, i) => (l.k === "act" ? [i] : []));
      const cut = actIndexes[9] ?? -1;
      const tenth = lines[cut];
      if (tenth?.k !== "act") throw new Error("fewer than 10 actions");
      const fatal: LogLine = {
        k: "fatal",
        t: tenth.t,
        error: { kind: "engine", message: "boom" },
      };
      const log = join(dir, "match.jsonl");
      writeFileSync(log, jsonlText([...lines.slice(0, cut + 1), fatal]));
      const out = writeTrace(log, join(dir, "trace.jsonl"));
      expect(out).toEqual({ traced: 10, problem: null });
      expect(readFileSync(join(dir, "trace.jsonl"), "utf8").trimEnd().split("\n")).toHaveLength(10);

      // A replay that diverges before the fatal line is reported, and traces what it reached.
      const first = lines.findIndex((l) => l.k === "act" && l.r.ok);
      const act = lines[first];
      if (act?.k !== "act") throw new Error("no accepted action");
      const tampered = lines
        .slice(0, cut + 1)
        .with(first, { ...act, r: { ok: false, code: "QUEUE_FULL" } });
      writeFileSync(log, jsonlText([...tampered, fatal]));
      const bad = writeTrace(log, join(dir, "trace.jsonl"));
      expect(bad.traced).toBeLessThan(10);
      expect(bad.problem).toContain(`the trace replay diverged after ${bad.traced} action(s)`);
      expect(bad.problem).toContain('"kind":"result"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a 1-day system-clock run at very high speed passes verify", async () => {
    const dir = tempDir();
    try {
      const out = join(dir, "sys");
      const r = await cli(
        "run",
        "--players",
        "6",
        "--days",
        "1",
        "--clock",
        "realtime",
        "--time",
        "system",
        "--speed",
        "864000",
        "--out",
        out,
        "--json",
      );
      expect(r.code).toBe(EXIT.ok);
      expect(JSON.parse(r.out)).toMatchObject({
        status: "ended",
        clock: { kind: "realtime", speed: [864000, 1], time: "system" },
      });
      expect(
        [...readLogLines(join(out, "match.jsonl"))].some(
          (l) => l.k === "turn" && l.wallMs !== undefined,
        ),
      ).toBe(true);
      const v = await cli("verify", out);
      expect(v.code).toBe(EXIT.ok);
      expect(v.out).toContain("Level E: ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("the plan of a run", () => {
  test("defaults: the latest published perfidia-1, its minimum seats, seed 1, the seed's id key, lockstep", () => {
    const plan = planRun({});
    expect(plan.ruleset.ref).toBe("perfidia-1@1.1.0");
    expect(plan.setup.seats.map((s) => s.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    expect([plan.setup.seed, plan.setup.idKey]).toEqual([1, idKeyFromSeed(1)]);
    expect(plan.setup.overrides).toEqual({});
    expect([plan.clock, plan.invariants, plan.snapshotEvery, plan.traceHashes]).toEqual([
      { kind: "lockstep" },
      "checkpoint",
      24,
      false,
    ]);
    expect(defaultRunDir(plan)).toBe(join("runs", "perfidia-1@1.1.0-s1-6p-default-lockstep"));
    expect(planRun({ ruleset: "perfidia-1@1.0.0" }).ruleset.ref).toBe("perfidia-1@1.0.0");
    const rt = planRun({ clock: "realtime", days: 2, seed: 5, players: 7 });
    expect(rt.clock).toEqual({
      kind: "virtual",
      speed: { num: 3, den: 1 },
      latencyMs: DEFAULT_VIRTUAL_LATENCY_MS,
    });
    expect(defaultRunDir(rt)).toBe(join("runs", "perfidia-1@1.1.0-s5-7p-2d-rt-virtual"));
    expect(planRun({ clock: "realtime", time: "system", speed: { num: 5, den: 2 } }).clock).toEqual(
      {
        kind: "system",
        speed: { num: 5, den: 2 },
      },
    );
    expect(planRun({ idKey: "random" }, { randomKey: () => "f".repeat(32) }).setup.idKey).toBe(
      "f".repeat(32),
    );
    const bots = planRun({ bots: ["turtle,rusher"], seats: ["p2=expander"] });
    expect([bots.bots, bots.seatBots]).toEqual([["turtle", "rusher"], { p2: "expander" }]);
    // A version picks a frozen bot (the phase-1 composition can be rerun beside the latest ones).
    const old = planRun({ bots: ["expander,rusher@1"], seats: ["p3=rusher@2"] });
    expect([old.bots, old.seatBots]).toEqual([["expander", "rusher@1"], { p3: "rusher@2" }]);
  });
});
