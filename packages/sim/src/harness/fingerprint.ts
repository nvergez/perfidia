import { createMatch, sortedIds, type AnyRuleset } from "@perfidia/engine";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { canonicalJson, fmt, idKeyFromSeed, sha256Hex } from "@perfidia/engine/core";
import { relationsOf } from "@perfidia/engine/std";
import { visibilityOf } from "@perfidia/gateway";
import { PlayerIdSchema, z, type Hash64, type Sha256 } from "@perfidia/protocol";

// The ruleset fingerprint (docs/architecture.md §13.6): everything agents see from a ruleset, at
// every allowed N: its title, its config defaults and their JSON Schema, the compiled rules, the
// cheat sheet and the initial world (the hash of a match created with seed 1) for each N, every
// error and warning explainer rendered on its samples with core's `fmt`, its extra tools (name,
// family, kind, description and argument JSON Schema) and its own event types with their JSON
// Schemas. A published version whose fingerprint changes was altered (§3.5).
//
// What its visibility hooks show during a match is fingerprinted per golden (`checkpointViews`): at
// every checkpoint of the golden's Level E replay, every seat's view through the hooks, as the
// gateway resolves them with the `std` defaults.

/** What the fingerprint hashes; `compiled`, `cheatSheets` and `worlds` are keyed by N. */
export interface RulesetArtefacts {
  readonly title: string;
  readonly defaults: unknown;
  readonly configSchema: unknown;
  readonly compiled: Readonly<Record<string, unknown>>;
  readonly cheatSheets: Readonly<Record<string, string>>;
  /** The state hash of a match created with seed 1 (`idKeyFromSeed(1)`), no override. */
  readonly worlds: Readonly<Record<string, Hash64>>;
  readonly errors: readonly unknown[];
  readonly tools: readonly unknown[];
  readonly events: Readonly<Record<string, unknown>>;
  readonly intelEvents: readonly string[];
}

/** A Zod schema as JSON Schema; a schema that has none is fingerprinted by its failure text. */
function jsonSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { unrepresentable: "any" });
  } catch (error) {
    return { unrepresentable: error instanceof Error ? error.message : String(error) };
  }
}

/** The initial state hash of `rs` with `n` seats, seed 1 and its derived id key. */
function worldHash(rs: AnyRuleset, n: number): Hash64 {
  const seats = Array.from({ length: n }, (_, i) => ({ id: PlayerIdSchema.parse(`p${i + 1}`) }));
  const setup = { ruleset: rs.ref, overrides: {}, seed: 1, idKey: idKeyFromSeed(1), seats };
  return createMatch(setup, rs, { invariants: "off" }).hash();
}

/** The artefacts the fingerprint hashes (§13.6). */
export function rulesetArtefacts(rs: AnyRuleset): RulesetArtefacts {
  const { min, max } = rs.players(rs.defaults);
  const compiled: Record<string, unknown> = {};
  const cheatSheets: Record<string, string> = {};
  const worlds: Record<string, Hash64> = {};
  for (let n = min; n <= max; n += 1) {
    const rules = rs.compile(rs.defaults, n);
    compiled[String(n)] = rules;
    cheatSheets[String(n)] = rs.cheatSheet(rs.defaults, rules);
    worlds[String(n)] = worldHash(rs, n);
  }
  const errors = rs.errorSamples.map((v) => {
    const explainer = Object.hasOwn(rs.errors, v.code) ? rs.errors[v.code] : undefined;
    const text =
      explainer === undefined ? null : explainer({ code: v.code, details: { ...v.details } }, fmt);
    return {
      code: v.code,
      details: { ...v.details },
      text: text === null ? null : { message: text.message, hint: text.hint },
    };
  });
  const tools = (rs.tools ?? []).map((t) => ({
    name: t.name,
    family: t.family,
    kind: t.kind,
    description: t.description,
    args: jsonSchema(t.args),
  }));
  const events: Record<string, unknown> = {};
  for (const type of sortedIds(rs.eventSchemas)) {
    const schema = rs.eventSchemas[type];
    if (schema !== undefined) events[type] = jsonSchema(schema);
  }
  return {
    title: rs.title,
    defaults: rs.defaults,
    configSchema: jsonSchema(rs.configSchema),
    compiled,
    cheatSheets,
    worlds,
    errors,
    tools,
    events,
    intelEvents: [...(rs.intelEvents ?? [])],
  };
}

/** `sha256Hex(canonicalJson(rulesetArtefacts(rs)))` (§13.6). */
export function rulesetFingerprint(rs: AnyRuleset): Sha256 {
  return sha256Hex(canonicalJson(rulesetArtefacts(rs)));
}

/**
 * What the ruleset's hooks show every seat at one checkpoint, as the gateway resolves them: the
 * briefing extras, the public match and player extras, every player's relations, every city's
 * access and public extras, every movement's access, the standings, and every read extra tool that
 * takes no arguments.
 */
export function checkpointView(r: ReadCtx): unknown {
  const vis = visibilityOf(r);
  const players = sortedIds(r.state.players);
  const cities = sortedIds(r.state.cities);
  const movements = sortedIds(r.state.movements);
  const reads = (r.ruleset.tools ?? []).filter(
    (t) => t.kind === "read" && t.read !== undefined && t.args.safeParse({}).success,
  );
  const seats = players.map((seat) => ({
    seat,
    briefing: vis.briefing(seat),
    cities: cities.map((c) => [c, vis.cityAccess(seat, c), vis.publicCity(seat, c)]),
    movements: movements.map((m) => [m, vis.movementAccess(seat, m)]),
    tools: reads.map((t) => [t.name, t.read?.(r, seat, {}) ?? null]),
  }));
  return {
    t: r.now,
    match: vis.publicMatch(),
    players: players.map((p) => [p, vis.publicPlayer(p), relationsOf(r, p)]),
    standings: r.ruleset.hooks.standings(r),
    seats,
  };
}

/** Accumulates `checkpointView` over a replay: the hash of every checkpoint's view, in order. */
export class ViewHasher {
  private readonly hashes: string[] = [];

  add(r: ReadCtx): void {
    this.hashes.push(sha256Hex(canonicalJson(checkpointView(r))));
  }

  /** The views fingerprint of the replay: a hash of the checkpoints' hashes. */
  digest(): Sha256 {
    return sha256Hex(canonicalJson(this.hashes));
  }
}
