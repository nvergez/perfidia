// P10 at tool level (docs/architecture.md §13.2, §15 T16), through the harness for both rulesets:
// two states that differ only in data hidden from seat X give X byte-identical results for every
// tool, errors included, and the same briefing. The states come from 1-game-day bot runs, staged
// around X (an ally, an attack heading to X, and for perfidia-1 a siege between others, an open
// domination with a countdown, and the Crown) and perturbed in data X cannot see (`hidden.ts`).
// Also: `recall_troops {movement}` on another player's movement answers exactly like a missing
// id, and an ally's outgoing movements are shown exactly as `movementAccess` grants: never in
// perfidia-1, in full in sandbox-1.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { sortedIds, unitsAtHome } from "@perfidia/engine";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { canonicalJson, opaqueId } from "@perfidia/engine/core";
import { buildBriefing, visibilityOf, type GatewayState, type WakeRecord } from "@perfidia/gateway";
import type { PlayerId, ToolCall } from "@perfidia/protocol";
import {
  REFS,
  LOCKSTEP,
  ToolSession,
  cachedRun,
  daySpec,
  gatewayAt,
  loadChecked,
  snapshotAt,
  type Ref,
} from "./kit.ts";
import {
  editGateway,
  hiddenMovements,
  perturb,
  stage,
  type GwEdit,
  type Perturbation,
  type Staged,
} from "./hidden.ts";

const HOUR = 12;
const WAKE: WakeRecord = {
  reasons: ["safety"],
  urgent: false,
  charge: null,
  day: 0,
  used: { own: 1, social: 1 },
};

const playerNumber = (p: string): number => Number(p.slice(1));

/** Ids X may probe that belong to others: the next ids other players would mint, and theirs. */
function probes(
  r: ReadCtx,
  x: PlayerId,
  idKey: string,
): { movements: string[]; proposals: string[] } {
  const movements: string[] = [];
  const proposals: string[] = [];
  for (const p of sortedIds(r.state.ids.own)) {
    if (p === x) continue;
    const c = r.state.ids.own[p];
    if (c === undefined) continue;
    for (const n of [c.m, c.m + 1, c.m + 2])
      if (n > 0) movements.push(opaqueId(idKey, "m", playerNumber(p), n));
    for (const n of [c.q, c.q + 1])
      if (n > 0) proposals.push(opaqueId(idKey, "q", playerNumber(p), n));
  }
  return { movements, proposals };
}

/** Message and report ids in other seats' archives that X never received. */
function foreignEntries(gw: GatewayState, x: PlayerId): string[] {
  const out = new Set<string>();
  for (const [seat, s] of Object.entries(gw.seats)) {
    if (seat === x) continue;
    for (const d of s.archive) {
      if (d.event.to.some((t) => t.p === x) || d.event.public) continue;
      for (const key of ["message", "report"]) {
        const v = d.event.data[key];
        if (typeof v === "string") out.add(v);
      }
    }
  }
  return [...out].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 6);
}

/** Every tool, with arguments that reach X's own data, others' public data and hidden ids. */
function callsFor(r: ReadCtx, s: Staged, gw: GatewayState): ToolCall[] {
  const x = s.x;
  const st = r.state;
  const cities = sortedIds(st.cities);
  const own = cities.filter((c) => st.cities[c]?.owner === x);
  const home = own.find((c) => st.cities[c]?.capitalOf === x);
  const cx = home ?? own[0] ?? "c1";
  const vis = visibilityOf(r);
  const hidden = cities.filter((c) => vis.cityAccess(x, c) === "public");
  const ch = hidden.find((c) => st.cities[c]?.owner !== null) ?? hidden[0] ?? "c999";
  const ally = s.ally === null ? undefined : cities.find((c) => st.cities[c]?.owner === s.ally);
  const players = sortedIds(st.players);
  const stranger = players.find((p) => p !== x && p !== s.ally) ?? "p99";
  const other = players.find((p) => p !== x && p !== s.ally && p !== stranger) ?? stranger;
  const atHome = unitsAtHome(r, cx);
  const units = Object.entries(atHome).filter(([u, n]) => n > 0 && u !== r.rules.roles.settler);
  const some = Object.fromEntries(units.map(([u, n]) => [u, Math.max(1, Math.floor(n / 3))]));
  const one = units[0] === undefined ? {} : { [units[0][0]]: 1 };
  const settler = r.rules.roles.settler;
  const founders = (atHome[settler] ?? 0) > 0 ? { [settler]: 1, ...one } : one;
  const { movements, proposals } = probes(r, x, s.snap.setup.idKey);
  const islands = sortedIds(st.islands);
  const reads: ToolCall[] = [
    ...cities.map((city) => ({ tool: "view_city", args: { city } })),
    { tool: "view_city", args: { city: "c999" } },
    ...islands.map((island) => ({ tool: "view_island", args: { island } })),
    { tool: "view_island", args: { island: "i999" } },
    { tool: "view_map", args: {} },
    { tool: "view_map", args: { fromCity: cx } },
    { tool: "view_map", args: { fromCity: ch } },
    ...players.map((player) => ({ tool: "view_player", args: { player } })),
    { tool: "view_player", args: { player: "p99" } },
    { tool: "leaderboard", args: {} },
    { tool: "rules", args: {} },
    { tool: "read_notes", args: {} },
    { tool: "read_notes", args: { search: {} } },
    { tool: "read_notes", args: { search: { scope: "public" } } },
    { tool: "read_notes", args: { search: { scope: "mine", text: "e" } } },
    { tool: "read_notes", args: { search: { with: stranger } } },
    ...foreignEntries(gw, x).map((open) => ({ tool: "read_notes", args: { open } })),
    { tool: "read_notes", args: { open: "g00000" } },
    ...(r.ruleset.tools ?? [])
      .filter((t) => t.kind === "read")
      .map((t) => ({ tool: t.name, args: {} })),
  ];
  const writes: ToolCall[] = [
    ...(s.attackOnX === null ? [] : [{ tool: "recall_troops", args: { movement: s.attackOnX } }]),
    ...movements.map((movement) => ({ tool: "recall_troops", args: { movement } })),
    { tool: "recall_troops", args: { stationedAt: ch } },
    { tool: "recall_troops", args: { dismiss: { city: cx, player: stranger } } },
    ...proposals.map((id) => ({ tool: "answer_proposal", args: { id, accept: true } })),
    { tool: "send_resources", args: { from: cx, to: ch, wood: 5, gold: 3 } },
    { tool: "spy", args: { from: cx, to: ch, gold: 30 } },
    { tool: "attack", args: { from: cx, to: ch, units: some } },
    { tool: "support", args: { from: cx, to: ally ?? ch, units: one } },
    { tool: "found_city", args: { from: cx, island: islands.at(-1) ?? "i1", units: founders } },
    {
      tool: "build",
      args: { city: cx, buildings: r.rules.buildings.slice(0, 3).map((b) => b.id) },
    },
    {
      tool: "recruit",
      args: {
        city: cx,
        orders: r.rules.units
          .slice(0, 2)
          .map((u, i) => ({ unit: u.id, count: i === 0 ? "max" : 2 })),
      },
    },
    { tool: "cancel_queue", args: { city: cx, item: 1 } },
    { tool: "send_message", args: { to: [stranger], text: "hello there" } },
    { tool: "send_message", args: { to: "all", text: "hello all" } },
    { tool: "propose_alliance", args: { to: stranger, kind: "pact" } },
    { tool: "propose_alliance", args: { to: other, kind: "alliance", name: "Bloc" } },
    { tool: "leave_alliance", args: { with: other } },
    { tool: "write_note", args: { text: "seen it", mode: "append" } },
    ...(r.ruleset.tools ?? [])
      .filter((t) => t.kind !== "read")
      .map((t) => ({ tool: t.name, args: { city: cx, name: "Home Port" } })),
  ];
  const after: ToolCall[] = [
    { tool: "view_city", args: { city: cx } },
    { tool: "view_city", args: { city: ch } },
    { tool: "view_player", args: { player: x } },
    { tool: "read_notes", args: { search: {} } },
    { tool: "leaderboard", args: {} },
    { tool: "end_turn", args: { nextWakeIn: 3600 } },
  ];
  return [...reads, ...writes, ...after];
}

/** X's results for every call, then X's briefing, as canonical JSON texts. */
function seenBy(
  snap: Staged["snap"],
  gw: GatewayState,
  x: PlayerId,
  calls: readonly ToolCall[],
): string[] {
  const m = loadChecked(snap);
  const session = new ToolSession(m, gw, x);
  const out: string[] = calls.map((c) => canonicalJson([c.tool, session.call(c)]));
  out.push(canonicalJson(buildBriefing(m.read(), x, session.gw, WAKE)));
  return out;
}

const perturbation = (ref: Ref): fc.Arbitrary<Perturbation> => {
  const pick = fc.nat(40);
  const common: fc.Arbitrary<Perturbation>[] = [
    fc.record({
      kind: fc.constant("stock" as const),
      pick,
      amount: fc.integer({ min: 0, max: 900 }),
    }),
    fc.record({
      kind: fc.constant("units" as const),
      pick,
      count: fc.integer({ min: 1, max: 40 }),
    }),
    fc.record({ kind: fc.constant("build" as const), pick }),
    fc.record({
      kind: fc.constant("support" as const),
      pick,
      count: fc.integer({ min: 1, max: 9 }),
      arriveIn: fc.integer({ min: 600, max: 30000 }),
    }),
    fc.record({ kind: fc.constant("proposal" as const), pick }),
    fc.record({ kind: fc.constant("dropProposal" as const), pick }),
    fc.record({
      kind: fc.constant("counters" as const),
      pick,
      m: fc.nat(5),
      r: fc.nat(5),
      q: fc.nat(5),
      g: fc.nat(5),
    }),
  ];
  const perfidia: fc.Arbitrary<Perturbation>[] = [
    fc.record({ kind: fc.constant("battlePoints" as const), pick, units: fc.nat(9) }),
    fc.record({ kind: fc.constant("garrison" as const), count: fc.integer({ min: 1, max: 30 }) }),
    fc.constant<Perturbation>({ kind: "reschedule" }),
    fc.record({
      kind: fc.constant("crown" as const),
      amount: fc.integer({ min: 0, max: 500 }),
      count: fc.integer({ min: 1, max: 30 }),
    }),
    fc.record({
      kind: fc.constant("allyOutgoing" as const),
      pick,
      arriveIn: fc.integer({ min: 900, max: 30000 }),
    }),
    fc.record({ kind: fc.constant("returnOrigin" as const), pick }),
  ];
  return fc.oneof(...common, ...(ref === "perfidia-1@1.0.0" ? perfidia : []));
};

const gwEdit: fc.Arbitrary<GwEdit> = fc.oneof(
  fc.record({
    kind: fc.constant("note" as const),
    pick: fc.nat(10),
    text: fc.string({ maxLength: 30 }),
  }),
  fc.record({
    kind: fc.constant("day" as const),
    pick: fc.nat(10),
    attacks: fc.nat(20),
    messages: fc.nat(20),
  }),
  fc.record({ kind: fc.constant("archive" as const), pick: fc.nat(10), n: fc.nat(30) }),
);

const players = (ref: Ref): number => (ref === "perfidia-1@1.0.0" ? 8 : 6);

async function world(ref: Ref): Promise<{ snap: Staged["snap"]; gw: GatewayState }> {
  const run = await cachedRun({
    ...daySpec(ref, LOCKSTEP, 17, { players: players(ref) }),
    snapshotEvery: 6,
  });
  return { snap: snapshotAt(run, HOUR), gw: gatewayAt(run.lines, HOUR) };
}

describe("P10 at tool level: hidden data never changes what a seat gets", () => {
  for (const ref of REFS) {
    test(`${ref}: every tool, errors included, and the briefing`, async () => {
      const { snap, gw } = await world(ref);
      const n = players(ref);
      let changed = 0;
      let applied = 0;
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: n }),
          fc.array(perturbation(ref), { minLength: 1, maxLength: 6 }),
          fc.array(gwEdit, { maxLength: 3 }),
          (xn, list, edits) => {
            const x: PlayerId = `p${xn}`;
            const base = loadChecked(snap);
            const s = stage(snap, x, base.rules);
            const staged = loadChecked(s.snap);
            const r = staged.read();
            const p = perturb(s, r, list);
            applied += p.applied;
            const perturbed = loadChecked(p.snap);
            if (perturbed.hash() !== staged.hash()) changed += 1;
            // The perturbations stayed hidden: every movement X cannot see in the perturbed world
            // is one X could not see before, or a new one.
            const before = new Set(sortedIds(r.state.movements));
            for (const m of sortedIds(perturbed.read().state.movements)) {
              if (!before.has(m)) expect(hiddenMovements(perturbed, x)).toContain(m);
            }
            const calls = callsFor(r, s, gw);
            const gw2 = editGateway(gw, x, edits, r.now);
            const a = seenBy(s.snap, structuredClone(gw), x, calls);
            const b = seenBy(p.snap, gw2, x, calls);
            expect(b).toHaveLength(a.length);
            for (let i = 0; i < a.length; i += 1) expect(b[i]).toBe(a[i]);
          },
        ),
        { numRuns: 12 },
      );
      // Not vacuous: the perturbations found targets and changed the state.
      expect(applied).toBeGreaterThan(12);
      expect(changed).toBeGreaterThan(6);
    }, 60000);
  }

  for (const ref of REFS) {
    test(`${ref}: recall_troops on another player's movement reads exactly like a missing id`, async () => {
      const { snap, gw } = await world(ref);
      const base = loadChecked(snap);
      const s = stage(snap, "p1", base.rules);
      const m = loadChecked(s.snap);
      const r = m.read();
      // A hidden movement between others too.
      const p = perturb(s, r, [{ kind: "support", pick: 0, count: 2, arriveIn: 3600 }]);
      expect(p.applied).toBe(1);
      const withHidden = loadChecked(p.snap);
      const theirs = sortedIds(withHidden.read().state.movements).filter(
        (id) => withHidden.read().state.movements[id]?.owner !== "p1",
      );
      expect(theirs.length).toBeGreaterThan(1);
      expect(s.attackOnX !== null && theirs.includes(s.attackOnX)).toBe(true);
      const missing = opaqueId(s.snap.setup.idKey, "m", 1, 999);
      const session = new ToolSession(withHidden, structuredClone(gw), "p1");
      const answer = (id: string): string =>
        canonicalJson(session.call({ tool: "recall_troops", args: { movement: id } })).replaceAll(
          id,
          "<id>",
        );
      const expected = answer(missing);
      expect(expected).toContain("UNKNOWN_ID");
      for (const id of theirs) expect(answer(id)).toBe(expected);
    }, 30000);
  }

  test("an ally's outgoing movement: never shown in perfidia-1, shown in full in sandbox-1", async () => {
    for (const ref of REFS) {
      // oxlint-disable-next-line no-await-in-loop -- one world per ruleset, cached
      const { snap, gw } = await world(ref);
      const s = stage(snap, "p1", loadChecked(snap).rules);
      const movement = s.allyMovement;
      if (s.ally === null || movement === null) throw new Error(`${ref}: no ally movement staged`);
      const staged = loadChecked(s.snap);
      const r = staged.read();
      const access = visibilityOf(r).movementAccess("p1", movement);
      const allyCity = r.state.movements[movement]?.from ?? "c999";
      const calls: ToolCall[] = [
        { tool: "view_city", args: { city: allyCity } },
        { tool: "view_player", args: { player: "p1" } },
        { tool: "view_player", args: { player: s.ally } },
      ];
      const seen = seenBy(s.snap, structuredClone(gw), "p1", calls);
      if (ref === "perfidia-1@1.0.0") {
        expect(access).toBeNull();
        expect(seen.join("\n")).not.toContain(movement);
        // Another destination and arrival time: p1 sees exactly the same.
        const other = perturb(s, r, [{ kind: "allyOutgoing", pick: 1, arriveIn: 20000 }]);
        expect(other.applied).toBe(1);
        expect(seenBy(other.snap, structuredClone(gw), "p1", calls)).toEqual(seen);
      } else {
        expect(access).toBe("full");
        // The ally's city lists the movement with its composition.
        const view = seen[0] ?? "";
        expect(view).toContain(movement);
        expect(view).toMatch(/"units":\{"[a-z_]+":2\}/);
      }
    }
  }, 30000);
});
