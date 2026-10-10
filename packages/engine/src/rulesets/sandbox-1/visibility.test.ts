import { describe, expect, test } from "bun:test";
import { defaultVisibility } from "@perfidia/engine/std";
import { addAlliance, addMovement } from "@perfidia/engine/testing";
import type { MovementId, PlayerId } from "@perfidia/protocol";
import type { Match } from "@perfidia/engine/kernel";
import { movementAccess } from "./visibility.ts";
import { sandboxCity, sandboxMatch, sandboxState } from "./testkit.test.ts";

// Fog of war (docs/architecture.md §3.8): std's defaults, except that allies see each other's
// movements in full; `publicCity` adds the name and `publicMatch` the hill status.

function world() {
  const now = 50000;
  const { state, rules } = sandboxState({ players: 4, now });
  sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
  sandboxCity(state, rules, { owner: "p2", id: "c2", island: "i3", capital: true });
  sandboxCity(state, rules, { owner: "p3", id: "c3", island: "i5", capital: true });
  sandboxCity(state, rules, { owner: "p4", id: "c4", island: "i7", capital: true });
  addAlliance(state, "North", ["p1", "p2"]);
  const at = now + 9000;
  const base = { owner: "p1" as PlayerId, from: "c1" as const, arriveAt: at };
  const ids: Record<string, MovementId> = {
    attack: addMovement(state, rules, {
      ...base,
      kind: "attack",
      to: "c3",
      units: { axeman: 3 },
      party: "p3",
    }).id,
    spy: addMovement(state, rules, { ...base, kind: "spy", to: "c3", gold: 60, party: "p3" }).id,
    found: addMovement(state, rules, {
      ...base,
      kind: "found",
      toIsland: "i6",
      units: { colonist: 1 },
    }).id,
    support: addMovement(state, rules, {
      ...base,
      kind: "support",
      to: "c4",
      units: { spearman: 2 },
      party: "p4",
    }).id,
    shipment: addMovement(state, rules, {
      ...base,
      kind: "shipment",
      to: "c4",
      cargo: { wood: 10 },
      party: "p4",
    }).id,
  };
  return { match: sandboxMatch(state), ids };
}

/** The descriptor's visibility hooks, called as the gateway calls them. */
function hooks(match: Match) {
  const v = match.ruleset.hooks.visibility;
  const r = match.read();
  return {
    access: (viewer: PlayerId, m: MovementId) => v?.movementAccess?.(r, viewer, m),
    std: (viewer: PlayerId, m: MovementId) => defaultVisibility.movementAccess(r, viewer, m),
    publicCity: (viewer: PlayerId, city: "c1" | "c99") => v?.publicCity?.(r, viewer, city),
    publicMatch: () => v?.publicMatch?.(r),
  };
}

describe("movementAccess", () => {
  test("the mover: own; its ally: full for every kind; others as std grants", () => {
    const { match, ids } = world();
    const h = hooks(match);
    for (const [kind, id] of Object.entries(ids)) {
      expect([kind, h.access("p1", id)]).toEqual([kind, "own"]);
      expect([kind, h.access("p2", id)]).toEqual([kind, "full"]);
      for (const viewer of ["p3", "p4"] as const) {
        expect([kind, viewer, h.access(viewer, id)]).toEqual([kind, viewer, h.std(viewer, id)]);
      }
    }
    expect(h.access("p3", ids["attack"] ?? "m00000")).toBe("incoming");
    expect(h.access("p3", ids["spy"] ?? "m00000")).toBeNull();
    expect(h.access("p4", ids["support"] ?? "m00000")).toBe("full");
    expect(h.access("p4", ids["attack"] ?? "m00000")).toBeNull();
    // std alone would show the ally nothing of its partner's attack, spy and founding.
    expect(h.std("p2", ids["attack"] ?? "m00000")).toBeNull();
    expect(h.access("p2", "m00000")).toBeNull();
  });

  test("is the hook the descriptor declares", () => {
    const { match } = world();
    expect(match.ruleset.hooks.visibility?.movementAccess).toBe(movementAccess);
    expect(match.ruleset.hooks.visibility?.cityAccess).toBeUndefined();
    expect(match.ruleset.hooks.visibility?.briefing).toBeUndefined();
  });
});

describe("public extras", () => {
  test("publicCity: the name, for any viewer; publicMatch: the hill status", () => {
    const { match } = world();
    const h = hooks(match);
    expect(h.publicCity("p3", "c1")).toEqual({ name: "c1" });
    expect(h.publicCity("p1", "c99")).toEqual({});
    expect(h.publicMatch()).toEqual({
      hill: {
        open: false,
        opensAt: [172800, "D3 00:00"],
        threshold: 2,
        totalCities: 4,
        leaders: [
          { player: "p1", cities: 1 },
          { player: "p2", cities: 1 },
          { player: "p3", cities: 1 },
        ],
      },
    });
  });
});
