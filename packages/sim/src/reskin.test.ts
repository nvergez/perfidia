// The reskin of perfidia-1@1.1.0 (docs/rulesets/perfidia-1.md §0.1) changes ids, not mechanics:
// the actions of 1.0.0's bot goldens, every id renamed, replayed under 1.1.0 with domination off
// (the one rule 1.1.0 changes besides the score's Olympus term, which none of these matches
// reaches) give the same events, mapped back to 1.0.0's ids, as the goldens record, and every
// action the same result.

import { describe, expect, test } from "bun:test";
import { createMatch, getRuleset } from "@perfidia/engine";
import {
  JsonObjectSchema,
  type DomainEvent,
  type LogLine,
  type MatchSetup,
} from "@perfidia/protocol";
import { FIXTURES_DIR } from "./golden/index.ts";
import { listGoldens, readLog } from "./harness/index.ts";

const P11 = getRuleset("perfidia-1@1.1.0");

/** 1.0.0 id → 1.1.0 id, for the ids that change. */
const TO_11: ReadonlyMap<string, string> = new Map([
  ["hall", "acropolis"],
  ["lumber", "sawmill"],
  ["mine", "goldmine"],
  ["guard", "hoplite"],
  ["raider", "peltast"],
  ["warship", "trireme"],
  ["crown", "olympus"],
  ["crownBonus", "olympusBonus"],
]);
const TO_10: ReadonlyMap<string, string> = new Map([...TO_11].map(([a, b]) => [b, a]));
/** The 1.0.0 ids 1.1.0 renamed: none may appear in what 1.1.0 emits. */
const OLD_IDS = [...TO_11.keys()];

/** A JSON value with ids renamed by `map`, in keys and in string values. */
function rename(v: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof v === "string") return map.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => rename(x, map));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [map.get(k) ?? k, rename(x, map)]));
  }
  return v;
}

const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/** What an event says, without its place in the hash chain. */
const said = (e: DomainEvent): unknown =>
  plain({ t: e.t, type: e.type, public: e.public, to: e.to, data: e.data });

const DOMINATION = /^domination_/;

/** Replays the act lines of a 1.0.0 log under 1.1.0 (ids renamed, domination off). */
function replay11(lines: readonly LogLine[]): {
  events: unknown[];
  results: unknown[];
  stale: string[];
  end: unknown;
} {
  const header = lines[0];
  if (header?.k !== "header") throw new Error("no header");
  const matchEnd = JsonObjectSchema.parse(header.config["time"])["matchEnd"];
  if (typeof matchEnd !== "number") throw new Error("no matchEnd");
  const overrides = JsonObjectSchema.parse(rename(header.setup.overrides, TO_11));
  const setup: MatchSetup = {
    ...header.setup,
    ruleset: P11.ref,
    overrides: { ...overrides, "time.dominationStart": matchEnd + 1 },
  };
  const match = createMatch(setup, P11, { invariants: "checkpoint" });
  const events: unknown[] = [];
  const results: unknown[] = [];
  const stale: string[] = [];
  const keep = (es: readonly DomainEvent[]): void => {
    for (const e of es) {
      if (DOMINATION.test(e.type)) continue;
      // Renaming back must not hide a 1.0.0 id that 1.1.0 itself emitted.
      const text = JSON.stringify(said(e));
      for (const old of OLD_IDS) if (text.includes(`"${old}"`)) stale.push(`${e.type}: ${old}`);
      events.push(rename(said(e), TO_10));
    }
  };
  for (const line of lines) {
    if (line.k !== "act") continue;
    keep(match.advanceTo(line.t).events);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a renamed copy of a logged action
    const out = match.apply(line.seat, rename(line.a, TO_11) as typeof line.a);
    results.push(out.ok ? { ok: true } : { ok: false, code: out.violation.code });
    if (out.ok) keep(out.events);
  }
  const end = lines.at(-1);
  if (end?.k !== "end") throw new Error("no end line");
  keep(match.advanceTo(end.t).events);
  return {
    events,
    results,
    stale,
    end:
      match.result === null
        ? null
        : plain({ reason: match.result.reason, winners: match.result.winners }),
  };
}

describe("1.0.0's bot goldens replayed under 1.1.0", () => {
  for (const name of ["lockstep-6p-4d", "lockstep-12p-1d", "lockstep-6p-6d-war"]) {
    test(`${name}: the same events and action results, ids renamed`, () => {
      const golden = listGoldens(FIXTURES_DIR).find(
        (g) => g.ref === "perfidia-1@1.0.0" && g.name === name,
      );
      if (golden === undefined) throw new Error(`no golden ${name}`);
      const lines = readLog(golden.path);
      const again = replay11(lines);
      const recorded = lines.flatMap((l) =>
        l.k === "ev" && !DOMINATION.test(l.e.type) ? [said(l.e)] : [],
      );
      const results = lines.flatMap((l) =>
        l.k === "act" ? [l.r.ok ? { ok: true } : { ok: false, code: l.r.code }] : [],
      );
      expect(again.stale).toEqual([]);
      expect(again.results.length).toBe(results.length);
      expect(again.results).toEqual(results);
      expect(again.events.length).toBe(recorded.length);
      expect(again.events).toEqual(recorded);
      const end = lines.at(-1);
      if (end?.k !== "end") throw new Error("no end line");
      expect(end.result.reason).toBe("time");
      expect(again.end).toEqual({ reason: end.result.reason, winners: end.result.winners });
    }, 60000);
  }
});
