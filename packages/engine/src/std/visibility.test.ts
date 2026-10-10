import { describe, expect, test } from "bun:test";
import type { PlayerId } from "@perfidia/protocol";
import type { DepartureDraft } from "@perfidia/engine/contracts";
import {
  defaultDeparture,
  defaultVisibility,
  incomingAudience,
  launch,
  recipients,
  startReturn,
  station,
} from "./index.ts";
import { SCALE, cityOf, ctxAt, res, type TestCtx } from "./fixtures.test.ts";

const NO_RES = res(0, 0, 0);

function ally(ctx: TestCtx, a: PlayerId, b: PlayerId): void {
  ctx.state.alliances.a1 = { id: "a1", name: "Bloc", members: [a, b], formedAt: 0 };
  for (const p of [a, b]) {
    const player = ctx.state.players[p];
    if (player === undefined) throw new Error("fixture");
    player.alliance = "a1";
  }
}

function draft(over: Partial<DepartureDraft> & Pick<DepartureDraft, "kind">): DepartureDraft {
  return {
    owner: "p1",
    from: "c1",
    to: "c2",
    island: "i2",
    slot: null,
    units: {},
    cargo: NO_RES,
    gold: 0,
    ...over,
  };
}

describe("recipients", () => {
  test("one entry per player with its best role, ordered by role then player", () => {
    expect(
      recipients(
        [
          ["p3", "ally"],
          ["p10", "stationed"],
          ["p2", "target"],
          ["p3", "party"],
          [null, "party"],
          ["p1", "self"],
          ["p2", "ally"],
        ],
        ["p1"],
      ),
    ).toEqual([
      { p: "p3", as: "party" },
      { p: "p2", as: "target" },
      { p: "p10", as: "stationed" },
    ]);
  });
});

describe("defaultVisibility", () => {
  test("cityAccess: full for the owner and its allies, public otherwise and for neutral cities", () => {
    const ctx = ctxAt();
    ally(ctx, "p1", "p2");
    ctx.state.pacts.push({ a: "p1", b: "p3", since: 0, expiresAt: null, seq: null });
    const r = ctx.read();
    const v = defaultVisibility;
    expect(v.cityAccess(r, "p1", "c1")).toBe("full");
    expect(v.cityAccess(r, "p2", "c1")).toBe("full");
    expect(v.cityAccess(r, "p3", "c1")).toBe("public");
    expect(v.cityAccess(r, "p1", "c5")).toBe("public");
    expect(v.publicCity(r, "p1", "c1")).toEqual({});
    expect(v.publicPlayer(r, "p1")).toEqual({});
    expect(v.publicMatch(r)).toEqual({});
    expect("briefing" in v).toBe(false);
  });

  test("movementAccess follows the incoming audience: composition only for supports and shipments", () => {
    const ctx = ctxAt(50000);
    ally(ctx, "p2", "p3");
    const r = () => ctx.read();
    const attack = launch(ctx, draft({ kind: "attack", units: { axe: 5 } }), "p2");
    const support = launch(ctx, draft({ kind: "support", units: { pike: 2 } }), "p2");
    const spy = launch(ctx, draft({ kind: "spy", gold: 100 }), "p2");
    const found = launch(
      ctx,
      draft({ kind: "found", to: null, island: "i3", units: { colonist: 1 } }),
      null,
    );
    const v = defaultVisibility;
    expect([attack, support, spy, found].map((m) => v.movementAccess(r(), "p1", m))).toEqual([
      "own",
      "own",
      "own",
      "own",
    ]);
    expect([attack, support, spy, found].map((m) => v.movementAccess(r(), "p2", m))).toEqual([
      "incoming",
      "full",
      null,
      null,
    ]);
    expect([attack, support, spy, found].map((m) => v.movementAccess(r(), "p3", m))).toEqual([
      "incoming",
      "full",
      null,
      null,
    ]);
    expect(v.movementAccess(r(), "p2", "m00000")).toBeNull();
  });

  test("a return heading into a held home is incoming for the holder only", () => {
    const ctx = ctxAt();
    cityOf(ctx, "c3").units = { pike: 9, axe: 10 };
    station(ctx, "c1", { owner: "p3", home: "c3", role: "hold", units: { pike: 1 } });
    cityOf(ctx, "c4").units = { pike: 3 };
    const m = startReturn(ctx, { owner: "p1", home: "c1", from: "c4", units: { pike: 2 } });
    expect(incomingAudience(ctx.read(), m)).toEqual([{ p: "p3", as: "party" }]);
    expect(defaultVisibility.movementAccess(ctx.read(), "p3", m)).toBe("incoming");
    expect(defaultVisibility.movementAccess(ctx.read(), "p2", m)).toBeNull();
    const free = startReturn(ctx, { owner: "p1", home: "c4", from: "c1", units: { pike: 1 } });
    expect(incomingAudience(ctx.read(), free)).toEqual([]);
  });

  test("an attack on a neutral city tells the groups stationed there and nobody else", () => {
    const ctx = ctxAt(50000);
    station(ctx, "c5", { owner: "p3", home: "c3", role: "support", units: { pike: 1 } });
    const m = launch(
      ctx,
      draft({ kind: "attack", to: "c5", island: "i1", units: { axe: 5 } }),
      null,
    );
    expect(incomingAudience(ctx.read(), m)).toEqual([{ p: "p3", as: "stationed" }]);
  });
});

describe("defaultDeparture", () => {
  test("records the party: the target's owner, or null for neutral cities and founding", () => {
    const r = ctxAt().read();
    expect(defaultDeparture(r, draft({ kind: "attack", units: { axe: 1 } }))).toEqual({
      ok: true,
      party: "p2",
    });
    expect(
      defaultDeparture(r, draft({ kind: "attack", to: "c5", island: "i1", units: { axe: 1 } })),
    ).toEqual({
      ok: true,
      party: null,
    });
    expect(defaultDeparture(r, draft({ kind: "support", to: "c4", units: { pike: 1 } }))).toEqual({
      ok: true,
      party: "p1",
    });
    expect(defaultDeparture(r, draft({ kind: "spy", to: "c5", island: "i1", gold: 100 }))).toEqual({
      ok: true,
      party: null,
    });
    expect(defaultDeparture(r, draft({ kind: "shipment", cargo: res(1, 0, 0) }))).toEqual({
      ok: true,
      party: "p2",
    });
    expect(
      defaultDeparture(r, draft({ kind: "found", to: null, island: "i1", units: { colonist: 1 } })),
    ).toEqual({ ok: true, party: null });
  });

  test("rejects invalid targets", () => {
    const r = ctxAt().read();
    const code = (d: DepartureDraft) => {
      const v = defaultDeparture(r, d);
      return v.ok ? "ok" : v.violation.code;
    };
    expect(code(draft({ kind: "attack", to: "c4", units: { axe: 1 } }))).toBe("INVALID_TARGET");
    expect(code(draft({ kind: "attack", to: "c99", units: { axe: 1 } }))).toBe("INVALID_TARGET");
    expect(code(draft({ kind: "support", to: "c5", island: "i1", units: { pike: 1 } }))).toBe(
      "INVALID_TARGET",
    );
    expect(code(draft({ kind: "support", to: "c1", island: "i1", units: { pike: 1 } }))).toBe(
      "INVALID_TARGET",
    );
    expect(code(draft({ kind: "spy", to: "c4", gold: 100 }))).toBe("INVALID_TARGET");
    expect(code(draft({ kind: "shipment", to: "c5", island: "i1", cargo: res(1, 0, 0) }))).toBe(
      "INVALID_TARGET",
    );
    expect(code(draft({ kind: "found", to: null, island: "i9", units: { colonist: 1 } }))).toBe(
      "INVALID_TARGET",
    );
  });

  test("an attack needs a fighting land unit, or across water a naval fighter", () => {
    const r = ctxAt().read();
    const v = (units: Record<string, number>, to: "c2" | "c5" = "c2", island: "i1" | "i2" = "i2") =>
      defaultDeparture(r, draft({ kind: "attack", to, island, units }));
    expect(v({ colonist: 1, ferry: 1 })).toEqual({
      ok: false,
      violation: { code: "NO_UNITS", details: { kind: "attack", crossing: true } },
    });
    expect(v({ galley: 1 })).toEqual({ ok: true, party: "p2" });
    expect(v({ galley: 1 }, "c5", "i1")).toEqual({
      ok: false,
      violation: { code: "NO_UNITS", details: { kind: "attack", crossing: false } },
    });
    expect(v({ axe: 1 }, "c5", "i1")).toEqual({ ok: true, party: null });
  });

  test("founding needs a free slot, a valid requested slot and a founding unit", () => {
    const ctx = ctxAt();
    const r = ctx.read();
    expect(
      defaultDeparture(r, draft({ kind: "found", to: null, island: "i1", units: { pike: 1 } })),
    ).toEqual({
      ok: false,
      violation: { code: "SETTLER_REQUIRED", details: { unit: "colonist" } },
    });
    expect(
      defaultDeparture(
        r,
        draft({ kind: "found", to: null, island: "i1", slot: 4, units: { colonist: 1 } }),
      ),
    ).toEqual({
      ok: false,
      violation: { code: "INVALID_ARGS", details: { island: "i1", slot: 4, slots: 4 } },
    });
    const c = cityOf(ctx, "c4");
    ctx.state.cities.c9 = { ...c, id: "c9", slot: 2, units: {}, stationed: [] };
    expect(
      defaultDeparture(
        ctx.read(),
        draft({ kind: "found", to: null, island: "i2", units: { colonist: 1 } }),
      ),
    ).toEqual({ ok: false, violation: { code: "NO_FREE_SLOT", details: { island: "i2" } } });
  });

  test("a spy needs spyMinGold ≤ gold ≤ the gold in stock", () => {
    const r = ctxAt().read();
    expect(defaultDeparture(r, draft({ kind: "spy", gold: 99 }))).toEqual({
      ok: false,
      violation: { code: "SPY_GOLD", details: { min: 100, gold: 99 } },
    });
    const v = defaultDeparture(r, draft({ kind: "spy", gold: 801 }));
    expect(v.ok ? null : v.violation).toEqual({
      code: "INSUFFICIENT_RESOURCES",
      details: { city: "c1", need_gold: 801, have_gold: 800, rate_gold: 110, availableAt: 33 },
    });
  });

  test("a shipment needs a load, the stock, and room under the in-flight cap", () => {
    const ctx = ctxAt();
    const r = ctx.read();
    expect(defaultDeparture(r, draft({ kind: "shipment" }))).toEqual({
      ok: false,
      violation: { code: "INVALID_ARGS", details: { load: 0 } },
    });
    const c1 = cityOf(ctx, "c1");
    c1.stock = res(2000 * SCALE, 0, 0);
    launch(ctx, draft({ kind: "shipment", cargo: res(600, 0, 0) }), "p2");
    // dock 1: cap 500 + 500 × 1 = 1000, 600 already in flight.
    expect(
      defaultDeparture(ctx.read(), draft({ kind: "shipment", cargo: res(400, 0, 0) })),
    ).toEqual({
      ok: true,
      party: "p2",
    });
    expect(
      defaultDeparture(ctx.read(), draft({ kind: "shipment", cargo: res(401, 0, 0) })),
    ).toEqual({
      ok: false,
      violation: {
        code: "SHIPMENT_CAPACITY",
        details: { city: "c1", cap: 1000, inFlight: 600, requested: 401 },
      },
    });
    const short = defaultDeparture(ctx.read(), draft({ kind: "shipment", cargo: res(0, 1, 0) }));
    expect(short.ok ? null : short.violation.code).toBe("INSUFFICIENT_RESOURCES");
  });
});
