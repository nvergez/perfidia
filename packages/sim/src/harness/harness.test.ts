// The sim harness (docs/architecture.md §12.1): the JSONL reader and writer, normalised logs, the
// system clock, Level G options from a header, the ruleset fingerprint, and the golden check with
// its add-only writers, run on temporary fixture directories.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULESETS, getRuleset, verifyLog, type AnyRuleset } from "@perfidia/engine";
import { idKeyFromSeed } from "@perfidia/engine/core";
import { PerfidiaExtSchema } from "@perfidia/engine/rulesets/perfidia-1";
import type { LogSink } from "@perfidia/gateway";
import type { LogLine } from "@perfidia/protocol";
import {
  FINGERPRINTS_FILE,
  botAgents,
  GoldenExists,
  JsonlError,
  JsonlFileSink,
  addFingerprints,
  addGolden,
  appendOnlyProblems,
  checkGoldens,
  jsonlText,
  listGoldens,
  normaliseLog,
  normalisedHash,
  optionsFromHeader,
  parseJsonl,
  prepareBotRun,
  readFingerprints,
  readLog,
  resimProblem,
  rulesetArtefacts,
  rulesetFingerprint,
  runBots,
  runPrepared,
  setupFor,
  snapshotFileName,
  writeJsonl,
  type Fingerprints,
} from "./index.ts";

const SANDBOX = getRuleset("sandbox-1@1.0.0");
const PERFIDIA = getRuleset("perfidia-1@1.0.0");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perfidia-harness-"));
}

/** A short sandbox-1 lockstep log of the default bots (the first three). */
async function shortLog(seed = 2): Promise<LogLine[]> {
  const out = await runBots({
    ruleset: SANDBOX,
    seed,
    players: 3,
    overrides: { "time.matchEnd": 21600 },
    clock: { kind: "lockstep" },
  });
  return out.lines;
}

describe("setups", () => {
  test("setupFor: seats p1..pN, the exact ref, days as time.matchEnd, the seed-derived id key", () => {
    const setup = setupFor(PERFIDIA, { seed: 7, players: 6, days: 2, overrides: { "x.y": 1 } });
    expect(setup.ruleset).toBe("perfidia-1@1.0.0");
    expect(setup.overrides).toEqual({ "time.matchEnd": 172800, "x.y": 1 });
    expect(setup.seed).toBe(7);
    expect(setup.idKey).toBe(idKeyFromSeed(7));
    expect(setup.seats.map((s) => s.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    expect(setupFor(SANDBOX, { seed: 7, players: 2, idKey: "0".repeat(32) }).idKey).toBe(
      "0".repeat(32),
    );
    const agents = botAgents(setup, ["turtle", "rusher"], undefined, { p4: "opportunist" });
    expect([...agents.values()].map((a) => a.label)).toEqual([
      "bot:turtle@1",
      "bot:rusher@2",
      "bot:turtle@1",
      "bot:opportunist@1",
      "bot:turtle@1",
      "bot:rusher@2",
    ]);
    expect(() => botAgents(setup, ["turtle"], undefined, { p9: "rusher" })).toThrow("not a seat");
  });
});

describe("JSONL", () => {
  test("parseJsonl names the first bad line", async () => {
    const lines = await shortLog();
    const text = jsonlText(lines);
    expect(parseJsonl(text)).toEqual(lines);
    const rows = text.split("\n");
    rows[3] = "{not json";
    expect(() => parseJsonl(rows.join("\n"))).toThrow(JsonlError);
    try {
      parseJsonl(rows.join("\n"));
    } catch (error) {
      expect(error).toBeInstanceOf(JsonlError);
      if (error instanceof JsonlError) expect(error.line).toBe(4);
    }
    rows[3] = '{"k":"defer","t":-1,"seat":"p1","to":0}';
    expect(() => parseJsonl(rows.join("\n"))).toThrow("line 4: t:");
  });

  test("plain and gzip files round-trip byte for byte", async () => {
    const lines = await shortLog();
    const dir = tempDir();
    try {
      for (const name of ["a.jsonl", "a.jsonl.gz"]) {
        writeJsonl(join(dir, name), lines);
        expect(jsonlText(readLog(join(dir, name)))).toBe(jsonlText(lines));
      }
      expect(readFileSync(join(dir, "a.jsonl"), "utf8")).toBe(jsonlText(lines));
      expect(readFileSync(join(dir, "a.jsonl.gz")).subarray(0, 2)).toEqual(
        Buffer.from([0x1f, 0x8b]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("normalised logs and the system clock", () => {
  test("a system-clock run at very high speed passes Level E; normalising drops its wall keys only", async () => {
    const out = await runBots({
      ruleset: "sandbox-1",
      seed: 3,
      players: 4,
      days: 1,
      clock: { kind: "system", speed: { num: 864000, den: 1 } },
      strict: true,
    });
    const header = out.lines[0];
    if (header?.k !== "header") throw new Error("no header");
    expect(typeof header.wallStart).toBe("string");
    expect(out.lines.some((l) => l.k === "turn" && l.wallMs !== undefined)).toBe(true);
    expect(verifyLog(out.lines).ok).toBe(true);
    const normal = normaliseLog(out.lines);
    expect(JSON.stringify(normal)).not.toContain('"wall');
    expect(normal).toHaveLength(out.lines.length);
    expect(normalisedHash(out.lines)).toBe(normalisedHash(normal));
    expect(resimProblem(header, out.lines)).toContain("system-clock run is not reproducible");
  }, 30000);

  test("optionsFromHeader rebuilds bots, hand-offs and the clock; an unknown controller is refused", async () => {
    const lines = await shortLog();
    const header = lines[0];
    if (header?.k !== "header") throw new Error("no header");
    const prepared = optionsFromHeader(header, lines);
    expect(prepared.virtual).toBeNull();
    expect(prepared.options.clock).toEqual({ kind: "lockstep", maxTurnsPerSecond: 3 });
    expect([...prepared.options.agents.values()].map((a) => a.label)).toEqual([
      "bot:expander@1",
      "bot:rusher@2",
      "bot:turtle@1",
    ]);
    const renamed = { ...header, controllers: { ...header.controllers, p2: "llm:somebody" } };
    expect(resimProblem(renamed, lines)).toBe("controller llm:somebody is not a bot of this build");
    expect(() => optionsFromHeader(renamed, lines)).toThrow("not a bot of this build");
    const handed: LogLine[] = [
      ...lines,
      { k: "controller", t: 100, seat: "p3", label: "bot:turtle@1" },
    ];
    expect(
      optionsFromHeader(header, handed).options.handoffs?.map((h) => [h.seat, h.at, h.label]),
    ).toEqual([["p3", 100, "bot:turtle@1"]]);
  });
});

describe("the ruleset fingerprint", () => {
  test("is stable, and changes with any agent-visible artefact", () => {
    const fp = rulesetFingerprint(PERFIDIA);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(rulesetFingerprint(PERFIDIA)).toBe(fp);
    const altered: AnyRuleset = {
      ...PERFIDIA,
      cheatSheet: (config, rules) => `${PERFIDIA.cheatSheet(config, rules)}!`,
    };
    expect(rulesetFingerprint(altered)).not.toBe(fp);
    const reworded: AnyRuleset = {
      ...SANDBOX,
      errors: Object.fromEntries(
        Object.entries(SANDBOX.errors).map(([code, e]) => [
          code,
          (v, f) => ({ ...e(v, f), hint: "changed" }),
        ]),
      ),
    };
    expect(rulesetFingerprint(reworded)).not.toBe(rulesetFingerprint(SANDBOX));
  });

  test("covers the title, the extra tools, the event schemas and the world at every N", () => {
    const fp = rulesetFingerprint(SANDBOX);
    const titled: AnyRuleset = { ...SANDBOX, title: `${SANDBOX.title} 2` };
    expect(rulesetFingerprint(titled)).not.toBe(fp);
    const [first, second] = SANDBOX.tools ?? [];
    if (first === undefined || second === undefined) throw new Error("sandbox-1 has two extras");
    const described: AnyRuleset = {
      ...SANDBOX,
      tools: [first, { ...second, description: second.description.replace("16", "12") }],
    };
    expect(described.tools?.[1]?.description).not.toBe(second.description);
    expect(rulesetFingerprint(described)).not.toBe(fp);
    const events: AnyRuleset = { ...SANDBOX, eventSchemas: {} };
    expect(rulesetFingerprint(events)).not.toBe(fp);
    // A world that changes only at the largest N (12 seats: the public tie-break order reversed)
    // changes the fingerprint, though no golden has 12 seats to replay it.
    const reversed: AnyRuleset = {
      ...PERFIDIA,
      hooks: {
        ...PERFIDIA.hooks,
        createWorld: (w) => {
          const out = PERFIDIA.hooks.createWorld(w);
          if (w.players.length !== 12) return out;
          const ext = PerfidiaExtSchema.parse(out.ext);
          return { ...out, ext: { ...ext, tiebreak: ext.tiebreak.toReversed() } };
        },
      },
    };
    expect(rulesetArtefacts(reversed).worlds["11"]).toBe(rulesetArtefacts(PERFIDIA).worlds["11"]);
    expect(rulesetArtefacts(reversed).worlds["12"]).not.toBe(
      rulesetArtefacts(PERFIDIA).worlds["12"],
    );
  });

  test("the append-only rule: an older entry may not change or go; new entries may come", () => {
    const head: Fingerprints = {
      "a@1.0.0": { artefacts: "1".repeat(64), goldens: { g1: "0".repeat(16) }, views: {} },
      "b@1.0.0": { artefacts: "2".repeat(64), goldens: {}, views: {} },
    };
    const base = { "a@1.0.0": { artefacts: "1".repeat(64), goldens: { g1: "0".repeat(16) } } };
    expect(appendOnlyProblems(base, head)).toEqual([]);
    const rewritten = { "a@1.0.0": { artefacts: "3".repeat(64), goldens: { g1: "f".repeat(16) } } };
    expect(appendOnlyProblems(rewritten, head)).toEqual([
      `${FINGERPRINTS_FILE}: a@1.0.0's artefacts were rewritten (${"3".repeat(64)} → ${"1".repeat(64)})`,
      `${FINGERPRINTS_FILE}: a@1.0.0's goldens entry g1 was rewritten (${"f".repeat(16)} → ${"0".repeat(16)})`,
    ]);
    const gone = { "c@1.0.0": {}, "a@1.0.0": { goldens: { g2: "0".repeat(16) } } };
    expect(appendOnlyProblems(gone, head)).toEqual([
      `${FINGERPRINTS_FILE}: a@1.0.0's goldens entry g2 was removed`,
      `${FINGERPRINTS_FILE}: the entry of c@1.0.0 was removed`,
    ]);
  });
});

describe("goldens", () => {
  test("add-only writers, the check, a tampered copy and an altered descriptor", async () => {
    const dir = tempDir();
    try {
      const lines = await shortLog(5);
      const path = addGolden(dir, SANDBOX.ref, "lockstep-3p", lines);
      expect(path.endsWith(join("golden", "sandbox-1@1.0.0", "lockstep-3p.jsonl"))).toBe(true);
      expect(() => addGolden(dir, SANDBOX.ref, "lockstep-3p", lines)).toThrow(GoldenExists);
      expect(() => addGolden(dir, PERFIDIA.ref, "x", lines)).toThrow("must name perfidia-1@1.0.0");
      expect(listGoldens(dir).map((g) => [g.ref, g.name])).toEqual([[SANDBOX.ref, "lockstep-3p"]]);

      // Before any fingerprint, the check reports the missing entries.
      const missing = await checkGoldens(dir, [SANDBOX], { levelG: false });
      expect(missing.problems).toEqual([
        `golden ${SANDBOX.ref}/lockstep-3p: no final hash in ${FINGERPRINTS_FILE}`,
      ]);
      expect(addFingerprints(dir, [SANDBOX])).toEqual([SANDBOX.ref, `${SANDBOX.ref}/lockstep-3p`]);
      expect(addFingerprints(dir, [SANDBOX])).toEqual([]);
      const fp = readFingerprints(dir);
      expect(fp[SANDBOX.ref]?.artefacts).toBe(rulesetFingerprint(SANDBOX));
      expect(fp[SANDBOX.ref]?.goldens["lockstep-3p"]).toBe(verifyLog(lines).finalHash ?? "");

      const report = await checkGoldens(dir, [SANDBOX]);
      expect(report.problems).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.goldens).toEqual([
        {
          ref: SANDBOX.ref,
          name: "lockstep-3p",
          finalHash: fp[SANDBOX.ref]?.goldens["lockstep-3p"] ?? null,
          levelG: "pass",
        },
      ]);

      // A published ref of the list without a golden or an entry fails the check.
      const published = await checkGoldens(dir, RULESETS, { levelG: false });
      expect(published.problems).toEqual([
        "perfidia-1@1.0.0 has no golden",
        `perfidia-1@1.0.0 has no entry in ${FINGERPRINTS_FILE}`,
      ]);

      // A descriptor whose cheat sheet changed fails on its artefacts.
      const altered: AnyRuleset = {
        ...SANDBOX,
        cheatSheet: (config, rules) => `${SANDBOX.cheatSheet(config, rules)}!`,
      };
      const changed = await checkGoldens(dir, [altered], { levelG: false });
      expect(changed.ok).toBe(false);
      expect(changed.problems[0]).toContain("sandbox-1@1.0.0's artefacts changed");

      // A tampered copy of the golden (one act line's recorded result flipped) fails at Level E.
      const first = lines.find((l) => l.k === "act" && l.r.ok);
      if (first?.k !== "act") throw new Error("no accepted action");
      const tampered = lines.with(lines.indexOf(first), {
        ...first,
        r: { ok: false, code: "QUEUE_FULL" },
      });
      writeFileSync(path, jsonlText(tampered));
      const broken = await checkGoldens(dir, [SANDBOX]);
      expect(broken.ok).toBe(false);
      expect(broken.problems[0]).toContain(
        `Level E: result divergence at t = ${first.t} (n ${first.n})`,
      );
      // A golden that does not replay is not re-simulated.
      expect(broken.goldens.map((g) => g.levelG)).toEqual(["skipped"]);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("a deleted golden, a golden of a ruleset outside the list and a failing re-simulation are problems, never throws", async () => {
    const dir = tempDir();
    try {
      const lines = await shortLog(5);
      addGolden(dir, SANDBOX.ref, "lockstep-3p", lines);
      const second = addGolden(dir, SANDBOX.ref, "lockstep-3p-b", await shortLog(6));
      addFingerprints(dir, [SANDBOX]);
      expect((await checkGoldens(dir, [SANDBOX], { levelG: false })).ok).toBe(true);

      // Deleting a committed golden fails the freeze guard even though the ref keeps another one.
      rmSync(second);
      const deleted = await checkGoldens(dir, [SANDBOX], { levelG: false });
      expect(deleted.ok).toBe(false);
      expect(deleted.problems).toEqual([
        `golden ${SANDBOX.ref}/lockstep-3p-b is recorded in ${FINGERPRINTS_FILE} but missing`,
      ]);

      // Checked against another ruleset list, the sandbox golden fails Level E and is not re-simulated.
      const other = await checkGoldens(dir, [PERFIDIA]);
      expect(other.ok).toBe(false);
      expect(other.goldens.map((g) => [g.name, g.finalHash, g.levelG])).toEqual([
        ["lockstep-3p", null, "skipped"],
      ]);
      expect(other.problems).toContain(
        `${FINGERPRINTS_FILE}: ${SANDBOX.ref} is not a ruleset of this build`,
      );

      // A golden that replays but whose re-simulation throws (a hand-off to a seat the match does
      // not have) reports the failure as a problem of that golden.
      const path = listGoldens(dir)[0]?.path ?? "";
      const handed: LogLine[] = [
        ...lines.slice(0, 1),
        { k: "controller", t: 0, seat: "p9", label: "bot:turtle@1" },
        ...lines.slice(1),
      ];
      expect(verifyLog(handed).ok).toBe(true);
      writeFileSync(path, jsonlText(handed));
      const resim = await checkGoldens(dir, [SANDBOX]);
      expect(resim.goldens.map((g) => g.levelG)).toEqual(["fail"]);
      expect(resim.problems).toEqual([
        `golden ${SANDBOX.ref}/lockstep-3p: Level G re-simulation failed: hand-off to p9, which is not a seat`,
        `golden ${SANDBOX.ref}/lockstep-3p-b is recorded in ${FINGERPRINTS_FILE} but missing`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("the file sink", () => {
  test("holds every line up to a checkpoint before that hour's snapshot file exists", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "match.jsonl");
      const snapshotsDir = join(dir, "snapshots");
      const file = new JsonlFileSink(path, { snapshotsDir });
      const seen: [number, string | undefined][] = [];
      const sink: LogSink = {
        write: (line) => file.write(line),
        flush: () => file.flush(),
        snapshot(snap) {
          const name = snapshotFileName(snap);
          expect(existsSync(join(snapshotsDir, name))).toBe(false);
          const onDisk = readLog(path);
          const last = onDisk.at(-1);
          seen.push([snap.hour, last?.k === "ckpt" ? `ckpt ${last.hour}` : last?.k]);
          file.snapshot(snap);
        },
      };
      const prepared = prepareBotRun({
        ruleset: SANDBOX,
        seed: 3,
        players: 3,
        overrides: { "time.matchEnd": 6 * 3600 },
        clock: { kind: "lockstep" },
        snapshotEvery: 2,
      });
      await runPrepared(prepared, sink);
      // Each checkpoint snapshot finds its own ckpt line last on disk; the final one the end line.
      expect(seen).toEqual([
        [2, "ckpt 2"],
        [4, "ckpt 4"],
        [5, "end"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
