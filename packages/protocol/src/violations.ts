import { z } from "zod";
import { safeRecord } from "./json.ts";

// Player errors are data (§7.3): a code and flat details, worded by the gateway.

/** The closed list of domain codes. Rulesets add their own codes (`perfidia-1`: `CITY_BESIEGED`, `NOT_BESIEGER`). */
export const DOMAIN_ERROR_CODES = [
  "INVALID_ARGS",
  "UNKNOWN_ID",
  "NOT_OWNER",
  "TURN_OVER",
  "ROUND_TRIP_CAP",
  "CALLS_CAP",
  "DAILY_CAP",
  "MATCH_ENDED",
  "ELIMINATED",
  "NOTE_TOO_LONG",
  "INSUFFICIENT_RESOURCES",
  "EXCEEDS_STORAGE",
  "INSUFFICIENT_POPULATION",
  "REQUIREMENT_MISSING",
  "MAX_LEVEL",
  "QUEUE_FULL",
  "QUEUE_ITEM",
  "BATCH_LIMIT",
  "INSUFFICIENT_UNITS",
  "NO_UNITS",
  "TRANSPORT_CAPACITY",
  "SHIPMENT_CAPACITY",
  "ATTACK_PROTECTION",
  "INVALID_TARGET",
  "NO_FREE_SLOT",
  "SETTLER_REQUIRED",
  "SPY_GOLD",
  "NOT_RECALLABLE",
  "NOTHING_STATIONED",
  "AMBIGUOUS_GROUP",
  "TEXT_TOO_LONG",
  "PROPOSAL_LIMIT",
  "PROPOSAL_NOT_FOUND",
  "ALREADY_ALLIED",
  "ALLIANCE_FULL",
  "NOT_IN_ALLIANCE",
  "PACT_LIMIT",
  "PACT_NOT_FOUND",
  "INTERNAL",
] as const;
export const DomainErrorCodeSchema = z.enum(DOMAIN_ERROR_CODES);
export type DomainErrorCode = z.infer<typeof DomainErrorCodeSchema>;

/** Warnings the gateway itself raises on accepted calls (§7.3). Ruleset warnings come from the ruleset. */
export const GATEWAY_WARNING_CODES = ["WAKE_CLAMPED"] as const;

/** Any error or warning code: a domain code or a ruleset code, in upper snake case. */
export const ErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, {
  error: "expected an UPPER_SNAKE_CASE code",
});
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * Flat details: numbers and ids, no prose. Conventions (§7.3): `need_wood`, `have_wood`,
 * `rate_wood` (same for stone and gold); `availableAt` (game time, `null` = never) on any
 * time-gated rejection; `unit`, `requested`, `home` and `backAt` on unit shortages; `city` and
 * `item` on `QUEUE_ITEM`.
 */
export const ViolationDetailsSchema = safeRecord(
  z.string(),
  z.union([z.int(), z.string(), z.boolean(), z.null()]),
);
export type ViolationDetails = z.infer<typeof ViolationDetailsSchema>;

export const ViolationSchema = z.strictObject({
  code: ErrorCodeSchema,
  details: ViolationDetailsSchema,
});
export type Violation = z.infer<typeof ViolationSchema>;
