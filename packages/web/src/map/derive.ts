import type { ReportDetail } from "@perfidia/protocol/spectator";
import type { FeedEntry } from "../playback/timeline.ts";

// What the map reads from the feed, pure: battles of the last two game hours (they flash at their
// city), the attacks launched against an ally or pact partner (their markers pulse red), when each
// city's current siege started (for its countdown arc), and which copy of a battle report to show
// (the fullest one: the defender's when the attacker's is redacted).

/** How long a battle flashes on the map: 2 game hours. */
export const BATTLE_FLASH_S = 2 * 3_600;

type BattleItem = Extract<FeedEntry["item"], { k: "battle" }>;

export interface Flash {
  readonly id: string;
  readonly city: BattleItem["city"];
  readonly t: number;
  /** The winner's player id (null: the neutral defender won). */
  readonly winner: BattleItem["attacker"] | null;
  readonly reports: BattleItem["reports"];
  readonly fell: boolean;
}

/** The latest battle at each city within `window` seconds before `t`, newest first. */
export function recentBattles(
  feed: readonly FeedEntry[],
  t: number,
  window: number = BATTLE_FLASH_S,
): Flash[] {
  const out: Flash[] = [];
  const seen = new Set<string>();
  for (let i = feed.length - 1; i >= 0; i -= 1) {
    const item = feed[i]?.item;
    if (item === undefined) continue;
    if (item.t < t - window) break;
    if (item.k !== "battle" || item.t > t || seen.has(item.city)) continue;
    seen.add(item.city);
    const w = item.winner === "attacker" ? item.attacker : item.defender;
    out.push({
      id: item.id,
      city: item.city,
      t: item.t,
      winner: w === "neutral" ? null : w,
      reports: item.reports,
      fell: item.fell,
    });
  }
  return out;
}

export interface SiegeStart {
  readonly t: number;
  readonly endsAt: number | null;
}

export interface FeedFacts {
  /** Movements launched as an attack on an ally or pact partner. */
  readonly againstAlly: ReadonlyMap<string, "ally" | "pact">;
  /** The last siege started at each city. */
  readonly siegeStarts: ReadonlyMap<string, SiegeStart>;
}

const EMPTY: FeedFacts = Object.freeze({ againstAlly: new Map(), siegeStarts: new Map() });

/**
 * A reader of `FeedFacts` that only reads the entries added since its last call when the feed grew
 * (the usual case while playing), and starts over when it did not (a seek back). It returns the
 * same object until a relevant item is added.
 */
export function createFeedFacts(): (feed: readonly FeedEntry[]) => FeedFacts {
  let facts = EMPTY;
  let count = 0;
  let last: FeedEntry | undefined;
  return (feed) => {
    const grew = count <= feed.length && (count === 0 || feed[count - 1] === last);
    let from = count;
    let ally = facts.againstAlly;
    let sieges = facts.siegeStarts;
    if (!grew) {
      from = 0;
      ally = EMPTY.againstAlly;
      sieges = EMPTY.siegeStarts;
    }
    let a: Map<string, "ally" | "pact"> | null = null;
    let s: Map<string, SiegeStart> | null = null;
    for (let i = from; i < feed.length; i += 1) {
      const item = feed[i]?.item;
      if (item?.k === "launch" && item.againstAlly !== null) {
        a ??= new Map(ally);
        a.set(item.movement, item.againstAlly);
      } else if (item?.k === "siege" && item.event === "started") {
        s ??= new Map(sieges);
        s.set(item.city, { t: item.t, endsAt: item.endsAt });
      }
    }
    count = feed.length;
    last = feed[count - 1];
    if (a !== null || s !== null || !grew) {
      facts = { againstAlly: a ?? ally, siegeStarts: s ?? sieges };
    }
    return facts;
  };
}

/** How much a report copy tells: the size of its data (a redacted copy is much smaller). */
function fullness(d: ReportDetail): number {
  return JSON.stringify(d.data).length;
}

/** The fullest of a report's copies (the first one on a tie); null for none. */
export function fullestCopy(copies: readonly ReportDetail[]): ReportDetail | null {
  let best: ReportDetail | null = null;
  for (const c of copies) if (best === null || fullness(c) > fullness(best)) best = c;
  return best;
}
