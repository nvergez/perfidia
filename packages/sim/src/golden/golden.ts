import { join } from "node:path";
import { RULESETS, type AnyRuleset } from "@perfidia/engine";
import { canonicalJson, sha256Hex } from "@perfidia/engine/core";
import type { LogLine } from "@perfidia/protocol";
import { UsageError, errorText } from "../args.ts";
import { SCENARIO_LATE_NAME, SCENARIO_LATE_REF, runScenarioLate } from "../exit/scenario.ts";
import { SCENARIO_R1_NAME, SCENARIO_R1_REF, runScenarioR1 } from "../exit/scenario_r1.ts";
import {
  GoldenExists,
  addFingerprints,
  addGolden,
  checkGoldens,
  listGoldens,
  prepareBotRun,
  runBots,
  type BotRunSpec,
  type GoldenReport,
} from "../harness/index.ts";
import { readFirstLine } from "../io/index.ts";

// `sim golden` (docs/architecture.md §3.5, §12.1, §13.5, §13.6): `--check` runs the harness's
// freeze guard over the committed fixtures; `--update` only adds: a golden for each bot spec below
// that has none for the current bot labels (a later bot version gets a new golden, suffixed with a
// hash of its labels, and the old one keeps its Level E and G checks, §11.1), the scripted scenario
// goldens that do not exist yet, then fingerprint entries for every ref and golden without one.
// Nothing is ever rewritten; naming an existing golden is refused.

/** `packages/sim/fixtures`: the committed goldens and `fingerprints.json`. */
export const FIXTURES_DIR = join(import.meta.dir, "..", "..", "fixtures");

/** A golden the CLI can (re)create from bots: its ref, its name and the match it records. */
export interface BotGoldenSpec {
  readonly ref: string;
  readonly name: string;
  readonly run: Omit<BotRunSpec, "ruleset">;
}

/**
 * A golden recorded by a scripted scenario (§13.5 `scenario-late`): its agents are not registered
 * bots, so the golden is checked at Level E only. A changed script is a new scenario name.
 */
export interface ScenarioGoldenSpec {
  readonly ref: string;
  readonly name: string;
  play(): Promise<readonly LogLine[]>;
}

export type GoldenSpec = BotGoldenSpec | ScenarioGoldenSpec;

const isScenario = (s: GoldenSpec): s is ScenarioGoldenSpec => !("run" in s);

/**
 * The seed of 1.1.0's war golden: of seeds 1–30 of that lineup over 6 days (no countdown starts in
 * any), the first with three conquests or more and a recapture by a former owner (8 conquests, 2
 * recaptures), so that both kinds of conquest record are under Level G.
 */
const WAR_SEED_1_1 = 7;

/**
 * The goldens of §13.5: five bot goldens (one at the largest N, 12, so that the seat-count
 * dependent parts of a ruleset are replayed too), one of the war-call bots allied (`-war`, its
 * lineup pinned) and the scripted `scenario-late`; for perfidia-1@1.1.0 the same bot goldens and
 * the scripted `scenario-r1` (domination by conquest).
 */
export const GOLDEN_SPECS: readonly GoldenSpec[] = Object.freeze([
  {
    ref: "perfidia-1@1.0.0",
    name: "lockstep-6p-4d",
    run: { seed: 1, players: 6, days: 4, clock: { kind: "lockstep" }, strict: true },
  },
  {
    ref: "perfidia-1@1.0.0",
    name: "rt-virtual-6p-1d",
    run: {
      seed: 1,
      players: 6,
      days: 1,
      clock: { kind: "virtual", speed: { num: 3, den: 1 }, latencyMs: [2000, 60000] },
      strict: true,
    },
  },
  {
    ref: "perfidia-1@1.0.0",
    name: "lockstep-12p-1d",
    run: { seed: 1, players: 12, days: 1, clock: { kind: "lockstep" }, strict: true },
  },
  {
    // The war-call bots allied as in the decision batches (`conqueror@3` beside `opportunist@3` and
    // `turtle@3`): their calls, answers, joint attacks and held conquests are under Level G.
    ref: "perfidia-1@1.0.0",
    name: "lockstep-6p-6d-war",
    run: {
      seed: 33,
      players: 6,
      days: 6,
      bots: ["conqueror@3", "opportunist@3", "turtle@3", "conqueror@3", "expander@2", "rusher@3"],
      clock: { kind: "lockstep" },
      strict: true,
    },
  },
  {
    ref: SCENARIO_LATE_REF,
    name: SCENARIO_LATE_NAME,
    play: async (): Promise<readonly LogLine[]> => (await runScenarioLate()).lines,
  },
  {
    ref: "perfidia-1@1.1.0",
    name: "lockstep-6p-4d",
    run: { seed: 1, players: 6, days: 4, clock: { kind: "lockstep" }, strict: true },
  },
  {
    ref: "perfidia-1@1.1.0",
    name: "rt-virtual-6p-1d",
    run: {
      seed: 1,
      players: 6,
      days: 1,
      clock: { kind: "virtual", speed: { num: 3, den: 1 }, latencyMs: [2000, 60000] },
      strict: true,
    },
  },
  {
    ref: "perfidia-1@1.1.0",
    name: "lockstep-12p-1d",
    run: { seed: 1, players: 12, days: 1, clock: { kind: "lockstep" }, strict: true },
  },
  {
    // The war-call bots under domination by conquest: their sieges, conquests and the conquest
    // records (taken cities, former owners) in the views are under Level G.
    ref: "perfidia-1@1.1.0",
    name: "lockstep-6p-6d-war",
    run: {
      seed: WAR_SEED_1_1,
      players: 6,
      days: 6,
      bots: ["conqueror@3", "opportunist@3", "turtle@3", "conqueror@3", "expander@2", "rusher@3"],
      clock: { kind: "lockstep" },
      strict: true,
    },
  },
  {
    ref: SCENARIO_R1_REF,
    name: SCENARIO_R1_NAME,
    play: async (): Promise<readonly LogLine[]> => (await runScenarioR1()).lines,
  },
  {
    ref: "sandbox-1@1.0.0",
    name: "lockstep-6p-3d",
    run: { seed: 1, players: 6, days: 3, clock: { kind: "lockstep" }, strict: true },
  },
  {
    ref: "sandbox-1@1.0.0",
    name: "rt-virtual-6p-1d",
    run: {
      seed: 1,
      players: 6,
      days: 1,
      clock: { kind: "virtual", speed: { num: 3, den: 1 }, latencyMs: [2000, 60000] },
      strict: true,
    },
  },
]);

export interface GoldenUpdate {
  /** `ref/name` of every golden written. */
  readonly added: string[];
  /** `ref/name` of goldens that already exist for the current bot labels (left untouched). */
  readonly kept: string[];
  /** Goldens named on the command line that already exist: refused, never rewritten. */
  readonly refused: string[];
  /** Goldens whose match failed (never written). */
  readonly failed: string[];
  /** Fingerprint entries added (`ref` or `ref/name`). */
  readonly fingerprints: string[];
}

/** The controller labels a bot spec's match gives each seat. */
function labelsOf(rs: AnyRuleset, spec: BotGoldenSpec): Record<string, string> {
  const prepared = prepareBotRun({ ...spec.run, ruleset: rs });
  const out: Record<string, string> = {};
  for (const [seat, agent] of prepared.options.agents) out[seat] = agent.label;
  return out;
}

/** The controllers recorded in a golden's header, or null when it has none readable. */
function goldenLabels(path: string): Record<string, string> | null {
  try {
    const header = readFirstLine(path);
    return header?.k === "header" ? { ...header.controllers } : null;
  } catch {
    return null;
  }
}

/**
 * The existing golden that records `spec` (a bot spec: one of its family played by the same bot
 * labels; a scenario: the golden of its name), and the name a new golden of it gets.
 */
function existing(
  fixturesDir: string,
  rs: AnyRuleset,
  spec: GoldenSpec,
): { readonly current: string | null; readonly name: string } {
  const goldens = listGoldens(fixturesDir).filter((g) => g.ref === spec.ref);
  if (isScenario(spec)) {
    const found = goldens.some((g) => g.name === spec.name);
    return { current: found ? `${spec.ref}/${spec.name}` : null, name: spec.name };
  }
  const labels = canonicalJson(labelsOf(rs, spec));
  const family = goldens.filter(
    (g) => g.name === spec.name || g.name.startsWith(`${spec.name}-bots-`),
  );
  const current = family.find((g) => {
    const l = goldenLabels(g.path);
    return l !== null && canonicalJson(l) === labels;
  });
  const name = family.some((g) => g.name === spec.name)
    ? `${spec.name}-bots-${sha256Hex(labels).slice(0, 8)}`
    : spec.name;
  return { current: current === undefined ? null : `${current.ref}/${current.name}`, name };
}

/**
 * Adds the missing goldens of `specs` (all of them, or the `only` ones, named `ref/name`) and the
 * missing fingerprint entries of `rulesets`. Never rewrites a file or an entry.
 */
export async function updateGoldens(
  fixturesDir: string,
  o: {
    readonly specs?: readonly GoldenSpec[];
    readonly rulesets?: readonly AnyRuleset[];
    readonly only?: readonly string[];
    readonly progress?: (text: string) => void;
  } = {},
): Promise<GoldenUpdate> {
  const specs = o.specs ?? GOLDEN_SPECS;
  const rulesets = o.rulesets ?? RULESETS;
  const only = o.only ?? [];
  for (const name of only) {
    if (!specs.some((s) => `${s.ref}/${s.name}` === name)) {
      throw new UsageError(
        `no golden spec named ${name}; the specs are ${specs.map((s) => `${s.ref}/${s.name}`).join(", ")}`,
      );
    }
  }
  const selected =
    only.length === 0 ? specs : specs.filter((s) => only.includes(`${s.ref}/${s.name}`));
  const report: GoldenUpdate = { added: [], kept: [], refused: [], failed: [], fingerprints: [] };
  for (const spec of selected) {
    const rs = rulesets.find((r) => r.ref === spec.ref);
    if (rs === undefined)
      throw new UsageError(
        `golden spec ${spec.ref}/${spec.name}: ${spec.ref} is not in this build`,
      );
    const { current, name } = existing(fixturesDir, rs, spec);
    if (current !== null) {
      report.kept.push(current);
      if (only.includes(`${spec.ref}/${spec.name}`)) report.refused.push(current);
      continue;
    }
    o.progress?.(`running ${spec.ref}/${name} …`);
    try {
      const played = isScenario(spec)
        ? spec.play()
        : runBots({ ...spec.run, ruleset: rs }).then((out) => out.lines);
      // oxlint-disable-next-line no-await-in-loop -- one match at a time
      const lines = await played;
      addGolden(fixturesDir, spec.ref, name, lines);
      report.added.push(`${spec.ref}/${name}`);
    } catch (error) {
      if (error instanceof GoldenExists) throw error;
      report.failed.push(`${spec.ref}/${name}: ${errorText(error)}`);
    }
  }
  report.fingerprints.push(...addFingerprints(fixturesDir, rulesets));
  return report;
}

/** The freeze guard over `fixturesDir` (§13.5, §13.6), with every ruleset of the build. */
export function checkFixtures(
  fixturesDir: string,
  o: { readonly rulesets?: readonly AnyRuleset[]; readonly levelG?: boolean } = {},
): Promise<GoldenReport> {
  return checkGoldens(fixturesDir, o.rulesets ?? RULESETS, { levelG: o.levelG ?? true });
}
