import { GameTimeSchema, PlayerIdSchema, z, type ZodType } from "@perfidia/protocol";
import { DOMINATION_STARTED, PERFIDIA_1_EVENT_SCHEMAS } from "./events.ts";
import { BlocKeySchema } from "./ext.ts";

// The event types of perfidia-1@1.1.0: 1.0.0's, with a domination countdown start that also gives
// the bloc's taken cities and the taken cities it needs (docs/rulesets/perfidia-1.md §13.3).

/**
 * A public domination countdown start (§13.3): the bloc's cities and taken cities against the
 * threshold. `key` is the bloc key, which the gateway's `publicOncePerDay` rule groups by.
 */
export const DominationStarted11Schema = z.strictObject({
  key: BlocKeySchema,
  members: z.array(PlayerIdSchema).min(1),
  cities: z.int().nonnegative(),
  taken: z.int().nonnegative(),
  threshold: z.int().nonnegative(),
  needTaken: z.int().nonnegative(),
  endsAt: GameTimeSchema,
});

/** `Ruleset.eventSchemas` of 1.1.0: 1.0.0's, with the 1.1.0 countdown start. */
export const PERFIDIA_1_1_EVENT_SCHEMAS: Readonly<Record<string, ZodType>> = Object.freeze({
  ...PERFIDIA_1_EVENT_SCHEMAS,
  [DOMINATION_STARTED]: DominationStarted11Schema,
});
