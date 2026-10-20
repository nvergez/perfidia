// Per seat per match statistics (phase-4 design §6.1, §8.8): on the war golden and on fake arena
// runs they equal the dossier's counts (the fold's turns and messages, the web's tally of turns,
// messages and betrayals) and the ranks equal the end line's standings; on fake runs every figure
// the orchestrator's own `arena.json` reports independently (attempts, stops, errors, refusals,
// wake and prompt caps, cost, tokens, turns, thoughts, rejections, calls, the hand-off) is the same;
// `--no-costs` leaves cost, tokens and model time out; and hand-made feeds pin the rules the logs do
// not reach (pacts kept and broken, alliances joined, same-model pairs, self-identification, the
// preflight split, the parallel-call share).

import { beforeAll, describe, expect, test } from "bun:test";
import {
  ArenaReportAnySchema,
  LlmLogLineSchema,
  MatchStatsSchema,
  SeatsFileSchema,
  type AllianceId,
  type ArenaReportAny,
  type FeedItem,
  type LlmCallLine,
  type LlmLogLine,
  type LogLine,
  type MatchStats,
  type PlayerId,
  type SeatsFile,
  type Step,
} from "@perfidia/protocol";
import { foldLog, type SpectatorFold } from "../fold/fold.ts";
import { seatTally } from "../reduce/index.ts";
import { WAR_GOLDEN, fakeRun, golden, type FakeRun } from "../testkit.test.ts";
import { ID_MAX, PART_MAX, idPart, modelIdOf, parseLabel } from "./keys.ts";
import { foldedOf, statsOfLog } from "./log.ts";
import {
  NAME_MAX_CHARS,
  SELF_ID,
  malformedCall,
  matchStats,
  nameOf,
  type FoldedMatch,
} from "./match.ts";

const LONG = 120_000;

let warLines: LogLine[] = [];
let warFold: SpectatorFold;
let war: MatchStats;

beforeAll(() => {
  warLines = golden(WAR_GOLDEN);
  warFold = foldLog(warLines, { match: "war" });
  war = MatchStatsSchema.parse(
    matchStats(foldedOf(warFold), {}, { match: "war", status: "ended" }),
  );
}, LONG);

const endLine = (lines: readonly LogLine[]): Extract<LogLine, { k: "end" }> => {
  const end = lines.at(-1);
  if (end?.k !== "end") throw new Error("no end line");
  return end;
};

/** Every feed item of a fold. */
const itemsOf = (fold: SpectatorFold): FeedItem[] => fold.steps.flatMap((s) => s.items ?? []);

/** The dossier's counts and the web's tally must equal the statistics, seat by seat. */
function expectDossierCounts(stats: MatchStats, fold: SpectatorFold): void {
  const items = itemsOf(fold);
  for (const s of stats.seats) {
    const counts = fold.counts(s.seat);
    if (counts === null) throw new Error(`no counts of ${s.seat}`);
    const tally = seatTally(items, s.seat);
    expect([s.seat, s.play.turns, s.diplomacy.messagesSent, s.diplomacy.messagesReceived]).toEqual([
      s.seat,
      counts.turns,
      counts.messagesSent,
      counts.messagesReceived,
    ]);
    expect([
      s.seat,
      s.play.turns,
      s.diplomacy.messagesSent,
      s.diplomacy.messagesReceived,
      s.diplomacy.betrayalsCommitted,
      s.diplomacy.betrayalsSuffered,
    ]).toEqual([
      s.seat,
      tally.turns,
      tally.messagesSent,
      tally.messagesReceived,
      tally.betrayalsCommitted,
      tally.betrayalsSuffered,
    ]);
  }
}

/** Ranks, scores, cities and winners equal the end line's standings. */
function expectStandings(stats: MatchStats, lines: readonly LogLine[]): void {
  const end = endLine(lines);
  expect(stats.endedAt).toBe(end.t);
  expect(stats.result).toEqual({ reason: end.result.reason, winners: end.result.winners });
  const bySeat = stats.seats
    .map((s) => [s.seat, s.outcome.rank, s.outcome.score, s.outcome.cities, s.outcome.alive])
    .toSorted((a, b) => Number(a[1]) - Number(b[1]));
  expect(bySeat).toEqual(
    end.result.standings.map((s) => [s.player, s.rank, s.score, s.cities, s.alive]),
  );
  for (const s of stats.seats) {
    expect([s.seat, s.outcome.winner]).toEqual([s.seat, end.result.winners.includes(s.seat)]);
  }
}

/** War golden events of a type. */
const events = (type: string): number =>
  warLines.filter((l) => l.k === "ev" && l.e.type === type).length;

/** A figure summed over the war golden's seats. */
const sum = (f: (s: MatchStats["seats"][number]) => number): number =>
  war.seats.reduce((n, s) => n + f(s), 0);

describe("the war golden (six bots, six days)", () => {
  test("its counts equal the dossier's: turns, messages sent and received, betrayals", () => {
    expectDossierCounts(war, warFold);
    expect(war.seats.map((s) => s.diplomacy.messagesSent).reduce((a, b) => a + b, 0)).toBe(10);
    expect(
      war.seats.map((s) => [s.seat, s.diplomacy.betrayalsCommitted, s.diplomacy.betrayalsSuffered]),
    ).toEqual([
      ["p1", 0, 0],
      ["p2", 1, 0],
      ["p3", 0, 1],
      ["p4", 0, 0],
      ["p5", 0, 0],
      ["p6", 0, 0],
    ]);
  });

  test("ranks, scores, cities and winners equal the end line's standings", () => {
    expectStandings(war, warLines);
    expect(war.rated).toBe(true);
    expect(war.result?.reason).toBe("domination");
  });

  test("battles, conquests, foundings and proposals add up to the log's events", () => {
    expect(sum((s) => s.military.battlesAttacked)).toBe(events("battle"));
    expect(events("battle")).toBe(42);
    expect(sum((s) => s.military.citiesConquered)).toBe(events("city_conquered"));
    expect(sum((s) => s.military.citiesFounded)).toBe(events("city_founded"));
    expect(sum((s) => s.diplomacy.proposalsSent)).toBe(7);
    expect(sum((s) => s.diplomacy.proposalsReceived)).toBe(7);
    expect(sum((s) => s.diplomacy.alliancesFounded)).toBeGreaterThan(0);
    // p2's betrayal of p3 broke an alliance, not a pact.
    expect(sum((s) => s.diplomacy.pactsBroken)).toBe(0);
    expect(sum((s) => s.diplomacy.pactsSigned) % 2).toBe(0);
  });

  test("a bot-only run: bot keys, no model, no operations, no cost, nothing to collude", () => {
    expect(war.seats.map((s) => [s.kind, s.key, s.id])).toEqual([
      ["bot", "bot:conqueror@3", "bot.conqueror.3"],
      ["bot", "bot:opportunist@3", "bot.opportunist.3"],
      ["bot", "bot:turtle@3", "bot.turtle.3"],
      ["bot", "bot:conqueror@3", "bot.conqueror.3"],
      ["bot", "bot:expander@2", "bot.expander.2"],
      ["bot", "bot:rusher@3", "bot.rusher.3"],
    ]);
    for (const s of war.seats) {
      expect([s.model, s.operations, s.cost, s.play.wakes, s.diplomacy.sameModel]).toEqual([
        null,
        null,
        null,
        0,
        null,
      ]);
      expect(s.incidents.parallelPermille).toBeNull();
    }
    expect(war.cost).toBeNull();
    expect(war.collusion).toEqual({
      samePairs: 0,
      crossPairs: 0,
      same: { messages: 0, pacts: 0, alliances: 0 },
      cross: { messages: 0, pacts: 0, alliances: 0 },
    });
    expect(war.seats.every((s) => s.diplomacy.selfIdentification === 0)).toBe(true);
  });

  test("statsOfLog folds the log itself; an unverifiable log is never rated", () => {
    const again = statsOfLog(warLines, {}, { match: "war" });
    expect(again).toEqual(war);
    const t = warLines.findIndex((l) => l.k === "ckpt");
    const bad = warLines.map((l, i) =>
      i === t && l.k === "ckpt" ? { ...l, h: "0000000000000000" } : l,
    );
    const broken = statsOfLog(bad, {}, { match: "war", status: "unverifiable" });
    expect([broken.verified, broken.rated]).toEqual([false, false]);
  });
});

// Fake arena runs -------------------------------------------------------------------------------

interface Side {
  readonly calls: LlmLogLine[];
  readonly seats: SeatsFile;
  readonly arena: ReturnType<typeof ArenaReportAnySchema.parse>;
}

function sideOf(run: Pick<FakeRun, "calls" | "seats" | "arena">): Side {
  return {
    calls: run.calls,
    seats: SeatsFileSchema.parse(run.seats),
    arena: ArenaReportAnySchema.parse(run.arena),
  };
}

function statsOf(
  lines: readonly LogLine[],
  side: Side,
  costs = true,
): { stats: MatchStats; fold: SpectatorFold } {
  const fold = foldLog(lines, { match: "fake" });
  const stats = matchStats(
    foldedOf(fold),
    { calls: side.calls, seats: side.seats, fake: side.arena.fake },
    { match: "fake", status: "ended", costs },
  );
  return { stats: MatchStatsSchema.parse(stats), fold };
}

/** The statistics of an LLM seat against the orchestrator's own report of it. */
function expectArenaSeat(
  s: MatchStats["seats"][number],
  r: ArenaReportAny["seats"][number] | undefined,
): void {
  if (r === undefined) throw new Error(`no report of ${s.seat}`);
  const ops = s.operations;
  const cost = s.cost;
  if (ops === null || cost === null) throw new Error(`${s.seat}: no operations or cost`);
  expect([s.seat, ops.attempts, ops.stops, ops.errors]).toEqual([
    r.seat,
    r.attempts,
    r.stops,
    r.errors,
  ]);
  expect([s.seat, s.incidents.refusals, s.incidents.wakeCaps]).toEqual([
    r.seat,
    r.refusals,
    r.wakeCaps,
  ]);
  const { reasoning: _reasoning, ...tokens } = cost.tokens;
  expect([s.seat, cost.nanoUsd, tokens]).toEqual([r.seat, r.costNanoUsd, r.tokens]);
  expect([s.seat, s.play.wakes, s.play.thoughts, s.play.calls, s.play.rejections]).toEqual([
    r.seat,
    r.thoughts.turns,
    r.thoughts.withThought,
    r.calls,
    r.rejections,
  ]);
  const byWhy = Object.fromEntries(Object.entries(r.thoughts.byWhy).map(([k, v]) => [k, v.turns]));
  expect([s.seat, s.play.endings]).toEqual([r.seat, byWhy]);
  expect([s.seat, s.model?.model, s.model?.effort, s.profile]).toEqual([
    r.seat,
    r.model,
    r.effort,
    r.profile,
  ]);
}

/** The seats without their cost and model time. */
const strip = (m: MatchStats): unknown =>
  m.seats.map((s) => ({
    ...s,
    cost: null,
    operations: s.operations === null ? null : { ...s.operations, latencyMs: null, ttftMs: null },
  }));

describe("fake arena runs", () => {
  let plain: FakeRun;
  let secret: FakeRun;
  beforeAll(async () => {
    plain = await fakeRun({ days: 1, seed: 3 });
    secret = await fakeRun({ days: 1, seed: 4, secrets: true });
  }, LONG);

  test(
    "counts equal the dossier's and ranks the standings; LLM figures equal arena.json's",
    () => {
      for (const run of [plain, secret]) {
        const side = sideOf(run);
        const { stats, fold } = statsOf(run.lines, side);
        expectDossierCounts(stats, fold);
        expectStandings(stats, run.lines);
        expect(stats.rated).toBe(true);
        expect(stats.fake).toBe(true);
        const llm = stats.seats.filter((s) => s.kind === "llm");
        expect(llm.length).toBeGreaterThan(0);
        for (const s of llm) {
          expect(s.fake).toBe(true);
          expect(s.key.startsWith("fake/")).toBe(true);
          expectArenaSeat(
            s,
            side.arena.seats.find((r) => r.seat === s.seat),
          );
        }
        // The run's spend: every attempt, the start preflight and probes.
        const total = side.calls.reduce(
          (n, l) => n + (l.k === "llm_call" || l.k === "preflight" ? l.costNanoUsd : 0),
          0,
        );
        expect(stats.cost?.nanoUsd).toBe(total);
        expect(stats.cost?.budgetNanoUsd).toBe(side.seats.budgetNanoUsd ?? null);
      }
    },
    LONG,
  );

  test("the planted refusal and failure are counted, never their texts", () => {
    const { stats } = statsOf(secret.lines, sideOf(secret));
    const p1 = stats.seats.find((s) => s.seat === "p1");
    const p2 = stats.seats.find((s) => s.seat === "p2");
    expect(p1?.incidents.refusals).toEqual({ cyber: 1 });
    expect(p2?.operations?.errors).toEqual({ overloaded: 1 });
    const text = JSON.stringify(stats);
    for (const planted of ["PLANTED-REFUSAL-EXPLANATION", "PLANTED-ERROR-MESSAGE", "req_PLANTED"]) {
      expect([planted, text.includes(planted)]).toEqual([planted, false]);
    }
  });

  test("--no-costs: no cost, no tokens, no model time; everything else unchanged", () => {
    const side = sideOf(plain);
    const shown = statsOf(plain.lines, side).stats;
    const hidden = statsOf(plain.lines, side, false).stats;
    expect(hidden.published).toEqual({ costs: false });
    expect(hidden.cost).toBeNull();
    for (const s of hidden.seats) {
      expect([
        s.seat,
        s.cost,
        s.operations?.latencyMs ?? null,
        s.operations?.ttftMs ?? null,
      ]).toEqual([s.seat, null, null, null]);
    }
    expect(strip(hidden)).toEqual(strip(shown));
    expect(JSON.stringify(hidden)).not.toContain('NanoUsd":1');
  });
});

// Hand-made feeds ---------------------------------------------------------------------------------

/** A folded match with the war golden's header, these controllers, these feed items and this end. */
function handMade(controllers: Record<string, string>, items: readonly FeedItem[]): FoldedMatch {
  const header = warLines[0];
  if (header?.k !== "header") throw new Error("no header");
  const frame = warFold.frame();
  const steps: Step[] = items.map((item, i) => ({ seq: i + 1, t: item.t, items: [item] }));
  return {
    header: { ...header, controllers },
    steps,
    frame,
    verified: { ok: true, divergence: null },
    lastT: items.at(-1)?.t ?? 0,
  };
}

const base = { importance: 1 };
const diplomacy = (
  id: string,
  t: number,
  event: Extract<FeedItem, { k: "diplomacy" }>["event"],
  players: PlayerId[],
  o: { alliance?: AllianceId; cause?: "left" | "betrayal" | "eliminated" | "superseded" } = {},
): FeedItem => ({
  ...base,
  k: "diplomacy",
  id,
  t,
  players,
  event,
  alliance: o.alliance ?? null,
  name: null,
  cause: o.cause ?? null,
  expiresAt: null,
});

/** An `llm_call` line of a Haiku seat: `calls` tool calls, a fallback on turn 3. */
const call = (seat: string, turn: number, calls: number, cost: number): LlmLogLine =>
  LlmLogLineSchema.parse({
    k: "llm_call",
    seat,
    turn,
    round: 0,
    attempt: 1,
    kind: "round",
    t: turn * 100,
    latencyMs: turn * 10,
    ttftMs: null,
    provider: "anthropic",
    model: "claude-haiku-5-5",
    servedBy: "claude-haiku-5-5",
    effort: "medium",
    maxTokens: 16000,
    stop: calls === 0 ? "end_turn" : "tool_use",
    rawStop: null,
    refusal: null,
    fallback: turn === 3,
    cacheMiss: false,
    usage: [
      {
        model: "claude-haiku-5-5",
        kind: "message",
        input: 100,
        cacheWrite5m: 100,
        cacheWrite1h: 0,
        cacheRead: 800,
        output: 50,
        estimated: false,
      },
    ],
    costNanoUsd: cost,
    seatSpentNanoUsd: cost,
    capNanoUsd: 5_000_000_000,
    wakeSpentNanoUsd: cost,
    unpriced: [],
    calls,
    textChars: 10,
    reasoningChars: 20,
    requestId: null,
    error: null,
  });

/** A `seats.json` without seats, and one LLM seat of it (the hostile-strings test). */
const SEATS_BASE = {
  harness: "perfidia-harness@2",
  promptVersion: 2,
  prompts: { shared: "s", operator: "o", tools: "t" },
  seats: [],
};
const LLM_SEAT = {
  kind: "llm",
  label: "llm:compat/m/medium:odysseus@1:p2",
  effort: "medium",
  maxTokens: 16_000,
  capNanoUsd: 5_000_000_000,
  profile: {
    id: "odysseus",
    version: 1,
    name: "Odysseus, the schemer",
    goal: "g",
    temperament: "t",
    word: "w",
    style: "s",
    handoffBot: "bot:opportunist@3",
  },
  handoffBot: "bot:opportunist@3",
  prompt: "0".repeat(64),
} as const;

describe("hand-made feeds", () => {
  const LABELS = {
    p1: "llm:anthropic/claude-haiku-5-5/medium:odysseus@1:p2",
    p2: "llm:anthropic/claude-haiku-5-5/medium:achilles@1:p2",
    p3: "llm:openai/gpt-6-luna/medium:penelope@1:p2-dev",
    p4: "llm:openrouter/z-ai%2Fglm-5.3-flash@z-ai%2Ffp8/low:agamemnon@1:p2-env",
    p5: "bot:opportunist@3",
    p6: "bot:conqueror@3",
  };

  test("pacts kept and broken, alliances joined and left, same-model and cross-model pairs", () => {
    const items: FeedItem[] = [
      diplomacy("1:0", 10, "pact_signed", ["p1", "p2"]),
      diplomacy("2:0", 11, "pact_signed", ["p1", "p3"]),
      diplomacy("3:0", 12, "pact_signed", ["p3", "p4"]),
      diplomacy("4:0", 13, "pact_signed", ["p4", "p5"]),
      // p3 betrays its pact with p4; the pact ends by betrayal: kept by neither.
      {
        ...base,
        k: "betrayal",
        id: "5:0",
        t: 20,
        players: ["p3", "p4"],
        importance: 3,
        by: "p3",
        against: "p4",
        relation: "pact",
        city: "c1",
        context: { messages: [], thoughts: [], since: 12 },
      },
      diplomacy("6:0", 20, "pact_ended", ["p3", "p4"], { cause: "betrayal" }),
      // p1–p2 expires (kept by both); p1–p3 and p4–p5 are active at the end (kept by all four).
      diplomacy("7:0", 30, "pact_expired", ["p1", "p2"]),
      diplomacy("8:0", 40, "alliance_formed", ["p1", "p2"], { alliance: "a1" }),
      diplomacy("9:0", 41, "alliance_joined", ["p1", "p2", "p3"], { alliance: "a1" }),
      diplomacy("10:0", 42, "alliance_left", ["p2", "p1", "p3"], { alliance: "a1", cause: "left" }),
      {
        ...base,
        k: "message",
        id: "11:0",
        t: 50,
        players: ["p1", "p2", "p3"],
        message: "g1",
        from: "p1",
        to: ["p2", "p3"],
        private: true,
        text: "As a Claude model I keep my word.",
        turn: 1,
      },
      {
        ...base,
        k: "message",
        id: "12:0",
        t: 51,
        players: ["p4"],
        message: "g2",
        from: "p4",
        to: "all",
        private: false,
        text: "Olympus will fall; Claudette agrees.",
        turn: 1,
      },
    ];
    const stats = MatchStatsSchema.parse(
      matchStats(handMade(LABELS, items), {}, { match: "hand", status: "ended" }),
    );
    const d = (seat: string) => stats.seats.find((s) => s.seat === seat)?.diplomacy;
    expect(
      ["p1", "p2", "p3", "p4", "p5"].map((p) => [
        p,
        d(p)?.pactsSigned,
        d(p)?.pactsKept,
        d(p)?.pactsBroken,
        d(p)?.pactEnds,
      ]),
    ).toEqual([
      ["p1", 2, 2, 0, {}],
      ["p2", 1, 1, 0, {}],
      ["p3", 2, 1, 1, { betrayal: 1 }],
      ["p4", 2, 1, 0, { betrayal: 1 }],
      ["p5", 1, 1, 0, {}],
    ]);
    expect(
      ["p1", "p2", "p3"].map((p) => [
        p,
        d(p)?.alliancesFounded,
        d(p)?.alliancesJoined,
        d(p)?.alliancesLeft,
      ]),
    ).toEqual([
      ["p1", 1, 0, 0],
      ["p2", 1, 0, 1],
      ["p3", 0, 1, 0],
    ]);
    // p1 and p2 share Haiku: one same-model pair; the other four LLM pairs are cross-model.
    expect(stats.collusion.samePairs).toBe(1);
    expect(stats.collusion.crossPairs).toBe(5);
    // p1's partners: p2 on its own model, p3 and p4 on others (rates are counts ÷ partners).
    expect(d("p1")?.sameModel).toEqual({ messages: 1, pacts: 1, alliances: 1, partners: 1 });
    expect(d("p1")?.crossModel).toEqual({ messages: 1, pacts: 1, alliances: 1, partners: 2 });
    expect(stats.collusion.same).toEqual({ messages: 1, pacts: 1, alliances: 1 });
    // Pacts p1–p3 and p3–p4 (p4–p5 has a bot); alliance pairs p1–p3, p2–p3; p1→p3 and p4→p1..p3.
    expect(stats.collusion.cross).toEqual({ messages: 4, pacts: 2, alliances: 2 });
    expect(d("p5")?.sameModel).toBeNull();
    // Self-identification: "Claude" counts, "Claudette" does not.
    expect([d("p1")?.selfIdentification, d("p4")?.selfIdentification]).toEqual([1, 0]);
    expect(d("p4")?.publicSent).toBe(1);
    expect(d("p5")?.messagesReceived).toBe(1);
  });

  test("labels: models, endpoints, profiles and channels; ids are URL path segments", () => {
    const stats = matchStats(handMade(LABELS, []), {}, { match: "hand", status: "live" });
    expect(stats.seats.map((s) => [s.key, s.id, s.profile, s.promptVariant, s.name])).toEqual([
      [
        "anthropic/claude-haiku-5-5/medium",
        "anthropic.claude-haiku-5-5.medium",
        "odysseus@1",
        "system",
        "Odysseus",
      ],
      [
        "anthropic/claude-haiku-5-5/medium",
        "anthropic.claude-haiku-5-5.medium",
        "achilles@1",
        "system",
        "Achilles",
      ],
      [
        "openai/gpt-6-luna/medium",
        "openai.gpt-6-luna.medium",
        "penelope@1",
        "developer",
        "Penelope",
      ],
      [
        "openrouter/z-ai/glm-5.3-flash@z-ai/fp8/low",
        "openrouter.z-ai-glm-5-3-flash.z-ai-fp8.low",
        "agamemnon@1",
        "envelope",
        "Agamemnon",
      ],
      ["bot:opportunist@3", "bot.opportunist.3", null, null, "Opportunist (bot)"],
      ["bot:conqueror@3", "bot.conqueror.3", null, null, "Conqueror (bot)"],
    ]);
    expect(stats.rated).toBe(false);
    expect(parseLabel("llm:anthropic/claude-haiku-5-5/medium:odysseus@1:p2:x")).toBeNull();
    expect(parseLabel("llm:x/a%3Fb/medium:odysseus@1:p2")).toBeNull();
    expect(
      modelIdOf({ provider: "fake", model: "Z.AI/GLM 5", endpoint: null, effort: "max" }),
    ).toBe("fake.z-ai-glm-5.max");
    expect(SELF_ID.test("we are both language models")).toBe(true);
    expect(SELF_ID.test("our gpt-6 alliance")).toBe(true);
    expect(SELF_ID.test("Agamemnon goes")).toBe(false);
  });

  test("side lines: the preflight split, the parallel-call share, caps and the hand-off reason", () => {
    const lines: LlmLogLine[] = [
      LlmLogLineSchema.parse({
        k: "preflight",
        phase: "start",
        group: "anthropic/claude-haiku-5-5/medium",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        endpoint: null,
        t: 0,
        ok: true,
        usage: [],
        costNanoUsd: 7,
        priceCard: null,
        error: null,
      }),
      call("p1", 1, 0, 100),
      call("p1", 2, 1, 100),
      call("p1", 3, 3, 100),
      call("p1", 4, 2, 100),
      call("p2", 1, 1, 50),
      LlmLogLineSchema.parse({
        k: "handoff",
        seat: "p2",
        t: 500,
        reason: "match_budget",
        label: "bot:conqueror@3",
        spentNanoUsd: 50,
        capNanoUsd: 5_000_000_000,
      }),
      LlmLogLineSchema.parse({
        k: "wake_cap",
        seat: "p1",
        turn: 4,
        round: 0,
        t: 400,
        wakeSpentNanoUsd: 100,
        wakeCapNanoUsd: 100,
      }),
    ];
    const items: FeedItem[] = [
      {
        ...base,
        k: "handoff",
        id: "1:0",
        t: 600,
        players: ["p2"],
        importance: 2,
        seat: "p2",
        label: "bot:conqueror@3",
        from: LABELS.p2,
      },
    ];
    const stats = MatchStatsSchema.parse(
      matchStats(handMade(LABELS, items), { calls: lines }, { match: "hand", status: "ended" }),
    );
    const p1 = stats.seats.find((s) => s.seat === "p1");
    const p2 = stats.seats.find((s) => s.seat === "p2");
    // The 7 nano-dollars of Haiku's check: 4 to p1, 3 to p2.
    expect([p1?.cost?.preflightNanoUsd, p2?.cost?.preflightNanoUsd]).toEqual([4, 3]);
    expect(stats.cost).toEqual({
      nanoUsd: 457,
      preflightNanoUsd: 7,
      probeNanoUsd: 0,
      budgetNanoUsd: null,
    });
    // p1's tool rounds: 1, 3 and 2 calls: two of three parallel.
    expect(p1?.incidents.parallelPermille).toBe(667);
    expect([
      p1?.operations?.toolRounds,
      p1?.operations?.parallelRounds,
      p1?.operations?.fallbacks,
    ]).toEqual([3, 2, 1]);
    expect(p1?.incidents.fallbackPermille).toBe(250);
    expect(p1?.incidents.wakeCaps).toBe(1);
    expect(p1?.operations?.latencyMs).toEqual({ n: 4, p50: 20, p95: 40 });
    expect(p1?.cost?.cacheReadPermille).toBe(800);
    expect(p1?.cost?.perWakeNanoUsd).toBeNull();
    expect(p2?.incidents.handoff).toEqual({
      t: 600,
      reason: "match_budget",
      label: "bot:conqueror@3",
    });
    // A seat named by no line has operations and cost of zero, a bot none.
    const p3 = stats.seats.find((s) => s.seat === "p3");
    expect([p3?.operations?.attempts, p3?.cost?.nanoUsd, p3?.incidents.parallelPermille]).toEqual([
      0,
      0,
      null,
    ]);
    expect(stats.seats.find((s) => s.seat === "p5")?.cost).toBeNull();
  });

  test("a pact superseded by an alliance of the two is kept, not broken (review fix)", () => {
    const items: FeedItem[] = [
      diplomacy("1:0", 10, "pact_signed", ["p1", "p3"]),
      diplomacy("2:0", 20, "alliance_formed", ["p1", "p3"], { alliance: "a1" }),
      diplomacy("3:0", 20, "pact_ended", ["p1", "p3"], { cause: "superseded" }),
      diplomacy("4:0", 30, "pact_signed", ["p2", "p4"]),
      diplomacy("5:0", 40, "pact_ended", ["p2", "p4"], { cause: "left" }),
    ];
    const stats = matchStats(handMade(LABELS, items), {}, { match: "hand", status: "ended" });
    const d = (seat: string) => stats.seats.find((s) => s.seat === seat)?.diplomacy;
    expect(["p1", "p2", "p3", "p4"].map((p) => [p, d(p)?.pactsKept, d(p)?.pactEnds])).toEqual([
      ["p1", 1, { superseded: 1 }],
      ["p2", 0, { left: 1 }],
      ["p3", 1, { superseded: 1 }],
      ["p4", 0, { left: 1 }],
    ]);
  });

  test("tool-call errors: only a malformed call counts, not every stop `other` (review fix)", () => {
    const other = (rawStop: string | null, calls = 0): LlmCallLine => {
      const line = LlmLogLineSchema.parse({ ...call("p1", 1, calls, 1), stop: "other", rawStop });
      if (line.k !== "llm_call") throw new Error("not a call");
      return line;
    };
    // Gemini's malformed call and an OpenAI-compatible tool_calls finish without a parsed call.
    expect(malformedCall(other("MALFORMED_FUNCTION_CALL"))).toBe(true);
    expect(malformedCall(other("tool_calls"))).toBe(true);
    expect(malformedCall(other("function_call"))).toBe(true);
    // Provider failures and other finishes are not the model's tool calling.
    for (const raw of [
      null,
      "null",
      "error",
      "OTHER",
      "MALFORMED_RESPONSE",
      "TOO_MANY_TOOL_CALLS",
      "UNEXPECTED_TOOL_CALL",
      "incomplete:content_filter",
      "model_context_window_exceeded",
    ]) {
      expect([raw, malformedCall(other(raw))]).toEqual([raw, false]);
    }
    expect(malformedCall({ stop: "tool_use", rawStop: "MALFORMED_FUNCTION_CALL", calls: 0 })).toBe(
      false,
    );
    const lines = [
      other("MALFORMED_FUNCTION_CALL"),
      other("error"),
      other(null),
      call("p1", 2, 1, 1),
    ];
    const stats = matchStats(
      handMade(LABELS, []),
      { calls: lines },
      { match: "hand", status: "ended" },
    );
    const ops = stats.seats.find((s) => s.seat === "p1")?.operations;
    expect(ops?.toolErrors.malformed).toBe(1);
    expect(ops?.stops).toEqual({ other: 3, tool_use: 1 });
  });

  test("operator strings are cleaned and cut; long ids stay valid and distinct (review fix)", () => {
    const bidi = "\u202e";
    const seats = SeatsFileSchema.parse({
      ...SEATS_BASE,
      lineup: `budget${bidi}-mix\u200b\u0007`,
      seats: [
        {
          ...LLM_SEAT,
          seat: "p1",
          provider: "compat",
          model: `<img src=x>${bidi}gnp.x${"m".repeat(300)}`,
          endpoint: `${bidi}z-ai/fp8\u2066`,
          quantization: `fp8${bidi}<b>x</b>\u200b`,
        },
        { ...LLM_SEAT, seat: "p2", provider: "compat", model: `${"m".repeat(300)}2` },
      ],
    });
    const stats = MatchStatsSchema.parse(
      matchStats(handMade(LABELS, []), { seats }, { match: "hand", status: "ended" }),
    );
    const [p1, p2] = stats.seats;
    const bad = {
      test: (t: string): boolean => {
        for (let i = 0; i < t.length; i += 1) {
          const c = t.charCodeAt(i);
          if (c < 0x20 || c === 0x200b || (c >= 0x202a && c <= 0x202e)) return true;
          if (c >= 0x2066 && c <= 0x2069) return true;
        }
        return false;
      },
    };
    for (const text of [
      p1?.model?.model,
      p1?.model?.endpoint,
      p1?.model?.quantization,
      p1?.key,
      stats.lineup,
    ]) {
      expect([text, bad.test(text ?? "")]).toEqual([text, false]);
    }
    expect(p1?.model?.model.length).toBeLessThanOrEqual(NAME_MAX_CHARS);
    // The bell (U+0007) becomes a space, then the line is trimmed.
    expect(stats.lineup).toBe("budget-mix");
    // Two long model ids that share their first characters: bounded, valid and still distinct.
    expect(p1?.id.length).toBeLessThanOrEqual(ID_MAX);
    expect(p2?.id.length).toBeLessThanOrEqual(ID_MAX);
    expect(p1?.id).not.toBe(p2?.id);
    expect(idPart("x".repeat(400)).length).toBe(PART_MAX);
    expect(idPart("x".repeat(400))).not.toBe(idPart(`${"x".repeat(399)}y`));
    expect(nameOf(" a\n\tb ")).toBe("a b");
  });
});
