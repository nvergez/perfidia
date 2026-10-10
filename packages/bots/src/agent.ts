// The bot turn engine (docs/architecture.md §11.1): one `SeatAgent` per seat and match, which plays
// a turn as a few rounds — gather (the rules once per match, its own player view, the map, its
// cities, then strategy reads), act (the strategy's calls, in priority order), end (`write_note`
// and `end_turn` with a self-wake). It respects the round and call caps of `RoundInput` and of
// `rules.gateway`, never throws on `{ok: false}`, and keeps no state across turns other than caches
// of data it could fetch again (the rules and travel times), held in the instance.

import {
  CityViewSchema,
  LeaderboardViewSchema,
  MapViewSchema,
  PlayerViewSchema,
  RulesInfoSchema,
  compareIds,
  type Briefing,
  type CityId,
  type PlayerId,
  type RoundInput,
  type RoundOutput,
  type SeatAgent,
  type ToolCall,
  type ToolResult,
  z,
} from "@perfidia/protocol";
import { hintsFor, NO_HINTS, type StrategyHints } from "./hints.ts";
import { DAY, call, fmtTime, makeKit, type Kit } from "./kit.ts";
import { encodeMemory, parseMemory, type Memory } from "./memory.ts";
import { Planner } from "./plan.ts";
import { streamOf } from "./rng.ts";
import type { Brain, StrategyDef } from "./strategies/strategy.ts";
import { buildWorld, emptyReads, type Reads, type World } from "./world.ts";

export interface BotOptions {
  /** The seat this bot plays. */
  readonly seat: PlayerId;
  /** The match seed (uint32): every choice is seeded from it, the seat and the round played. */
  readonly seed: number;
  /**
   * Ruleset hints. Omitted: the built-in hints of the briefing's ruleset (`hints.ts`); `null`: none,
   * so the bot plays from structured data alone.
   */
  readonly hints?: StrategyHints | null;
  /** Rethrow internal errors instead of ending the turn safely (tests). */
  readonly strict?: boolean;
}

/** Own city → island id → travel seconds per probe. */
type TravelRows = Map<CityId, Readonly<Record<string, readonly number[]>>>;

interface Act {
  readonly call: ToolCall;
  readonly result: ToolResult;
}

interface Plan {
  readonly calls: readonly ToolCall[];
  readonly memory: Memory;
  readonly cadence: number;
  readonly summary: readonly string[];
}

interface TurnState {
  readonly turn: number;
  readonly briefing: Briefing;
  /** The latest game time seen (briefing, then results). */
  t: number;
  memory: Memory;
  kit: Kit | null;
  readonly reads: Reads;
  /** Keys of read calls already issued this turn (never repeated, even when they failed). */
  readonly issued: Set<string>;
  /** Base reads (rules, own player, map, own cities), fixed at the first gathering round. */
  base: readonly ToolCall[] | null;
  /** Strategy reads, computed once the base reads are in. */
  extra: readonly ToolCall[] | null;
  /** The previous round's calls, matched with this round's results. */
  pending: readonly ToolCall[];
  plan: Plan | null;
  /** Plan calls already sent. */
  sent: number;
  readonly acts: Act[];
  /** Calls issued this turn (the per-wake cap). */
  used: number;
  /** `end_turn` was sent; a further round of this turn means it was rejected. */
  finished: boolean;
}

const keyOf = (c: ToolCall): string => `${c.tool}:${JSON.stringify(c.args)}`;

const READ_TOOLS: readonly string[] = Object.freeze([
  "rules",
  "view_player",
  "view_map",
  "view_city",
  "view_island",
  "leaderboard",
  "read_notes",
]);

export class BotAgent implements SeatAgent {
  readonly label: string;
  private readonly def: StrategyDef;
  private readonly o: BotOptions;
  private readonly brain: Brain;
  /** Rules by `(configHash, players)`; travel rows by the same key. Instance-owned (§11.1). */
  private readonly kits = new Map<string, Kit>();
  private readonly travel = new Map<string, TravelRows>();
  private state: TurnState | null = null;

  constructor(def: StrategyDef, o: BotOptions) {
    this.def = def;
    this.o = o;
    this.label = `bot:${def.name}@${def.version}`;
    this.brain = def.brain(streamOf(o.seed, o.seat, def.name, "params"));
  }

  round(input: RoundInput): Promise<RoundOutput> {
    try {
      return Promise.resolve(this.step(input));
    } catch (error) {
      if (this.o.strict === true) return Promise.reject(toError(error));
      const kit = this.state?.kit ?? null;
      this.state = null;
      return Promise.resolve(safeEnd(input, kit));
    }
  }

  private hints(b: Briefing): StrategyHints {
    if (this.o.hints === undefined) return hintsFor(b.ruleset);
    return this.o.hints ?? NO_HINTS;
  }

  private begin(input: RoundInput): TurnState {
    const memory = parseMemory(input.briefing.notes, this.def.name);
    const kit = memory.h === null ? null : (this.kits.get(memory.h) ?? null);
    return {
      turn: input.turn,
      briefing: input.briefing,
      t: input.briefing.t,
      memory,
      kit,
      reads: emptyReads(),
      issued: new Set(),
      base: null,
      extra: null,
      pending: [],
      plan: null,
      sent: 0,
      acts: [],
      used: 0,
      finished: false,
    };
  }

  private step(input: RoundInput): RoundOutput {
    let s = this.state;
    if (s === null || input.round === 0 || s.turn !== input.turn) {
      s = this.begin(input);
      this.state = s;
    } else {
      this.absorb(s, input.results);
    }
    // The briefing's budget carries the per-wake cap before the rules are known (§8.2).
    const fromBudget = s.briefing.budget.callsPerWake;
    const perWake =
      fromBudget === undefined ? (s.kit?.gateway.toolCallsPerWake ?? null) : fromBudget;
    const wakeLeft = perWake === null ? Number.MAX_SAFE_INTEGER : perWake - s.used;
    const cap = Math.min(input.maxCalls, wakeLeft);
    const roundsLeft = input.maxRounds - input.round;
    if (cap <= 0) return this.emit(s, [], undefined);
    if (s.finished) {
      // The previous round's `end_turn` was rejected: ask again, nothing else.
      const plan = s.plan!;
      const wakeAt = this.wakeAt(s, plan, this.settleMemory(s, plan.memory));
      return this.emit(s, [call("end_turn", { wakeAt })], undefined);
    }
    const room = Math.min(input.maxCalls, wakeLeft - 2);

    if (roundsLeft >= 3 && room > 0) {
      const reads = this.missingReads(s, input);
      if (reads.length > 0) return this.emit(s, reads.slice(0, room), undefined);
    }
    s.plan ??= this.makePlan(s, input);
    if (roundsLeft >= 2 && room > 0 && s.sent < s.plan.calls.length) {
      const chunk = s.plan.calls.slice(s.sent, s.sent + room);
      s.sent += chunk.length;
      return this.emit(s, chunk, undefined);
    }
    return this.finish(s, cap);
  }

  private emit(s: TurnState, calls: readonly ToolCall[], thought: string | undefined): RoundOutput {
    s.pending = calls;
    s.used += calls.length;
    for (const c of calls) if (READ_TOOLS.includes(c.tool)) s.issued.add(keyOf(c));
    return thought === undefined ? { calls: [...calls] } : { calls: [...calls], thought };
  }

  // Results.

  private absorb(s: TurnState, results: readonly ToolResult[]): void {
    const n = Math.min(s.pending.length, results.length);
    for (let i = 0; i < n; i += 1) {
      const c = s.pending[i]!;
      const r = results[i]!;
      if (typeof r !== "object" || r === null) continue;
      if (Number.isSafeInteger(r.t) && r.t > s.t) s.t = r.t;
      if (!READ_TOOLS.includes(c.tool)) {
        s.acts.push({ call: c, result: r });
        continue;
      }
      if (!r.ok) continue;
      this.absorbRead(s, c, r.data);
    }
    s.pending = [];
  }

  private absorbRead(s: TurnState, c: ToolCall, data: unknown): void {
    switch (c.tool) {
      case "rules": {
        const parsed = RulesInfoSchema.safeParse(data);
        if (!parsed.success) return;
        const kit = makeKit(parsed.data);
        this.kits.set(kit.key, kit);
        s.kit = kit;
        s.memory = { ...s.memory, h: kit.key };
        return;
      }
      case "view_player": {
        const parsed = PlayerViewSchema.safeParse(data);
        if (parsed.success && parsed.data.id === this.o.seat) s.reads.self = parsed.data;
        return;
      }
      case "view_map": {
        const parsed = MapViewSchema.safeParse(data);
        if (!parsed.success) return;
        s.reads.map = parsed.data;
        const { from, travel } = parsed.data;
        if (from !== undefined && travel !== undefined && s.kit !== null) {
          const row: Record<string, readonly number[]> = {};
          for (const [island, pairs] of Object.entries(travel))
            row[island] = pairs.map((p) => p[0]);
          this.travelRows(s.kit).set(from, row);
        }
        return;
      }
      case "view_city": {
        const parsed = CityViewSchema.safeParse(data);
        if (parsed.success) s.reads.views.set(parsed.data.id, parsed.data);
        return;
      }
      case "leaderboard": {
        const parsed = LeaderboardViewSchema.safeParse(data);
        if (parsed.success) s.reads.board = parsed.data;
        return;
      }
      default:
        return;
    }
  }

  private travelRows(kit: Kit): TravelRows {
    let rows = this.travel.get(kit.key);
    if (rows === undefined) {
      rows = new Map();
      this.travel.set(kit.key, rows);
    }
    return rows;
  }

  // Gathering.

  /**
   * The turn's base reads, fixed when the turn begins: the rules (unless cached), its own player
   * view, the map (from a city whose travel times are not cached yet), and its cities' full views.
   * City views are capped at about a third of the turn's call budget: cities whose build queue has
   * room come first (they need planning), the others in an order that rotates with the turn.
   */
  private baseReads(s: TurnState, input: RoundInput): ToolCall[] {
    const own = s.briefing.cities.map((c) => c.id).toSorted(compareIds);
    const base: ToolCall[] = [];
    if (s.kit === null) base.push(call("rules", {}));
    base.push(call("view_player", { player: this.o.seat }));
    const rows = s.kit === null ? null : this.travelRows(s.kit);
    const fromCity = own.find((id) => rows === null || !rows.has(id));
    base.push(call("view_map", fromCity === undefined ? {} : { fromCity }));

    const perWake = s.briefing.budget.callsPerWake ?? null;
    const perRound = Math.max(1, s.briefing.budget.callsPerRoundTrip);
    const turnCalls = Math.min(perWake ?? Number.MAX_SAFE_INTEGER, input.maxRounds * perRound);
    const views = Math.max(1, Math.floor(turnCalls / 3) - base.length);
    const queueLength = new Map(s.briefing.cities.map((c) => [c.id, c.build.length]));
    const shift = own.length === 0 ? 0 : s.turn % own.length;
    const rotated = [...own.slice(shift), ...own.slice(0, shift)];
    const order = rotated
      .map((id, i) => ({ id, i, queued: queueLength.get(id) ?? 0 }))
      .toSorted((a, b) => a.queued - b.queued || a.i - b.i)
      .slice(0, views)
      .map((x) => x.id)
      .toSorted(compareIds);
    for (const id of order) base.push(call("view_city", { city: id }));
    return base;
  }

  private missingReads(s: TurnState, input: RoundInput): ToolCall[] {
    s.base ??= this.baseReads(s, input);
    const missing = s.base.filter((c) => !s.issued.has(keyOf(c)));
    if (missing.length > 0 || s.kit === null) return missing;
    const own = s.briefing.cities.map((c) => c.id).toSorted(compareIds);

    if (s.extra === null) {
      const extra: ToolCall[] = [];
      const lacking = own.filter((id) => !this.travelRows(s.kit!).has(id)).slice(0, 2);
      for (const id of lacking) extra.push(call("view_map", { fromCity: id }));
      extra.push(...this.brain.reads(this.world(s, input)));
      const seen = new Set<string>();
      s.extra = extra.filter((c) => {
        const k = keyOf(c);
        if (seen.has(k) || s.issued.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return s.extra.filter((c) => !s.issued.has(keyOf(c)));
  }

  private world(s: TurnState, input: RoundInput): World {
    const kit = s.kit!;
    return buildWorld({
      seat: this.o.seat,
      turn: s.turn,
      t: s.t,
      briefing: s.briefing,
      kit,
      hints: this.hints(s.briefing),
      memory: s.memory,
      rng: streamOf(this.o.seed, this.o.seat, s.briefing.t, s.turn, input.round),
      reads: s.reads,
      travel: this.travelRows(kit),
    });
  }

  // Planning.

  private makePlan(s: TurnState, input: RoundInput): Plan {
    const cadence = this.brain.knobs.cadence;
    if (s.kit === null) return { calls: [], memory: s.memory, cadence, summary: ["no rules"] };
    const p = new Planner(this.world(s, input), this.brain.knobs);
    this.brain.plan(p);
    return { calls: p.calls, memory: p.memory, cadence, summary: p.summary };
  }

  // Ending.

  private finish(s: TurnState, cap: number): RoundOutput {
    const plan = s.plan!;
    const memory = this.settleMemory(s, plan.memory);
    const end = call("end_turn", { wakeAt: this.wakeAt(s, plan, memory) });
    const calls: ToolCall[] = [];
    let note: ToolCall | null = null;
    if (s.kit !== null && cap >= 2) {
      const text = encodeMemory(memory, s.kit.gateway.notesMaxChars);
      if (text !== s.briefing.notes) note = call("write_note", { text, mode: "replace" });
    }
    const fixed = note === null ? 1 : 2;
    calls.push(...plan.calls.slice(s.sent, s.sent + Math.max(0, cap - fixed)));
    s.sent += calls.length;
    if (note !== null) calls.push(note);
    calls.push(end);
    const done = plan.summary.length === 0 ? "nothing to do" : plan.summary.join("; ");
    const thought = `${this.def.name} ${fmtTime(s.t)}: ${done}`.slice(0, 280);
    s.finished = true;
    return this.emit(s, calls, thought);
  }

  /** Founding results replace the planned arrival estimates; failed ones are forgotten. */
  private settleMemory(s: TurnState, memory: Memory): Memory {
    const f: Record<string, number> = { ...memory.f };
    for (const a of s.acts) {
      if (a.call.tool !== "found_city") continue;
      const island = argOf(a.call, "island");
      if (typeof island !== "string") continue;
      if (a.result.ok) {
        const arrive = a.result.data["arrive"];
        if (Array.isArray(arrive) && typeof arrive[0] === "number") f[island] = arrive[0];
      } else {
        delete f[island];
      }
    }
    return { ...memory, f };
  }

  /**
   * The self-wake: the strategy's cadence, or earlier when a queue empties, a rejected call becomes
   * possible (`availableAt`) or a founding lands; never earlier than the wake budget allows (the
   * rest of the game day spread over the own wakes left) and always within `selfWake`.
   */
  private wakeAt(s: TurnState, plan: Plan, memory: Memory): number {
    const now = s.t;
    const gw = s.kit?.gateway;
    if (gw === undefined) return now + plan.cadence;
    const events: number[] = [];
    const lastEnd = new Map<string, number>();
    const bump = (key: string, end: number): void => {
      lastEnd.set(key, Math.max(lastEnd.get(key) ?? 0, end));
    };
    for (const c of s.briefing.cities) {
      for (const b of c.build) bump(`${c.id}/build`, b.end[0]);
      for (const [q, batches] of Object.entries(c.recruit)) {
        for (const b of batches) bump(`${c.id}/${q}`, b.end[0]);
      }
    }
    for (const a of s.acts) {
      const city = argOf(a.call, "city");
      if (!a.result.ok) {
        const at = a.result.details?.["availableAt"];
        if (typeof at === "number") events.push(at);
        continue;
      }
      if ((a.call.tool !== "build" && a.call.tool !== "recruit") || typeof city !== "string") {
        continue;
      }
      const items = a.result.data["items"];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const end = item["end"];
        if (item["ok"] !== true || !Array.isArray(end) || typeof end[0] !== "number") continue;
        const unit = item["unit"];
        const queue =
          typeof unit === "string" ? (s.kit?.units.get(unit)?.queue ?? "units") : "build";
        bump(`${city}/${queue}`, end[0]);
      }
    }
    events.push(...lastEnd.values());
    for (const at of Object.values(memory.f)) events.push(at + 60);

    let want = now + plan.cadence;
    for (const e of events) if (e > now && e < want) want = e;
    const own = s.briefing.budget.ownWakesLeft;
    const gap = Math.ceil((DAY - (now % DAY)) / Math.max(1, own));
    const lo = now + Math.max(gw.selfWake.min, Math.min(gap, gw.selfWake.max));
    const hi = now + gw.selfWake.max;
    return Math.min(hi, Math.max(lo, want));
  }
}

/** Ends the turn after an internal error (non-strict mode), with a self-wake inside the range. */
function safeEnd(input: RoundInput, kit: Kit | null): RoundOutput {
  if (input.maxCalls < 1) return { calls: [] };
  const range = kit?.gateway.selfWake ?? { min: 3600, max: 3600 };
  const wakeAt = input.briefing.t + Math.min(range.max, Math.max(range.min, 3600));
  return { calls: [call("end_turn", { wakeAt })], thought: "recovering" };
}

/** The `city` and `island` arguments of a call the bot built itself. */
const PlaceArgs = z.looseObject({ city: z.string().optional(), island: z.string().optional() });

function argOf(c: ToolCall, key: "city" | "island"): string | undefined {
  const parsed = PlaceArgs.safeParse(c.args);
  return parsed.success ? parsed.data[key] : undefined;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
