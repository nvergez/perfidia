// The sim harness (docs/architecture.md §12.1): the JSONL reader and writer, normalised logs, the
// system clock, Level G options from a header, the ruleset fingerprint, and the golden check with
// its add-only writers, run on temporary fixture directories.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULESETS, getRuleset, verifyLog, type AnyRuleset } from "@perfidia/engine";
import { idKeyFromSeed } from "@perfidia/engine/core";
import type { LogLine } from "@perfidia/protocol";
import {
  FINGERPRINTS_FILE,
  botAgents,
  GoldenExists,
  JsonlError,
  addFingerprints,
  addGolden,
  checkGoldens,
  jsonlText,
  listGoldens,
  normaliseLog,
  normalisedHash,
  optionsFromHeader,
  parseJsonl,
  readFingerprints,
  readJsonl,
  resimProblem,
  rulesetFingerprint,
  runBots,
  setupFor,
  writeJsonl,
} from "./index.ts";

const SANDBOX = getRuleset("sandbox-1@1.0.0");
const PERFIDIA = getRuleset("perfidia-1@1.0.0");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perfidia-harness-"));
}

/** A short sandbox-1 lockstep log of the four bots. */
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
      "bot:rusher@1",
      "bot:turtle@1",
      "bot:opportunist@1",
      "bot:turtle@1",
      "bot:rusher@1",
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
        expect(jsonlText(readJsonl(join(dir, name)))).toBe(jsonlText(lines));
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
      "bot:rusher@1",
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
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
