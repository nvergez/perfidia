// P15, transition non-interference (docs/architecture.md §13.2), through the harness for both
// rulesets, on states taken from 1-game-day bot runs and staged around a seat X (`hidden.ts`):
// (a) perturbing data hidden from X before a step (an action of X or of another seat, or the next
//     events) leaves X's copies of the step's non-intel events identical, once every opaque id not
//     owned by X is replaced by a placeholder of its kind and the copies are compared as a
//     multiset; the standard intel types and the ruleset's `intelEvents` are exempt;
// (b) inserting hidden-only actions by other seats (private messages between others, spies,
//     supports and shipments between others, builds and recruits) before X's calls leaves every
//     result X receives identical, ids included, and X's briefing too.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { relation, sortedIds, unitsAtHome } from "@perfidia/engine";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { canonicalJson, opaqueId, streamRng } from "@perfidia/engine/core";
import type { Match } from "@perfidia/engine/kernel";
import { buildBriefing, visibilityOf, type GatewayState, type WakeRecord } from "@perfidia/gateway";
import {
  INTEL_EVENT_TYPES,
  type Action,
  type DomainEvent,
  type Json,
  type PlayerId,
  type ToolCall,
} from "@perfidia/protocol";
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
import { perturb, stage, type Perturbation, type Staged } from "./hidden.ts";
import { intent, intentOf, type IntentKind } from "./intents.ts";

const HOUR = 12;
const WAKE: WakeRecord = {
  reasons: ["safety"],
  urgent: false,
  charge: null,
  day: 0,
  used: { own: 1, social: 1 },
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const OPAQUE = /^[mrqg][0-9a-hjkmnp-tv-z]{5}$/;

/** The opaque ids X owns in `r`: its own counters, through the keyed permutation (§4.1). */
function ownedBy(r: ReadCtx, x: PlayerId, idKey: string): Set<string> {
  const c = r.state.ids.own[x];
  const out = new Set<string>();
  if (c === undefined) return out;
  const n = Number(x.slice(1));
  for (const [prefix, count] of [
    ["m", c.m],
    ["r", c.r],
    ["q", c.q],
    ["g", c.g],
  ] as const) {
    for (let i = 1; i <= count; i += 1) out.add(opaqueId(idKey, prefix, n, i));
  }
  return out;
}

/** `value` with every opaque id not in `mine` replaced by `<prefix>`. */
function placeholders(value: Json, mine: ReadonlySet<string>): Json {
  if (typeof value === "string")
    return OPAQUE.test(value) && !mine.has(value) ? `<${value[0]}>` : value;
  if (Array.isArray(value)) return value.map((v) => placeholders(v, mine));
  if (value !== null && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) out[k] = placeholders(v, mine);
    return out;
  }
  return value;
}

/**
 * X's copies of `events`: those addressed to X or public, intel types left out, with only X's own
 * recipient entry (as X's archive shows it), opaque ids of others as placeholders; sorted, a multiset.
 */
function copiesOf(
  events: readonly DomainEvent[],
  x: PlayerId,
  intel: ReadonlySet<string>,
  mine: ReadonlySet<string>,
): string[] {
  return events
    .filter((e) => !intel.has(e.type) && (e.public || e.to.some((t) => t.p === x)))
    .map((e) =>
      canonicalJson(
        placeholders(
          {
            t: e.t,
            type: e.type,
            public: e.public,
            to: e.to.filter((t) => t.p === x),
            data: e.data,
          },
          mine,
        ),
      ),
    )
    .toSorted(byText);
}

/** A step: the next events, or one action of X or of another seat. */
type Step =
  | { readonly kind: "events" }
  | { readonly kind: "action"; readonly actor: "x" | "other"; readonly seed: number };

/**
 * An action of `actor` that X hears about: a message to X or to everyone, a pact offered to X, an
 * attack, support or shipment to X's capital (from another seat); X's own message, proposal,
 * attack, support or shipment (from X). Otherwise a random intent.
 */
function towardX(r: ReadCtx, actor: PlayerId, x: PlayerId, seed: number): Action {
  const rng = streamRng(seed, "p15");
  const st = r.state;
  const cities = sortedIds(st.cities);
  const mine =
    cities.find((c) => st.cities[c]?.capitalOf === actor) ??
    cities.find((c) => st.cities[c]?.owner === actor);
  const target =
    actor === x
      ? cities.find((c) => st.cities[c]?.owner !== x && st.cities[c]?.owner !== null)
      : cities.find((c) => st.cities[c]?.capitalOf === x);
  const someone =
    actor === x
      ? (sortedIds(st.players).find((p) => p !== x && relation(r, x, p) === "none") ?? x)
      : x;
  const home = mine === undefined ? {} : unitsAtHome(r, mine);
  const unit = Object.keys(home).find((u) => (home[u] ?? 0) > 1 && u !== r.rules.roles.settler);
  const choice = seed % 8;
  if (mine === undefined || target === undefined || choice >= 7) return intent(r, actor, rng);
  switch (choice) {
    case 0:
      return { type: "send_message", to: [someone], text: `to ${someone}` };
    case 1:
      return { type: "send_message", to: "all", text: "to everyone" };
    case 2:
      return { type: "propose", to: someone, kind: "pact", name: null, text: "peace", until: null };
    case 3:
      return unit === undefined
        ? intent(r, actor, rng)
        : { type: "attack", from: mine, to: target, units: { [unit]: 1 } };
    case 4:
      return unit === undefined
        ? intent(r, actor, rng)
        : { type: "support", from: mine, to: target, units: { [unit]: 1 } };
    case 5:
      return {
        type: "send_resources",
        from: mine,
        to: target,
        res: { wood: 3, stone: 0, gold: 0 },
      };
    default:
      return intent(r, actor, rng);
  }
}

function stepOnce(
  m: Match,
  step: Step,
  actor: PlayerId,
  x: PlayerId,
  at: number | null,
): DomainEvent[] {
  if (step.kind === "events") return at === null ? [] : m.advanceTo(at).events;
  const out = m.apply(actor, towardX(m.read(), actor, x, step.seed));
  return out.ok ? out.events : [];
}

const perturbation = (ref: Ref): fc.Arbitrary<Perturbation> => {
  const pick = fc.nat(40);
  const list: fc.Arbitrary<Perturbation>[] = [
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
      arriveIn: fc.integer({ min: 1, max: 30000 }),
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
  if (ref === "perfidia-1@1.0.0") {
    list.push(
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
    );
  }
  return fc.oneof(...list);
};

const players = (ref: Ref): number => (ref === "perfidia-1@1.0.0" ? 8 : 6);

async function world(ref: Ref, hour = HOUR): Promise<{ snap: Staged["snap"]; gw: GatewayState }> {
  const run = await cachedRun({
    ...daySpec(ref, LOCKSTEP, 17, { players: players(ref) }),
    snapshotEvery: 6,
  });
  return { snap: snapshotAt(run, hour), gw: gatewayAt(run.lines, hour) };
}

describe("P15 (a): hidden data before a step never changes X's copies of its non-intel events", () => {
  for (const ref of REFS) {
    test(`${ref}: the next events, X's actions and other seats' actions`, async () => {
      const worlds = await Promise.all([6, 12, 18].map((h) => world(ref, h)));
      const n = players(ref);
      let copies = 0;
      let changed = 0;
      fc.assert(
        fc.property(
          fc.nat(worlds.length - 1),
          fc.integer({ min: 1, max: n }),
          fc.oneof(
            fc.constant<Step>({ kind: "events" }),
            fc.record({
              kind: fc.constant("action" as const),
              actor: fc.constantFrom("x" as const, "other" as const),
              seed: fc.nat(1_000_000),
            }),
          ),
          fc.array(perturbation(ref), { minLength: 1, maxLength: 6 }),
          (w, xn, step, list) => {
            const snap = worlds[w]?.snap;
            if (snap === undefined) throw new Error("no world");
            const x: PlayerId = `p${xn}`;
            const s = stage(snap, x, loadChecked(snap).rules, { countdown: false });
            const a = loadChecked(s.snap);
            const r = a.read();
            // The actor of an action step: X, or a seat whose data the perturbations leave alone.
            const others = sortedIds(r.state.players).filter(
              (p) => p !== x && r.state.players[p]?.alive === true,
            );
            const actor =
              step.kind === "action" && step.actor === "other"
                ? (others[step.kind === "action" ? step.seed % others.length : 0] ?? x)
                : x;
            const p = perturb(s, r, list, actor === x ? [] : [actor]);
            const b = loadChecked(p.snap);
            if (b.hash() !== a.hash()) changed += 1;
            const at = a.nextEventTime();
            const ea = stepOnce(a, step, actor, x, at);
            const eb = stepOnce(b, step, actor, x, at);
            const intel = new Set<string>([...INTEL_EVENT_TYPES, ...(r.ruleset.intelEvents ?? [])]);
            const mine = ownedBy(a.read(), x, s.snap.setup.idKey);
            const ca = copiesOf(ea, x, intel, mine);
            copies += ca.length;
            expect(copiesOf(eb, x, intel, mine)).toEqual(ca);
          },
        ),
        { numRuns: 150 },
      );
      expect(changed).toBeGreaterThan(75);
      expect(copies).toBeGreaterThan(30);
    }, 60000);
  }
});

/** Hidden-only actions by seats other than X and X's allies, in cities X sees only publicly. */
function hiddenActions(
  r: ReadCtx,
  x: PlayerId,
  seed: number,
): { seat: PlayerId; call: ToolCall }[] {
  const rng = streamRng(seed, "p15b");
  const vis = visibilityOf(r);
  const st = r.state;
  const strangers = sortedIds(st.players).filter(
    (p) =>
      p !== x &&
      st.players[p]?.alive === true &&
      sortedIds(st.cities).every(
        (c) => st.cities[c]?.owner !== p || vis.cityAccess(x, c) === "public",
      ),
  );
  const out: { seat: PlayerId; call: ToolCall }[] = [];
  for (const [i, p] of strangers.entries()) {
    const q = strangers[(i + 1) % strangers.length];
    if (q === undefined || q === p) continue;
    const from = sortedIds(st.cities).find((c) => st.cities[c]?.owner === p);
    const to = sortedIds(st.cities).find((c) => st.cities[c]?.owner === q);
    if (from === undefined || to === undefined) continue;
    const home = unitsAtHome(r, from);
    const unit = Object.keys(home).find((u) => (home[u] ?? 0) > 0 && u !== r.rules.roles.settler);
    const kinds: IntentKind[] = ["build", "recruit"];
    for (const kind of kinds) {
      const a = intentOf(kind, r, p, rng);
      if (a.type === "build")
        out.push({
          seat: p,
          call: { tool: "build", args: { city: from, buildings: [a.building] } },
        });
      if (a.type === "recruit")
        out.push({
          seat: p,
          call: { tool: "recruit", args: { city: from, orders: [{ unit: a.unit, count: 1 }] } },
        });
    }
    out.push(
      { seat: p, call: { tool: "send_message", args: { to: [q], text: `between us, ${q}` } } },
      { seat: p, call: { tool: "spy", args: { from, to, gold: 20 } } },
      { seat: p, call: { tool: "send_resources", args: { from, to, wood: 7 } } },
    );
    if (unit !== undefined)
      out.push({ seat: p, call: { tool: "support", args: { from, to, units: { [unit]: 1 } } } });
  }
  return out;
}

/** X's calls: its own actions and reads (the same list as P10 uses, shorter). */
function xCalls(r: ReadCtx, x: PlayerId): ToolCall[] {
  const st = r.state;
  const cities = sortedIds(st.cities);
  const cx =
    cities.find((c) => st.cities[c]?.capitalOf === x) ??
    cities.find((c) => st.cities[c]?.owner === x) ??
    "c1";
  const other =
    cities.find((c) => st.cities[c]?.owner !== x && st.cities[c]?.owner !== null) ?? "c999";
  const someone = sortedIds(st.players).find((p) => p !== x) ?? "p99";
  const home = unitsAtHome(r, cx);
  const unit = Object.keys(home).find((u) => (home[u] ?? 0) > 1 && u !== r.rules.roles.settler);
  return [
    {
      tool: "build",
      args: { city: cx, buildings: r.rules.buildings.slice(0, 2).map((b) => b.id) },
    },
    {
      tool: "recruit",
      args: { city: cx, orders: [{ unit: r.rules.units[0]?.id ?? "x", count: 1 }] },
    },
    { tool: "send_message", args: { to: [someone], text: "hello" } },
    { tool: "propose_alliance", args: { to: someone, kind: "pact" } },
    { tool: "spy", args: { from: cx, to: other, gold: 25 } },
    { tool: "send_resources", args: { from: cx, to: other, stone: 4 } },
    ...(unit === undefined
      ? []
      : [{ tool: "attack", args: { from: cx, to: other, units: { [unit]: 1 } } }]),
    { tool: "write_note", args: { text: "after", mode: "append" } },
    { tool: "view_city", args: { city: cx } },
    { tool: "view_city", args: { city: other } },
    { tool: "view_player", args: { player: x } },
    { tool: "view_map", args: { fromCity: cx } },
    { tool: "leaderboard", args: {} },
    { tool: "read_notes", args: { search: {} } },
    { tool: "read_notes", args: { search: { scope: "mine" } } },
    { tool: "end_turn", args: { nextWakeIn: 5000 } },
  ];
}

describe("P15 (b): hidden-only actions of other seats never change X's results", () => {
  for (const ref of REFS) {
    test(`${ref}: messages, spies, supports and shipments between others, builds, recruits`, async () => {
      const { snap, gw } = await world(ref);
      const n = players(ref);
      let accepted = 0;
      fc.assert(
        fc.property(fc.integer({ min: 1, max: n }), fc.nat(1_000_000), (xn, seed) => {
          const x: PlayerId = `p${xn}`;
          const s = stage(snap, x, loadChecked(snap).rules);
          const plain = loadChecked(s.snap);
          const busy = loadChecked(s.snap);
          const gwPlain = structuredClone(gw);
          const gwBusy = structuredClone(gw);
          const calls = xCalls(plain.read(), x);
          for (const { seat, call } of hiddenActions(busy.read(), x, seed)) {
            if (new ToolSession(busy, gwBusy, seat).call(call).ok) accepted += 1;
          }
          const sa = new ToolSession(plain, gwPlain, x);
          const sb = new ToolSession(busy, gwBusy, x);
          for (const c of calls) {
            expect([c.tool, canonicalJson(sb.call(c))]).toEqual([
              c.tool,
              canonicalJson(sa.call(c)),
            ]);
          }
          expect(canonicalJson(buildBriefing(busy.read(), x, gwBusy, WAKE))).toBe(
            canonicalJson(buildBriefing(plain.read(), x, gwPlain, WAKE)),
          );
        }),
        { numRuns: 12 },
      );
      expect(accepted).toBeGreaterThan(30);
    }, 60000);
  }
});
