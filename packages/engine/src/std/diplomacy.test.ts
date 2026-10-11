import { describe, expect, test } from "bun:test";
import type { PlayerId } from "@perfidia/protocol";
import {
  StdError,
  cancelProposalsOf,
  checkStd,
  defaultRelations,
  endPact,
  leaveAlliance,
} from "./index.ts";
import { ctxAt, danglingRefs, type TestCtx } from "./fixtures.test.ts";

function bloc(ctx: TestCtx, members: PlayerId[]): void {
  ctx.state.alliances.a1 = { id: "a1", name: "Bloc", members, formedAt: 0 };
  for (const p of members) {
    const player = ctx.state.players[p];
    if (player === undefined) throw new Error("fixture");
    player.alliance = "a1";
  }
}

function pact(ctx: TestCtx, a: PlayerId, b: PlayerId, expiresAt: number | null): void {
  const seq = expiresAt === null ? null : ctx.schedule("pact_expire", expiresAt, `${a}|${b}`);
  ctx.state.pacts.push({ a, b, since: 0, expiresAt, seq });
}

describe("defaultRelations", () => {
  test("lists alliance members and pact partners by player", () => {
    const ctx = ctxAt();
    bloc(ctx, ["p1", "p3"]);
    pact(ctx, "p1", "p2", 172800);
    pact(ctx, "p2", "p3", null);
    const r = ctx.read();
    expect(defaultRelations(r, "p1")).toEqual([
      { player: "p2", kind: "pact", until: 172800 },
      { player: "p3", kind: "ally", until: null },
    ]);
    expect(defaultRelations(r, "p2")).toEqual([
      { player: "p1", kind: "pact", until: 172800 },
      { player: "p3", kind: "pact", until: null },
    ]);
    expect(defaultRelations(ctxAt().read(), "p1")).toEqual([]);
  });
});

describe("leaveAlliance", () => {
  test("a member leaves publicly; an alliance left with one member dissolves", () => {
    const ctx = ctxAt(500);
    bloc(ctx, ["p1", "p2", "p3"]);
    leaveAlliance(ctx, "p2", "left");
    expect(ctx.state.alliances.a1?.members).toEqual(["p1", "p3"]);
    expect(ctx.state.players.p2?.alliance).toBeNull();
    expect(ctx.events).toEqual([
      {
        t: 500,
        type: "alliance_left",
        public: true,
        to: [
          { p: "p2", as: "self" },
          { p: "p1", as: "ally" },
          { p: "p3", as: "ally" },
        ],
        data: { alliance: "a1", player: "p2", cause: "left" },
      },
    ]);
    leaveAlliance(ctx, "p1", "betrayal");
    expect(ctx.state.alliances).toEqual({});
    expect(ctx.state.players.p3?.alliance).toBeNull();
    expect(ctx.events.slice(1).map((e) => [e.type, e.data, e.to])).toEqual([
      [
        "alliance_left",
        { alliance: "a1", player: "p1", cause: "betrayal" },
        [
          { p: "p1", as: "self" },
          { p: "p3", as: "ally" },
        ],
      ],
      ["alliance_dissolved", { alliance: "a1" }, [{ p: "p3", as: "self" }]],
    ]);
    leaveAlliance(ctx, "p1", "left");
    expect(ctx.events).toHaveLength(3);
    expect(checkStd(ctx.read())).toEqual([]);
    expect(danglingRefs(ctx.state)).toEqual([]);
  });
});

describe("endPact", () => {
  test("ends the pact, cancels its expiry and says why", () => {
    const ctx = ctxAt(10);
    pact(ctx, "p1", "p3", 172800);
    pact(ctx, "p2", "p3", 172800);
    endPact(ctx, "p3", "p1", "betrayal");
    expect(ctx.state.pacts.map((x) => [x.a, x.b])).toEqual([["p2", "p3"]]);
    expect(ctx.state.queue.map((e) => e.ref)).toEqual(["p2|p3"]);
    expect(ctx.events).toEqual([
      {
        t: 10,
        type: "pact_ended",
        public: true,
        to: [
          { p: "p3", as: "self" },
          { p: "p1", as: "target" },
        ],
        data: { a: "p1", b: "p3", cause: "betrayal" },
      },
    ]);
    expect(() => endPact(ctx, "p1", "p3", "left")).toThrow(StdError);
  });

  test("an expiry (its event already fired) emits pact_expired", () => {
    const ctx = ctxAt(0);
    pact(ctx, "p1", "p2", 172800);
    ctx.state.queue.shift();
    ctx.setNow(172800);
    endPact(ctx, "p1", "p2", "expired");
    expect(ctx.events.map((e) => [e.type, e.data])).toEqual([
      ["pact_expired", { a: "p1", b: "p2" }],
    ]);
    expect(ctx.state.pacts).toEqual([]);
  });
});

describe("cancelProposalsOf", () => {
  test("deletes the proposals from and to the player with their events, silently", () => {
    const ctx = ctxAt();
    const make = (from: PlayerId, to: PlayerId) => {
      const id = ctx.nextId("q", from);
      ctx.state.proposals[id] = {
        id,
        from,
        to,
        kind: "pact",
        name: null,
        until: null,
        expiresAt: 43200,
        seq: ctx.schedule("proposal_expire", 43200, id),
      };
      return id;
    };
    make("p1", "p2");
    make("p3", "p1");
    const keep = make("p2", "p3");
    cancelProposalsOf(ctx, "p1");
    expect(Object.keys(ctx.state.proposals)).toEqual([keep]);
    expect(ctx.state.queue.map((e) => e.ref)).toEqual([keep]);
    expect(ctx.events).toEqual([]);
    expect(danglingRefs(ctx.state)).toEqual([]);
  });
});
