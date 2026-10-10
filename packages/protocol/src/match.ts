import { z } from "zod";
import { GameTimeSchema, PlayerIdSchema, RulesetRefSchema } from "./ids.ts";
import { JsonSchema, safeRecord } from "./json.ts";

// Match setup, clock specs, standings and results (§3.6, §8.7, §10.2).

/** The per-match secret key of opaque ids (§4.1): 32 lowercase hex characters (128 bits). */
export const IdKeySchema = z.string().regex(/^[0-9a-f]{32}$/, {
  error: "expected 32 lowercase hex characters (128 bits)",
});
export type IdKey = z.infer<typeof IdKeySchema>;

/**
 * Path segments that would reach `Object.prototype` when `resolveConfig` sets the path on a plain
 * object (prototype pollution through a log header or a CLI override).
 */
const RESERVED_SEGMENT = /^(?:__proto__|prototype|constructor)$/;

/** A dotted config path, e.g. `time.siegeDuration`; array elements use numeric segments (`homeRadius.6`). */
export const ConfigPathSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, {
    error: "expected a dotted config path, such as time.matchEnd",
  })
  .superRefine((path, ctx) => {
    for (const segment of path.split(".")) {
      if (RESERVED_SEGMENT.test(segment)) {
        ctx.addIssue({
          code: "custom",
          message: `"${segment}" is not a config key: it would reach Object.prototype`,
        });
      }
    }
  });

/**
 * The most seats a match can have: opaque ids encode the owner in 4 bits, so owners are players
 * 1..15 (§4.1). A ruleset's `players(config)` must stay within it.
 */
export const MAX_SEATS = 15;

export const MatchSetupSchema = z
  .strictObject({
    /** Always the exact ref, even if the CLI was given a bare id. */
    ruleset: RulesetRefSchema,
    /** Dotted config paths → values. */
    overrides: safeRecord(ConfigPathSchema, JsonSchema),
    /** uint32. */
    seed: z.int().min(0).max(4294967295),
    /** Never shown to agents. */
    idKey: IdKeySchema,
    /** `p1..pN` in order. Seats have no names (§4.2). N is checked against the ruleset at creation. */
    seats: z
      .array(z.strictObject({ id: PlayerIdSchema }))
      .min(1)
      .max(MAX_SEATS, {
        error: `at most ${MAX_SEATS} seats: opaque ids encode the owner as player 1..${MAX_SEATS} (§4.1)`,
      }),
  })
  .superRefine((setup, ctx) => {
    for (const [i, seat] of setup.seats.entries()) {
      const expected = `p${i + 1}`;
      if (seat.id !== expected) {
        ctx.addIssue({
          code: "custom",
          path: ["seats", i, "id"],
          message: `seats are p1..pN in order: expected ${expected}, got ${seat.id}`,
        });
      }
    }
  });
export type MatchSetup = z.infer<typeof MatchSetupSchema>;

/** A dotted config path and what is wrong with it (§3.6). */
export const ConfigIssueSchema = z.strictObject({
  /** Dotted config path, e.g. `time.siegeDuration`; empty for the whole config. */
  path: z.string(),
  message: z.string().min(1),
});
export type ConfigIssue = z.infer<typeof ConfigIssueSchema>;

/** A player's public standing (§3.6). */
export const StandingSchema = z.strictObject({
  player: PlayerIdSchema,
  /** 1-based, no shared ranks. */
  rank: z.int().positive(),
  score: z.int(),
  /** Ruleset-defined, public, e.g. `cityPoints`, `battleScore`. */
  parts: safeRecord(z.string().min(1), z.int()),
  cities: z.int().nonnegative(),
  alive: z.boolean(),
});
export type Standing = z.infer<typeof StandingSchema>;

export const MatchResultSchema = z.strictObject({
  endedAt: GameTimeSchema,
  /** `time`, `domination`, `last_standing`, or a ruleset-specific reason. */
  reason: z.string().min(1),
  /** One player, or a winning bloc's members. */
  winners: z.array(PlayerIdSchema),
  standings: z.array(StandingSchema),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

const PositiveInt = z.int().positive();
const RangeMs = z.tuple([z.int().nonnegative(), z.int().nonnegative()]);

/** The lockstep clock as recorded in the log header (§9.2). */
export const LockstepClockSpecSchema = z.strictObject({
  kind: z.literal("lockstep"),
  /** Per-second turn cap per seat (default 3). */
  maxTurnsPerSecond: PositiveInt,
  /** Optional hung-agent bound; needs an injected time source. */
  roundTimeoutMs: PositiveInt.optional(),
});
export type LockstepClockSpec = z.infer<typeof LockstepClockSpecSchema>;

/** The real-time clock as recorded in the log header (§9.3). */
export const RealtimeClockSpecSchema = z.strictObject({
  kind: z.literal("realtime"),
  /** `[num, den]` game-seconds per wall-second. */
  speed: z.tuple([PositiveInt, PositiveInt]),
  time: z.enum(["virtual", "system"]),
  /** Seeded think-time range per round, recorded for Level G. */
  latencyMs: RangeMs.optional(),
  turnTimeoutMs: PositiveInt.optional(),
});
export type RealtimeClockSpec = z.infer<typeof RealtimeClockSpecSchema>;

export const ClockSpecSchema = z.discriminatedUnion("kind", [
  LockstepClockSpecSchema,
  RealtimeClockSpecSchema,
]);
export type ClockSpec = z.infer<typeof ClockSpecSchema>;
