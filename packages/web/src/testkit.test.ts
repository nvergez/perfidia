// Fixtures for the web's unit tests (no tests here): a small valid meta and frame, and steps that
// change players' scores and carry feed items, all checked against the protocol's schemas once.

import {
  FrameSchema,
  MatchMetaSchema,
  StepSchema,
  type FeedItem,
  type Frame,
  type MatchMeta,
  type PlayerEnt,
  type SeatInfo,
  type Step,
} from "@perfidia/protocol/spectator";

export const TIMELINE = "0123456789abcdef";

export function player(id: `p${number}`, rank: number, score = 0): PlayerEnt {
  return {
    id,
    alive: true,
    eliminatedAt: null,
    alliance: null,
    rank,
    score,
    parts: { cityPoints: score },
    cities: 1,
    relations: [],
    army: { pop: 0, units: {} },
    ext: {},
  };
}

export function seat(id: `p${number}`, i: number, o: Partial<SeatInfo> = {}): SeatInfo {
  return {
    seat: id,
    kind: "llm",
    name: ["Odysseus", "Achilles", "Penelope", "Agamemnon"][i] ?? `Seat ${i}`,
    label: `llm:anthropic/claude-opus-5-5/medium:x@1:${id}`,
    color: i,
    fake: false,
    model: { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" },
    profile: null,
    handoffBot: null,
    ...o,
  };
}

export interface MetaOptions {
  readonly matchEnd?: number;
  readonly dominationStart?: number;
  readonly dominationHold?: number;
  readonly ruleset?: string;
  readonly clock?: MatchMeta["clock"];
}

export function meta(o: MetaOptions = {}): MatchMeta {
  const matchEnd = o.matchEnd ?? 604_800;
  return MatchMetaSchema.parse({
    format: "perfidia-spectator/1",
    id: "m1",
    title: "Test match",
    description: null,
    ruleset: o.ruleset ?? "perfidia-1@1.1.0",
    engine: "0.1.0",
    configHash: "0".repeat(64),
    rulesHash: "1".repeat(64),
    config: {
      time: {
        dominationStart: o.dominationStart ?? 259_200,
        dominationHold: o.dominationHold ?? 86_400,
        matchEnd,
      },
    },
    clock: o.clock ?? { kind: "lockstep", maxTurnsPerSecond: 3 },
    matchEnd,
    seats: [seat("p1", 0), seat("p2", 1)],
    map: { width: 600, height: 600, islands: [] },
    status: "ended",
    reason: "time",
    wallStart: null,
    lastSeq: 100,
    lastT: 1000,
    logId: "2".repeat(64),
    timeline: TIMELINE,
    keyframes: [0],
    verified: { ok: true, divergence: null },
  });
}

export function frame(seq = 0, t = 0, o: Partial<Frame> = {}): Frame {
  return FrameSchema.parse({
    format: "perfidia-spectator/1",
    match: "m1",
    timeline: TIMELINE,
    seq,
    t,
    status: "live",
    result: null,
    ext: {},
    cities: {},
    queues: {},
    movements: {},
    players: { p1: player("p1", 1), p2: player("p2", 2) },
    seats: {},
    alliances: {},
    pacts: [],
    proposals: [],
    ...o,
  });
}

/** A feed item of kind `end` (the simplest), with the step's id. */
export function endItem(seq: number, t: number, importance: 0 | 1 | 2 | 3 = 1): FeedItem {
  return { k: "end", id: `${seq}:0`, t, players: [], importance, reason: "time", winners: [] };
}

/** A step setting p1's score to `score` (and carrying an item when `item`). */
export function scoreStep(seq: number, t: number, score: number, item = false): Step {
  return StepSchema.parse({
    seq,
    t,
    patch: { playerFields: { p1: { score } } },
    ...(item ? { items: [endItem(seq, t)] } : {}),
  });
}

/** The frame after every step with `t ≤ until` (score steps only), computed directly. */
export function naive(base: Frame, steps: readonly Step[], until: number): Frame {
  const last = steps.findLast((s) => s.t <= until);
  if (last === undefined) return base;
  const score = steps.findLast(
    (s) => s.t <= until && s.patch?.playerFields?.p1?.score !== undefined,
  )?.patch?.playerFields?.p1?.score;
  const p1 = base.players.p1;
  if (score === undefined || p1 === undefined) return { ...base, seq: last.seq, t: last.t };
  return { ...base, seq: last.seq, t: last.t, players: { ...base.players, p1: { ...p1, score } } };
}
