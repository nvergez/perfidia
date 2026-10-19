import type { FeedItem, FeedItemOf } from "@perfidia/protocol/spectator";
import type { PlayerId } from "../lib/ids.ts";
import type { FeedEntry } from "../playback/timeline.ts";
import type { FeedFilter } from "../store/ui.ts";

// The feed's filters (phase-3 design §4.3 "Feed", §4.2.4 "Pair filter"), pure: the chips (All,
// Diplomacy, Military, Thoughts, Private only), the player multi-select, and the pair mode
// (everything between two players, in time order). Also the lookups the cards need: a message's
// same-turn thought, an entry by its cursor and id, and who saw a private message.

export interface FilterChip {
  readonly id: FeedFilter;
  readonly label: string;
  readonly hint: string;
}

export const FILTER_CHIPS: readonly FilterChip[] = Object.freeze([
  { id: "all", label: "All", hint: "Everything, spying and foundings included" },
  {
    id: "diplomacy",
    label: "Diplomacy",
    hint: "Messages, proposals, alliances, pacts and betrayals",
  },
  { id: "military", label: "Military", hint: "Attacks launched, battles, sieges and conquests" },
  { id: "thoughts", label: "Thoughts", hint: "What each agent thought at the end of its turns" },
  { id: "private", label: "Private only", hint: "Private messages and proposals" },
]);

/** What the feed shows: a chip, the players picked (empty: everyone), the pair mode, bot turns. */
export interface FeedView {
  readonly filter: FeedFilter;
  readonly players: readonly PlayerId[];
  readonly pair: readonly [PlayerId, PlayerId] | null;
  /** Bots' turn summaries count as thoughts. */
  readonly showBots: boolean;
  /** No agent plays the match: the Thoughts chip shows the bots' turn summaries (as the column does). */
  readonly botsOnly?: boolean;
}

export const DEFAULT_VIEW: FeedView = Object.freeze({
  filter: "all",
  players: [],
  pair: null,
  showBots: false,
  botsOnly: false,
});

/** A turn item worth showing: an agent's, or a bot's when bots are shown. */
function isThought(item: FeedItemOf<"turn">, showBots: boolean): boolean {
  return item.llm || showBots;
}

/** An attack launched against the attacker's own ally or pact partner. */
export function isAttackOnAlly(item: FeedItem): item is FeedItemOf<"launch"> {
  return item.k === "launch" && item.againstAlly !== null;
}

type Kind = FeedItem["k"];

const DIPLOMACY: ReadonlySet<Kind> = new Set<Kind>([
  "message",
  "proposal",
  "answer",
  "expired",
  "diplomacy",
  "betrayal",
  "handoff",
  "end",
]);
const MILITARY: ReadonlySet<Kind> = new Set<Kind>([
  "battle",
  "siege",
  "conquest",
  "elimination",
  "countdown",
  "betrayal",
  "end",
]);
const PROPOSALS: ReadonlySet<Kind> = new Set<Kind>(["proposal", "answer", "expired"]);

/** Whether `item` belongs to the chip `filter`. */
export function inCategory(
  item: FeedItem,
  filter: FeedFilter,
  showBots: boolean,
  botsOnly = false,
): boolean {
  switch (filter) {
    case "all":
      if (item.k === "turn") return isThought(item, showBots);
      if (item.k === "launch") return item.importance >= 1;
      return true;
    case "diplomacy":
      return DIPLOMACY.has(item.k) || isAttackOnAlly(item);
    case "military":
      return MILITARY.has(item.k) || (item.k === "launch" && item.importance >= 1);
    case "thoughts":
      return item.k === "turn" && isThought(item, showBots || botsOnly);
    case "private":
      return item.k === "message" ? item.private : PROPOSALS.has(item.k);
  }
  throw new Error("inCategory: unknown filter");
}

/** Whether `item` involves any of `players` (empty: everyone). */
export function involves(item: FeedItem, players: readonly PlayerId[]): boolean {
  if (players.length === 0) return true;
  return item.players.some((p) => players.includes(p));
}

const same = (x: readonly [string, string], a: PlayerId, b: PlayerId): boolean =>
  (x[0] === a && x[1] === b) || (x[0] === b && x[1] === a);

/**
 * Whether `item` happens between `a` and `b`: a message from one to the other, a proposal or its
 * answer, a pact or alliance change with both, a battle, siege or conquest of one against the
 * other, a launch by one at the other (an attack, a support, a shipment), a betrayal. Turns are
 * left out: each message carries its sender's thought of that turn.
 */
export function between(item: FeedItem, a: PlayerId, b: PlayerId): boolean {
  switch (item.k) {
    case "message":
      if (item.to === "all") return false;
      return (item.from === a && item.to.includes(b)) || (item.from === b && item.to.includes(a));
    case "proposal":
    case "answer":
    case "expired":
      return same([item.from, item.to], a, b);
    case "betrayal":
      return same([item.by, item.against], a, b);
    case "launch": {
      const other = item.owner === a ? b : item.owner === b ? a : null;
      return other !== null && (item.foe === other || item.target === other);
    }
    case "battle":
      return same([item.attacker, item.defender], a, b);
    case "siege":
      return item.owner !== null && same([item.by, item.owner], a, b);
    case "conquest":
      return item.from !== null && same([item.from, item.to], a, b);
    case "diplomacy":
    case "spy":
    case "countdown":
    case "event":
    case "end":
      return item.players.includes(a) && item.players.includes(b);
    case "turn":
    case "founding":
    case "elimination":
    case "handoff":
      return false;
  }
  throw new Error("between: unknown feed item kind");
}

/** Whether the feed shows `item` under `view` (the pair mode replaces the chips and players). */
export function visible(item: FeedItem, view: FeedView): boolean {
  if (view.pair !== null) return between(item, view.pair[0], view.pair[1]);
  return (
    inCategory(item, view.filter, view.showBots, view.botsOnly === true) &&
    involves(item, view.players)
  );
}

/** The entries `view` shows, in order. */
export function filterFeed(feed: readonly FeedEntry[], view: FeedView): FeedEntry[] {
  return feed.filter((e) => visible(e.item, view));
}

/** The last `limit` entries (the rendered window), and how many older ones are hidden. */
export function windowOf<T>(
  list: readonly T[],
  limit: number,
): { readonly shown: readonly T[]; readonly hidden: number } {
  const n = Math.max(0, list.length - limit);
  return { shown: n === 0 ? list : list.slice(n), hidden: n };
}

/** Entries merged by cursor, then by id (older pages from the server and the local feed). */
export function mergeEntries(
  older: readonly FeedEntry[],
  local: readonly FeedEntry[],
  /** The frame's cursor: older pages never show what lies after the playhead. */
  cursor: number = Number.POSITIVE_INFINITY,
): readonly FeedEntry[] {
  if (older.length === 0) return local;
  const firstLocal = local[0];
  const seen = new Set(local.map((e) => e.item.id));
  const before = older.filter(
    (e) =>
      !seen.has(e.item.id) &&
      e.seq <= cursor &&
      (firstLocal === undefined || e.seq <= firstLocal.seq),
  );
  return before.length === 0 ? local : [...before, ...local];
}

// Lookups -----------------------------------------------------------------------------------------

/** `seat:turn` of a turn item. */
export const turnKeyOf = (seat: string, turn: number): string => `${seat}:${turn}`;

/**
 * The turn whose thought a message card shows (phase-3 design §4.1): its sender's, of the turn it
 * was sent in (that turn's item closes it, after the message). Null for a message outside a turn.
 */
export function sameTurnOf(
  item: FeedItemOf<"message">,
): { readonly seat: PlayerId; readonly turn: number } | null {
  return item.turn === null ? null : { seat: item.from, turn: item.turn };
}

/** Every turn item of a feed by `seat:turn`. */
export function turnIndex(feed: readonly FeedEntry[]): ReadonlyMap<string, FeedEntry> {
  const out = new Map<string, FeedEntry>();
  for (const e of feed) {
    if (e.item.k === "turn") out.set(turnKeyOf(e.item.seat, e.item.turn), e);
  }
  return out;
}

/** The turn items of one seat, oldest first. */
export function turnsOf(feed: readonly FeedEntry[], seat: string): FeedItemOf<"turn">[] {
  const out: FeedItemOf<"turn">[] = [];
  for (const e of feed) if (e.item.k === "turn" && e.item.seat === seat) out.push(e.item);
  return out;
}

/** The cursor of a feed item id (`"<seq>:<i>"`). */
export function seqOfItem(id: string): number | null {
  const head = id.split(":")[0] ?? "";
  return /^[0-9]+$/.test(head) ? Number(head) : null;
}

/** The entry of item `id` at cursor `seq` (the feed is in cursor order), by binary search. */
export function findEntry(feed: readonly FeedEntry[], seq: number, id: string): FeedEntry | null {
  let lo = 0;
  let hi = feed.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((feed[mid]?.seq ?? Number.MAX_SAFE_INTEGER) < seq) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < feed.length; i += 1) {
    const e = feed[i];
    if (e === undefined || e.seq !== seq) break;
    if (e.item.id === id) return e;
  }
  return null;
}

/**
 * The battle a betrayal was: the betrayer's attack on the city, at the same time and just before it
 * in the log (the outcome the betrayal card tells: did the city hold?). Null when not held.
 */
export function betrayalBattle(
  feed: readonly FeedEntry[],
  seq: number,
  b: FeedItemOf<"betrayal">,
): FeedItemOf<"battle"> | null {
  let lo = 0;
  let hi = feed.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((feed[mid]?.seq ?? Number.MAX_SAFE_INTEGER) <= seq) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0; i -= 1) {
    const it = feed[i]?.item;
    if (it === undefined || it.t < b.t) break;
    if (it.k === "battle" && it.t === b.t && it.city === b.city && it.attacker === b.by) return it;
  }
  return null;
}

/** Who saw a message: everyone, or its sender and recipients (a private message). */
export function seenBy(item: FeedItemOf<"message">): readonly string[] | "all" {
  if (item.to === "all") return "all";
  return [item.from, ...item.to.filter((p) => p !== item.from)];
}

// Alliances' history ------------------------------------------------------------------------------

export interface AllianceInfo {
  readonly name: string | null;
  /** Its members when it was formed, and those who joined later. */
  readonly members: readonly string[];
}

const ALLIANCES = new WeakMap<readonly FeedEntry[], ReadonlyMap<string, AllianceInfo>>();

/**
 * Every alliance the feed has seen formed, by id, with its name and members: an alliance that has
 * dissolved is gone from the frame but still named in the cards (two may share a name: the id and
 * the members tell them apart). Cached per feed array.
 */
export function allianceNamesOf(feed: readonly FeedEntry[]): ReadonlyMap<string, AllianceInfo> {
  const hit = ALLIANCES.get(feed);
  if (hit !== undefined) return hit;
  const out = new Map<string, AllianceInfo>();
  for (const e of feed) {
    const it = e.item;
    if (it.k !== "diplomacy" || it.alliance === null) continue;
    const cur = out.get(it.alliance);
    if (it.event === "alliance_formed") {
      out.set(it.alliance, { name: it.name ?? cur?.name ?? null, members: [...it.players] });
    } else if (it.event === "alliance_joined" && cur !== undefined) {
      const add = it.players.filter((p) => !cur.members.includes(p));
      out.set(it.alliance, { name: it.name ?? cur.name, members: [...cur.members, ...add] });
    }
  }
  ALLIANCES.set(feed, out);
  return out;
}
