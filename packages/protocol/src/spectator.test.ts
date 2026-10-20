import { describe, expect, test } from "bun:test";
import { z, type ZodType } from "zod";
import * as arena from "./arena.ts";
import * as spectator from "./spectator.ts";
import { FRAME as frame, ITEMS } from "./spectator.fixtures.test.ts";
import {
  FEED_KINDS,
  FeedItemSchema,
  FrameSchema,
  MatchMetaSchema,
  MomentSchema,
  PatchSchema,
  ReplyLineSchema,
  ServerMsgSchema,
  StepSchema,
  TurnAnnotationSchema,
  type MatchMeta,
  type Moment,
  type Patch,
  type ReplyLine,
  type TurnAnnotation,
} from "./index.ts";

// The spectator formats (phase-3 design §3.3) and the run-directory formats moved from the
// orchestrator (`arena.ts`): fixtures of every kind parse unchanged and reject unknown keys, every
// schema converts with `z.toJSONSchema` (the OpenAPI document is built from them), and the barrel
// exports the same objects as the `./spectator` sub-path.

/** Every value of a module that is a Zod schema, by export name. */
function schemasOf(mod: Record<string, unknown>): [string, ZodType][] {
  return Object.entries(mod).flatMap(([name, v]) => (v instanceof z.ZodType ? [[name, v]] : []));
}

describe("spectator schemas", () => {
  test("a fixture of every feed item kind parses unchanged and rejects an unknown key", () => {
    expect(Object.keys(ITEMS)).toEqual([...FEED_KINDS]);
    for (const item of Object.values(ITEMS)) {
      expect(FeedItemSchema.parse(item)).toEqual(item);
      expect(FeedItemSchema.safeParse({ ...item, extra: 1 }).success).toBe(false);
    }
    expect(FeedItemSchema.safeParse({ ...ITEMS.message, id: "a:b" }).success).toBe(false);
    expect(FeedItemSchema.safeParse({ ...ITEMS.message, importance: 4 }).success).toBe(false);
  });

  test("frames, patches, steps and moments parse unchanged and reject unknown keys", () => {
    expect(FrameSchema.parse(frame)).toEqual(frame);
    expect(FrameSchema.safeParse({ ...frame, idKey: "0".repeat(32) }).success).toBe(false);
    const city = frame.cities.c1;
    if (city === undefined) throw new Error("no c1");
    expect(FrameSchema.safeParse({ ...frame, cities: { c1: { ...city, seed: 1 } } }).success).toBe(
      false,
    );
    const patch: Patch = { cities: { c1: city, c2: null }, status: "ended", result: null };
    expect(PatchSchema.parse(patch)).toEqual(patch);
    expect(PatchSchema.safeParse({ cities: { x1: null } }).success).toBe(false);
    const step = { seq: 12, t: 3600, patch, items: [ITEMS.message, ITEMS.turn] };
    expect(StepSchema.parse(step)).toEqual(step);
    expect(StepSchema.safeParse({ seq: -1, t: 0 }).success).toBe(false);
    const moment: Moment = {
      item: "17:0",
      seq: 17,
      t: 3600,
      k: "betrayal",
      importance: 3,
      title: "p2 betrayed its ally p1 at c3",
      players: ["p2", "p1"],
      cities: ["c3"],
      context: { messages: [], thoughts: [], since: null },
    };
    expect(MomentSchema.parse(moment)).toEqual(moment);
    expect(MomentSchema.safeParse({ ...moment, k: "nope" }).success).toBe(false);
  });

  test("annotations, meta and server messages parse; the closed vocabularies hold", () => {
    const annotation: TurnAnnotation = {
      seat: "p1",
      turn: 3,
      complete: true,
      rounds: [
        {
          round: 0,
          kind: "round",
          attempts: 1,
          stop: "tool_use",
          refusal: null,
          errors: [],
          reasoning: ["thinking"],
          text: [],
          calls: ["view_map"],
          costNanoUsd: 1000,
          tokens: { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 2, output: 3 },
          latencyMs: 10,
        },
      ],
      spentNanoUsd: 1000,
      capNanoUsd: null,
    };
    expect(TurnAnnotationSchema.parse(annotation)).toEqual(annotation);
    const meta: MatchMeta = {
      format: "perfidia-spectator/1",
      id: "war",
      title: "War",
      description: null,
      ruleset: "perfidia-1@1.1.0",
      engine: "0.1.0",
      configHash: "a".repeat(64),
      rulesHash: "b".repeat(64),
      config: {},
      clock: { kind: "lockstep", maxTurnsPerSecond: 3 },
      matchEnd: 604800,
      seats: [
        {
          seat: "p1",
          kind: "llm",
          name: "Odysseus",
          label: "llm:fake/claude-opus-5-5/medium:odysseus@1:p2",
          color: 0,
          fake: true,
          model: { provider: "fake", model: "claude-opus-5-5", effort: "medium" },
          profile: {
            id: "odysseus",
            version: 1,
            name: "Odysseus",
            goal: "win",
            temperament: "calm",
            word: "flexible",
            style: "terse",
          },
          handoffBot: "bot:opportunist@3",
        },
      ],
      map: { width: 600, height: 600, islands: [] },
      status: "live",
      reason: null,
      wallStart: null,
      lastSeq: 0,
      lastT: 0,
      logId: "c".repeat(64),
      timeline: "0123456789abcdef",
      keyframes: [0],
      verified: { ok: true, divergence: null },
      published: { costs: true, reasoning: true },
    };
    expect(MatchMetaSchema.parse(meta)).toEqual(meta);
    expect(MatchMetaSchema.safeParse({ ...meta, seed: 14 }).success).toBe(false);
    expect(MatchMetaSchema.safeParse({ ...meta, id: "../etc" }).success).toBe(false);
    expect(MatchMetaSchema.safeParse({ ...meta, reason: "operator says hi" }).success).toBe(false);
    expect(
      ServerMsgSchema.parse({
        type: "steps",
        match: "war",
        timeline: "0123456789abcdef",
        from: 0,
        to: 12,
        steps: [],
      }),
    ).toMatchObject({ type: "steps", to: 12 });
    expect(ServerMsgSchema.safeParse({ type: "live", match: "war" }).success).toBe(false);
  });

  test("every schema of the spectator and arena modules converts to JSON Schema", () => {
    const all = [...schemasOf(spectator), ...schemasOf(arena)];
    // 63 through phase 4 Pass 1a; Pass 1b adds Provider, PromptVariant, ReminderCadence,
    // ReasoningContext and TokenProfile.
    expect(all.length).toBe(68);
    for (const [name, schema] of all) {
      const json = z.toJSONSchema(schema, { io: "output", unrepresentable: "any" });
      expect([name, typeof json]).toEqual([name, "object"]);
    }
  });

  test("the barrel and the ./spectator sub-path export the same objects", () => {
    expect(spectator.FrameSchema).toBe(FrameSchema);
    expect(spectator.StepSchema).toBe(StepSchema);
    expect(spectator.SPECTATOR_FORMAT).toBe("perfidia-spectator/1");
  });
});

describe("run-directory schemas (arena.ts)", () => {
  test("a reply line parses; refusals and unknown keys do not", () => {
    const line: ReplyLine = {
      k: "reply",
      seat: "p1",
      turn: 3,
      round: 0,
      attempt: 1,
      kind: "round",
      t: 3600,
      stop: "tool_use",
      reasoning: ["Fake reasoning: build"],
      text: [],
      calls: [{ name: "build", args: { city: "c1", buildings: ["acropolis"] } }],
    };
    expect(ReplyLineSchema.parse(line)).toEqual(line);
    expect(ReplyLineSchema.safeParse({ ...line, requestId: "x" }).success).toBe(false);
    expect(ReplyLineSchema.safeParse({ ...line, attempt: 0 }).success).toBe(false);
    expect(arena.EffortSchema.options).toEqual([...arena.EFFORTS]);
  });
});
