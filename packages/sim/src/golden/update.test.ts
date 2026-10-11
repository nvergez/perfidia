// `sim golden` (docs/architecture.md §3.5, §12.1, §13.5, §13.6, §15 T15): `--update` adds a missing
// golden and the fingerprint entries and refuses to overwrite an existing golden; `--check` passes
// on what it wrote and fails on a tampered copy; a new bot version gets a new golden. Every match
// here lasts at most 1 game day (§13): the CLI writes only the 1-day goldens of `GOLDEN_SPECS`,
// named on its command line, and the multi-day ones are left to T17's exit work.

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
  test("the specs are the bot goldens of §13.5", () => {
    expect(GOLDEN_SPECS.map((s) => [`${s.ref}/${s.name}`, s.run.days, s.run.clock.kind])).toEqual([
      ["perfidia-1@1.0.0/lockstep-6p-4d", 4, "lockstep"],
      ["perfidia-1@1.0.0/rt-virtual-6p-1d", 1, "virtual"],
      ["sandbox-1@1.0.0/lockstep-6p-3d", 3, "lockstep"],
      ["sandbox-1@1.0.0/rt-virtual-6p-1d", 1, "virtual"],
    ]);
  });

  test("--update adds goldens once and refuses to overwrite them; --check passes, then fails on a tampered golden", async () => {
    const dir = tempDir();
    // The 1-day goldens of each published ref: `--check` wants one golden per published ref.
    const names = ["perfidia-1@1.0.0/rt-virtual-6p-1d", "sandbox-1@1.0.0/rt-virtual-6p-1d"];
    const name = names[1] ?? "";
    const specs = GOLDEN_SPECS.filter((s) => names.includes(`${s.ref}/${s.name}`));
    expect(specs.map((s) => s.run.days)).toEqual([1, 1]);
    try {
      const first = await cli("golden", "--update", "--fixtures", dir, ...names);
      expect(first.code).toBe(EXIT.ok);
      expect(first.out).toBe(
        [
          ...names.map((n) => `added golden ${n}`),
          "added fingerprint entry perfidia-1@1.0.0",
          "added fingerprint entry perfidia-1@1.0.0/rt-virtual-6p-1d",
          "added fingerprint entry sandbox-1@1.0.0",
          "added fingerprint entry sandbox-1@1.0.0/rt-virtual-6p-1d",
          "",
        ].join("\n"),
      );
      expect(listGoldens(dir).map((g) => `${g.ref}/${g.name}`)).toEqual(names);
      const fp = readFingerprints(dir);
      expect(Object.keys(fp)).toEqual(["perfidia-1@1.0.0", "sandbox-1@1.0.0"]);
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
      expect(check.out).toContain("golden check: ok (2 golden(s))");

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
