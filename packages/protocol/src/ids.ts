import { z } from "zod";

// Ids and primitives (docs/architecture.md §4.1).

/** Integer game-seconds since match start. */
export const GameTimeSchema = z.int().nonnegative();
export type GameTime = z.infer<typeof GameTimeSchema>;

/** A time or a duration as shown to agents: the integer and its text, e.g. `[226620, "D3 14:57"]` (§7.3). */
export const TimePairSchema = z.tuple([GameTimeSchema, z.string()]);
export type TimePair = z.infer<typeof TimePairSchema>;
/** A duration as shown to agents, e.g. `[381480, "4d 9h58m"]`. */
export const DurationPairSchema = z.tuple([z.int().nonnegative(), z.string()]);
export type DurationPair = z.infer<typeof DurationPairSchema>;

/**
 * Builds the schema of a public id kind: a counter in creation order, `p1`, `i7`, `c12`, `a2`.
 * The template literal gives the type; the regex rejects `p0`, `p01` and `p-1`, and its pattern
 * replaces the template's looser one in `z.toJSONSchema`.
 */
function publicIdSchema<const P extends string>(prefix: P, what: string) {
  const pattern = `^${prefix}[1-9][0-9]*$`;
  const error = `expected ${what} id: "${prefix}" followed by a number from 1, such as ${prefix}3`;
  return z
    .templateLiteral([prefix, z.int()], { error })
    .check(z.regex(new RegExp(pattern), { error }))
    .meta({ pattern });
}

/** Lowercase Crockford base 32, the alphabet of opaque ids (no i, l, o, u). */
export const OPAQUE_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/** Characters after the prefix of an opaque id. */
export const OPAQUE_ID_LENGTH = 5;

/**
 * Builds the schema of a private (opaque) id kind: the prefix and 5 characters of lowercase
 * Crockford base 32, such as `m0k4qz` (§4.1). Their order is not creation order.
 */
function opaqueIdSchema<const P extends string>(prefix: P, what: string) {
  const pattern = `^${prefix}[0-9a-hjkmnp-tv-z]{${OPAQUE_ID_LENGTH}}$`;
  const error = `expected ${what} id: "${prefix}" followed by 5 characters of ${OPAQUE_ID_ALPHABET}, such as ${prefix}0k4qz`;
  return z
    .templateLiteral([prefix, z.string()], { error })
    .check(z.regex(new RegExp(pattern), { error }))
    .meta({ pattern });
}

export const PlayerIdSchema = publicIdSchema("p", "a player");
export type PlayerId = z.infer<typeof PlayerIdSchema>;
export const IslandIdSchema = publicIdSchema("i", "an island");
export type IslandId = z.infer<typeof IslandIdSchema>;
/** A city keeps its id when it changes owner. */
export const CityIdSchema = publicIdSchema("c", "a city");
export type CityId = z.infer<typeof CityIdSchema>;
export const AllianceIdSchema = publicIdSchema("a", "an alliance");
export type AllianceId = z.infer<typeof AllianceIdSchema>;

export const MovementIdSchema = opaqueIdSchema("m", "a movement");
export type MovementId = z.infer<typeof MovementIdSchema>;
export const ReportIdSchema = opaqueIdSchema("r", "a report");
export type ReportId = z.infer<typeof ReportIdSchema>;
export const ProposalIdSchema = opaqueIdSchema("q", "a proposal");
export type ProposalId = z.infer<typeof ProposalIdSchema>;
export const MessageIdSchema = opaqueIdSchema("g", "a message");
export type MessageId = z.infer<typeof MessageIdSchema>;

/** Prefixes of the public id kinds (counters), in no particular order. */
export const PUBLIC_ID_PREFIXES = ["p", "i", "c", "a"] as const;
/** Prefixes of the private id kinds (opaque, per owner), in no particular order. */
export const OPAQUE_ID_PREFIXES = ["m", "r", "q", "g"] as const;

/** Queue item number, per city, shared by build items and recruit batches; shown as "#7". */
export const QueueItemIdSchema = z.int().positive();
export type QueueItemId = z.infer<typeof QueueItemIdSchema>;

/** FNV-1a 64 hash: 16 lowercase hex characters. */
export const Hash64Schema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, { error: "expected 16 lowercase hex characters (FNV-1a 64)" });
export type Hash64 = z.infer<typeof Hash64Schema>;
/** SHA-256 hash: 64 lowercase hex characters. */
export const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: "expected 64 lowercase hex characters (SHA-256)" });
export type Sha256 = z.infer<typeof Sha256Schema>;

/** A ruleset id, e.g. `perfidia-1`. */
export const RulesetIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, {
  error: "expected a ruleset id: lowercase letters, digits and '-', starting with a letter",
});
export type RulesetId = z.infer<typeof RulesetIdSchema>;

const RULESET_REF_PATTERN = "^[a-z][a-z0-9-]*@(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$";
const RULESET_REF_ERROR = "expected a ruleset ref id@MAJOR.MINOR.PATCH, such as perfidia-1@1.0.0";
/** An exact ruleset version, `id@MAJOR.MINOR.PATCH`, e.g. `perfidia-1@1.0.0`. */
export const RulesetRefSchema = z
  .templateLiteral([z.string(), "@", z.int(), ".", z.int(), ".", z.int()], {
    error: RULESET_REF_ERROR,
  })
  .check(z.regex(new RegExp(RULESET_REF_PATTERN), { error: RULESET_REF_ERROR }))
  .meta({ pattern: RULESET_REF_PATTERN });
export type RulesetRef = z.infer<typeof RulesetRefSchema>;

/** Semantic version `MAJOR.MINOR.PATCH`, e.g. the engine version. */
export const SemverSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/, {
    error: "expected a version MAJOR.MINOR.PATCH, such as 0.1.0",
  });

const TABLE_ID_ERROR = "expected an id of lowercase letters and '_', such as warehouse";
/** A building id of the ruleset, validated against `CompiledRules`. */
export const BuildingIdSchema = z.string().regex(/^[a-z][a-z_]*$/, { error: TABLE_ID_ERROR });
export type BuildingId = z.infer<typeof BuildingIdSchema>;
/** A unit id of the ruleset, validated against `CompiledRules`. */
export const UnitIdSchema = z.string().regex(/^[a-z][a-z_]*$/, { error: TABLE_ID_ERROR });
export type UnitId = z.infer<typeof UnitIdSchema>;
/** `"build"` or a recruit queue id of `CompiledRules`. */
export const QueueIdSchema = z.string().regex(/^[a-z][a-z_]*$/, { error: TABLE_ID_ERROR });
export type QueueId = z.infer<typeof QueueIdSchema>;

/** Event types and scheduled event kinds: snake case, e.g. `arrive_attack`, `siege_end`. */
export const EventTypeSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, {
  error: "expected a snake_case event name, such as queue_empty",
});
export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * Player-authored names (alliance names, `sandbox-1` city names): ASCII letters and digits, space,
 * `-`, `_` and `.` only. ASCII rather than `\p{L}`, so validation never depends on the runtime's
 * Unicode tables (§4.1). The length limit comes from `CompiledRules`.
 */
export const AuthoredNameSchema = z.string().regex(/^[A-Za-z0-9 _.-]+$/, {
  error: "names use ASCII letters, digits, space, '-', '_' and '.' only",
});
export type AuthoredName = z.infer<typeof AuthoredNameSchema>;

const PUBLIC_KINDS: readonly string[] = PUBLIC_ID_PREFIXES;
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * The total order on ids shared by engine, gateway and bots (§4.1, §6.5): the one-character prefix
 * first (UTF-16 code units, so ids group by kind), then, for the public kinds `p`, `i`, `c` and `a`,
 * the number (`p2 < p10`), and code-unit order for everything else (opaque ids are fixed width).
 * Within a public kind, a malformed rest sorts after every number. Any two strings compare, and the
 * result is 0 only for equal strings, so it can sort record keys that are not ids (`"neutral"`).
 */
export function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  const pa = a.slice(0, 1);
  const pb = b.slice(0, 1);
  if (pa !== pb) return pa < pb ? -1 : 1;
  const ra = a.slice(1);
  const rb = b.slice(1);
  if (PUBLIC_KINDS.includes(pa)) {
    const na = CANONICAL_DECIMAL.test(ra);
    const nb = CANONICAL_DECIMAL.test(rb);
    if (na !== nb) return na ? -1 : 1;
    if (na && ra.length !== rb.length) return ra.length < rb.length ? -1 : 1;
  }
  return ra < rb ? -1 : 1;
}
