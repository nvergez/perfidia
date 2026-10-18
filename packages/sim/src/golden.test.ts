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
import { CityIdSchema, PlayerIdSchema, type EvLine, type LogLine } from "@perfidia/protocol";
import { Perfidia11ExtSchema, type Perfidia11Ext } from "@perfidia/engine/rulesets/perfidia-1";
import { parseWar } from "@perfidia/bots";
import { teamRecords } from "./batch/index.ts";
import { SCENARIO_LATE_LABEL, runScenarioLate } from "./exit/scenario.ts";
import { SCENARIO_R1_LABEL, SCENARIO_R1_OVERRIDES, runScenarioR1 } from "./exit/scenario_r1.ts";
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
const P11 = "perfidia-1@1.1.0";
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
    // perfidia-1@1.1.0 has the same bot goldens, for the default bots of its release, and the
    // scripted `scenario-r1`.
    expect(report.goldens.map((g) => `${g.ref}/${g.name} ${g.levelG}`)).toEqual([
      `${PERFIDIA}/lockstep-12p-1d-${RELIEF_12P} pass`,
      `${PERFIDIA}/lockstep-12p-1d-${BOTS_12P} pass`,
      `${PERFIDIA}/lockstep-12p-1d-${FIGHT_12P} pass`,
      `${PERFIDIA}/lockstep-12p-1d pass`,
      `${PERFIDIA}/lockstep-6p-4d-${FIGHT_6P} pass`,
      `${PERFIDIA}/lockstep-6p-4d-${RELIEF_6P} pass`,
      `${PERFIDIA}/lockstep-6p-4d-${BOTS_6P} pass`,
      `${PERFIDIA}/lockstep-6p-4d pass`,
      `${PERFIDIA}/lockstep-6p-6d-war pass`,
      `${PERFIDIA}/rt-virtual-6p-1d-${FIGHT_6P} pass`,
      `${PERFIDIA}/rt-virtual-6p-1d-${RELIEF_6P} pass`,
      `${PERFIDIA}/rt-virtual-6p-1d-${BOTS_6P} pass`,
      `${PERFIDIA}/rt-virtual-6p-1d pass`,
      `${PERFIDIA}/scenario-late skipped`,
      `${P11}/lockstep-12p-1d pass`,
      `${P11}/lockstep-6p-4d pass`,
      `${P11}/lockstep-6p-6d-war pass`,
      `${P11}/rt-virtual-6p-1d pass`,
      `${P11}/scenario-r1 skipped`,
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
    expect(published.map((rs) => rs.ref)).toEqual([PERFIDIA, P11]);
    for (const rs of published) {
      expect(report.goldens.some((g) => g.ref === rs.ref)).toBe(true);
      expect(fp[rs.ref]?.artefacts).toBe(report.fingerprints[rs.ref] ?? "");
      expect(Object.keys(fp[rs.ref]?.goldens ?? {}).length).toBeGreaterThan(0);
    }
    for (const g of report.goldens) expect(fp[g.ref]?.goldens[g.name]).toBe(g.finalHash ?? "");
  }, 240000);

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

  // The default bots of this build take no city in these four days (their sieges are all relieved):
  // `lockstep-6p-6d-war` records conquests by them.
  for (const [what, labels, six, conquest] of [
    ["the PR #8 default bots", RELIEF_LABELS, RELIEF_6P, true],
    ["the default bots", DEFAULT_LABELS, BOTS_6P, false],
  ] as const) {
    test(`lockstep-6p-4d-${six}: the same match with ${what}, sieges${conquest ? ", conquests" : ""}, a siege relieved by bots and a domination countdown`, () => {
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
      expect(evs(lines, "city_conquered").length > 0).toBe(conquest);
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

  test("lockstep-6p-6d-war: the war-call bots allied: calls, yes answers kept, a joint attack after a call, a held conquest", () => {
    const lines = readLog(golden(PERFIDIA, "lockstep-6p-6d-war").path);
    const header = lines[0];
    if (header?.k !== "header") throw new Error("no header");
    expect(header.setup.overrides).toEqual({ "time.matchEnd": 518400 });
    expect(header.controllers).toEqual({
      p1: "bot:conqueror@3",
      p2: "bot:opportunist@3",
      p3: "bot:turtle@3",
      p4: "bot:conqueror@3",
      p5: "bot:expander@2",
      p6: "bot:rusher@3",
    });
    const war = lines.flatMap((l) =>
      l.k === "act" && l.r.ok && l.a.type === "send_message" && l.a.text.includes("WAR#")
        ? parseWar(l.a.text).map((item) => ({ seat: l.seat, item }))
        : [],
    );
    const roles = new Set(war.flatMap((w) => (w.item.kind === "call" ? [w.item.call.role] : [])));
    expect(roles).toEqual(new Set(["strike", "siege"]));
    // conqueror@3 answers yes to an opportunist@3's strike, turtle@3 to a conqueror@3's siege.
    const yes = new Set(
      war.flatMap((w) => (w.item.kind === "ack" && w.item.ack.yes ? [w.seat] : [])),
    );
    expect(yes).toEqual(new Set(["p1", "p3"]));
    expect(teamRecords(lines, null).joint.some((j) => j.caller !== null)).toBe(true);
    const conquests = evs(lines, "city_conquered");
    expect(conquests.length).toBeGreaterThan(0);
    // An ally of the conqueror holds its conquest: a support of another seat lands in the city.
    const supports = lines.flatMap((l) =>
      l.k === "act" && l.r.ok && l.a.type === "support"
        ? [{ seat: l.seat, t: l.t, to: l.a.to }]
        : [],
    );
    const held = supports.some((x) =>
      conquests.some((c) => field(c, "city") === x.to && field(c, "to") !== x.seat && c.t <= x.t),
    );
    expect(held).toBe(true);
  });

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

/** The conquest records of a 1.1.0 match after `line`, from a replay of its log. */
function conquestsAt(
  lines: readonly LogLine[],
  at: (line: LogLine) => boolean,
): Map<LogLine, Perfidia11Ext["conquests"]> {
  const out = new Map<LogLine, Perfidia11Ext["conquests"]>();
  const report = verifyLog(lines, {
    onLine: (line, r) => {
      if (at(line)) out.set(line, Perfidia11ExtSchema.parse(r.ext()).conquests);
    },
  });
  expect(report.ok).toBe(true);
  return out;
}

describe("what the perfidia-1@1.1.0 goldens cover (§13.5)", () => {
  test("the bot goldens: the default bots of this build, the renamed ids, no countdown without conquests", () => {
    for (const name of ["lockstep-6p-4d", "lockstep-12p-1d", "rt-virtual-6p-1d"]) {
      const lines = readLog(golden(P11, name).path);
      const header = lines[0];
      if (header?.k !== "header") throw new Error(`no header in ${name}`);
      expect(header.setup.ruleset).toBe(P11);
      expect(new Set(Object.values(header.controllers))).toEqual(new Set(DEFAULT_LABELS));
      expect(Object.keys(header.config["buildings"] ?? {})).toContain("acropolis");
      const units = Object.keys(header.config["units"] ?? {});
      for (const unit of ["hoplite", "peltast", "trireme"]) expect(units).toContain(unit);
      for (const old of ["hall", "lumber", "mine", "guard", "raider", "warship", "crown"]) {
        expect(JSON.stringify(header.config)).not.toContain(`"${old}"`);
      }
    }
    const four = readLog(golden(P11, "lockstep-6p-4d").path);
    expect(four[0]).toMatchObject({ setup: { overrides: { "time.matchEnd": 345600 } } });
    const end = four.at(-1);
    if (end?.k !== "end") throw new Error("no end line");
    expect(end.t).toBe(345600);
    expect(evs(four, "siege_started").length).toBeGreaterThan(0);
    // Domination opens at the start of day 4 (259200), the last second a countdown could still end
    // by this match's end (345600), and a bloc that took no city cannot start one (§13.3).
    expect(evs(four, "city_conquered")).toEqual([]);
    expect(evs(four, "domination_started")).toEqual([]);
    expect(readLog(golden(P11, "rt-virtual-6p-1d").path)[0]).toMatchObject({
      clock: { kind: "realtime", speed: [3, 1], time: "virtual", latencyMs: [2000, 60000] },
    });
  });

  test("lockstep-6p-6d-war: the war-call bots take cities, and a pair wins by domination by conquest", () => {
    const lines = readLog(golden(P11, "lockstep-6p-6d-war").path);
    const header = lines[0];
    if (header?.k !== "header") throw new Error("no header");
    expect(header.setup.overrides).toEqual({ "time.matchEnd": 518400 });
    expect(header.controllers).toEqual({
      p1: "bot:conqueror@3",
      p2: "bot:opportunist@3",
      p3: "bot:turtle@3",
      p4: "bot:conqueror@3",
      p5: "bot:expander@2",
      p6: "bot:rusher@3",
    });
    const conquests = evs(lines, "city_conquered");
    expect(conquests.length).toBeGreaterThanOrEqual(3);
    const records = conquestsAt(lines, (l) => l.k === "ev" && conquests.includes(l));
    let taken = 0;
    for (const c of conquests) {
      const city = CityIdSchema.parse(field(c, "city"));
      const to = PlayerIdSchema.parse(field(c, "to"));
      const record = records.get(c)?.[city];
      expect(record?.by).toBe(to);
      if (record?.former.includes(to) === false) taken += 1;
    }
    expect(taken).toBeGreaterThanOrEqual(2);
    // The countdown of a bloc holding the threshold (16 cities at N = 6) with 2 taken cities, held
    // for 24 h: the match ends by domination before day 6 is over.
    const started = evs(lines, "domination_started");
    const win = started.at(-1);
    if (win === undefined) throw new Error("no countdown");
    expect(Number(field(win, "threshold"))).toBe(16);
    expect(Number(field(win, "needTaken"))).toBe(2);
    expect(Number(field(win, "taken"))).toBeGreaterThanOrEqual(2);
    expect(Number(field(win, "cities"))).toBeGreaterThanOrEqual(16);
    const end = lines.at(-1);
    if (end?.k !== "end") throw new Error("no end line");
    expect(end.result.reason).toBe("domination");
    expect(end.result.winners as unknown).toEqual(field(win, "members"));
    expect(end.t).toBe(Number(field(win, "endsAt")));
    expect(end.t).toBeLessThan(518400);
  }, 60000);

  test("scenario-r1: no countdown at one city taken, one at two, cancelled by a recapture, a win after Olympus is taken", () => {
    const lines = readLog(golden(P11, "scenario-r1").path);
    const header = lines[0];
    if (header?.k !== "header") throw new Error("no header");
    expect(new Set(Object.values(header.controllers))).toEqual(new Set([SCENARIO_R1_LABEL]));
    expect(header.setup.overrides).toEqual(SCENARIO_R1_OVERRIDES);
    const conquests = evs(lines, "city_conquered");
    expect(conquests.map((l) => [l.t, field(l, "city"), field(l, "from"), field(l, "to")])).toEqual(
      [
        [11400, "c4", "p4", "p1"],
        [12000, "c5", "p5", "p2"],
        [22200, "c4", "p1", "p4"],
        [29800, "c7", null, "p1"],
      ],
    );
    const started = evs(lines, "domination_started");
    expect(
      started.map((l) => [l.t, field(l, "members"), field(l, "taken"), field(l, "needTaken")]),
    ).toEqual([
      [12000, ["p1", "p2"], 2, 2],
      [29800, ["p1", "p2"], 2, 2],
    ]);
    expect(
      evs(lines, "domination_cancelled").map((l) => [l.t, field(l, "key"), field(l, "reason")]),
    ).toEqual([[22200, "a1", "condition"]]);
    const end = lines.at(-1);
    if (end?.k !== "end") throw new Error("no end line");
    expect(end.result.reason).toBe("domination");
    expect(end.result.winners as unknown).toEqual(["p1", "p2"]);
    expect(started.map((l) => field(l, "key"))).toEqual(["a1", "a1"]);
    const win = started.at(-1);
    if (win === undefined) throw new Error("no countdown");
    expect(end.t).toBe(Number(field(win, "endsAt")));
    // The recapture is recorded with its former owners, so c4 is not a taken city of p4.
    const last = conquests.at(-1);
    if (last === undefined) throw new Error("unreachable");
    const records = conquestsAt(lines, (l) => l === last).get(last);
    expect(records?.["c4"]).toEqual({ by: "p4", former: ["p1", "p4"] });
    expect(records?.["c5"]).toEqual({ by: "p2", former: ["p5"] });
    expect(records?.["c7"]).toEqual({ by: "p1", former: [] });
  });

  test("the scenario agent still plays scenario-r1 byte for byte", async () => {
    const lines = readLog(golden(P11, "scenario-r1").path);
    const again = await runScenarioR1();
    expect(normalisedText(again.lines)).toBe(normalisedText(lines));
  });
});
