import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@perfidia/engine/core";
import { fakeDomain, fixtureMatch, fixtureRuleset } from "@perfidia/engine/testing";
import type { Action, CityId, Json, PlayerId, Snapshot } from "@perfidia/protocol";
import fc from "fast-check";
import { SnapshotMismatch, loadMatch, stateHash, type Match } from "./index.ts";

const OVERRIDES: Record<string, Json> = {
  "time.travel": 4000,
  "start.soldiers": 12,
  "time.matchEnd": 43200,
};

function mismatch(snap: Snapshot): SnapshotMismatch {
  try {
    loadMatch(snap, fixtureRuleset, fakeDomain, { invariants: "step" });
  } catch (error) {
    if (error instanceof SnapshotMismatch) return error;
    throw error;
  }
  throw new Error("expected a SnapshotMismatch");
}

function copy(snap: Snapshot): Snapshot {
  return structuredClone(snap);
}

describe("snapshots (§10.3)", () => {
  test("a snapshot is a canonical copy that round-trips with its hash", () => {
    const m = fixtureMatch({ overrides: OVERRIDES });
    m.apply("p1", { type: "attack", from: "c1", to: "c2", units: { soldier: 2 } });
    m.advanceTo(3600);
    const snap = m.snapshot(17);
    expect(snap).toMatchObject({
      format: "perfidia-snapshot/1",
      engine: "0.1.0",
      hour: 1,
      t: 3600,
      afterN: 17,
    });
    expect(snap.hash).toBe(m.hash());
    expect(stateHash(snap.state)).toBe(snap.hash);
    const loaded = loadMatch(snap, fixtureRuleset, fakeDomain);
    expect(loaded.hash()).toBe(snap.hash);
    expect(loaded.now).toBe(3600);
    expect(loaded.configHash).toBe(m.configHash);
    expect(loaded.rulesHash).toBe(m.rulesHash);
    snap.state.now = 1;
    expect(loaded.hash()).toBe(m.hash());
    expect(() => m.snapshot(-1)).toThrow();
  });

  test("loading checks the ref, both hashes, the state, ext and the hash", () => {
    const m = fixtureMatch({ overrides: OVERRIDES });
    m.advanceTo(7200);
    const snap = m.snapshot(0);

    const ref = copy(snap);
    ref.setup.ruleset = "fixture-1@1.0.1";
    expect(mismatch(ref).field).toBe("ruleset");
    const stateRef = copy(snap);
    stateRef.state.ruleset = "fixture-1@2.0.0";
    expect(mismatch(stateRef).field).toBe("ruleset");

    const config = copy(snap);
    config.configHash = "0".repeat(64);
    expect(mismatch(config).field).toBe("configHash");
    const overrides = copy(snap);
    overrides.setup.overrides["time.travel"] = 4001;
    expect(mismatch(overrides).field).toBe("configHash");
    const badOverride = copy(snap);
    badOverride.setup.overrides["time.nope"] = 1;
    expect(mismatch(badOverride).field).toBe("config");

    const rules = copy(snap);
    rules.rulesHash = "f".repeat(64);
    expect(mismatch(rules).field).toBe("rulesHash");

    const ext = copy(snap);
    ext.state.ext = { opened: "yes" };
    expect(mismatch(ext).field).toBe("ext");

    const hash = copy(snap);
    hash.hash = "0123456789abcdef";
    expect(mismatch(hash).field).toBe("hash");
    const edited = copy(snap);
    const c1 = edited.state.cities["c1"];
    if (c1 !== undefined) c1.name = "Moved";
    expect(mismatch(edited).field).toBe("hash");

    const state = copy(snap);
    state.state.seq = -1;
    expect(mismatch(state).field).toBe("state");
    const format = copy(snap);
    Reflect.set(format, "format", "perfidia-snapshot/0");
    expect(mismatch(format).field).toBe("format");
    const hour = copy(snap);
    hour.hour = 1;
    expect(mismatch(hour).field).toBe("hour");
  });
});

describe("P6: snapshot round trip and resume", () => {
  const step = fc.oneof(
    fc.record({
      kind: fc.constant("act" as const),
      seat: fc.constantFrom<PlayerId>("p1", "p2", "p3"),
      pick: fc.nat({ max: 5 }),
      n: fc.integer({ min: 1, max: 5 }),
    }),
    fc.record({ kind: fc.constant("wait" as const), dt: fc.integer({ min: 0, max: 5000 }) }),
  );

  function play(
    m: Match,
    steps: readonly (typeof step extends fc.Arbitrary<infer T> ? T : never)[],
  ): string[] {
    const log: string[] = [];
    for (const s of steps) {
      if (s.kind === "wait") {
        log.push(canonicalJson(m.advanceTo(m.now + s.dt)));
        continue;
      }
      const own: CityId = s.seat === "p1" ? "c1" : s.seat === "p2" ? "c2" : "c3";
      const foe = s.seat === "p1" ? "c2" : "c1";
      const actions: Action[] = [
        { type: "build", city: own, building: "tower" },
        { type: "recruit", city: own, unit: "soldier", count: s.n },
        { type: "attack", from: own, to: foe, units: { soldier: s.n } },
        { type: "send_message", to: "all", text: `n${s.n}` },
        { type: "spy", from: own, to: foe, gold: 10 * s.n },
        {
          type: "propose",
          to: s.seat === "p1" ? "p2" : "p1",
          kind: "pact",
          name: null,
          text: "",
          until: null,
        },
      ];
      const action = actions[s.pick];
      if (action !== undefined) log.push(canonicalJson(m.apply(s.seat, action)));
    }
    return log;
  }

  test("resuming from a checkpoint snapshot equals the uninterrupted run, with overrides", () => {
    fc.assert(
      fc.property(
        fc.array(step, { maxLength: 15 }),
        fc.array(step, { maxLength: 15 }),
        fc.integer({ min: 1, max: 6 }),
        (before, after, hour) => {
          const whole = fixtureMatch({ players: 3, overrides: OVERRIDES });
          play(whole, before);
          const t = Math.max(whole.now, hour * 3600);
          const boundary = Math.ceil(t / 3600) * 3600;
          whole.advanceTo(boundary);
          const snap = whole.snapshot(0);
          expect(loadMatch(snap, fixtureRuleset, fakeDomain).hash()).toBe(whole.hash());
          const resumed = loadMatch(snap, fixtureRuleset, fakeDomain, { invariants: "step" });
          const a = play(whole, after);
          const b = play(resumed, after);
          expect(b).toEqual(a);
          whole.advanceTo(43200);
          resumed.advanceTo(43200);
          expect(resumed.hash()).toBe(whole.hash());
          expect(resumed.result).toEqual(whole.result);
        },
      ),
      { numRuns: 60 },
    );
  });
});
