import {
  CityIdSchema,
  GameTimeSchema,
  PlayerIdSchema,
  ResSchema,
  z,
  type ZodType,
} from "@perfidia/protocol";
import { BlocKeySchema } from "./ext.ts";

// The event types perfidia-1 adds to the standard ones (docs/architecture.md §8.6): sieges and
// domination countdowns, all public (perfidia-1 §11.5), and the private refund of a besieged
// city's queues to its owner (§9.1, §4.3). Every other event it emits is standard.

export const SIEGE_STARTED = "siege_started";
export const SIEGE_BROKEN = "siege_broken";
export const DOMINATION_STARTED = "domination_started";
export const DOMINATION_CANCELLED = "domination_cancelled";
export const QUEUES_REFUNDED = "queues_refunded";

/**
 * Why a siege ended without a conquest (§9.3): a relief battle, a homecoming battle, the besieger
 * recalling the last settler, or the besieger's elimination.
 */
export const SIEGE_BREAK_CAUSES = ["relief", "homecoming", "abandoned", "eliminated"] as const;
export type SiegeBreakCause = (typeof SIEGE_BREAK_CAUSES)[number];

/** Why a domination countdown was cancelled (§13.3). */
export const COUNTDOWN_CANCEL_REASONS = ["condition", "membership"] as const;
export type CountdownCancelReason = (typeof COUNTDOWN_CANCEL_REASONS)[number];

/** A public siege start (§9.1); `owner` is null for the neutral Crown. */
export const SiegeStartedSchema = z.strictObject({
  city: CityIdSchema,
  owner: PlayerIdSchema.nullable(),
  by: PlayerIdSchema,
  endsAt: GameTimeSchema,
});

/**
 * The refund of a besieged city's cancelled queues (§9.1), to its owner only: what was credited to
 * its stock and what the warehouse cap cut (§4.3). Emitted only when something was due.
 */
export const QueuesRefundedSchema = z.strictObject({
  city: CityIdSchema,
  refund: ResSchema,
  lost: ResSchema,
});

/** A public siege end without a conquest (§9.3). */
export const SiegeBrokenSchema = z.strictObject({
  city: CityIdSchema,
  owner: PlayerIdSchema.nullable(),
  by: PlayerIdSchema,
  cause: z.enum(SIEGE_BREAK_CAUSES),
});

/**
 * A public domination countdown start (§13.3). `key` is the bloc key, which the gateway's
 * `publicOncePerDay` rule reads to wake everyone once per bloc per game day.
 */
export const DominationStartedSchema = z.strictObject({
  key: BlocKeySchema,
  members: z.array(PlayerIdSchema).min(1),
  cities: z.int().nonnegative(),
  threshold: z.int().nonnegative(),
  endsAt: GameTimeSchema,
});

/** A public domination countdown cancellation (§13.3). */
export const DominationCancelledSchema = z.strictObject({
  key: BlocKeySchema,
  members: z.array(PlayerIdSchema).min(1),
  reason: z.enum(COUNTDOWN_CANCEL_REASONS),
});

/** `Ruleset.eventSchemas`: every non-standard event type perfidia-1 emits. */
export const PERFIDIA_1_EVENT_SCHEMAS: Readonly<Record<string, ZodType>> = Object.freeze({
  [SIEGE_STARTED]: SiegeStartedSchema,
  [SIEGE_BROKEN]: SiegeBrokenSchema,
  [DOMINATION_STARTED]: DominationStartedSchema,
  [DOMINATION_CANCELLED]: DominationCancelledSchema,
  [QUEUES_REFUNDED]: QueuesRefundedSchema,
});

/**
 * `Ruleset.intelEvents`: siege starts and breaks, and the refund that comes with a siege start,
 * follow from battles whose outcome depends on hidden armies, so they are exempt from the
 * transition non-interference property P15.
 */
export const PERFIDIA_1_INTEL_EVENTS: readonly string[] = Object.freeze([
  SIEGE_STARTED,
  SIEGE_BROKEN,
  QUEUES_REFUNDED,
]);
