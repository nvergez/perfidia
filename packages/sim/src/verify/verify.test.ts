// `sim verify` (docs/architecture.md §10.4, §12.1, §15 T15): a tampered log exits 1 naming the
// divergence, `--from` a mid-run snapshot passes for both rulesets with a non-empty override and a
// foreign snapshot is a divergence, `--resim` is byte-identical for lockstep and catches a changed
// controller, a corrupt line reports its number, and `--dump` writes the divergent checkpoint and
// diffs it against the nearest snapshot.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogLine } from "@perfidia/protocol";
import { EXIT, memoryIo } from "../args.ts";
import { main } from "../cli.ts";
import { jsonlText, normalisedText, resimulate } from "../harness/index.ts";
import { readLog } from "../io/index.ts";
import { jsonDiff } from "./index.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perfidia-sim-verify-"));
}

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo();
  const code = await main(argv, io);
  return { code, out: io.stdout(), err: io.stderr() };
}

/** A 1-day run of `ruleset` with 6-hour snapshots and a non-empty override, into `out`. */
async function runInto(
  out: string,
  ruleset: string,
  override: string,
  ...extra: string[]
): Promise<LogLine[]> {
  const r = await cli(
    "run",
    "--ruleset",
    ruleset,
    "--allow-test",
    "--players",
    "6",
    "--days",
    "1",
    "--snapshot-every",
    "6",
    "--override",
    override,
    "--out",
    out,
    "--quiet",
    ...extra,
  );
  expect(r.err).toBe("");
  expect(r.code).toBe(EXIT.ok);
  return readLog(join(out, "match.jsonl"));
}

/** Writes `lines` with the line at `index` replaced. */
function tamper(path: string, lines: readonly LogLine[], index: number, line: LogLine): void {
  writeFileSync(path, jsonlText(lines.with(index, line)));
}

describe("sim verify", () => {
  test("--from a mid-run snapshot passes for both rulesets with a non-empty override; --resim is byte-identical", async () => {
    const dir = tempDir();
    try {
      for (const [ruleset, override] of [
        ["perfidia-1@1.0.0", "time.protectionEnd=21600"],
        ["sandbox-1@1.0.0", "combat.lootPm=400"],
      ] as const) {
        const out = join(dir, ruleset);
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        const lines = await runInto(out, ruleset, override);
        const header = lines[0];
        expect(header?.k === "header" ? header.setup.overrides : null).toEqual({
          [override.split("=")[0] ?? ""]: Number(override.split("=")[1]),
          "time.matchEnd": 86400,
        });
        for (const from of ["h012", "h6", join(out, "snapshots", "h0018.json")]) {
          // oxlint-disable-next-line no-await-in-loop -- sequential
          const r = await cli("verify", out, "--from", from);
          expect(r.code).toBe(EXIT.ok);
          expect(r.out).toContain("Level E: ok · from the snapshot of hour");
        }
        // oxlint-disable-next-line no-await-in-loop -- sequential
        const g = await cli("verify", out, "--resim", "--invariants", "step");
        expect(g.code).toBe(EXIT.ok);
        expect(g.out).toContain(`Level G: identical · ${lines.length} lines`);
        // oxlint-disable-next-line no-await-in-loop -- sequential
        const again = await resimulate(lines);
        expect(normalisedText(again.lines)).toBe(normalisedText(lines));
      }
      // A snapshot of another match does not match this log's checkpoint.
      const foreign = await cli(
        "verify",
        join(dir, "perfidia-1@1.0.0"),
        "--from",
        join(dir, "sandbox-1@1.0.0", "snapshots", "h0012.json"),
      );
      expect(foreign.code).toBe(EXIT.divergence);
      expect(foreign.out).toContain("snapshot divergence");
      const missing = await cli("verify", join(dir, "sandbox-1@1.0.0"), "--from", "h0005");
      expect(missing.code).toBe(EXIT.usage);
      expect(missing.err).toContain("no such snapshot file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("a tampered log exits 1 naming the divergence; --dump writes the divergent checkpoint and diffs it", async () => {
    const dir = tempDir();
    try {
      const out = join(dir, "run");
      const lines = await runInto(out, "perfidia-1@1.0.0", "time.protectionEnd=21600");
      const log = join(out, "match.jsonl");

      // An accepted action logged as rejected: a result divergence at its n.
      const ai = lines.findIndex((l) => l.k === "act" && l.r.ok);
      const act = lines[ai];
      if (act?.k !== "act") throw new Error("no accepted action");
      tamper(log, lines, ai, { ...act, r: { ok: false, code: "QUEUE_FULL" } });
      const result = await cli("verify", out, "--dump");
      expect(result.code).toBe(EXIT.divergence);
      expect(result.out).toContain(`result divergence at t = ${act.t}`);
      expect(result.out).toContain(`n ${act.n}`);
      expect(result.out).toContain('expected: {"code":"QUEUE_FULL","ok":false}');
      expect(result.out).toContain("--dump: no checkpoint differs before the replay stops");

      // A checkpoint hash changed: a checkpoint divergence at its hour; the dump equals the
      // snapshot of that hour, since only the logged hash was changed.
      const ci = lines.findIndex((l) => l.k === "ckpt" && l.hour === 12);
      const ck = lines[ci];
      if (ck?.k !== "ckpt") throw new Error("no checkpoint at hour 12");
      tamper(log, lines, ci, { ...ck, h: "0".repeat(16) });
      const hashed = await cli("verify", out, "--dump", "--resim");
      expect(hashed.code).toBe(EXIT.divergence);
      expect(hashed.out).toContain("checkpoint divergence at t = 43200 (D1 12:00), hour 12");
      expect(hashed.out).toContain("Level G: skipped (Level E failed)");
      expect(hashed.out).toContain("the recorded state of that hour");
      expect(hashed.out).toContain(", 0 path(s):");
      const dumped = join(out, "dump-h0012.json");
      expect(existsSync(dumped)).toBe(true);
      const snap: unknown = JSON.parse(readFileSync(join(out, "snapshots", "h0012.json"), "utf8"));
      const state: unknown = JSON.parse(readFileSync(dumped, "utf8"));
      expect(
        typeof snap === "object" && snap !== null && "state" in snap ? snap.state : null,
      ).toEqual(state);

      // A changed action whose effect shows at the next checkpoint: the dump differs from the
      // nearest snapshot at the paths it changed.
      const ri = lines.findIndex(
        (l) => l.k === "act" && l.a.type === "recruit" && l.a.count > 1 && l.t > 6 * 3600,
      );
      const rec = lines[ri];
      if (rec?.k !== "act" || rec.a.type !== "recruit")
        throw new Error("no recruit to tamper with");
      tamper(log, lines, ri, { ...rec, a: { ...rec.a, count: rec.a.count - 1 } });
      const changed = await cli("verify", out, "--dump");
      expect(changed.code).toBe(EXIT.divergence);
      expect(changed.out).toMatch(/--dump: the replay's state at hour \d+ /);
      expect(changed.out).toMatch(/--dump: structural diff, snapshot .*h00\d\d\.json/);
      expect(changed.out).toMatch(/\n {2}cities\.c\d+\./);

      // A clean log has nothing to dump.
      writeFileSync(log, jsonlText(lines));
      const clean = await cli("verify", out, "--dump");
      expect(clean.code).toBe(EXIT.ok);
      expect(clean.out).toContain("--dump: no divergence, nothing to dump");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("--resim catches a log whose controllers would play differently; a corrupt line reports its number", async () => {
    const dir = tempDir();
    try {
      const out = join(dir, "run");
      const lines = await runInto(out, "sandbox-1", "combat.lootPm=400");
      const log = join(out, "match.jsonl");
      const header = lines[0];
      if (header?.k !== "header") throw new Error("no header");
      const swapped = { ...header.controllers, p1: header.controllers["p2"] ?? "" };
      tamper(log, lines, 0, { ...header, controllers: swapped });
      expect((await cli("verify", out)).code).toBe(EXIT.ok);
      const g = await cli("verify", out, "--resim");
      expect(g.code).toBe(EXIT.divergence);
      expect(g.out).toMatch(/Level G: DIVERGENCE at line \d+\n {2}log: {3}\{.*\n {2}resim: \{/);

      const llm = { ...header.controllers, p1: "llm:somebody" };
      tamper(log, lines, 0, { ...header, controllers: llm });
      const unknown = await cli("verify", out, "--resim");
      expect(unknown.code).toBe(EXIT.usage);
      expect(unknown.err).toContain("controller llm:somebody is not a bot of this build");

      const rows = jsonlText(lines).split("\n");
      writeFileSync(log, rows.with(41, (rows[41] ?? "").slice(0, 20)).join("\n"));
      const corrupt = await cli("verify", out);
      expect(corrupt.code).toBe(EXIT.divergence);
      expect(corrupt.out).toContain("match.jsonl: line 42: not JSON");
      const summary = await cli("summary", out);
      expect(summary.code).toBe(EXIT.divergence);
      expect(summary.err).toContain("line 42: not JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("usage errors", async () => {
    expect((await cli("verify")).code).toBe(EXIT.usage);
    const missing = await cli("verify", join(tmpdir(), "perfidia-no-such-run"));
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.err).toContain("no such run directory or log file");
    expect((await cli("verify", "x", "--invariants", "always")).err).toContain(
      "--invariants must be one of",
    );
  });
});

describe("the structural diff", () => {
  test("lists the differing paths in a deterministic order, up to the limit", () => {
    const a = { b: 1, a: { x: [1, 2, 3], y: "s" }, c: null, "odd key": 1 };
    const b = { a: { x: [1, 5], y: "s", z: true }, b: 1, c: { d: 1 }, "odd key": 2 };
    expect(jsonDiff(a, b)).toEqual({
      entries: [
        { path: "a.x[1]", expected: "2", actual: "5" },
        { path: "a.x[2]", expected: "3", actual: "(missing)" },
        { path: "a.z", expected: "(missing)", actual: "true" },
        { path: "c", expected: "null", actual: '{"d":1}' },
        { path: '["odd key"]', expected: "1", actual: "2" },
      ],
      truncated: false,
    });
    expect(jsonDiff(a, a)).toEqual({ entries: [], truncated: false });
    expect(jsonDiff(1, 2).entries).toEqual([{ path: "(root)", expected: "1", actual: "2" }]);
    const many = jsonDiff(
      Array.from({ length: 30 }, (_, i) => i),
      Array.from({ length: 30 }, (_, i) => -i - 1),
      20,
    );
    expect([many.entries.length, many.truncated, many.entries[19]?.path]).toEqual([
      20,
      true,
      "[19]",
    ]);
    const long = jsonDiff({ s: "x".repeat(500) }, { s: "y" }).entries[0];
    expect(long?.expected.length).toBe(120);
    expect(long?.expected.endsWith("…")).toBe(true);
  });
});
