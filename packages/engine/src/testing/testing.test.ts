import { describe, expect, test } from "bun:test";
import { fmt } from "@perfidia/engine/core";
import { checkRules, resolveConfig } from "@perfidia/engine/kernel";
import type { AnyRuleset } from "@perfidia/engine/contracts";
import { MovementIdSchema, ProposalIdSchema, TOOL_NAMES, z } from "@perfidia/protocol";
import {
  FIXTURE_DEFAULTS,
  FixtureConfigSchema,
  LogRecorder,
  addAlliance,
  addBuildItem,
  addCity,
  addMovement,
  addPact,
  addProposal,
  addRecruitBatch,
  addStationed,
  fixtureMatch,
  fixtureRules,
  fixtureRuleset,
  fixtureState,
  matchFromState,
  testStep,
} from "./index.ts";

describe("the fixture ruleset", () => {
  test("its defaults parse and its compiled rules pass the generic checks for every N", () => {
    expect(FixtureConfigSchema.safeParse(FIXTURE_DEFAULTS).success).toBe(true);
    for (const n of [2, 3, 4]) expect(checkRules(fixtureRules(n))).toEqual([]);
  });

  test("it has a timer, a non-empty ext, an intel event, error samples and two extra tools", () => {
    const keys = Object.keys(fixtureRuleset.eventSchemas);
    for (const e of fixtureRuleset.intelEvents ?? []) expect(keys).toContain(e);
    expect(fixtureRuleset.intelEvents).toEqual(["fixture_scouted"]);
    for (const code of Object.keys(fixtureRuleset.errors)) {
      const sample = fixtureRuleset.errorSamples.find((s) => s.code === code);
      expect(sample).toBeDefined();
      if (sample === undefined) continue;
      const words = fixtureRuleset.errors[code]?.(sample, fmt);
      expect(words).toEqual({
        message: "Renaming is closed until D1 02:00.",
        hint: "Try again at D1 02:00 or later.",
      });
    }
    const tools = fixtureRuleset.tools ?? [];
    expect(tools.map((t) => [t.name, t.kind])).toEqual([
      ["fixture_status", "read"],
      ["fixture_rename", "write"],
    ]);
    const builtIn: readonly string[] = TOOL_NAMES;
    for (const t of tools) {
      expect(builtIn).not.toContain(t.name);
      expect(z.toJSONSchema(t.args)).toMatchObject({ type: "object" });
    }
    expect(fixtureRuleset.hooks.actions?.ext).toBeDefined();
  });

  test("its cheat sheet is rendered from the config", () => {
    const resolved = resolveConfig(fixtureRuleset, { "time.travel": 7200 });
    if (!resolved.ok) throw new Error("rejected");
    const sheet = fixtureRuleset.cheatSheet(resolved.config, fixtureRules());
    expect(sheet).toContain("2h between islands");
    expect(fixtureRuleset.cheatSheet(FIXTURE_DEFAULTS, fixtureRules())).toContain(
      "1h30m between islands",
    );
  });

  test("visibility: a publicCity extra and a briefing driven by ext; the read tool too", () => {
    const m = fixtureMatch();
    const generic: AnyRuleset = fixtureRuleset;
    const vis = generic.hooks.visibility;
    const read = () => m.read();
    expect(vis?.publicCity?.(read(), "p1", "c2")).toEqual({ renamingOpen: false });
    expect(vis?.briefing?.(read(), "p1")).toEqual({
      renamingOpen: false,
      renames: 0,
      openAt: 7200,
    });
    m.advanceTo(7200);
    m.apply("p1", { type: "ext", tool: "fixture_rename", args: { city: "c1", name: "Port" } });
    expect(vis?.briefing?.(read(), "p1")).toEqual({
      renamingOpen: true,
      renames: 1,
      openAt: 7200,
    });
    expect(fixtureRuleset.tools?.[0]?.read?.(read(), "p1", {})).toEqual({
      opened: true,
      renames: 1,
    });
    expect(m.read().state.cities["c1"]?.name).toBe("Port");
  });

  test("the world places every seat on the two islands with the seats stream", () => {
    const m = fixtureMatch({ players: 4, seed: 99 });
    const s = m.read().state;
    expect(Object.keys(s.islands)).toEqual(["i1", "i2"]);
    const places = Object.values(s.cities)
      .map((c) => `${c.island}/${c.slot}`)
      .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(places).toEqual(["i1/0", "i1/1", "i2/0", "i2/1"]);
    expect(Object.values(s.cities).map((c) => c.capitalOf)).toEqual(["p1", "p2", "p3", "p4"]);
  });

  test("a trivial battle: the larger side wins, the loser's units die, survivors sail home", () => {
    const m = fixtureMatch({ players: 2 });
    const out = m.apply("p1", { type: "attack", from: "c1", to: "c2", units: { soldier: 3 } });
    expect(out.ok).toBe(true);
    const battle = m.advanceTo(5400).events;
    expect(battle.map((e) => e.type)).toEqual(["battle", "battle_report", "battle_report"]);
    expect(battle[0]?.data).toMatchObject({ winner: "defender", attacker: "p1", defender: "p2" });
    expect(m.read().state.movements).toEqual({});
    const raid = m.apply("p2", { type: "attack", from: "c2", to: "c1", units: { soldier: 10 } });
    expect(raid.ok).toBe(true);
    const events = m.advanceTo(30000).events.map((e) => e.type);
    expect(events).toEqual([
      "fixture_opened",
      "battle",
      "battle_report",
      "battle_report",
      "returned",
    ]);
    expect(m.read().state.cities["c1"]?.units).toEqual({});
    expect(m.read().state.cities["c2"]?.units).toEqual({ soldier: 10 });
  });

  test("a spy reports to the spier and warns the target with the intel event", () => {
    const m = fixtureMatch();
    m.apply("p1", { type: "spy", from: "c1", to: "c2", gold: 20 });
    const events = m.advanceTo(5400).events;
    expect(events.map((e) => [e.type, e.to])).toEqual([
      ["spy_report", [{ p: "p1", as: "self" }]],
      ["fixture_scouted", [{ p: "p2", as: "target" }]],
    ]);
  });
});

describe("the fake domain", () => {
  test("queues, cancels and completes builds and recruits", () => {
    const m = fixtureMatch();
    m.apply("p1", { type: "build", city: "c1", building: "tower" });
    const second = m.apply("p1", { type: "build", city: "c1", building: "tower" });
    expect(second).toMatchObject({ ok: true, data: { item: 2, level: 3, end: 1200 + 1800 } });
    expect(m.apply("p1", { type: "build", city: "c1", building: "tower" })).toMatchObject({
      ok: false,
      violation: { code: "MAX_LEVEL" },
    });
    expect(m.apply("p1", { type: "cancel_queue", city: "c1", item: 2 })).toMatchObject({
      ok: true,
      data: { removed: 1 },
    });
    expect(m.apply("p1", { type: "cancel_queue", city: "c1", item: 2 })).toEqual({
      ok: false,
      violation: { code: "QUEUE_ITEM", details: { city: "c1", item: 2 } },
    });
    m.apply("p1", { type: "recruit", city: "c1", unit: "soldier", count: 4 });
    const events = m.advanceTo(1200).events.map((e) => e.type);
    expect(events).toEqual(["recruit_done", "queue_empty", "build_done", "queue_empty"]);
    expect(m.read().state.cities["c1"]?.units).toEqual({ soldier: 14 });
    expect(m.read().state.ledger["p1"]?.made).toEqual({ soldier: 14 });
  });

  test("recalls inside the window, pacts expire, messages carry their text", () => {
    const m = fixtureMatch({ players: 3 });
    const out = m.apply("p1", { type: "support", from: "c1", to: "c2", units: { soldier: 2 } });
    const movement = MovementIdSchema.parse(out.ok ? out.data["movement"] : null);
    m.advanceTo(300);
    const recall = m.apply("p1", { type: "recall", movement });
    expect(recall).toMatchObject({ ok: true, data: { arriveAt: 600 } });
    m.advanceTo(700);
    expect(m.read().state.cities["c1"]?.units).toEqual({ soldier: 10 });
    const proposal = m.apply("p1", {
      type: "propose",
      to: "p2",
      kind: "pact",
      name: null,
      text: "peace",
      until: null,
    });
    const id = ProposalIdSchema.parse(proposal.ok ? proposal.data["proposal"] : null);
    expect(m.apply("p2", { type: "answer", proposal: id, accept: true }).ok).toBe(true);
    expect(m.read().state.pacts).toMatchObject([{ a: "p1", b: "p2", expiresAt: 700 + 86400 }]);
    const msg = m.apply("p3", { type: "send_message", to: ["p1", "p2"], text: "hi" });
    expect(msg.ok && msg.events[0]?.data).toMatchObject({
      from: "p3",
      to: ["p1", "p2"],
      text: "hi",
    });
    expect(m.apply("p1", { type: "leave", with: null })).toMatchObject({
      ok: false,
      violation: { code: "INVALID_ARGS" },
    });
  });
});

describe("state builders and matchFromState", () => {
  test("every builder keeps the kernel and fake-domain invariants", () => {
    const { state, rules } = fixtureState({ players: 3, now: 100 });
    addCity(state, rules, {
      owner: "p1",
      capital: true,
      units: { soldier: 5 },
      stock: 200,
      buildings: { vault: 1 },
    });
    addCity(state, rules, { owner: "p2", island: "i2", capital: true, stock: { gold: 50 } });
    addCity(state, rules, { owner: "p3", island: "i2" });
    addCity(state, rules, { owner: null, tag: "crown", units: { soldier: 40 } });
    addMovement(state, rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      units: { soldier: 2 },
      arriveAt: 4000,
    });
    addMovement(state, rules, {
      kind: "found",
      owner: "p3",
      from: "c3",
      units: { pioneer: 1 },
      toIsland: "i1",
      arriveAt: 5000,
    });
    addBuildItem(state, rules, "c1", "tower");
    addBuildItem(state, rules, "c1", "tower");
    addRecruitBatch(state, rules, "c2", "soldier", 3);
    addProposal(state, rules, { from: "p2", to: "p3" });
    addPact(state, rules, "p3", "p1", { expiresAt: 20000 });
    addPact(state, rules, "p2", "p3");
    addAlliance(state, "North", ["p2", "p1"]);
    addStationed(state, "c2", { owner: "p1", home: "c1", role: "support", units: { soldier: 1 } });
    const m = matchFromState(state, fixtureRuleset);
    m.checkInvariants("checkpoint");
    const s = m.read().state;
    expect(s.cities["c1"]?.stock).toEqual({ wood: 720000, stone: 720000, gold: 720000 });
    expect(s.cities["c4"]?.owner).toBeNull();
    expect(s.cities["c1"]?.build.map((b) => [b.id, b.level, b.end])).toEqual([
      [1, 1, 100 + 600],
      [2, 2, 700 + 1200],
    ]);
    expect(s.pacts.map((p) => `${p.a}|${p.b}`)).toEqual(["p1|p3", "p2|p3"]);
    expect(s.alliances["a1"]?.members).toEqual(["p1", "p2"]);
    expect(s.players["p1"]?.alliance).toBe("a1");
    expect(s.ledger["neutral"]?.made).toEqual({ soldier: 40 });
    m.advanceTo(30000);
    m.checkInvariants("checkpoint");
  });

  test("testStep edits a loaded match and runs afterStep with the test cause", () => {
    const { state, rules } = fixtureState();
    addCity(state, rules, { owner: "p1" });
    addCity(state, rules, { owner: "p2", island: "i2" });
    const m = matchFromState(state, fixtureRuleset);
    const events = testStep(m, (ctx) => {
      const c2 = ctx.state.cities["c2"];
      if (c2 !== undefined) c2.owner = "p1";
    });
    expect(events.map((e) => e.type)).toEqual(["player_eliminated", "match_ended"]);
  });

  test("the recorder's snapshots load and match their ckpt lines", () => {
    const rec = new LogRecorder(fixtureMatch(), { snapshotEvery: 3 });
    rec.advanceTo(4 * 3600);
    const [snap] = rec.snapshots;
    const ck = rec.lines.find((l) => l.k === "ckpt" && l.hour === 3);
    expect(snap?.hour).toBe(3);
    expect(ck?.k === "ckpt" && ck.h).toBe(snap?.hash ?? "");
  });
});
