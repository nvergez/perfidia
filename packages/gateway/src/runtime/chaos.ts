import { randInt, streamRng, type Rng } from "@perfidia/engine/core";
import {
  RulesInfoSchema,
  TOOL_NAMES,
  TOOL_RESULT_DATA,
  ToolResultSchema,
  MapViewSchema,
  type Json,
  type PlayerId,
  type RoundInput,
  type RoundOutput,
  type SeatAgent,
  type ToolCall,
  type ToolName,
} from "@perfidia/protocol";

// The chaos agent (docs/architecture.md §11.2, §13.2 P12 and P16): a test agent, not a bot strategy.
// It sends seeded random calls to every tool, the ruleset's extra tools and unknown ones, with
// valid-looking arguments built from what it was told (its cities, the map, the rules, its
// movements and proposals) and with junk; it ends turns in every way the interface allows (and
// some it forbids: both end_turn fields, calls after end_turn, calls beyond the caps). It checks
// every result it receives against the protocol schemas (P12), and then mutates every object it
// received (P16): since the host hands it canonical copies, neither the match, the log nor another
// seat may notice. Its choices depend only on its seed and on what it received, read before the
// mutation, so a mutating and a non-mutating instance play identically.

export interface ChaosOptions {
  readonly seat: PlayerId;
  readonly seed: number;
  /** Mutate every object received (default true). */
  readonly mutate?: boolean;
  /** Default `chaos@1`. */
  readonly label?: string;
}

/** Thrown when a result does not match the protocol schemas (P12): a gateway bug. */
export class ChaosResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChaosResultError";
  }
}

interface Knowledge {
  buildings: string[];
  units: string[];
  extras: string[];
  cities: string[];
  islands: string[];
  players: number;
}

function isToolName(s: string): s is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(s);
}

const pick = <T>(rng: Rng, list: readonly T[], fallback: T): T =>
  list.length === 0 ? fallback : (list[randInt(rng, 0, list.length - 1)] ?? fallback);

const chance = (rng: Rng, percent: number): boolean => randInt(rng, 0, 99) < percent;

/** A junk JSON-like value: wrong types, odd numbers, odd strings, nested objects and arrays. */
function junk(rng: Rng, depth = 0): unknown {
  switch (randInt(rng, 0, depth >= 2 ? 6 : 8)) {
    case 0:
      return null;
    case 1:
      return chance(rng, 50);
    case 2:
      return pick(rng, [0, -1, 1, 7, 65535, 4294967296, 9007199254740991, -9007199254740991], 0);
    case 3:
      return pick(rng, [1.5, -0.25, 1e21], 1.5);
    case 4:
      return pick(
        rng,
        ["", "x", "c1", "p1", "i1", "m00000", "constructor", "__proto__", "\u0000\ud800é"],
        "",
      );
    case 5:
      return "a".repeat(randInt(rng, 0, 64));
    case 6:
      return pick(rng, ["max", "all", "public", "append", "replace"], "max");
    case 7:
      return Array.from({ length: randInt(rng, 0, 3) }, () => junk(rng, depth + 1));
    default: {
      const out: Record<string, unknown> = {};
      for (let i = randInt(rng, 0, 3); i > 0; i -= 1) {
        out[
          pick(rng, ["city", "units", "to", "from", "id", "x", "__proto__", "constructor"], "x")
        ] = junk(rng, depth + 1);
      }
      return out;
    }
  }
}

function idOf(rng: Rng, prefix: string, max: number): string {
  return `${prefix}${randInt(rng, 1, max)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deeply mutates every object and array reachable from `value`. */
function scramble(value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) scramble(v);
    value.push("chaos");
    value.reverse();
    return;
  }
  if (!isRecord(value)) return;
  const rec = value;
  for (const key of Object.keys(rec)) {
    const v = rec[key];
    scramble(v);
    if (typeof v === "number") rec[key] = -v - 1;
    else if (typeof v === "string") rec[key] = `${v}!`;
    else if (typeof v === "boolean") rec[key] = !v;
  }
  rec["chaos"] = true;
}

export class ChaosAgent implements SeatAgent {
  readonly label: string;
  private readonly o: ChaosOptions;
  private readonly know: Knowledge = {
    buildings: [],
    units: [],
    extras: [],
    cities: [],
    islands: [],
    players: 2,
  };
  private lastCalls: readonly ToolCall[] = [];

  constructor(o: ChaosOptions) {
    this.o = o;
    this.label = o.label ?? "chaos@1";
  }

  round(input: RoundInput): Promise<RoundOutput> {
    this.check(input);
    this.learn(input);
    const view = this.extract(input);
    const { seat, turn, round, maxCalls } = input;
    if (this.o.mutate ?? true) scramble(input);
    const out = this.decide(seat, turn, round, maxCalls, view);
    this.lastCalls = out.calls;
    return Promise.resolve(out);
  }

  /** P12: every result is a schema-valid `ToolResult`, and a success's data matches its tool's schema. */
  private check(input: RoundInput): void {
    for (const [i, result] of input.results.entries()) {
      const parsed = ToolResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new ChaosResultError(`result ${i} is not a ToolResult: ${parsed.error.message}`);
      }
      const call = this.lastCalls[i];
      if (call === undefined || !parsed.data.ok) continue;
      if (!isToolName(call.tool)) continue;
      const schema = TOOL_RESULT_DATA[call.tool];
      const data = schema.safeParse(parsed.data.data);
      if (!data.success) {
        throw new ChaosResultError(
          `${call.tool} data does not match its schema: ${data.error.message}`,
        );
      }
    }
    if (input.round === 0 && input.results.length > 0) {
      throw new ChaosResultError("round 0 carries results");
    }
  }

  /** Ids from the rules and the map, kept for the match (data it could read again). */
  private learn(input: RoundInput): void {
    for (const [i, result] of input.results.entries()) {
      const call = this.lastCalls[i];
      if (call === undefined || !result.ok) continue;
      if (call.tool === "rules") {
        const info = RulesInfoSchema.safeParse(result.data);
        if (!info.success) continue;
        this.know.buildings = info.data.rules.buildings.map((b) => b.id);
        this.know.units = info.data.rules.units.map((u) => u.id);
        this.know.extras = info.data.extraTools.map((t) => t.name);
        this.know.players = info.data.rules.players;
      } else if (call.tool === "view_map") {
        const map = MapViewSchema.safeParse(result.data);
        if (!map.success) continue;
        this.know.islands = map.data.islands.map((x) => x.id);
        this.know.cities = map.data.cities.map((c) => c.id);
      }
    }
  }

  /** What the briefing tells it, read before the input is mutated. */
  private extract(input: RoundInput): {
    own: string[];
    movements: string[];
    proposals: string[];
    messages: string[];
    t: number;
  } {
    const b = input.briefing;
    return {
      own: b.cities.map((c) => c.id),
      movements: [...b.moves.map((m) => m.id), ...b.incoming.map((m) => m.id)],
      proposals: b.proposals.filter((p) => p.to === input.seat).map((p) => p.id),
      messages: b.msgs.map((m) => m.id),
      t: b.t,
    };
  }

  private decide(
    seat: PlayerId,
    turn: number,
    round: number,
    maxCalls: number,
    v: { own: string[]; movements: string[]; proposals: string[]; messages: string[]; t: number },
  ): RoundOutput {
    const rng = streamRng(this.o.seed, `chaos:${seat}:${turn}:${round}:${v.t}`);
    if (round === 0) {
      return {
        calls: [
          { tool: "rules", args: {} },
          { tool: "view_map", args: {} },
        ],
      };
    }
    if (chance(rng, 8)) return { calls: [], thought: "nothing to say" };
    const n = randInt(rng, 1, maxCalls + 2);
    const calls: ToolCall[] = [];
    for (let i = 0; i < n; i += 1) calls.push(this.call(rng, v));
    if (chance(rng, 35)) {
      const at = randInt(rng, 0, calls.length);
      calls.splice(at, 0, { tool: "end_turn", args: this.endTurnArgs(rng, v.t) });
    }
    return { calls, thought: `chaos ${turn}.${round}` };
  }

  private endTurnArgs(rng: Rng, t: number): Json {
    switch (randInt(rng, 0, 4)) {
      case 0:
        return {};
      case 1:
        return { nextWakeIn: randInt(rng, 0, 60000) };
      case 2:
        return { wakeAt: t + randInt(rng, 0, 60000) };
      case 3:
        return { nextWakeIn: 600, wakeAt: t + 600 };
      default:
        return { wakeAt: randInt(rng, 0, Math.max(0, t)) };
    }
  }

  private call(
    rng: Rng,
    v: { own: string[]; movements: string[]; proposals: string[]; messages: string[] },
  ): ToolCall {
    const k = this.know;
    const tools = [...TOOL_NAMES, ...k.extras, "no_such_tool"];
    const tool = pick(rng, tools, "view_map");
    if (chance(rng, 20)) return { tool, args: junk(rng) };
    const own = (): string => pick(rng, v.own, "c1");
    const city = (): string => pick(rng, k.cities, idOf(rng, "c", 30));
    const island = (): string => pick(rng, k.islands, idOf(rng, "i", 30));
    const player = (): string => idOf(rng, "p", Math.max(2, k.players + 1));
    const unit = (): string => pick(rng, k.units, "unknown_unit");
    const units = (): Record<string, number> => ({ [unit()]: randInt(rng, 1, 40) });
    const amount = (): number => randInt(rng, 0, 400);
    switch (tool) {
      case "view_city":
        return { tool, args: { city: chance(rng, 50) ? own() : city() } };
      case "view_island":
        return { tool, args: { island: island() } };
      case "view_map":
        return { tool, args: chance(rng, 50) ? {} : { fromCity: own() } };
      case "view_player":
        return { tool, args: { player: player() } };
      case "leaderboard":
      case "rules":
        return { tool, args: {} };
      case "build":
        return {
          tool,
          args: {
            city: own(),
            buildings: Array.from({ length: randInt(rng, 1, 3) }, () =>
              pick(rng, k.buildings, "unknown_building"),
            ),
          },
        };
      case "recruit":
        return {
          tool,
          args: {
            city: own(),
            orders: Array.from({ length: randInt(rng, 1, 3) }, () => ({
              unit: unit(),
              count: chance(rng, 50) ? "max" : randInt(rng, 1, 30),
            })),
          },
        };
      case "cancel_queue":
        return { tool, args: { city: own(), item: randInt(rng, 1, 12) } };
      case "send_resources":
        return { tool, args: { from: own(), to: city(), wood: amount(), stone: amount() } };
      case "attack":
      case "support":
        return { tool, args: { from: own(), to: city(), units: units() } };
      case "spy":
        return { tool, args: { from: own(), to: city(), gold: randInt(rng, 0, 300) } };
      case "recall_troops":
        switch (randInt(rng, 0, 2)) {
          case 0:
            return { tool, args: { movement: pick(rng, v.movements, "m00000") } };
          case 1:
            return {
              tool,
              args: chance(rng, 50)
                ? { stationedAt: city() }
                : { stationedAt: city(), home: own(), units: units() },
            };
          default:
            return { tool, args: { dismiss: { city: own(), player: player() } } };
        }
      case "found_city":
        return {
          tool,
          args: chance(rng, 70)
            ? { from: own(), island: island(), units: units() }
            : { from: own(), island: island(), units: units(), slot: randInt(rng, 0, 3) },
        };
      case "send_message":
        return {
          tool,
          args: {
            to: chance(rng, 30) ? "all" : [player()],
            text: `hello ${randInt(rng, 0, 999)}`,
          },
        };
      case "propose_alliance":
        return {
          tool,
          args: chance(rng, 50)
            ? { to: player(), kind: "pact", text: "peace?" }
            : { to: player(), kind: "alliance", name: `Bloc ${randInt(rng, 1, 9)}` },
        };
      case "answer_proposal":
        return { tool, args: { id: pick(rng, v.proposals, "q00000"), accept: chance(rng, 70) } };
      case "leave_alliance":
        return { tool, args: chance(rng, 50) ? {} : { with: player() } };
      case "write_note":
        return {
          tool,
          args: {
            text: "n".repeat(randInt(rng, 0, chance(rng, 10) ? 9000 : 200)),
            mode: chance(rng, 50) ? "append" : "replace",
          },
        };
      case "read_notes":
        return {
          tool,
          args: chance(rng, 40)
            ? { search: { scope: pick(rng, ["public", "all"], "all"), text: "a" } }
            : chance(rng, 50)
              ? { open: pick(rng, v.messages, "g00000") }
              : {},
        };
      case "end_turn":
        return { tool, args: this.endTurnArgs(rng, 0) };
      default:
        // An extra tool or an unknown one: city-and-name arguments, or none.
        return {
          tool,
          args: chance(rng, 60) ? { city: own(), name: `Chaos ${randInt(rng, 1, 99)}` } : {},
        };
    }
  }
}

/** A chaos agent for one seat of one match. */
export function createChaosAgent(o: ChaosOptions): SeatAgent {
  return new ChaosAgent(o);
}
