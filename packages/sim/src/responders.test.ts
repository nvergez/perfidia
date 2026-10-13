// The war-call responders (docs/architecture.md §11.2: opportunist@3, turtle@3) on a real seeded
// perfidia-1 match, through the gateway. Their caller is a stand-in that lives in this test only
// (never registered): conqueror@2 that, at its first turn from D3 02:00 with an ally, launches a
// raid on the nearest city of a common enemy (no relation to it or, by the leaderboard, to its
// ally) that its ally can reach too (estimated from the islands' coordinates), and calls its ally,
// in one private message, to strike there in an hour around its own landing (`composeCall`). On
// seed 16, p4 (opportunist@3, allied with p5 from the first hour) answers yes, launches at its
// planned time and lands inside the window: a joint attack after a call (`teamRecords`). The same
// seed gives the same log. The match is cut at the end of day 3 to keep the test fast.

import { describe, expect, test } from "bun:test";
import { composeCall, parseWar, type WarCall } from "@perfidia/bots";
import {
  LeaderboardViewSchema,
  MapViewSchema,
  PlayerViewSchema,
  type EvLine,
  type LogLine,
  type PlayerId,
  type RoundInput,
  type RoundOutput,
  type SeatAgent,
  type ToolCall,
} from "@perfidia/protocol";
import { MemorySink } from "@perfidia/gateway";
import { teamRecords } from "./batch/index.ts";
import { normalisedHash, prepareBotRun, runPrepared, type BotRunSpec } from "./harness/index.ts";

const DAY = 86400;
/** The stand-in calls from this time on. */
const CALL_FROM = 2 * DAY + 2 * 3600;
/** Its raid's target is at least this far: its allies need the time to hear and to land. */
const MIN_TRAVEL = 3 * 3600;

const spec = (seed: number): BotRunSpec => ({
  ruleset: "perfidia-1@1.0.0",
  seed,
  players: 6,
  days: 3,
  bots: ["expander@2", "rusher@3", "turtle@3", "opportunist@3", "conqueror@2", "expander@2"],
  clock: { kind: "lockstep" },
  strict: true,
});

const call = (tool: ToolCall["tool"], args: Record<string, unknown>): ToolCall => ({ tool, args });

/**
 * The stand-in caller: `inner` plays every turn, except that the first turn from `CALL_FROM` on
 * with an ally starts with two rounds of its own (its player view and its capital's map, then the
 * raid and the call), after which `inner` plays the rest of the turn from its first round.
 */
class StandInCaller implements SeatAgent {
  readonly label = "test:caller";
  /** The call it sent, and to whom. */
  sent: { call: WarCall; to: PlayerId[] } | null = null;
  private shift = 0;

  constructor(
    private readonly inner: SeatAgent,
    private readonly seat: PlayerId,
  ) {}

  round(input: RoundInput): Promise<RoundOutput> {
    if (input.round === 0) {
      this.shift = 0;
      const capital = input.briefing.cities[0]?.id;
      if (this.sent === null && input.briefing.t >= CALL_FROM && capital !== undefined) {
        if (input.maxRounds >= 6 && input.maxCalls >= 3) {
          this.shift = 1;
          return Promise.resolve({
            calls: [
              call("view_player", { player: this.seat }),
              call("view_map", { fromCity: capital }),
              call("leaderboard", {}),
            ],
          });
        }
      }
    }
    if (this.shift === 1 && input.round === 1) {
      const calls = this.raid(input);
      if (calls.length > 0) {
        this.shift = 2;
        return Promise.resolve({ calls });
      }
    }
    return this.inner.round({
      ...input,
      round: input.round - this.shift,
      maxRounds: input.maxRounds - this.shift,
      results: input.round === this.shift ? [] : input.results,
    });
  }

  /** The raid and the call, from the reads of round 0; none without an ally or a target. */
  private raid(input: RoundInput): ToolCall[] {
    const [playerResult, mapResult, boardResult] = input.results;
    if (playerResult?.ok !== true || mapResult?.ok !== true) return [];
    const self = PlayerViewSchema.safeParse(playerResult.data);
    const map = MapViewSchema.safeParse(mapResult.data);
    if (!self.success || !map.success || map.data.travel === undefined) return [];
    const allies = self.data.relations.filter((r) => r.kind === "ally").map((r) => r.player);
    // Neither its relations nor its allies' (the leaderboard's): a common enemy.
    const board =
      boardResult?.ok === true ? LeaderboardViewSchema.safeParse(boardResult.data) : null;
    const related = new Set(self.data.relations.map((r) => r.player));
    for (const s of board?.success === true ? board.data.standings : []) {
      if (!allies.includes(s.player)) continue;
      for (const r of s.relations) related.add(r.player);
    }
    const home = input.briefing.cities[0];
    if (allies.length === 0 || home === undefined) return [];
    const probe = Math.max(0, (map.data.probes ?? []).indexOf("transport"));
    const t = input.briefing.t;
    // The ally's trip, estimated from the islands' coordinates (perfidia-1 §7.2: 60 s a tile
    // with transports, an hour at least): the target must be within its reach too.
    const isle = new Map<string, (typeof map.data.islands)[number]>(
      map.data.islands.map((i) => [i.id, i]),
    );
    const allyHome = map.data.cities.find((c) => c.capitalOf === allies[0])?.island;
    const allyTrip = (island: string): number => {
      const a = allyHome === undefined ? undefined : isle.get(allyHome);
      const b = isle.get(island);
      if (a === undefined || b === undefined) return Number.MAX_SAFE_INTEGER;
      const d = Math.ceil(Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2));
      return Math.max(3600, 60 * d);
    };
    const targets = map.data.cities
      .filter((c) => c.owner !== null && c.owner !== this.seat && !related.has(c.owner))
      .filter((c) => c.ext === undefined || !Object.hasOwn(c.ext, "siege"))
      .map((c) => ({ c, travel: map.data.travel?.[c.island]?.[probe]?.[0] ?? null }))
      .filter(
        (x): x is { c: (typeof map.data.cities)[number]; travel: number } =>
          x.travel !== null && x.travel >= MIN_TRAVEL && allyTrip(x.c.island) + 1200 <= x.travel,
      )
      .toSorted((a, b) => a.travel - b.travel || a.c.id.localeCompare(b.c.id));
    const target = targets[0];
    const raiders = Math.min(home.units["raider"] ?? 0, (home.units["transport"] ?? 0) * 20);
    if (target === undefined || target.c.owner === null || raiders < 10) return [];
    const lands = t + target.travel;
    const warCall: WarCall = {
      id: "k1",
      role: "strike",
      target: target.c.id,
      t0: Math.max(t + 4200, lands - 1800),
      t1: lands + 1800,
      vs: target.c.owner,
      lands,
    };
    this.sent = { call: warCall, to: allies };
    return [
      call("send_message", { to: allies, text: composeCall(warCall) }),
      call("attack", {
        from: home.id,
        to: target.c.id,
        units: { raider: raiders, transport: Math.ceil(raiders / 20) },
      }),
    ];
  }
}

async function runWithCaller(seed: number): Promise<{ lines: LogLine[]; caller: StandInCaller }> {
  const prepared = prepareBotRun(spec(seed));
  const inner = prepared.options.agents.get("p5");
  if (inner === undefined) throw new Error("no p5");
  const caller = new StandInCaller(inner, "p5");
  const agents = new Map(prepared.options.agents);
  agents.set("p5", caller);
  const sink = new MemorySink();
  await runPrepared({ ...prepared, options: { ...prepared.options, agents } }, sink);
  return { lines: sink.parsed(), caller };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const events = (lines: readonly LogLine[], type: string): EvLine[] =>
  lines.filter((l): l is EvLine => l.k === "ev" && l.e.type === type);

describe("war calls on a real match (perfidia-1, 6 seats, days 1–3)", () => {
  test("seed 16: opportunist@3 answers its ally's call, launches in time and joins the strike", async () => {
    const { lines, caller } = await runWithCaller(16);
    expect(lines.at(-1)?.k).toBe("end");
    const sent = caller.sent;
    if (sent === null) throw new Error("the stand-in never called");
    expect(sent.to).toEqual(["p4"]);
    // p4's answer: a yes, with a landing inside the window.
    const answers = events(lines, "message")
      .filter((l) => l.e.data["from"] === "p4")
      .flatMap((l) => parseWar(str(l.e.data["text"])))
      .flatMap((i) => (i.kind === "ack" && i.ack.id === "k1" ? [i.ack] : []));
    expect(answers.map((a) => a.yes)).toEqual([true]);
    // Its strike left after the answer and landed inside the window.
    const strikes = events(lines, "incoming_attack").filter(
      (l) => l.e.data["by"] === "p4" && l.e.data["to"] === sent.call.target,
    );
    expect(strikes.length).toBeGreaterThan(0);
    const arrive = Number(strikes[0]!.e.data["arriveAt"]);
    expect(arrive).toBeGreaterThanOrEqual(sent.call.t0);
    expect(arrive).toBeLessThanOrEqual(sent.call.t1);
    // Both battles at the target: a joint attack after a call.
    const joint = teamRecords(lines, null).joint.filter((j) => j.city === sent.call.target);
    expect(joint.map((j) => [j.players, j.caller])).toEqual([[["p4", "p5"], "p5"]]);
    // p3 (turtle@3) starts no war: it sends no call, and attacks only the besieger of a city under
    // siege (no countdown runs before day 4).
    const sieges = new Map<string, string>();
    for (const l of lines) {
      if (l.k === "ev" && l.e.type === "siege_started") {
        sieges.set(str(l.e.data["city"]), str(l.e.data["by"]));
      } else if (l.k === "ev" && (l.e.type === "siege_broken" || l.e.type === "city_conquered")) {
        sieges.delete(str(l.e.data["city"]));
      } else if (l.k === "act" && l.seat === "p3" && l.r.ok && l.a.type === "attack") {
        const by = sieges.get(l.a.to);
        expect([l.a.to, by !== undefined && by !== "p3"]).toEqual([l.a.to, true]);
      } else if (l.k === "act" && l.seat === "p3" && l.a.type === "send_message") {
        expect(parseWar(l.a.text).filter((i) => i.kind === "call")).toEqual([]);
      }
    }
    const again = await runWithCaller(16);
    expect(normalisedHash(again.lines)).toBe(normalisedHash(lines));
  }, 60_000);
});
