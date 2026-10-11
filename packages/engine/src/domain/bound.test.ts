// The top barrel's bound API (docs/architecture.md §5.3, §15 T10): `createMatch`, `loadMatch` and
// `verifyLog` with the default domain module filled in, and the groups the barrel re-exports.

import { describe, expect, test } from "bun:test";
import * as engine from "@perfidia/engine";
import { verifyLog as kernelVerifyLog } from "@perfidia/engine/kernel";
import { LogRecorder, fakeDomain } from "@perfidia/engine/testing";
import type { AnyRuleset } from "@perfidia/engine/contracts";
import { ACTION_TYPES, ProposalIdSchema, type LogLine } from "@perfidia/protocol";
import { domain } from "./index.ts";
import { FIXTURE, RICH, setupOf } from "./fixtures.test.ts";

const resolve = (ref: string): AnyRuleset | undefined =>
  ref === FIXTURE.ref ? FIXTURE : ref === RICH.ref ? RICH : undefined;

/** A recorded match of the rich ruleset: builds, recruits, a raid, a shipment, diplomacy. */
function recorded(): LogRecorder {
  const m = engine.createMatch(setupOf(RICH, 3, 9), RICH, { invariants: "step" });
  const rec = new LogRecorder(m, { snapshotEvery: 2 });
  rec.act("p1", { type: "build", city: "c1", building: "tower" });
  rec.act("p1", { type: "recruit", city: "c1", unit: "soldier", count: 3 });
  rec.act("p2", { type: "send_message", to: ["p1"], text: "hello" });
  rec.act("p3", { type: "propose", to: "p1", kind: "pact", name: null, text: "", until: null });
  rec.advanceTo(1800);
  const proposal = ProposalIdSchema.parse(Object.keys(m.read().state.proposals)[0]);

  rec.act("p1", { type: "answer", proposal, accept: true });
  rec.act("p1", { type: "attack", from: "c1", to: "c3", units: { soldier: 4 } });
  rec.act("p1", { type: "build", city: "c1", building: "castle" });
  rec.advanceTo(9000);
  rec.act("p2", {
    type: "send_resources",
    from: "c2",
    to: "c1",
    res: { wood: 20, stone: 0, gold: 0 },
  });
  rec.end();
  return rec;
}

describe("the bound API", () => {
  test("createMatch runs the default domain module", () => {
    const m = engine.createMatch(setupOf(RICH), RICH, { invariants: "step" });
    const out = m.apply("p1", { type: "build", city: "c1", building: "tower" });
    expect(out.ok && out.data).toMatchObject({ item: 1, level: 2, end: [2000, "D1 00:33:20"] });
  });

  test("verifyLog replays a log of the default domain with zero divergence", () => {
    const rec = recorded();
    const report = engine.verifyLog(rec.lines, resolve);
    expect(report.divergence).toBeUndefined();
    expect(report).toMatchObject({ ok: true, actions: 8 });
    expect(report.finalHash).toBe(rec.match.hash());
    // The fake domain of the testing kit replays it differently: the binding matters.
    expect(kernelVerifyLog(rec.lines, resolve, fakeDomain).ok).toBe(false);
    // A tampered action is reported at its line.
    const tampered: LogLine[] = [...rec.lines];
    const i = tampered.findIndex((line) => line.k === "act" && line.n === 2);
    const line = tampered[i];
    if (line?.k !== "act") throw new Error("no act line 2");
    tampered[i] = { ...line, a: { type: "recruit", city: "c1", unit: "soldier", count: 500 } };
    const bad = engine.verifyLog(tampered, resolve);
    expect(bad.ok).toBe(false);
    expect(bad.divergence?.n).toBe(2);
  });

  test("verifyLog and loadMatch resume from a snapshot", () => {
    const rec = recorded();
    const snap = rec.snapshots[0];
    if (snap === undefined) throw new Error("no snapshot");
    expect(engine.verifyLog(rec.lines, resolve, { from: snap }).ok).toBe(true);
    const loaded = engine.loadMatch(snap, RICH, { invariants: "step" });
    expect(loaded.hash()).toBe(snap.hash);
    loaded.advanceTo(loaded.rules.time.matchEnd);
    expect(loaded.ended).toBe(true);
  });

  test("the barrel exports core, contracts, kernel, std and domain", () => {
    expect(engine.domain).toBe(domain);
    expect(typeof engine.canonicalJson).toBe("function");
    expect(typeof engine.resolveConfig).toBe("function");
    expect(typeof engine.stockAt).toBe("function");
    expect(typeof engine.recruitMax).toBe("function");
    expect(engine.ENGINE_VERSION).toBe("0.1.0");
    expect("ENGINE_PACKAGE" in engine).toBe(false);
    expect(Object.keys(engine.domain.actions)).toEqual(ACTION_TYPES.filter((t) => t !== "ext"));
    expect(Object.keys(engine.domain.events)).toEqual([
      "build_done",
      "recruit_done",
      "proposal_expire",
      "pact_expire",
    ]);
    expect(Object.keys(engine.domain.arrivals)).toEqual(["support", "shipment", "found", "return"]);
  });

  test("the domain module holds no mutable shared object (§6.5 rule 6)", () => {
    const shared: [string, unknown][] = [
      ["domain", domain],
      ["domain.actions", domain.actions],
      ["domain.events", domain.events],
      ["domain.arrivals", domain.arrivals],
      ["domain.invariants", domain.invariants],
      ...Object.entries(domain.actions).map(([k, h]): [string, unknown] => [`actions.${k}`, h]),
      ...engine.diplomacyInvariants.map((inv): [string, unknown] => [inv.name, inv]),
    ];
    expect(shared.filter(([, v]) => !Object.isFrozen(v)).map(([k]) => k)).toEqual([]);
  });
});
