import type { DomainEvent, GameTime, Json, JsonObject, PlayerId } from "@perfidia/protocol";

// What the fold knows of rulesets (phase-3 design §2.1): the only module that names a ruleset's own
// event types. Each published ruleset version maps its sieges and domination countdowns to the
// spectator's `siege` and `countdown` items, by exact ref; any other ruleset falls back to a generic
// `event` item for its public non-standard events. A new ruleset version needs an entry here (an
// unknown one still folds, with generic items).

export interface SiegeOf {
  readonly event: "started" | "broken";
  readonly city: string;
  readonly owner: PlayerId | null;
  readonly by: PlayerId;
  readonly endsAt: GameTime | null;
  readonly cause: string | null;
}

export interface CountdownOf {
  readonly event: "started" | "cancelled";
  readonly key: string;
  readonly members: PlayerId[];
  readonly cities: number | null;
  readonly taken: number | null;
  readonly need: number | null;
  readonly needTaken: number | null;
  readonly endsAt: GameTime | null;
  readonly reason: string | null;
}

export interface RulesetEvents {
  /** A siege start or break, or null. */
  siege(e: DomainEvent): SiegeOf | null;
  /** A domination countdown start or cancellation, or null. */
  countdown(e: DomainEvent): CountdownOf | null;
  /** Ruleset events that never become feed items (private bookkeeping). */
  hidden(type: string): boolean;
  /** Whether a city tag marks the ruleset's prize city. */
  prize(tag: string | null): boolean;
}

const str = (d: JsonObject, k: string): string | null => {
  const v = d[k];
  return typeof v === "string" ? v : null;
};
const int = (d: JsonObject, k: string): number | null => {
  const v = d[k];
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
};
const isPlayer = (v: Json | undefined): v is PlayerId =>
  typeof v === "string" && /^p[1-9][0-9]*$/.test(v);
const player = (d: JsonObject, k: string): PlayerId | null => {
  const v = d[k];
  return isPlayer(v) ? v : null;
};
const players = (d: JsonObject, k: string): PlayerId[] => {
  const v = d[k];
  return Array.isArray(v) ? v.filter(isPlayer) : [];
};

/** perfidia-1 (both versions): sieges and domination countdowns (docs/rulesets/perfidia-1.md §9, §13). */
function perfidia1(prizeTag: string): RulesetEvents {
  return {
    siege(e) {
      if (e.type !== "siege_started" && e.type !== "siege_broken") return null;
      const city = str(e.data, "city");
      const by = player(e.data, "by");
      if (city === null || by === null) return null;
      return {
        event: e.type === "siege_started" ? "started" : "broken",
        city,
        owner: player(e.data, "owner"),
        by,
        endsAt: int(e.data, "endsAt"),
        cause: str(e.data, "cause"),
      };
    },
    countdown(e) {
      if (e.type !== "domination_started" && e.type !== "domination_cancelled") return null;
      const key = str(e.data, "key");
      if (key === null) return null;
      const started = e.type === "domination_started";
      return {
        event: started ? "started" : "cancelled",
        key,
        members: players(e.data, "members"),
        cities: started ? int(e.data, "cities") : null,
        taken: started ? int(e.data, "taken") : null,
        need: started ? int(e.data, "threshold") : null,
        needTaken: started ? int(e.data, "needTaken") : null,
        endsAt: started ? int(e.data, "endsAt") : null,
        reason: started ? null : str(e.data, "reason"),
      };
    },
    hidden: (type) => type === "queues_refunded",
    prize: (tag) => tag === prizeTag,
  };
}

/** Any other ruleset: no siege and no countdown items; any tagged city counts as a prize. */
const GENERIC: RulesetEvents = {
  siege: () => null,
  countdown: () => null,
  hidden: () => false,
  prize: (tag) => tag !== null,
};

const BY_REF: Readonly<Record<string, RulesetEvents>> = {
  "perfidia-1@1.0.0": perfidia1("crown"),
  "perfidia-1@1.1.0": perfidia1("olympus"),
};

/** The event mapping of a ruleset, by exact ref; the generic one for a ref it does not know. */
export function rulesetEvents(ref: string): RulesetEvents {
  return Object.hasOwn(BY_REF, ref) ? (BY_REF[ref] ?? GENERIC) : GENERIC;
}
