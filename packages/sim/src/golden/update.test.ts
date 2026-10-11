// `sim golden` (docs/architecture.md §3.5, §12.1, §13.5, §13.6, §15 T15): `--update` adds the
// missing goldens and fingerprint entries and refuses to overwrite an existing golden; `--check`
// passes on what it wrote and fails on a tampered copy; a new bot version gets a new golden.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuleset } from "@perfidia/engine";
import { EXIT, memoryIo } from "../args.ts";
import { main } from "../cli.ts";
import { FINGERPRINTS_FILE, jsonlText, listGoldens, readFingerprints } from "../harness/index.ts";
import { readLog } from "../io/index.ts";
import { GOLDEN_SPECS, updateGoldens, type GoldenSpec } from "./index.ts";

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
  test("--update adds the goldens of §13.5 once and refuses to overwrite; --check passes, then fails on a tampered golden", async () => {
    const dir = tempDir();
    try {
      const first = await cli("golden", "--update", "--fixtures", dir);
      expect(first.code).toBe(EXIT.ok);
      const names = GOLDEN_SPECS.map((s) => `${s.ref}/${s.name}`);
      for (const n of names) expect(first.out).toContain(`added golden ${n}\n`);
      expect(listGoldens(dir).map((g) => `${g.ref}/${g.name}`)).toEqual(names);
      const fp = readFingerprints(dir);
      expect(Object.keys(fp)).toEqual(["perfidia-1@1.0.0", "sandbox-1@1.0.0"]);
      expect(Object.keys(fp["perfidia-1@1.0.0"]?.goldens ?? {})).toEqual([
        "lockstep-6p-4d",
        "rt-virtual-6p-1d",
      ]);

      const before = snapshotFiles(dir);
      const again = await cli("golden", "--update", "--fixtures", dir);
      expect(again.code).toBe(EXIT.ok);
      for (const n of names)
        expect(again.out).toContain(`kept golden ${n} (it exists; goldens are append-only)`);
      expect(again.out).not.toContain("added");
      const named = await cli(
        "golden",
        "--update",
        "--fixtures",
        dir,
        "sandbox-1@1.0.0/lockstep-6p-3d",
      );
      expect(named.code).toBe(EXIT.usage);
      expect(named.err).toContain("refusing to overwrite sandbox-1@1.0.0/lockstep-6p-3d");
      expect(snapshotFiles(dir)).toEqual(before);

      const check = await cli("golden", "--check", "--fixtures", dir);
      expect(check.code).toBe(EXIT.ok);
      expect(check.out).toContain("perfidia-1@1.0.0/lockstep-6p-4d: Level E ");
      expect(check.out).toContain(" · Level G pass");
      expect(check.out).toContain("golden check: ok (4 golden(s))");

      // A tampered golden fails the check, and --update still does not touch it.
      const g = listGoldens(dir).find((x) => x.name === "lockstep-6p-3d");
      if (g === undefined) throw new Error("no sandbox golden");
      const lines = readLog(g.path);
      const at = lines.findIndex((l) => l.k === "act" && l.r.ok);
      const act = lines[at];
      if (act?.k !== "act") throw new Error("no accepted action");
      const tampered = jsonlText(lines.with(at, { ...act, r: { ok: false, code: "QUEUE_FULL" } }));
      writeFileSync(g.path, tampered);
      const broken = await cli("golden", "--check", "--fixtures", dir, "--no-resim");
      expect(broken.code).toBe(EXIT.divergence);
      expect(broken.out).toContain(
        "problem: golden sandbox-1@1.0.0/lockstep-6p-3d: Level E: result divergence",
      );
      expect((await cli("golden", "--update", "--fixtures", dir)).code).toBe(EXIT.ok);
      expect(readFileSync(g.path, "utf8")).toBe(tampered);
      expect(readFileSync(join(dir, FINGERPRINTS_FILE), "latin1")).toBe(
        before[join(dir, FINGERPRINTS_FILE)] ?? "",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

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
