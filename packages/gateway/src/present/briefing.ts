import type { ReadCtx } from "@perfidia/engine/contracts";
import {
  citiesOf,
  popCap,
  popUsed,
  queueEtas,
  rates,
  stockAt,
  storageCap,
  unitsAtHome,
} from "@perfidia/engine/std";
import {
  readableNumbers,
  seatBudget,
  seatOf,
  unreadNews,
  type Delivered,
  type GatewayState,
  type SeatState,
  type WakeRecord,
} from "@perfidia/gateway/seat";
import {
  BriefingIncomingSchema,
  BriefingMessageSchema,
  compareIds,
  type Briefing,
  type BriefingCity,
  type BriefingIncoming,
  type City,
  type DeepReadonly,
  type GameTime,
  type JsonObject,
  type PlayerId,
} from "@perfidia/protocol";
import {
  byCodeUnit,
  cutText,
  durationPair,
  lookup,
  orderedUnits,
  resTriple,
  timePair,
  visibilityOf,
  type SeatVisibility,
} from "./common.ts";
import { renderData, renderEvent } from "./events.ts";
import {
  byArrival,
  homecomingFoe,
  originOf,
  ownMovements,
  partyOf,
  seenMovements,
  type SeenMovement,
} from "./movements.ts";
import { gatewayRulesCopy } from "./rules.ts";
import { openProposals } from "./views.ts";

// The briefing (docs/architecture.md §8.2): compact, deterministic JSON built at every wake, after
// the scheduler's `begin` and before `briefed`. It stays within `BRIEFING_TARGET_CHARS` excluding
// the notes, which are always included verbatim (bounded by `notesMaxChars`). Every incoming attack
// (those turned back since the last briefing included) and every open proposal is always listed;
// the other lists (`news`, `moves`, `events`, `msgs`, in that order) give way, oldest entries first
// (latest arrivals first for `moves`), and a `more` entry names the call that lists what was left
// out. Cities, `incoming` and `proposals` never give way, so a seat with full queues in every city,
// several attacks and several open proposals can exceed the target (measured in the tests).

/** The briefing's size target in characters of compact JSON, excluding `notes` (≈ 600 tokens). */
export const BRIEFING_TARGET_CHARS = 2400;

/** The shortest message body a briefing shows when the target forces a cut below `MESSAGE_CUT`. */
export const MESSAGE_MIN_CUT = 100;

/** The lists that give way, least important first. */
const GIVE_WAY = ["news", "moves", "events", "msgs"] as const;
type ListName = (typeof GIVE_WAY)[number];

type BriefingMore = NonNullable<Briefing["more"]>[string];
type MoveEntry = Briefing["moves"][number];
type MessageEntry = Briefing["msgs"][number];
type EventEntry = Briefing["events"][number];
type UnseenEntry = NonNullable<Briefing["lastTurn"]>["unseen"][number];
type RecruitEntry = BriefingCity["recruit"][string][number];

/** Compact JSON characters of a briefing, excluding its notes. */
export function briefingSize(b: Briefing): number {
  return JSON.stringify({ ...b, notes: "" }).length;
}

function briefingCity(
  r: ReadCtx,
  vis: SeatVisibility,
  seat: PlayerId,
  c: DeepReadonly<City>,
): BriefingCity {
  const build: BriefingCity["build"] = [];
  const recruit: BriefingCity["recruit"] = {};
  for (const eta of queueEtas(r, c.id)) {
    if (eta.kind === "build") {
      build.push({ item: eta.item, b: eta.building, lvl: eta.level, end: timePair(eta.end) });
      continue;
    }
    const batch: RecruitEntry = {
      item: eta.item,
      unit: eta.unit,
      n: eta.count,
      end: timePair(eta.end),
    };
    if (eta.done > 0) batch["done"] = eta.done;
    recruit[eta.queue] = [...(lookup(recruit, eta.queue) ?? []), batch];
  }
  const city: BriefingCity = {
    id: c.id,
    isl: c.island,
    res: resTriple(stockAt(r, c.id)),
    rate: resTriple(rates(r, c.id)),
    cap: storageCap(r, c.id),
    pop: [popUsed(r, c.id), popCap(r, c.id)],
    build,
    recruit,
    units: orderedUnits(r.rules.units, unitsAtHome(r, c.id)),
    stationed: c.stationed.length,
  };
  const ext = vis.publicCity(seat, c.id);
  if (Object.keys(ext).length > 0) city.ext = ext;
  return city;
}

/**
 * Whether a movement the seat can see, and does not own, belongs in `incoming`: the seat is its
 * recorded foe or party (as `partyOf` shows it), or it heads to one of the seat's cities; and for
 * an attack (or a return heading into a held city, a coming homecoming battle), also when it heads
 * to a city the seat sees in full (an ally's) or where the seat has a stationed group.
 */
function concerns(r: ReadCtx, vis: SeatVisibility, seat: PlayerId, s: SeenMovement): boolean {
  const { m } = s;
  if (m.owner === seat || m.to === null) return false;
  if (partyOf(r, m, s.access, seat) === seat) return true;
  const to = lookup(r.state.cities, m.to);
  if (to === undefined) return false;
  if (to.owner === seat) return true;
  if (m.kind !== "attack" && m.kind !== "return") return false;
  if (to.stationed.some((g) => g.owner === seat)) return true;
  return vis.cityAccess(seat, to.id) === "full";
}

function incomingEntry(r: ReadCtx, seat: PlayerId, s: SeenMovement): BriefingIncoming | null {
  const { m } = s;
  if (m.to === null) return null;
  const entry: BriefingIncoming = {
    id: m.id,
    kind: m.kind,
    from: originOf(m, s.access),
    by: m.owner,
    to: m.to,
    depart: timePair(m.departAt),
    arrive: timePair(m.arriveAt),
  };
  if (m.kind === "attack" || m.kind === "return") entry.foe = partyOf(r, m, s.access, seat);
  if (m.back !== null && s.access !== "incoming") entry.turnedBack = timePair(m.back.at);
  if (homecomingFoe(r, m, seat) !== null) entry.homecoming = true;
  return entry;
}

/**
 * The attacks the seat was told about and that were turned back since its last briefing, which it
 * no longer sees (perfidia-1 §7.4: "the target's incoming list drops it and shows 'turned back at
 * t'"): one entry per `movement_recalled` of an attack in the inbox, rendered from the attack's
 * last `incoming_attack` notice in the archive, with `turnedBack` at the recall's time. Taken from
 * the seat's own archive only; an attack still in `visible` or without a notice is left out.
 */
function recalledAttacks(s: SeatState, visible: ReadonlySet<string>): BriefingIncoming[] {
  const out: BriefingIncoming[] = [];
  const done = new Set<string>();
  for (const d of s.inbox) {
    const ev = d.event;
    const id = ev.data["movement"];
    if (ev.type !== "movement_recalled" || ev.data["kind"] !== "attack") continue;
    if (typeof id !== "string" || visible.has(id) || done.has(id)) continue;
    const notice = s.archive.findLast(
      (x) =>
        x.e < d.e &&
        x.event.type === "incoming_attack" &&
        x.event.data["movement"] === id &&
        x.event.data["homecoming"] !== true,
    )?.event.data;
    const departAt = notice?.["departAt"];
    const arriveAt = notice?.["arriveAt"];
    if (notice === undefined || typeof departAt !== "number" || typeof arriveAt !== "number") {
      continue;
    }
    const entry = BriefingIncomingSchema.safeParse({
      id,
      kind: "attack",
      from: notice["from"],
      by: notice["by"],
      foe: notice["foe"] ?? null,
      to: notice["to"],
      depart: timePair(departAt),
      arrive: timePair(arriveAt),
      turnedBack: timePair(ev.t),
    });
    if (!entry.success) continue;
    out.push(entry.data);
    done.add(id);
  }
  return out;
}

/** A message the seat received, for `msgs`: typed fields, control characters stripped, body cut. */
function messageEntry(d: Delivered): MessageEntry | null {
  const data = renderData(d.event.data);
  const entry: JsonObject = {
    id: data["message"] ?? null,
    from: data["from"] ?? null,
    to: data["to"] ?? null,
    text: data["text"] ?? "",
  };
  if (data["cut"] === true) entry["cut"] = true;
  const parsed = BriefingMessageSchema.safeParse(entry);
  return parsed.success ? parsed.data : null;
}

/**
 * An entry that can give way, with the game time it happened at and, for an archived event (every
 * list but `moves`), its delivery number.
 */
interface Item<V> {
  readonly t: GameTime;
  readonly e?: number;
  readonly value: V;
}

interface Lists {
  news: Item<EventEntry>[];
  moves: Item<MoveEntry>[];
  events: Item<EventEntry>[];
  msgs: Item<MessageEntry>[];
}

/**
 * The call that lists the entries left out of a list (§8.2): `view_player` on oneself for `moves`;
 * for the others a `read_notes` search since the last briefing, newest first, of the entries
 * numbered below `before` (one past the newest entry left out, so none the briefing kept): of the
 * messages (`msgs`), of the event types left out (`events`, an addition to §8.2, whose calls cover
 * `moves`, `msgs` and `news` only), or of the public feed (`news`). For `msgs` the search also
 * lists the seat's own messages of that span; past 20 hits, `more` pages on with `before`.
 */
function moreCall(
  name: ListName,
  seat: PlayerId,
  since: GameTime,
  before: number,
  leftTypes: readonly string[],
): BriefingMore["call"] {
  if (name === "moves") return { tool: "view_player", args: { player: seat } };
  if (name === "news") {
    return { tool: "read_notes", args: { search: { scope: "public", since, before } } };
  }
  const kinds = name === "msgs" ? ["message"] : [...new Set(leftTypes)].toSorted(byCodeUnit);
  return { tool: "read_notes", args: { search: { scope: "mine", kinds, since, before } } };
}

/** How many entries of each list are kept. */
type Keep = Record<ListName, number>;

/** The kept entries: the earliest arrivals of `moves`, the newest entries of the other lists. */
function keptOf<V>(name: ListName, list: readonly Item<V>[], keep: number): V[] {
  const kept = name === "moves" ? list.slice(0, keep) : list.slice(list.length - keep);
  return kept.map((x) => x.value);
}

/** `more` for the lists cut short, or `null` when nothing was left out. */
function moreOf(
  all: Readonly<Lists>,
  keep: Readonly<Keep>,
  seat: PlayerId,
  since: GameTime,
  readable: () => ReadonlyMap<number, number>,
): Record<string, BriefingMore> | null {
  const more: Record<string, BriefingMore> = {};
  // Entries left out: the latest arrivals of `moves`, the oldest entries of the other lists.
  const leftTypes = all.events.slice(0, all.events.length - keep.events).map((x) => x.value.type);
  for (const name of ["moves", "msgs", "events", "news"] as const) {
    const list: readonly Item<unknown>[] = all[name];
    const count = list.length - keep[name];
    if (count <= 0) continue;
    // One past the readable number of the newest entry left out: the search lists it and older.
    const newest = list[count - 1]?.e;
    const before = newest === undefined ? 1 : (readable().get(newest) ?? 0) + 1;
    more[name] = { count, call: moreCall(name, seat, since, before, leftTypes) };
  }
  return Object.keys(more).length === 0 ? null : more;
}

function byArrive(a: BriefingIncoming, b: BriefingIncoming): number {
  return a.arrive[0] - b.arrive[0] || compareIds(a.id, b.id);
}

/**
 * `buildBriefing(r, seat, gw, wake)`: the seat's briefing at `r.now`, for the wake `begin` opened
 * (its reasons and urgency). Pure: it reads the match and the gateway state and builds fresh
 * objects. The inbox gives `msgs` (messages from others) and `events` (everything else addressed
 * to the seat, except proposals, which `proposals` lists from the state with their texts, and the
 * incoming and recall notices of the attacks `incoming` lists); `news` is the public feed since the
 * last briefing, minus what the inbox holds.
 */
export function buildBriefing(
  r: ReadCtx,
  seat: PlayerId,
  gw: GatewayState,
  wake: WakeRecord,
): Briefing {
  const s = seatOf(gw, seat);
  const vis = visibilityOf(r);
  const now = r.now;

  const cities: BriefingCity[] = [];
  for (const id of citiesOf(r, seat)) {
    const c = r.state.cities[id];
    if (c !== undefined) cities.push(briefingCity(r, vis, seat, c));
  }

  const seen = seenMovements(r, vis, seat).toSorted(byArrival);
  const visible = seen
    .filter((x) => concerns(r, vis, seat, x))
    .flatMap((x) => {
      const entry = incomingEntry(r, seat, x);
      return entry === null ? [] : [entry];
    });
  const visibleIds = new Set<string>(visible.map((x) => x.id));
  const recalled = recalledAttacks(s, visibleIds);
  const recalledIds = new Set<string>(recalled.map((x) => x.id));
  const incoming = [...visible, ...recalled].toSorted(byArrive);
  const moves: Item<MoveEntry>[] = ownMovements(r, seat)
    .toSorted(byArrival)
    .map((x) => ({
      t: x.m.arriveAt,
      value: { id: x.m.id, kind: x.m.kind, to: x.m.to, arrive: timePair(x.m.arriveAt) },
    }));

  const msgs: Item<MessageEntry>[] = [];
  const events: Item<EventEntry>[] = [];
  for (const d of s.inbox) {
    const ev = d.event;
    if (ev.type === "message") {
      const entry = ev.data["from"] === seat ? null : messageEntry(d);
      if (entry !== null) msgs.push({ t: ev.t, e: d.e, value: entry });
      continue;
    }
    if (ev.type === "proposal") continue;
    const movement = ev.data["movement"];
    const listed =
      typeof movement === "string" &&
      (ev.type.startsWith("incoming_")
        ? visibleIds.has(movement) || recalledIds.has(movement)
        : ev.type === "movement_recalled" && recalledIds.has(movement));
    if (!listed) events.push({ t: ev.t, e: d.e, value: renderEvent(ev) });
  }
  const news: Item<EventEntry>[] = unreadNews(gw, seat).map((d) => ({
    t: d.event.t,
    e: d.e,
    value: renderEvent(d.event),
  }));
  let numbers: ReadonlyMap<number, number> | null = null;
  const readable = (): ReadonlyMap<number, number> => {
    numbers ??= readableNumbers(gw, seat);
    return numbers;
  };

  const b = seatBudget(s, gatewayRulesCopy(r.rules.gateway), now);
  const budget: Briefing["budget"] = {
    roundTrips: b.roundTrips,
    callsPerRoundTrip: b.callsPerRoundTrip,
    ownWakesLeft: b.ownWakesLeft,
    socialWakesLeft: b.socialWakesLeft,
    selfWakeAt: b.selfWakeAt === null ? null : timePair(b.selfWakeAt),
    attacksLeft: b.attacksLeft,
    messagesLeft: b.messagesLeft,
  };
  if (b.callsPerWake !== null) budget.callsPerWake = b.callsPerWake;

  const last = s.lastTurn;
  const lastTurn: Briefing["lastTurn"] =
    last === null
      ? null
      : {
          ended: last.ended,
          unseen: last.unseen.map((u) => {
            const entry: UnseenEntry = { tool: u.tool, code: u.code, message: u.message };
            if (u.count !== undefined) entry["count"] = u.count;
            return entry;
          }),
          warnings: last.warnings.map((w) => ({ tool: w.tool, code: w.code, message: w.message })),
          nextWake:
            last.nextWake === null
              ? null
              : { at: timePair(last.nextWake.at), kind: last.nextWake.kind },
        };

  const fixed = {
    you: seat,
    t: now,
    time: timePair(now)[1],
    left: durationPair(Math.max(0, r.rules.time.matchEnd - now)),
    ruleset: r.rules.ruleset,
    wake: { urgent: wake.urgent, reasons: [...wake.reasons] },
    lastTurn,
    cities,
    incoming,
    proposals: openProposals(r, seat, gw),
    notes: s.notes,
    budget,
    ext: vis.briefing(seat),
  };
  const all: Lists = { news, moves, events, msgs };
  const assemble = (keep: Readonly<Keep>, shortened?: MessageEntry): Briefing => {
    const briefing: Briefing = {
      ...fixed,
      moves: keptOf("moves", moves, keep.moves),
      msgs: shortened === undefined ? keptOf("msgs", msgs, keep.msgs) : [shortened],
      events: keptOf("events", events, keep.events),
      news: keptOf("news", news, keep.news),
    };
    const more = moreOf(all, keep, seat, s.lastBriefingAt, readable);
    if (more !== null) briefing.more = more;
    return briefing;
  };

  // Each list in turn, least important first, keeps the most entries that bring the briefing
  // within the target (a binary search: the size grows with the entries kept). When even none
  // does, it keeps whichever of all or none makes the briefing smaller (a short list can cost less
  // than its `more` entry), and the next list gives way.
  const keep: Keep = {
    news: news.length,
    moves: moves.length,
    events: events.length,
    msgs: msgs.length,
  };
  let briefing = assemble(keep);
  for (const name of GIVE_WAY) {
    const size = briefingSize(briefing);
    if (size <= BRIEFING_TARGET_CHARS) break;
    const none = assemble({ ...keep, [name]: 0 });
    if (briefingSize(none) > BRIEFING_TARGET_CHARS) {
      if (briefingSize(none) < size) {
        keep[name] = 0;
        briefing = none;
      }
      continue;
    }
    let best = { k: 0, briefing: none };
    let lo = 1;
    let hi = keep[name] - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = assemble({ ...keep, [name]: mid });
      if (briefingSize(candidate) <= BRIEFING_TARGET_CHARS) {
        best = { k: mid, briefing: candidate };
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    keep[name] = best.k;
    briefing = best.briefing;
  }
  return keep.msgs > 0 ? briefing : (withShortenedMessage(msgs, keep, assemble) ?? briefing);
}

/**
 * When not even the newest message fits with its body cut at `MESSAGE_CUT`, the briefing keeps it
 * with the longest body that fits, down to `MESSAGE_MIN_CUT` characters (`cut: true`), rather than
 * leaving every message out: an addition to §8.2, whose cut is 300 characters. `null` when even
 * that does not fit.
 */
function withShortenedMessage(
  msgs: readonly Item<MessageEntry>[],
  keep: Readonly<Keep>,
  assemble: (keep: Readonly<Keep>, shortened?: MessageEntry) => Briefing,
): Briefing | null {
  const newest = msgs.at(-1)?.value;
  if (newest === undefined || newest.text.length <= MESSAGE_MIN_CUT) return null;
  const at = (length: number): Briefing =>
    assemble({ ...keep, msgs: 1 }, { ...newest, text: cutText(newest.text, length), cut: true });
  let lo = MESSAGE_MIN_CUT;
  let hi = newest.text.length - 1;
  let best: Briefing | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = at(mid);
    if (briefingSize(candidate) <= BRIEFING_TARGET_CHARS) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
