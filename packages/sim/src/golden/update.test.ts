// `sim golden` (docs/architecture.md §3.5, §12.1, §13.5, §13.6, §15 T15): `--update` adds a missing
// golden and the fingerprint entries and refuses to overwrite an existing golden; `--check` passes
// on what it wrote and fails on a tampered copy; a new bot version gets a new golden; the scripted
// scenarios (`scenario-late`, `scenario-r1`) are written once and checked at Level E only. Every match here lasts at most 1
// game day (§13): the CLI writes only the 1-day goldens of `GOLDEN_SPECS` and the scenario, named
// on its command line. The committed fixtures are guarded by `src/golden.test.ts`.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuleset } from "@perfidia/engine";
import { EXIT, memoryIo } from "../args.ts";
import { main } from "../cli.ts";
import { FINGERPRINTS_FILE, jsonlText, listGoldens, readFingerprints } from "../harness/index.ts";
import { readLog } from "../io/index.ts";
import { GOLDEN_SPECS, checkFixtures, updateGoldens, type GoldenSpec } from "./index.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perfidia-sim-golden-"));
}

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo();
  const code = await main(argv, io);
  return { code, out: io.stdout(), err: io.stderr() };
}

/** Every file under `dir` with its bytes, for before/after comparisons. */
function snapshotFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path] = readFileSync(path, "latin1");
  }
  return out;
}

describe("sim golden", () => {
  test("the specs are the goldens of §13.5", () => {
    expect(
      GOLDEN_SPECS.map((s) => [
        `${s.ref}/${s.name}`,
        "run" in s ? s.run.days : "scenario",
        "run" in s ? s.run.clock.kind : "lockstep",
      ]),
    ).toEqual([
      ["perfidia-1@1.0.0/lockstep-6p-4d", 4, "lockstep"],
      ["perfidia-1@1.0.0/rt-virtual-6p-1d", 1, "virtual"],
      ["perfidia-1@1.0.0/lockstep-12p-1d", 1, "lockstep"],
      ["perfidia-1@1.0.0/lockstep-6p-6d-war", 6, "lockstep"],
      ["perfidia-1@1.0.0/scenario-late", "scenario", "lockstep"],
      ["perfidia-1@1.1.0/lockstep-6p-4d", 4, "lockstep"],
      ["perfidia-1@1.1.0/rt-virtual-6p-1d", 1, "virtual"],
      ["perfidia-1@1.1.0/lockstep-12p-1d", 1, "lockstep"],
      ["perfidia-1@1.1.0/lockstep-6p-6d-war", 6, "lockstep"],
      ["perfidia-1@1.1.0/scenario-r1", "scenario", "lockstep"],
      ["sandbox-1@1.0.0/lockstep-6p-3d", 3, "lockstep"],
      ["sandbox-1@1.0.0/rt-virtual-6p-1d", 1, "virtual"],
    ]);
  });

  test("--update adds goldens once and refuses to overwrite them; --check passes, then fails on a tampered golden", async () => {
    const dir = tempDir();
    // The 1-day goldens of each published ref: `--check` wants one golden per published ref.
    const names = [
      "perfidia-1@1.0.0/rt-virtual-6p-1d",
      "perfidia-1@1.1.0/rt-virtual-6p-1d",
      "sandbox-1@1.0.0/rt-virtual-6p-1d",
    ];
    const name = names[2] ?? "";
    const specs = GOLDEN_SPECS.filter((s) => names.includes(`${s.ref}/${s.name}`));
    expect(specs.map((s) => ("run" in s ? s.run.days : null))).toEqual([1, 1, 1]);
    try {
      const first = await cli("golden", "--update", "--fixtures", dir, ...names);
      expect(first.code).toBe(EXIT.ok);
      expect(first.out).toBe(
        [
          ...names.map((n) => `added golden ${n}`),
          "added fingerprint entry perfidia-1@1.0.0",
          "added fingerprint entry perfidia-1@1.0.0/rt-virtual-6p-1d",
          "added fingerprint entry perfidia-1@1.1.0",
          "added fingerprint entry perfidia-1@1.1.0/rt-virtual-6p-1d",
          "added fingerprint entry sandbox-1@1.0.0",
          "added fingerprint entry sandbox-1@1.0.0/rt-virtual-6p-1d",
          "",
        ].join("\n"),
      );
      expect(listGoldens(dir).map((g) => `${g.ref}/${g.name}`)).toEqual(names);
      const fp = readFingerprints(dir);
      expect(Object.keys(fp)).toEqual(["perfidia-1@1.0.0", "perfidia-1@1.1.0", "sandbox-1@1.0.0"]);
      expect(Object.keys(fp["sandbox-1@1.0.0"]?.goldens ?? {})).toEqual(["rt-virtual-6p-1d"]);

      const before = snapshotFiles(dir);
      const named = await cli("golden", "--update", "--fixtures", dir, name);
      expect(named.code).toBe(EXIT.usage);
      expect(named.out).toBe(`kept golden ${name} (it exists; goldens are append-only)\n`);
      expect(named.err).toContain(`refusing to overwrite ${name}`);
      expect(snapshotFiles(dir)).toEqual(before);

      const check = await cli("golden", "--check", "--fixtures", dir);
      expect(check.code).toBe(EXIT.ok);
      for (const n of names) expect(check.out).toContain(`${n}: Level E `);
      expect(check.out).toContain(" · Level G pass");
      expect(check.out).toContain("golden check: ok (3 golden(s))");

      // Append-only against an older fingerprints file: unchanged passes, a rewritten entry fails.
      const older = join(dir, "older-fingerprints.json");
      writeFileSync(older, readFileSync(join(dir, FINGERPRINTS_FILE), "utf8"));
      const same = await cli("golden", "--check", "--no-resim", "--fixtures", dir, "--base", older);
      expect(same.code).toBe(EXIT.ok);
      const base = readFingerprints(dir);
      const entry = base["sandbox-1@1.0.0"];
      if (entry === undefined) throw new Error("no sandbox-1 entry");
      writeFileSync(
        older,
        JSON.stringify({ ...base, "sandbox-1@1.0.0": { ...entry, artefacts: "0".repeat(64) } }),
      );
      const rewritten = await cli(
        "golden",
        "--check",
        "--no-resim",
        "--fixtures",
        dir,
        "--base",
        older,
      );
      expect(rewritten.code).toBe(EXIT.divergence);
      expect(rewritten.out).toContain("sandbox-1@1.0.0's artefacts were rewritten");
      rmSync(older);

      // A tampered golden fails the check, and an update without names keeps it as it is.
      const g = listGoldens(dir).find((x) => `${x.ref}/${x.name}` === name);
      if (g === undefined) throw new Error("no golden");
      const lines = readLog(g.path);
      const at = lines.findIndex((l) => l.k === "act" && l.r.ok);
      const act = lines[at];
      if (act?.k !== "act") throw new Error("no accepted action");
      const tampered = jsonlText(lines.with(at, { ...act, r: { ok: false, code: "QUEUE_FULL" } }));
      writeFileSync(g.path, tampered);
      const broken = await cli("golden", "--check", "--fixtures", dir, "--no-resim");
      expect(broken.code).toBe(EXIT.divergence);
      expect(broken.out).toContain(`problem: golden ${name}: Level E: result divergence`);
      const kept = await updateGoldens(dir, { specs });
      expect([kept.added, kept.kept, kept.refused, kept.fingerprints]).toEqual([[], names, [], []]);
      expect(readFileSync(g.path, "utf8")).toBe(tampered);
      expect(readFileSync(join(dir, FINGERPRINTS_FILE), "latin1")).toBe(
        before[join(dir, FINGERPRINTS_FILE)] ?? "",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("--update writes the scripted scenario goldens once, then refuses to rewrite them", async () => {
    const dir = tempDir();
    const names = ["perfidia-1@1.0.0/scenario-late", "perfidia-1@1.1.0/scenario-r1"];
    try {
      const first = await cli("golden", "--update", "--fixtures", dir, ...names);
      expect(first.code).toBe(EXIT.ok);
      expect(first.out).toBe(
        [
          ...names.map((n) => `added golden ${n}`),
          "added fingerprint entry perfidia-1@1.0.0",
          `added fingerprint entry ${names[0] ?? ""}`,
          "added fingerprint entry perfidia-1@1.1.0",
          `added fingerprint entry ${names[1] ?? ""}`,
          "added fingerprint entry sandbox-1@1.0.0",
          "",
        ].join("\n"),
      );
      const before = snapshotFiles(dir);
      for (const name of names) {
        // oxlint-disable-next-line no-await-in-loop -- one update at a time
        const again = await cli("golden", "--update", "--fixtures", dir, name);
        expect(again.code).toBe(EXIT.usage);
        expect(again.err).toContain(`refusing to overwrite ${name}`);
      }
      expect(snapshotFiles(dir)).toEqual(before);
      // A scenario golden is checked at Level E only: its agents are not bots of the registry.
      const check = await cli("golden", "--check", "--fixtures", dir);
      for (const name of names) expect(check.out).toContain(`${name}: Level E `);
      expect(check.out).toContain(" · Level G skipped");
      expect(check.out).not.toContain(" · Level G pass");
      // sandbox-1 is a test ruleset: without a golden of its own it is not a problem.
      expect(check.code).toBe(EXIT.ok);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("a new bot version gets a new golden next to the old one", async () => {
    const dir = tempDir();
    try {
      const sandbox = getRuleset("sandbox-1@1.0.0");
      const spec = (bots: readonly ("turtle" | "rusher")[]): GoldenSpec => ({
        ref: sandbox.ref,
        name: "lockstep-3p",
        run: {
          seed: 2,
          players: 3,
          overrides: { "time.matchEnd": 21600 },
          bots,
          clock: { kind: "lockstep" },
        },
      });
      const one = await updateGoldens(dir, { specs: [spec(["turtle"])], rulesets: [sandbox] });
      expect(one.added).toEqual(["sandbox-1@1.0.0/lockstep-3p"]);
      expect(one.fingerprints).toEqual(["sandbox-1@1.0.0", "sandbox-1@1.0.0/lockstep-3p"]);
      // The same family played by other bots (as after a label bump) is added under a new name.
      const two = await updateGoldens(dir, { specs: [spec(["rusher"])], rulesets: [sandbox] });
      expect(two.added).toHaveLength(1);
      expect(two.added[0]).toMatch(/^sandbox-1@1\.0\.0\/lockstep-3p-bots-[0-9a-f]{8}$/);
      expect(two.fingerprints).toEqual(two.added);
      const three = await updateGoldens(dir, {
        specs: [spec(["turtle"]), spec(["rusher"])],
        rulesets: [sandbox],
      });
      expect([three.added, three.kept.length, three.fingerprints]).toEqual([[], 2, []]);
      // Both goldens replay (Level E, and Level G with their bots).
      const check = await checkFixtures(dir, { rulesets: [sandbox] });
      expect([check.ok, check.problems, check.goldens.map((x) => x.levelG)]).toEqual([
        true,
        [],
        ["pass", "pass"],
      ]);
      let refused: unknown = null;
      try {
        await updateGoldens(dir, { only: ["nope@1.0.0/x"] });
      } catch (error) {
        refused = error;
      }
      expect(String(refused)).toContain("no golden spec named nope@1.0.0/x");
      expect((await cli("golden", "--fixtures", dir)).code).toBe(EXIT.usage);
      expect((await cli("golden", "--check", "--update")).code).toBe(EXIT.usage);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
