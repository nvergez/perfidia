import { expect, test } from "bun:test";
import { MATCH_STATUSES, MatchIdSchema } from "./spectator.ts";
import {
  ClaimsSchema,
  MatchStatsSchema,
  ModelIdSchema,
  STATS_MATCH_STATUSES,
  StatsGroupingSchema,
} from "./stats.ts";

// The statistics formats (phase 4, Pass 3): they repeat two lists of `./spectator.ts` (which
// re-exports this module, so it cannot import them), and must keep them equal.

test("the match statuses and match ids are the spectator's", () => {
  expect([...STATS_MATCH_STATUSES]).toEqual([...MATCH_STATUSES]);
  const ids = [
    "war",
    "m01",
    "run.2026-10-20",
    "a@b",
    "-x",
    "",
    "a/b",
    "x".repeat(128),
    "x".repeat(129),
  ];
  const stats = MatchStatsSchema.shape.match;
  for (const id of ids) {
    expect([id, stats.safeParse(id).success]).toEqual([id, MatchIdSchema.safeParse(id).success]);
  }
});

test("model ids are URL path segments", () => {
  for (const ok of [
    "anthropic.claude-sonnet-5-5.medium",
    "bot.conqueror.3",
    "openrouter.z-ai-glm-5-3.z-ai-fp8.low",
  ]) {
    expect([ok, ModelIdSchema.safeParse(ok).success]).toEqual([ok, true]);
  }
  for (const bad of ["Anthropic.x", "a/b", "a b", "", ".a", "a%2Fb"]) {
    expect([bad, ModelIdSchema.safeParse(bad).success]).toEqual([bad, false]);
  }
  expect(StatsGroupingSchema.options).toEqual(["model", "profile", "variant", "model-profile"]);
});

test("counts never carry a __proto__ key; a claim state is one of three", () => {
  const claims = {
    state: "too_few_matches",
    gap: "70/30",
    models: 4,
    pairs: 6,
    alpha: 0.05 / 6,
    matches: 4,
    needed: 74,
    more: 70,
    power: 0.1,
    table: [{ gap: "70/30", needed: 74, power: 0.1 }],
  };
  expect(ClaimsSchema.safeParse(claims).success).toBe(true);
  expect(ClaimsSchema.safeParse({ ...claims, state: "ranked" }).success).toBe(false);
  const counts = MatchStatsSchema.shape.seats.element.shape.play.shape.rejections;
  expect(counts.safeParse({ INVALID_ARGS: 1 }).success).toBe(true);
  expect(counts.safeParse(JSON.parse('{"__proto__": 1}')).success).toBe(false);
});
