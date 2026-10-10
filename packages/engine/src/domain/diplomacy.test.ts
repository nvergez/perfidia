import { describe, expect, test } from "bun:test";
import { fmtTime } from "@perfidia/engine/core";
import type { AnyRuleset } from "@perfidia/engine/contracts";
import { addAlliance, addCity, addPact, addProposal } from "@perfidia/engine/testing";
import type { Match } from "@perfidia/engine/kernel";
import {
  ProposalIdSchema,
  type Action,
  type CompiledRules,
  type GameState,
  type PlayerId,
  type ProposalId,
} from "@perfidia/protocol";
import { diplomacyInvariants, domain } from "./index.ts";
import {
  RICH,
  RICH_OPTIONS,
  accepted,
  emptyState,
  load,
  violation,
  world,
} from "./fixtures.test.ts";

const at = (t: number): [number, string] => [t, fmtTime(t)];
const message = (to: PlayerId[] | "all", text: string): Action => ({
  type: "send_message",
  to,
  text,
});
const propose = (
  to: PlayerId,
  kind: "alliance" | "pact",
  o: { name?: string; text?: string; until?: number } = {},
): Action => ({
  type: "propose",
  to,
  kind,
  name: o.name ?? null,
  text: o.text ?? "",
  until: o.until ?? null,
});
const answer = (proposal: ProposalId, accept: boolean): Action => ({
  type: "answer",
  proposal,
  accept,
});
const leave = (who: PlayerId | null = null): Action => ({ type: "leave", with: who });

function proposalOf(data: Record<string, unknown>): ProposalId {
  return ProposalIdSchema.parse(data["proposal"]);
}

/** `base` with some diplomacy rules replaced: a config its compile step could produce. */
function withDiplomacy(
  d: Partial<CompiledRules["diplomacy"]>,
  base: AnyRuleset = RICH,
): AnyRuleset {
  return {
    ...base,
    compile(config, players) {
      const rules = base.compile(config, players);
      return { ...rules, diplomacy: { ...rules.diplomacy, ...d } };
    },
  };
}

/** The seq of the match's only pending `pact_expire` event. */
function pactSeq(m: Match): number {
  const pending = m.read().state.queue.filter((e) => e.kind === "pact_expire");
  const first = pending[0];
  if (pending.length !== 1 || first === undefined) throw new Error("expected one pact_expire");
  return first.seq;
}

describe("send_message", () => {
  test("a private message goes to the sender (self) and each recipient (target)", () => {
    const m = load(world().state);
    const out = m.apply("p1", message(["p3", "p2", "p3"], "hi"));
    const data = accepted(out);
    expect(data["to"]).toEqual(["p2", "p3"]);
    expect(out.ok && out.events).toEqual([
      {
        t: 0,
        type: "message",
        public: false,
        to: [
          { p: "p1", as: "self" },
          { p: "p2", as: "target" },
          { p: "p3", as: "target" },
        ],
        data: { message: data["message"] ?? null, from: "p1", to: ["p2", "p3"], text: "hi" },
      },
    ]);
  });

  test("a message to all is public and addressed to the sender only", () => {
    const m = load(world().state);
    const out = m.apply("p1", message("all", "hello world"));
    expect(out.ok && out.events.map((e) => [e.public, e.to, e.data["to"]])).toEqual([
      [true, [{ p: "p1", as: "self" }], "all"],
    ]);
  });

  test("violations carry their numbers", () => {
    const { state, rules } = emptyState();
    addCity(state, rules, { owner: "p1", id: "c1" });
    addCity(state, rules, { owner: "p2", id: "c2", island: "i2" });
    const p3 = state.players["p3"];
    if (p3 !== undefined) {
      p3.alive = false;
      p3.eliminatedAt = 0;
    }
    const m = load(state);
    expect(violation(m.apply("p1", message(["p2"], "x".repeat(51))))).toEqual({
      code: "TEXT_TOO_LONG",
      details: { field: "text", max: 50, length: 51 },
    });
    expect(violation(m.apply("p1", message(["p9"], "x")))).toEqual({
      code: "UNKNOWN_ID",
      details: { player: "p9" },
    });
    expect(violation(m.apply("p1", message(["p1"], "x")))).toEqual({
      code: "INVALID_TARGET",
      details: { player: "p1", action: "send_message", reason: "self" },
    });
    expect(violation(m.apply("p1", message(["p2", "p3"], "x")))).toEqual({
      code: "INVALID_TARGET",
      details: { player: "p3", action: "send_message", reason: "eliminated" },
    });
  });
});

describe("propose", () => {
  test("opens a private proposal that expires after proposalTtl", () => {
    const m = load(world().state);
    const out = m.apply("p1", propose("p2", "alliance", { name: "North", text: "join" }));
    const data = accepted(out);
    const id = proposalOf(data);
    expect(data).toEqual({ proposal: id, expires: at(3600) });
    expect(out.ok && out.events).toEqual([
      {
        t: 0,
        type: "proposal",
        public: false,
        to: [
          { p: "p1", as: "self" },
          { p: "p2", as: "target" },
        ],
        data: {
          proposal: id,
          from: "p1",
          to: "p2",
          kind: "alliance",
          name: "North",
          text: "join",
          until: null,
          expiresAt: 3600,
        },
      },
    ]);
    const expired = m.advanceTo(3600).events;
    expect(expired).toEqual([
      {
        t: 3600,
        type: "proposal_expired",
        public: false,
        to: [
          { p: "p1", as: "self" },
          { p: "p2", as: "target" },
        ],
        data: { proposal: id, from: "p1", to: "p2", kind: "alliance" },
      },
    ]);
    expect(m.read().state.proposals).toEqual({});
  });

  test("proposal limits: one per (from, to, kind), at most maxOpenProposals", () => {
    const m = load(world().state);
    const id = proposalOf(accepted(m.apply("p1", propose("p2", "alliance"))));
    expect(violation(m.apply("p1", propose("p2", "alliance")))).toEqual({
      code: "PROPOSAL_LIMIT",
      details: {
        to: "p2",
        kind: "alliance",
        proposal: id,
        reason: "duplicate",
        open: 1,
        max: 2,
        availableAt: 3600,
      },
    });
    m.advanceTo(100);
    accepted(m.apply("p1", propose("p3", "pact")));
    expect(violation(m.apply("p1", propose("p2", "pact")))).toEqual({
      code: "PROPOSAL_LIMIT",
      details: { reason: "max_open", max: 2, open: 2, availableAt: 3600 },
    });
    // Another player's limits are its own.
    accepted(m.apply("p2", propose("p1", "alliance")));
  });

  test("with maxOpenProposals 0, a proposal is PROPOSAL_LIMIT and never available", () => {
    const zero = withDiplomacy({ maxOpenProposals: 0 });
    const m = load(world({ ruleset: zero }).state, zero);
    for (const kind of ["pact", "alliance"] as const) {
      expect(violation(m.apply("p1", propose("p2", kind)))).toEqual({
        code: "PROPOSAL_LIMIT",
        details: { reason: "max_open", max: 0, open: 0, availableAt: null },
      });
    }
    expect(m.read().state.proposals).toEqual({});
  });

  test("violations carry their numbers; until needs toolOptions.pactUntil", () => {
    const { state } = world();
    addAlliance(state, "Team", ["p1", "p2"]);
    const m = load(state);
    expect(violation(m.apply("p1", propose("p9", "pact")))).toEqual({
      code: "UNKNOWN_ID",
      details: { player: "p9" },
    });
    expect(violation(m.apply("p1", propose("p1", "pact")))).toEqual({
      code: "INVALID_TARGET",
      details: { player: "p1", action: "propose", reason: "self" },
    });
    expect(violation(m.apply("p1", propose("p3", "pact", { text: "x".repeat(31) })))).toEqual({
      code: "TEXT_TOO_LONG",
      details: { field: "text", max: 30, length: 31 },
    });
    expect(violation(m.apply("p1", propose("p3", "alliance", { name: "A".repeat(13) })))).toEqual({
      code: "TEXT_TOO_LONG",
      details: { field: "name", max: 12, length: 13 },
    });
    expect(violation(m.apply("p1", propose("p3", "pact", { name: "Pact" })))).toEqual({
      code: "INVALID_ARGS",
      details: { field: "name", kind: "pact", reason: "wrong_kind" },
    });
    expect(violation(m.apply("p1", propose("p3", "pact", { until: 5000 })))).toEqual({
      code: "INVALID_ARGS",
      details: { field: "until", ruleset: "domain-test@1.0.0", reason: "unsupported" },
    });
    expect(violation(m.apply("p1", propose("p2", "pact")))).toEqual({
      code: "ALREADY_ALLIED",
      details: { player: "p2", kind: "pact" },
    });
    expect(violation(m.apply("p1", propose("p2", "alliance"))).code).toBe("ALREADY_ALLIED");
  });

  test("with toolOptions.pactUntil, until sets a pact's end", () => {
    const m = load(world({ ruleset: RICH_OPTIONS }).state, RICH_OPTIONS);
    expect(violation(m.apply("p1", propose("p2", "alliance", { until: 5000 })))).toEqual({
      code: "INVALID_ARGS",
      details: { field: "until", kind: "alliance", reason: "wrong_kind" },
    });
    expect(violation(m.apply("p1", propose("p2", "pact", { until: 0 })))).toEqual({
      code: "INVALID_ARGS",
      details: { field: "until", until: 0, now: 0, reason: "past" },
    });
    const id = proposalOf(accepted(m.apply("p1", propose("p2", "pact", { until: 5000 }))));
    expect(accepted(m.apply("p2", answer(id, true)))).toMatchObject({ expires: at(5000) });
    expect(m.read().state.pacts).toEqual([
      { a: "p1", b: "p2", since: 0, expiresAt: 5000, seq: pactSeq(m) },
    ]);
    expect(m.advanceTo(5000).events.map((e) => [e.type, e.data])).toEqual([
      ["pact_expired", { a: "p1", b: "p2" }],
    ]);
    expect(m.read().state.pacts).toEqual([]);
  });
});

describe("answer", () => {
  test("accepting an alliance between unallied players forms it, named by the proposer", () => {
    const m = load(world().state);
    const id = proposalOf(accepted(m.apply("p1", propose("p2", "alliance", { name: "North" }))));
    const out = m.apply("p2", answer(id, true));
    expect(accepted(out)).toEqual({ proposal: id, accept: true, alliance: "a1" });
    expect(out.ok && out.events).toEqual([
      {
        t: 0,
        type: "proposal_answered",
        public: false,
        to: [
          { p: "p2", as: "self" },
          { p: "p1", as: "target" },
        ],
        data: { proposal: id, from: "p1", to: "p2", kind: "alliance", accept: true },
      },
      {
        t: 0,
        type: "alliance_formed",
        public: true,
        to: [
          { p: "p2", as: "self" },
          { p: "p1", as: "target" },
        ],
        data: { alliance: "a1", name: "North", members: ["p1", "p2"] },
      },
    ]);
    expect(m.read().state.alliances["a1"]).toEqual({
      id: "a1",
      name: "North",
      members: ["p1", "p2"],
      formedAt: 0,
    });
    expect(m.read().state.players["p1"]?.alliance).toBe("a1");
    expect(m.read().state.proposals).toEqual({});
    // An unnamed alliance takes its id as its name.
    const other = load(world().state);
    const q = proposalOf(accepted(other.apply("p1", propose("p3", "alliance"))));
    accepted(other.apply("p3", answer(q, true)));
    expect(other.read().state.alliances["a1"]?.name).toBe("a1");
  });

  test("a refusal closes the proposal", () => {
    const m = load(world().state);
    const id = proposalOf(accepted(m.apply("p1", propose("p2", "pact"))));
    const out = m.apply("p2", answer(id, false));
    expect(accepted(out)).toEqual({ proposal: id, accept: false });
    expect(out.ok && out.events.map((e) => e.type)).toEqual(["proposal_answered"]);
    expect(m.read().state.proposals).toEqual({});
    expect(m.read().state.queue.some((e) => e.kind === "proposal_expire")).toBe(false);
  });

  test("only the addressee answers; others read it as missing", () => {
    const m = load(world().state);
    const id = proposalOf(accepted(m.apply("p1", propose("p2", "pact"))));
    expect(violation(m.apply("p3", answer(id, true)))).toEqual({
      code: "PROPOSAL_NOT_FOUND",
      details: { proposal: id },
    });
    expect(violation(m.apply("p3", answer("q00000", true)))).toEqual({
      code: "PROPOSAL_NOT_FOUND",
      details: { proposal: "q00000" },
    });
    expect(violation(m.apply("p1", answer(id, true)))).toEqual({
      code: "INVALID_TARGET",
      details: { proposal: id, action: "answer", reason: "own_proposal" },
    });
  });

  test("an alliance between pact partners ends the pact (superseded) and frees the slot", () => {
    const { state, rules } = world();
    addPact(state, rules, "p1", "p2", { expiresAt: 7200 });
    const m = load(state);
    const id = proposalOf(accepted(m.apply("p1", propose("p2", "alliance"))));
    const out = m.apply("p2", answer(id, true));
    expect(out.ok && out.events.map((e) => [e.type, e.public, e.data])).toEqual([
      [
        "proposal_answered",
        false,
        { proposal: id, from: "p1", to: "p2", kind: "alliance", accept: true },
      ],
      ["alliance_formed", true, { alliance: "a1", name: "a1", members: ["p1", "p2"] }],
      ["pact_ended", true, { a: "p1", b: "p2", cause: "superseded" }],
    ]);
    expect(m.read().state.pacts).toEqual([]);
    expect(m.read().state.queue.some((e) => e.kind === "pact_expire")).toBe(false);
    // maxPacts is 1: the freed slot takes a new pact.
    const q = proposalOf(accepted(m.apply("p1", propose("p3", "pact"))));
    accepted(m.apply("p3", answer(q, true)));
    expect(m.read().state.pacts.map((p) => [p.a, p.b])).toEqual([["p1", "p3"]]);
  });

  test("joining an alliance supersedes the joiner's pacts with its members; the cap holds", () => {
    const { state, rules } = world({ players: 4 });
    addAlliance(state, "Team", ["p1", "p2"]);
    addPact(state, rules, "p2", "p3");
    const m = load(state);
    const id = proposalOf(accepted(m.apply("p3", propose("p1", "alliance"))));
    const out = m.apply("p1", answer(id, true));
    expect(accepted(out)).toEqual({ proposal: id, accept: true, alliance: "a1" });
    expect(out.ok && out.events.slice(1).map((e) => [e.type, e.to, e.data])).toEqual([
      [
        "alliance_joined",
        [
          { p: "p3", as: "self" },
          { p: "p1", as: "ally" },
          { p: "p2", as: "ally" },
        ],
        { alliance: "a1", player: "p3" },
      ],
      [
        "pact_ended",
        [
          { p: "p3", as: "self" },
          { p: "p2", as: "target" },
        ],
        { a: "p2", b: "p3", cause: "superseded" },
      ],
    ]);
    expect(m.read().state.alliances["a1"]?.members).toEqual(["p1", "p2", "p3"]);
    // allianceMax is 3 for N = 4.
    const q = proposalOf(accepted(m.apply("p4", propose("p2", "alliance"))));
    expect(violation(m.apply("p2", answer(q, true)))).toEqual({
      code: "ALLIANCE_FULL",
      details: { alliance: "a1", max: 3, members: 3 },
    });
    expect(Object.keys(m.read().state.proposals)).toEqual([q]);
  });

  test("an alliance at its cap is full; both allied is invalid and the proposal stays open", () => {
    const { state } = world();
    addAlliance(state, "Team", ["p1", "p2"]);
    const m = load(state);
    const id = proposalOf(accepted(m.apply("p3", propose("p1", "alliance"))));
    expect(violation(m.apply("p1", answer(id, true)))).toEqual({
      code: "ALLIANCE_FULL",
      details: { alliance: "a1", max: 2, members: 2 },
    });

    const four = world({ players: 4 }).state;
    addAlliance(four, "West", ["p1", "p2"]);
    addAlliance(four, "East", ["p3", "p4"]);
    const both = load(four);
    const q = proposalOf(accepted(both.apply("p1", propose("p3", "alliance"))));
    expect(violation(both.apply("p3", answer(q, true)))).toEqual({
      code: "ALREADY_ALLIED",
      details: {
        player: "p1",
        kind: "alliance",
        reason: "both_allied",
        alliance: "a1",
        yours: "a2",
      },
    });
    expect(Object.keys(both.read().state.proposals)).toEqual([q]);
  });

  test("pacts: at most maxPacts, a renewal does not count and restarts the expiry", () => {
    const { state, rules } = world();
    addPact(state, rules, "p1", "p2", { expiresAt: 7200 });
    const m = load(state);
    // p1, the proposer, holds its only pact slot; it frees when that pact expires.
    const q = proposalOf(accepted(m.apply("p1", propose("p3", "pact"))));
    expect(violation(m.apply("p3", answer(q, true)))).toEqual({
      code: "PACT_LIMIT",
      details: { player: "p1", max: 1, pacts: 1, availableAt: 7200 },
    });
    m.advanceTo(1000);
    const renew = proposalOf(accepted(m.apply("p2", propose("p1", "pact"))));
    const out = m.apply("p1", answer(renew, true));
    expect(accepted(out)).toEqual({
      proposal: renew,
      accept: true,
      pact: "p2",
      renewed: true,
      expires: at(8200),
    });
    expect(out.ok && out.events.map((e) => [e.type, e.data])).toEqual([
      ["proposal_answered", { proposal: renew, from: "p2", to: "p1", kind: "pact", accept: true }],
      ["pact_renewed", { a: "p1", b: "p2", expiresAt: 8200 }],
    ]);
    expect(m.read().state.pacts).toEqual([
      { a: "p1", b: "p2", since: 0, expiresAt: 8200, seq: pactSeq(m) },
    ]);
    expect(
      m
        .read()
        .state.queue.filter((e) => e.kind === "pact_expire")
        .map((e) => e.at),
    ).toEqual([8200]);
  });

  test("PACT_LIMIT on the accepting side; pacts without expiry free no slot (null)", () => {
    const { state, rules } = world();
    addPact(state, rules, "p2", "p3");
    const m = load(state);
    const q = proposalOf(accepted(m.apply("p1", propose("p3", "pact"))));
    expect(violation(m.apply("p3", answer(q, true)))).toEqual({
      code: "PACT_LIMIT",
      details: { player: "p3", max: 1, pacts: 1, availableAt: null },
    });
    expect(Object.keys(m.read().state.proposals)).toEqual([q]);
    expect(m.read().state.pacts.map((p) => [p.a, p.b])).toEqual([["p2", "p3"]]);
  });

  test("a pact proposal answered after the players became allies is ALREADY_ALLIED, still open", () => {
    const m = load(world().state);
    const pact = proposalOf(accepted(m.apply("p1", propose("p2", "pact"))));
    const ally = proposalOf(accepted(m.apply("p2", propose("p1", "alliance"))));
    accepted(m.apply("p1", answer(ally, true)));
    expect(violation(m.apply("p2", answer(pact, true)))).toEqual({
      code: "ALREADY_ALLIED",
      details: { player: "p1", kind: "pact" },
    });
    expect(Object.keys(m.read().state.proposals)).toEqual([pact]);
    expect(m.read().state.pacts).toEqual([]);
  });

  test("a pact whose until has passed by acceptance is INVALID_ARGS (past), still open", () => {
    const m = load(world({ ruleset: RICH_OPTIONS }).state, RICH_OPTIONS);
    const id = proposalOf(accepted(m.apply("p1", propose("p2", "pact", { until: 1000 }))));
    m.advanceTo(1000);
    expect(violation(m.apply("p2", answer(id, true)))).toEqual({
      code: "INVALID_ARGS",
      details: { field: "until", until: 1000, now: 1000, reason: "past" },
    });
    expect(Object.keys(m.read().state.proposals)).toEqual([id]);
    expect(m.read().state.pacts).toEqual([]);
    // A refusal still closes it.
    accepted(m.apply("p2", answer(id, false)));
    expect(m.read().state.proposals).toEqual({});
  });

  test("a new pact is public and expires after pactDuration", () => {
    const m = load(world().state);
    const id = proposalOf(accepted(m.apply("p1", propose("p2", "pact"))));
    const out = m.apply("p2", answer(id, true));
    expect(out.ok && out.events[1]).toEqual({
      t: 0,
      type: "pact_signed",
      public: true,
      to: [
        { p: "p2", as: "self" },
        { p: "p1", as: "target" },
      ],
      data: { a: "p1", b: "p2", expiresAt: 7200 },
    });
    expect(m.advanceTo(7200).events.map((e) => [e.type, e.public])).toEqual([
      ["pact_expired", true],
    ]);
  });
});

describe("leave", () => {
  test("leaving an alliance of two dissolves it", () => {
    const { state } = world();
    addAlliance(state, "Team", ["p1", "p2"]);
    const m = load(state);
    const out = m.apply("p1", leave());
    expect(accepted(out)).toEqual({ left: "alliance", alliance: "a1" });
    expect(out.ok && out.events.map((e) => [e.type, e.public, e.data])).toEqual([
      ["alliance_left", true, { alliance: "a1", player: "p1", cause: "left" }],
      ["alliance_dissolved", true, { alliance: "a1" }],
    ]);
    expect(m.read().state.alliances).toEqual({});
    expect(m.read().state.players["p2"]?.alliance).toBeNull();
  });

  test("with a pact partner ends the pact; with an ally leaves the alliance", () => {
    const { state, rules } = world();
    addPact(state, rules, "p1", "p3", { expiresAt: 7200 });
    addAlliance(state, "Team", ["p1", "p2"]);
    const m = load(state);
    const out = m.apply("p1", leave("p3"));
    expect(accepted(out)).toEqual({ left: "pact", with: "p3" });
    expect(out.ok && out.events).toEqual([
      {
        t: 0,
        type: "pact_ended",
        public: true,
        to: [
          { p: "p1", as: "self" },
          { p: "p3", as: "target" },
        ],
        data: { a: "p1", b: "p3", cause: "left" },
      },
    ]);
    expect(m.read().state.pacts).toEqual([]);
    expect(accepted(m.apply("p1", leave("p2")))).toEqual({ left: "alliance", alliance: "a1" });
  });

  test("violations carry their numbers", () => {
    const m = load(world().state);
    expect(violation(m.apply("p1", leave()))).toEqual({
      code: "NOT_IN_ALLIANCE",
      details: { player: "p1" },
    });
    expect(violation(m.apply("p1", leave("p3")))).toEqual({
      code: "PACT_NOT_FOUND",
      details: { player: "p3" },
    });
    expect(violation(m.apply("p1", leave("p1")))).toEqual({
      code: "INVALID_TARGET",
      details: { player: "p1", action: "leave", reason: "self" },
    });
    expect(violation(m.apply("p1", leave("p9")))).toEqual({
      code: "UNKNOWN_ID",
      details: { player: "p9" },
    });
  });
});

/** Every violation of the diplomacy invariants on a hand-built state. */
function problems(state: GameState, ruleset: AnyRuleset = RICH): string[] {
  const r = load(state, ruleset).read();
  return diplomacyInvariants.flatMap((inv) => inv.check(r).map((v) => `${inv.name}: ${v}`));
}

describe("diplomacy invariants", () => {
  test("hold on states the default handlers produce", () => {
    const { state, rules } = world({ players: 4 });
    addAlliance(state, "Team", ["p1", "p2"]);
    addPact(state, rules, "p3", "p4");
    addProposal(state, rules, { from: "p1", to: "p3" });
    expect(problems(state)).toEqual([]);
    expect(domain.invariants.length).toBeGreaterThan(diplomacyInvariants.length);
  });

  test("each catches a planted corruption", () => {
    const corruptions: [string, (s: GameState, rules: CompiledRules) => void][] = [
      [
        "domain.alliances",
        (s) => {
          addAlliance(s, "Team", ["p1", "p2"]);
          const p2 = s.players["p2"];
          if (p2 !== undefined) p2.alliance = null;
        },
      ],
      ["domain.alliances", (s) => void addAlliance(s, "Big", ["p1", "p2", "p3"])],
      ["domain.alliances", (s) => void addAlliance(s, "Solo", ["p1"])],
      [
        "domain.pacts",
        (s) => {
          addAlliance(s, "Team", ["p1", "p2"]);
          s.pacts = [{ a: "p1", b: "p2", since: 0, expiresAt: null, seq: null }];
        },
      ],
      [
        "domain.pacts",
        (s) => {
          s.pacts = [
            { a: "p2", b: "p3", since: 0, expiresAt: null, seq: null },
            { a: "p1", b: "p3", since: 0, expiresAt: null, seq: null },
          ];
        },
      ],
      [
        "domain.proposals",
        (s, rules) => {
          addProposal(s, rules, { from: "p1", to: "p2" });
          addProposal(s, rules, { from: "p1", to: "p2" });
        },
      ],
      [
        "domain.proposals",
        (s, rules) => {
          addProposal(s, rules, { from: "p1", to: "p2", kind: "pact" });
          addProposal(s, rules, { from: "p1", to: "p3", kind: "pact" });
          addProposal(s, rules, { from: "p1", to: "p3", kind: "alliance" });
        },
      ],
    ];
    for (const [name, plant] of corruptions) {
      const { state, rules } = world();
      plant(state, rules);
      expect(problems(state).some((p) => p.startsWith(`${name}:`))).toBe(true);
    }
  });

  test("switch off when the ruleset replaces propose, answer or leave", () => {
    const own: AnyRuleset = {
      ...RICH,
      hooks: { ...RICH.hooks, actions: { ...RICH.hooks.actions, leave: domain.actions.leave } },
    };
    const { state } = world({ ruleset: own });
    addAlliance(state, "Solo", ["p1"]);
    expect(problems(state, own)).toEqual([]);
  });
});
