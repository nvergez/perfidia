import {
  PlayerIdSchema,
  STANDARD_EVENT_DATA,
  z,
  type GameTime,
  type LogLine,
  type PlayerId,
} from "@perfidia/protocol";

// The battles of a log (docs/architecture.md §12.2): each public `battle` headline joined to the
// `battle_report` copies of the same battle (same second, city, attacker and kind; a ruleset emits
// its reports either all before or all after their headline, and the first battle of the log says
// which) and to the siege its city was under. Whether a defending unit was present comes from a
// full report's defender stacks (perfidia-1 §8.10), the battle points credited from its `points`;
// a ruleset whose reports carry neither leaves them null. A relief is a battle fought against the
// besieger of a city while its siege holds (an attack launched at the besieging garrison), except
// a homecoming (kind `homecoming`: a return fighting its way into its besieged home).

/** One battle of a log. */
export interface BattleRecord {
  readonly t: GameTime;
  readonly city: string;
  readonly attacker: PlayerId;
  /** The defending side's label: a player, or `neutral`. */
  readonly defender: string;
  /** The ruleset's battle type, e.g. `city`, `relief`, `homecoming`. */
  readonly kind: string;
  readonly winner: string;
  /** Defending units before the battle (a full report's defender stacks); null when no report shows them. */
  readonly defenders: number | null;
  /** Battle points credited by the battle (a full report's `points`); null when no report carries them. */
  readonly points: readonly { readonly player: PlayerId; readonly points: number }[] | null;
  /** The siege the city was under when the battle was fought, or null. */
  readonly siege: { readonly owner: PlayerId | null; readonly by: PlayerId } | null;
  /** A `siege_broken` of the city followed in the same second. */
  readonly brokeSiege: boolean;
}

/** The battles of a match by what they were fought over (§12.2). */
export interface BattleSplit {
  /** At least one defending unit was present. */
  readonly defended: number;
  /** No defending unit: a raid on an empty city. */
  readonly empty: number;
  /** No full report says (a ruleset without defender stacks, or every copy redacted). */
  readonly unknown: number;
  /** Fought against the besieger of a held siege, homecomings excluded. */
  readonly relief: number;
  /** Reliefs launched by the besieged city's owner (the others came from a third player). */
  readonly reliefByOwner: number;
  /** Reliefs after which the siege broke in the same second. */
  readonly reliefBroke: number;
  /** Returns that fought their way into their besieged home. */
  readonly homecoming: number;
}

export const HOMECOMING = "homecoming";

/** What joins a report to its headline, and the details read from a full one. */
const ReportSchema = z.looseObject({
  city: z.string(),
  attacker: PlayerIdSchema,
  kind: z.string(),
});
const ReportDetailSchema = z.looseObject({
  stacks: z.array(z.looseObject({ side: z.string(), before: z.int().nonnegative() })).optional(),
  points: z.array(z.looseObject({ player: PlayerIdSchema, points: z.int() })).optional(),
});
const SiegeSchema = z.looseObject({
  city: z.string(),
  owner: PlayerIdSchema.nullable(),
  by: PlayerIdSchema,
});
const CityFieldSchema = z.looseObject({ city: z.string() });

interface Report {
  readonly key: string;
  readonly defenders: number | null;
  readonly points: BattleRecord["points"];
}

type Draft = { -readonly [K in keyof BattleRecord]: BattleRecord[K] };

/** A battle being read, with the key its reports carry. */
interface Open {
  readonly key: string;
  readonly b: Draft;
}

const keyOf = (city: string, attacker: string, kind: string): string =>
  `${city}|${attacker}|${kind}`;

function reportOf(data: unknown): Report | null {
  const head = ReportSchema.safeParse(data);
  if (!head.success) return null;
  const detail = ReportDetailSchema.safeParse(data);
  const stacks = detail.success ? detail.data.stacks : undefined;
  const points = detail.success ? detail.data.points : undefined;
  return {
    key: keyOf(head.data.city, head.data.attacker, head.data.kind),
    defenders:
      stacks === undefined
        ? null
        : stacks.reduce((a, s) => a + (s.side === "defender" ? s.before : 0), 0),
    points:
      points === undefined ? null : points.map((p) => ({ player: p.player, points: p.points })),
  };
}

function attach(o: Open, r: Report): void {
  if (r.key !== o.key) return;
  o.b.defenders ??= r.defenders;
  o.b.points ??= r.points;
}

/** Every battle of a log, in order (any lines; only `ev` lines count). */
export function battleRecords(lines: Iterable<LogLine>): BattleRecord[] {
  const out: Draft[] = [];
  const sieges = new Map<string, { owner: PlayerId | null; by: PlayerId }>();
  let reportsFirst: boolean | null = null;
  let second = -1;
  // Reports waiting for their headline, and the battles of the current second.
  let pending: Report[] = [];
  let current: Open[] = [];
  for (const line of lines) {
    if (line.k !== "ev") continue;
    if (line.t !== second) {
      second = line.t;
      pending = [];
      current = [];
    }
    const { type, data } = line.e;
    if (type === "battle_report") {
      const r = reportOf(data);
      if (r === null) continue;
      reportsFirst ??= true;
      if (reportsFirst) pending.push(r);
      else {
        const o = current.findLast((x) => x.key === r.key);
        if (o !== undefined) attach(o, r);
      }
    } else if (type === "battle") {
      const h = STANDARD_EVENT_DATA.battle.safeParse(data);
      if (!h.success) continue;
      reportsFirst ??= false;
      const { city, attacker, defender, kind, winner } = h.data;
      const b: Draft = {
        t: line.t,
        city,
        attacker,
        defender,
        kind,
        winner,
        defenders: null,
        points: null,
        siege: sieges.get(city) ?? null,
        brokeSiege: false,
      };
      const o: Open = { key: keyOf(city, attacker, kind), b };
      for (const r of pending) attach(o, r);
      pending = [];
      out.push(b);
      current.push(o);
    } else if (type === "siege_started") {
      const s = SiegeSchema.safeParse(data);
      if (s.success) sieges.set(s.data.city, { owner: s.data.owner, by: s.data.by });
    } else if (type === "siege_broken" || type === "city_conquered") {
      const c = CityFieldSchema.safeParse(data);
      if (!c.success) continue;
      sieges.delete(c.data.city);
      if (type === "siege_broken") {
        const o = current.findLast((x) => x.b.city === c.data.city);
        if (o !== undefined) o.b.brokeSiege = true;
      }
    }
  }
  return out;
}

/** Whether a battle was fought against the besieger of its city (a relief or a homecoming). */
const againstBesieger = (b: BattleRecord): boolean => b.siege !== null && b.defender === b.siege.by;

/** Whether a battle is a relief (§12.2). */
export function isRelief(b: BattleRecord): boolean {
  return againstBesieger(b) && b.kind !== HOMECOMING;
}

/** Counts the battles by what they were fought over. */
export function battleSplit(battles: readonly BattleRecord[]): BattleSplit {
  const relief = battles.filter(isRelief);
  return {
    defended: battles.filter((b) => b.defenders !== null && b.defenders > 0).length,
    empty: battles.filter((b) => b.defenders === 0).length,
    unknown: battles.filter((b) => b.defenders === null).length,
    relief: relief.length,
    reliefByOwner: relief.filter((b) => b.siege?.owner === b.attacker).length,
    reliefBroke: relief.filter((b) => b.brokeSiege).length,
    homecoming: battles.filter((b) => b.kind === HOMECOMING).length,
  };
}
