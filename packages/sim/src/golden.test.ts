// The freeze guard (docs/architecture.md §13.5, §13.6), in the default suite on purpose: every
// `bun test` replays every committed golden at Level E (and Level G when its controllers are bots
// of this build), recomputes the ruleset fingerprints and the views fingerprint of every golden
// (what the hooks show every seat at every checkpoint), and checks that every published ref keeps
// a golden and a fingerprint entry. The same check must fail on a tampered temporary copy of the
// fixtures, and on descriptors whose cheat sheet, visibility hook, title or extra tool changed.
// The goldens' coverage claims of §13.5 are asserted from their own lines.

import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULESETS, getRuleset, verifyLog, type AnyRuleset } from "@perfidia/engine";
import type { EvLine, LogLine } from "@perfidia/protocol";
import { SCENARIO_LATE_LABEL, runScenarioLate } from "./exit/scenario.ts";
import { FIXTURES_DIR } from "./golden/index.ts";
import {
  FINGERPRINTS_FILE,
  checkGoldens,
  jsonlText,
  listGoldens,
  normalisedText,
  readFingerprints,
  readLog,
  type GoldenFile,
} from "./harness/index.ts";

const PERFIDIA = "perfidia-1@1.0.0";
const SANDBOX = "sandbox-1@1.0.0";

/** The phase-1 bots: the controllers of the first bot goldens. */
const PHASE1_BOTS = ["bot:expander@1", "bot:rusher@1", "bot:turtle@1", "bot:opportunist@1"];
/** The default bots of the fighting-bots release (PR #7): rusher@2 and conqueror@1, frozen. */
const FIGHT_LABELS = [
  "bot:expander@1",
  "bot:rusher@2",
  "bot:turtle@1",
  "bot:opportunist@1",
  "bot:conqueror@1",
];
/** The default bots of the relief release (PR #8): each strategy at its version then, frozen. */
const RELIEF_LABELS = [
  "bot:expander@2",
  "bot:rusher@3",
  "bot:turtle@2",
  "bot:opportunist@2",
  "bot:conqueror@2",
];
/** The default bots of this build, each at its latest version (the war-call bots). */
const DEFAULT_LABELS = [
  "bot:expander@2",
  "bot:rusher@3",
  "bot:turtle@3",
  "bot:opportunist@3",
  "bot:conqueror@3",
];
/** The name suffixes of the goldens of a set of bots: a hash of the seats' labels (§13.5). */
const FIGHT_6P = "bots-3cd67627";
const FIGHT_12P = "bots-c5bd73c9";
const RELIEF_6P = "bots-9ac064bb";
const RELIEF_12P = "bots-24a01286";
const BOTS_6P = "bots-aeaf1d12";
const BOTS_12P = "bots-52f1a52b";

function golden(ref: string, name: string): GoldenFile {
  const g = listGoldens(FIXTURES_DIR).find((x) => x.ref === ref && x.name === name);
  if (g === undefined) throw new Error(`golden ${ref}/${name} is not committed`);
  return g;
}

/** A temporary copy of the committed fixtures. */
function fixturesCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "perfidia-golden-guard-"));
  cpSync(FIXTURES_DIR, dir, { recursive: true });
  return dir;
}

const evs = (lines: readonly LogLine[], type: string): EvLine[] =>
  lines.filter((l): l is EvLine => l.k === "ev" && l.e.type === type);

const field = (l: EvLine, key: string): unknown =>
  Object.hasOwn(l.e.data, key) ? l.e.data[key] : undefined;

describe("the freeze guard", () => {
  test("every golden replays with its recorded final hash, and every fingerprint matches", async () => {
    const report = await checkGoldens(FIXTURES_DIR, RULESETS);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    // The goldens of §13.5; Level G runs for the bot goldens, not for the scripted scenario. Each
    // bot golden exists for the phase-1 bots and, suffixed with a hash of its labels, for the
    // default bots of PR #7 (rusher@2, conqueror@1), of PR #8 (the relief release) and of this
    // build (every strategy at its latest version): the older ones keep their Level G check.
    expect(report.goldens.map((g) => `${g.ref}/${g.name} ${g.levelG}`)).toEqual([
      `${PERFIDIA}/lockstep-12p-1d-${RELIEF_12P} pass`,
      `${PERFIDIA}/lockstep-12p-1d-${BOTS_12P} pass`,
      `${PERFIDIA}/lockstep-12p-1d-${FIGHT_12P} pass`,
      `${PERFIDIA}/lockstep-12p-1d pass`,
      `${PERFIDIA}/lockstep-6p-4d-${FIGHT_6P} pass`,
      `${PERFIDIA}/lockstep-6p-4d-${RELIEF_6P} pass`,
      `${PERFIDIA}/lockstep-6p-4d-${BOTS_6P} pass`,
      `${PERFIDIA}/lockstep-6p-4d pass`,
      `${PERFIDIA}/rt-virtual-6p-1d-${FIGHT_6P} pass`,
      `${PERFIDIA}/rt-virtual-6p-1d-${RELIEF_6P} pass`,
      `${PERFIDIA}/rt-virtual-6p-1d-${BOTS_6P} pass`,
      `${PERFIDIA}/rt-virtual-6p-1d pass`,
      `${PERFIDIA}/scenario-late skipped`,
      `${SANDBOX}/lockstep-6p-3d-${FIGHT_6P} pass`,
      `${SANDBOX}/lockstep-6p-3d-${RELIEF_6P} pass`,
      `${SANDBOX}/lockstep-6p-3d-${BOTS_6P} pass`,
      `${SANDBOX}/lockstep-6p-3d pass`,
      `${SANDBOX}/rt-virtual-6p-1d-${FIGHT_6P} pass`,
      `${SANDBOX}/rt-virtual-6p-1d-${RELIEF_6P} pass`,
      `${SANDBOX}/rt-virtual-6p-1d-${BOTS_6P} pass`,
      `${SANDBOX}/rt-virtual-6p-1d pass`,
    ]);
    // Every published ref of the registry has at least one golden and a fingerprint entry.
    const fp = readFingerprints(FIXTURES_DIR);
    const published = RULESETS.filter((rs) => rs.status === "published");
    expect(published.map((rs) => rs.ref)).toContain(PERFIDIA);
    for (const rs of published) {
      expect(report.goldens.some((g) => g.ref === rs.ref)).toBe(true);
      expect(fp[rs.ref]?.artefacts).toBe(report.fingerprints[rs.ref] ?? "");
      expect(Object.keys(fp[rs.ref]?.goldens ?? {}).length).toBeGreaterThan(0);
    }
    for (const g of report.goldens) expect(fp[g.ref]?.goldens[g.name]).toBe(g.finalHash ?? "");
  }, 60000);

  test("a tampered copy of the fixtures fails: a flipped result, then a deleted golden", async () => {
    const dir = fixturesCopy();
    try {
      const g = listGoldens(dir).find((x) => x.ref === PERFIDIA && x.name === "scenario-late");
      if (g === undefined) throw new Error("no scenario-late in the copy");
      const lines = readLog(g.path);
      const at = lines.findIndex((l) => l.k === "act" && l.r.ok);
      const act = lines[at];
      if (act?.k !== "act") throw new Error("no accepted action");
      writeFileSync(
        g.path,
        jsonlText(lines.with(at, { ...act, r: { ok: false, code: "QUEUE_FULL" } })),
      );
      // Only the golden tampered with is replayed: the first test replays them all.
      const late = (ref: string, name: string): boolean =>
        ref === PERFIDIA && name === "scenario-late";
      const flipped = await checkGoldens(dir, RULESETS, { levelG: false, only: late });
      expect(flipped.ok).toBe(false);
      expect(flipped.problems).toEqual([
        `golden ${PERFIDIA}/scenario-late: Level E: result divergence at t = ${act.t} (n ${act.n}): expected {"code":"QUEUE_FULL","ok":false}, got {"ok":true}`,
      ]);

      rmSync(g.path);
      const deleted = await checkGoldens(dir, RULESETS, { levelG: false, only: late });
      expect(deleted.ok).toBe(false);
      expect(deleted.problems).toEqual([
        `golden ${PERFIDIA}/scenario-late is recorded in ${FINGERPRINTS_FILE} but missing`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  test("a perfidia-1 descriptor whose cheat sheet changed fails", async () => {
    const original = getRuleset(PERFIDIA);
    const altered: AnyRuleset = {
      ...original,
      cheatSheet: (config, rules) => `${original.cheatSheet(config, rules)}\n`,
    };
    const rulesets = RULESETS.map((rs) => (rs.ref === PERFIDIA ? altered : rs));
    const report = await checkGoldens(FIXTURES_DIR, rulesets, { levelG: false, only: none });
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain(`${FINGERPRINTS_FILE}: ${PERFIDIA}'s artefacts changed`);
  }, 60000);

  test("a changed visibility hook, title or extra tool description fails", async () => {
    const perfidia = getRuleset(PERFIDIA);
    const sandbox = getRuleset(SANDBOX);
    const briefing = perfidia.hooks.visibility?.briefing;
    if (briefing === undefined) throw new Error("perfidia-1 has a briefing hook");
    // What the hooks show agents during a match: caught by the views of every perfidia-1 golden.
    const hooked: AnyRuleset = {
      ...perfidia,
      hooks: {
        ...perfidia.hooks,
        visibility: {
          ...perfidia.hooks.visibility,
          briefing: (r, seat) => ({ ...briefing(r, seat), x: 1 }),
        },
      },
    };
    // One perfidia-1 golden replayed is enough to see it (the first test replays them all).
    const views = await checkGoldens(FIXTURES_DIR, swap(hooked), {
      levelG: false,
      only: (ref, name) => ref === PERFIDIA && name === "rt-virtual-6p-1d",
    });
    expect(views.ok).toBe(false);
    expect(views.problems.length).toBeGreaterThan(0);
    for (const p of views.problems) {
      expect(p).toContain("what the ruleset's hooks show at its checkpoints changed");
    }
    const titled: AnyRuleset = { ...perfidia, title: `${perfidia.title} 2` };
    const title = await checkGoldens(FIXTURES_DIR, swap(titled), { levelG: false, only: none });
    expect(title.problems).toHaveLength(1);
    expect(title.problems[0]).toContain(`${FINGERPRINTS_FILE}: ${PERFIDIA}'s artefacts changed`);
    const [first, second] = sandbox.tools ?? [];
    if (first === undefined || second === undefined) throw new Error("sandbox-1 has two extras");
    const described: AnyRuleset = {
      ...sandbox,
      tools: [first, { ...second, description: `${second.description} ` }],
    };
    const tool = await checkGoldens(FIXTURES_DIR, swap(described), { levelG: false, only: none });
    expect(tool.problems).toHaveLength(1);
    expect(tool.problems[0]).toContain(`${FINGERPRINTS_FILE}: ${SANDBOX}'s artefacts changed`);
  }, 60000);
});

/** No golden replayed: the artefact fingerprints alone. */
const none = (): boolean => false;

/** The registry with `rs` in place of the ruleset of its ref. */
function swap(rs: AnyRuleset): AnyRuleset[] {
  return RULESETS.map((x) => (x.ref === rs.ref ? rs : x));
}

describe("what the goldens cover (§13.5)", () => {
  test("lockstep-6p-4d: the default config with the phase-1 bots, past capital immunity and the domination opening", () => {
    const lines = readLog(golden(PERFIDIA, "lockstep-6p-4d").path);
    const header = lines[0];
    if (header?.k !== "header") throw new Error("no header");
    expect(header.setup.overrides).toEqual({ "time.matchEnd": 345600 });
    expect(header.clock).toEqual({ kind: "lockstep", maxTurnsPerSecond: 3 });
    expect(new Set(Object.values(header.controllers))).toEqual(new Set(PHASE1_BOTS));
    const end = lines.at(-1);
    if (end?.k !== "end") throw new Error("no end line");
    expect(end.t).toBeGreaterThanOrEqual(259200);
    expect(evs(lines, "battle").length).toBeGreaterThan(0);
  });

  test(`lockstep-6p-4d-${FIGHT_6P}: the same match with the PR #7 default bots, sieges, conquests and an elimination played by bots`, () => {
    const lines = readLog(golden(PERFIDIA, `lockstep-6p-4d-${FIGHT_6P}`).path);
    const header = lines[0];
    if (header?.k !== "header") throw new Error("no header");
    expect(header.setup.overrides).toEqual({ "time.matchEnd": 345600 });
    expect(header.clock).toEqual({ kind: "lockstep", maxTurnsPerSecond: 3 });
    expect(new Set(Object.values(header.controllers))).toEqual(new Set(FIGHT_LABELS));
    const end = lines.at(-1);
    if (end?.k !== "end") throw new Error("no end line");
    expect(end.t).toBe(345600);
    expect(evs(lines, "battle").length).toBeGreaterThan(0);
    expect(evs(lines, "siege_started").length).toBeGreaterThan(0);
    expect(evs(lines, "city_conquered").length).toBeGreaterThan(0);
    expect(evs(lines, "player_eliminated").length).toBeGreaterThan(0);
  });

  for (const [what, labels, six] of [
    ["the PR #8 default bots", RELIEF_LABELS, RELIEF_6P],
    ["the default bots", DEFAULT_LABELS, BOTS_6P],
  ] as const) {
    test(`lockstep-6p-4d-${six}: the same match with ${what}, conquests, a siege relieved by bots and a domination countdown`, () => {
      const lines = readLog(golden(PERFIDIA, `lockstep-6p-4d-${six}`).path);
      const header = lines[0];
      if (header?.k !== "header") throw new Error("no header");
      expect(header.setup.overrides).toEqual({ "time.matchEnd": 345600 });
      expect(header.clock).toEqual({ kind: "lockstep", maxTurnsPerSecond: 3 });
      expect(new Set(Object.values(header.controllers))).toEqual(new Set(labels));
      const end = lines.at(-1);
      if (end?.k !== "end") throw new Error("no end line");
      expect(end.t).toBe(345600);
      expect(evs(lines, "siege_started").length).toBeGreaterThan(0);
      expect(evs(lines, "city_conquered").length).toBeGreaterThan(0);
      // A siege broken by a relief battle: won by the relief, in the same second and city.
      const won = evs(lines, "battle").filter(
        (l) => field(l, "kind") === "relief" && field(l, "winner") === "attacker",
      );
      const relieved = evs(lines, "siege_broken").filter(
        (b) =>
          field(b, "cause") === "relief" &&
          won.some((l) => l.t === b.t && field(l, "city") === field(b, "city")),
      );
      expect(relieved.length).toBeGreaterThan(0);
      expect(evs(lines, "domination_started").length).toBeGreaterThan(0);
    });
  }

  test("every bot golden of a default set of bots has their labels; the 12-seat ones fight on day 1", () => {
    for (const [labels, six, twelve] of [
      [FIGHT_LABELS, FIGHT_6P, FIGHT_12P],
      [RELIEF_LABELS, RELIEF_6P, RELIEF_12P],
      [DEFAULT_LABELS, BOTS_6P, BOTS_12P],
    ] as const) {
      for (const [ref, name] of [
        [PERFIDIA, `lockstep-12p-1d-${twelve}`],
        [PERFIDIA, `rt-virtual-6p-1d-${six}`],
        [SANDBOX, `lockstep-6p-3d-${six}`],
        [SANDBOX, `rt-virtual-6p-1d-${six}`],
      ] as const) {
        const header = readLog(golden(ref, name).path)[0];
        if (header?.k !== "header") throw new Error(`no header in ${name}`);
        expect(new Set(Object.values(header.controllers))).toEqual(new Set(labels));
      }
      const day1 = readLog(golden(PERFIDIA, `lockstep-12p-1d-${twelve}`).path);
      expect(evs(day1, "battle").length).toBeGreaterThan(0);
    }
  });

  test("rt-virtual-6p-1d: real time under VirtualTime, speed 3, latency 2–60 s", () => {
    for (const ref of [PERFIDIA, SANDBOX]) {
      for (const name of [
        "rt-virtual-6p-1d",
        `rt-virtual-6p-1d-${FIGHT_6P}`,
        `rt-virtual-6p-1d-${RELIEF_6P}`,
        `rt-virtual-6p-1d-${BOTS_6P}`,
      ]) {
        const header = readLog(golden(ref, name).path)[0];
        expect(header).toMatchObject({
          k: "header",
          clock: { kind: "realtime", speed: [3, 1], time: "virtual", latencyMs: [2000, 60000] },
        });
      }
    }
  });

  test("sandbox-1 lockstep-6p-3d runs past hill_open", () => {
    for (const name of [
      "lockstep-6p-3d",
      `lockstep-6p-3d-${FIGHT_6P}`,
      `lockstep-6p-3d-${RELIEF_6P}`,
      `lockstep-6p-3d-${BOTS_6P}`,
    ]) {
      const end = readLog(golden(SANDBOX, name).path).at(-1);
      if (end?.k !== "end") throw new Error("no end line");
      expect(end.t).toBeGreaterThan(172800);
    }
  });

  test("scenario-late: siege, relief, homecoming, capital conquest with re-homing, elimination, pact expiry and supersession, domination start, cancel and win", () => {
    const lines = readLog(golden(PERFIDIA, "scenario-late").path);
    const header = lines[0];
    if (header?.k !== "header") throw new Error("no header");
    expect(new Set(Object.values(header.controllers))).toEqual(new Set([SCENARIO_LATE_LABEL]));

    expect(evs(lines, "siege_started").length).toBeGreaterThanOrEqual(1);
    const kinds = evs(lines, "battle").map((l) => field(l, "kind"));
    expect(kinds).toContain("relief");
    expect(kinds).toContain("homecoming");
    expect(evs(lines, "incoming_attack").some((l) => field(l, "homecoming") === true)).toBe(true);
    // The siege held through both: no siege was broken.
    expect(evs(lines, "siege_broken")).toEqual([]);
    expect(evs(lines, "player_eliminated").length).toBeGreaterThanOrEqual(1);
    expect(evs(lines, "pact_expired").length).toBeGreaterThanOrEqual(1);
    expect(evs(lines, "pact_ended").map((l) => field(l, "cause"))).toContain("superseded");

    // A capital conquered from a player who keeps another city: units of the former owner homed in
    // the capital and stationed elsewhere are re-homed to its fallback city (its oldest city left).
    const eliminated = new Set(evs(lines, "player_eliminated").map((l) => field(l, "player")));
    const conquest = evs(lines, "city_conquered").find((l) => {
      const city = String(field(l, "city"));
      const from = field(l, "from");
      return /^c[1-6]$/.test(city) && typeof from === "string" && !eliminated.has(from);
    });
    if (conquest === undefined) throw new Error("no capital conquered from a surviving player");
    const capital = String(field(conquest, "city"));
    const owner = String(field(conquest, "from"));
    const groups = (state: {
      cities: Readonly<Record<string, { stationed: readonly { owner: string; home: string }[] }>>;
    }): string[] =>
      Object.entries(state.cities).flatMap(([id, c]) =>
        c.stationed.filter((g) => g.owner === owner).map((g) => `${g.home}@${id}`),
      );
    let before: string[] = [];
    let after: string[] = [];
    let fallback: string | null = null;
    let seen = false;
    const report = verifyLog(lines, {
      onLine: (line, r) => {
        if (line === conquest) {
          seen = true;
          const own = Object.values(r.state.cities)
            .filter((c) => c.owner === owner)
            .map((c) => c.id)
            .toSorted((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
          fallback = own[0] ?? null;
        }
        if (!seen) before = groups(r.state);
        else after = groups(r.state);
      },
    });
    expect(report.ok).toBe(true);
    expect(fallback).not.toBeNull();
    const abroad = before.filter((g) => g.startsWith(`${capital}@`));
    expect(abroad.length).toBeGreaterThan(0);
    expect(after.filter((g) => g.startsWith(`${capital}@`))).toEqual([]);
    for (const g of abroad) expect(after).toContain(g.replace(`${capital}@`, `${fallback}@`));

    // Domination: a countdown starts, is cancelled, and a later one wins.
    const started = evs(lines, "domination_started");
    const cancelled = evs(lines, "domination_cancelled");
    expect(started.length).toBeGreaterThanOrEqual(2);
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
    const firstStart = started[0];
    const lastStart = started.at(-1);
    const cancel = cancelled[0];
    if (firstStart === undefined || lastStart === undefined || cancel === undefined)
      throw new Error("unreachable");
    expect(field(cancel, "key")).toBe(field(firstStart, "key"));
    expect(cancel.t).toBeGreaterThanOrEqual(firstStart.t);
    expect(lastStart.t).toBeGreaterThanOrEqual(cancel.t);
    const end = lines.at(-1);
    if (end?.k !== "end") throw new Error("no end line");
    expect(end.result.reason).toBe("domination");
    expect(end.result.winners as unknown).toEqual(field(lastStart, "members"));
    expect(end.t).toBe(Number(field(lastStart, "endsAt")));
  });

  test("the scenario agent still plays scenario-late byte for byte", async () => {
    const lines = readLog(golden(PERFIDIA, "scenario-late").path);
    const again = await runScenarioLate();
    expect(normalisedText(again.lines)).toBe(normalisedText(lines));
  });
});
