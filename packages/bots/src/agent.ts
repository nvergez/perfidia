// The bot turn engine (docs/architecture.md §11.1): one `SeatAgent` per seat and match, which plays
// a turn as a few rounds — gather (the rules once per match, its own player view, the map, its
// cities, then strategy reads), act (the strategy's calls, in priority order), end (`write_note`
// and `end_turn` with a self-wake). It respects the round and call caps of `RoundInput` and of
// `rules.gateway`, never throws on `{ok: false}`, and keeps no state across turns other than caches
// of data it could fetch again (the rules and travel times), held in the instance. Its only random
// draws are its strategy parameters, once per match (rng.ts).

import {
  CityViewSchema,
  LeaderboardViewSchema,
  MapViewSchema,
  PlayerViewSchema,
  RulesInfoSchema,
  TOOL_RESULT_DATA,
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
import { call, fmtTime, makeKit, type Kit } from "./kit.ts";
import { encodeMemory, parseMemory, type Memory } from "./memory.ts";
import { Planner } from "./plan.ts";
import { streamOf } from "./rng.ts";
import type { Brain, StrategyDef } from "./strategies/strategy.ts";
import { chooseWake } from "./wake.ts";
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
  /**
   * Rethrow internal errors instead of ending the turn safely, and throw on a successful read
   * whose data does not parse with its protocol schema (tests: protocol drift must fail loudly).
   */
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
  /** Foundings in flight when the turn began; this turn's own are added from their results. */
  readonly foundings: Memory["f"];
  /** The estimated arrival of each planned `found_city` call. */
  readonly etas: ReadonlyMap<ToolCall, number>;
  readonly cadence: number;
  readonly summary: readonly string[];
}

interface TurnState {
  readonly turn: number;
  readonly briefing: Briefing;
  /** The latest game time seen (briefing, then results). */
  t: number;
  /** The longest game-time step between two rounds of this turn (0 in lockstep). */
  step: number;
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
      step: 0,
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
      const wakeAt = this.wakeAt(s, plan, this.settleMemory(s, plan, []));
      return this.emit(s, [call("end_turn", { wakeAt })], undefined);
    }
    const room = Math.min(input.maxCalls, wakeLeft - 2);

    if (roundsLeft >= 3 && room > 0) {
      const reads = this.missingReads(s, input);
      if (reads.length > 0) return this.emit(s, reads.slice(0, room), undefined);
    }
    s.plan ??= this.makePlan(s);
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
    let latest = s.t;
    for (let i = 0; i < n; i += 1) {
      const c = s.pending[i]!;
      const r = results[i]!;
      if (typeof r !== "object" || r === null) continue;
      if (Number.isSafeInteger(r.t) && r.t > latest) latest = r.t;
      if (!READ_TOOLS.includes(c.tool)) {
        s.acts.push({ call: c, result: r });
        continue;
      }
      if (!r.ok) continue;
      this.absorbRead(s, c, r.data);
    }
    s.step = Math.max(s.step, latest - s.t);
    s.t = latest;
    s.pending = [];
  }

  /** A successful read whose data does not parse: ignored, or an error in strict mode. */
  private malformed(c: ToolCall, error: z.ZodError): void {
    if (this.o.strict === true) {
      throw new Error(`${c.tool} result does not parse: ${error.message}`);
    }
  }

  private absorbRead(s: TurnState, c: ToolCall, data: unknown): void {
    switch (c.tool) {
      case "rules": {
        const parsed = RulesInfoSchema.safeParse(data);
        if (!parsed.success) return this.malformed(c, parsed.error);
        const kit = makeKit(parsed.data);
        this.kits.set(kit.key, kit);
        s.kit = kit;
        s.memory = { ...s.memory, h: kit.key };
        return;
      }
      case "view_player": {
        const parsed = PlayerViewSchema.safeParse(data);
        if (!parsed.success) return this.malformed(c, parsed.error);
        if (parsed.data.id === this.o.seat) s.reads.self = parsed.data;
        return;
      }
      case "view_map": {
        const parsed = MapViewSchema.safeParse(data);
        if (!parsed.success) return this.malformed(c, parsed.error);
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
        if (!parsed.success) return this.malformed(c, parsed.error);
        s.reads.views.set(parsed.data.id, parsed.data);
        return;
      }
      case "leaderboard": {
        const parsed = LeaderboardViewSchema.safeParse(data);
        if (!parsed.success) return this.malformed(c, parsed.error);
        s.reads.board = parsed.data;
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
   * City views are capped at about a third of the turn's call budget: cities under attack come
   * first (they need defending), then cities whose build queue has room (they need planning), the
   * others in an order that rotates with the turn.
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
    const threatened = new Set<string>(
      s.briefing.incoming.filter((inc) => inc.kind === "attack").map((inc) => inc.to),
    );
    const shift = own.length === 0 ? 0 : s.turn % own.length;
    const rotated = [...own.slice(shift), ...own.slice(0, shift)];
    const order = rotated
      .map((id, i) => ({
        id,
        i,
        safe: threatened.has(id) ? 0 : 1,
        queued: queueLength.get(id) ?? 0,
      }))
      .toSorted((a, b) => a.safe - b.safe || a.queued - b.queued || a.i - b.i)
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
      extra.push(...this.brain.reads(this.world(s)));
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

  private world(s: TurnState): World {
    const kit = s.kit!;
    return buildWorld({
      seat: this.o.seat,
      turn: s.turn,
      t: s.t,
      briefing: s.briefing,
      kit,
      hints: this.hints(s.briefing),
      memory: s.memory,
      reads: s.reads,
      travel: this.travelRows(kit),
    });
  }

  // Planning.

  private makePlan(s: TurnState): Plan {
    const cadence = this.brain.knobs.cadence;
    if (s.kit === null) {
      const none = new Map<ToolCall, number>();
      const summary = ["no rules"];
      return { calls: [], memory: s.memory, foundings: s.memory.f, etas: none, cadence, summary };
    }
    const p = new Planner(this.world(s), this.brain.knobs);
    this.brain.plan(p);
    return {
      calls: p.calls,
      memory: p.memory,
      foundings: p.startFoundings,
      etas: p.foundEtas,
      cadence,
      summary: p.summary,
    };
  }

  // Ending.

  private finish(s: TurnState, cap: number): RoundOutput {
    const plan = s.plan!;
    // The last plan calls ride with `end_turn` (and `write_note` when the notes change): the memory
    // written must count the foundings among them, whose results the bot will never see.
    const rest = (fixed: number): ToolCall[] =>
      plan.calls.slice(s.sent, s.sent + Math.max(0, cap - fixed));
    let tail = rest(1);
    let memory = this.settleMemory(s, plan, tail);
    let note: ToolCall | null = null;
    if (s.kit !== null && cap >= 2) {
      const max = s.kit.gateway.notesMaxChars;
      if (encodeMemory(memory, max) !== s.briefing.notes) {
        tail = rest(2);
        memory = this.settleMemory(s, plan, tail);
        note = call("write_note", { text: encodeMemory(memory, max), mode: "replace" });
      }
    }
    const end = call("end_turn", { wakeAt: this.wakeAt(s, plan, memory) });
    const calls: ToolCall[] = [...tail];
    s.sent += tail.length;
    if (note !== null) calls.push(note);
    calls.push(end);
    const done = plan.summary.length === 0 ? "nothing to do" : plan.summary.join("; ");
    const thought = `${this.def.name} ${fmtTime(s.t)}: ${done}`.slice(0, 280);
    s.finished = true;
    return this.emit(s, calls, thought);
  }

  /**
   * The memory to write: the plan's, with the foundings in flight rebuilt from the ones known when
   * the turn began, the arrivals of this turn's accepted `found_city` calls, and the planned
   * arrivals of those in `unanswered` (sent with `end_turn`, so without a result). Planned foundings
   * that were rejected or never sent are not counted.
   */
  private settleMemory(s: TurnState, plan: Plan, unanswered: readonly ToolCall[]): Memory {
    const f: Record<string, number[]> = {};
    const add = (island: string | undefined, at: unknown): void => {
      if (typeof island !== "string" || typeof at !== "number") return;
      f[island] = [...(f[island] ?? []), at].toSorted((x, y) => x - y);
    };
    for (const [island, etas] of Object.entries(plan.foundings)) f[island] = [...etas];
    for (const a of s.acts) {
      if (a.call.tool !== "found_city" || !a.result.ok) continue;
      const arrive = a.result.data["arrive"];
      if (Array.isArray(arrive)) add(argOf(a.call, "island"), arrive[0]);
    }
    for (const c of unanswered) add(argOf(c, "island"), plan.etas.get(c));
    return { ...plan.memory, f };
  }

  /**
   * The self-wake (`chooseWake`), from what the bot waits for: the end of each of its queues (the
   * briefing's, then this turn's accepted items), the `availableAt` of every time-gated rejection
   * (a whole call, or one item of a `build`/`recruit` batch) and each founding's arrival.
   */
  private wakeAt(s: TurnState, plan: Plan, memory: Memory): number {
    const events: number[] = [];
    const lastEnd = new Map<string, number>();
    const bump = (key: string, end: number): void => {
      lastEnd.set(key, Math.max(lastEnd.get(key) ?? 0, end));
    };
    const retry = (details: Readonly<Record<string, unknown>> | undefined): void => {
      const at = details?.["availableAt"];
      if (typeof at === "number") events.push(at);
    };
    for (const c of s.briefing.cities) {
      for (const b of c.build) bump(`${c.id}/build`, b.end[0]);
      for (const [q, batches] of Object.entries(c.recruit)) {
        for (const b of batches) bump(`${c.id}/${q}`, b.end[0]);
      }
    }
    for (const a of s.acts) {
      if (!a.result.ok) {
        retry(a.result.details);
        continue;
      }
      const city = argOf(a.call, "city");
      if (typeof city !== "string") continue;
      if (a.call.tool === "build") {
        const data = TOOL_RESULT_DATA.build.safeParse(a.result.data);
        for (const item of data.success ? data.data.items : []) {
          if (item.ok) bump(`${city}/build`, item.end[0]);
          else retry(item.details);
        }
      } else if (a.call.tool === "recruit") {
        const data = TOOL_RESULT_DATA.recruit.safeParse(a.result.data);
        for (const item of data.success ? data.data.items : []) {
          if (!item.ok) {
            retry(item.details);
            continue;
          }
          const queue = s.kit?.units.get(item.unit)?.queue ?? "units";
          bump(`${city}/${queue}`, item.end[0]);
        }
      }
    }
    events.push(...lastEnd.values());
    for (const etas of Object.values(memory.f)) for (const at of etas) events.push(at + 60);
    return chooseWake({
      now: s.t,
      step: s.step,
      cadence: plan.cadence,
      selfWake: s.kit?.gateway.selfWake ?? null,
      ownWakesLeft: s.briefing.budget.ownWakesLeft,
      events,
    });
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
