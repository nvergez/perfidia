// The war-call protocol (docs/architecture.md §11.2): how allied seats ask each other to fight
// together. No published bot version uses it; a new version opts in, as with the relief module.
//
// A call goes from its caller to its allies in one private message (one send against the daily
// message cap, however many allies), in plain text that people and models read as it is, with a tag
// the bots parse. Answers and cancels name the call's id:
//
//   WAR#k3 strike c12 vs p5 land D3 14:00-14:20 (I land 14:05)
//   WAR#k3 yes, landing D3 14:12        WAR#k3 no: too far        WAR#k3 cancel: siege broken
//
// The window is on the game clock (`fmtTime`), its end and the caller's own landing without their
// day when on the window's first day; several answers to one caller ride in one message ("; ").
// Every war message stays within `WAR_LIMITS.text` characters, which a briefing never cuts.
//
// Roles (what a support or an attack does to a besieged city, perfidia-1 §7.3, §7.5, §9.2):
// - `strike`: attack the target so as to land inside the window, before the caller's founders, to
//   break its garrison. An attack fights the foe recorded at launch, the besieger when the target is
//   besieged: a strike is never launched at a besieged city (against the caller's own siege it would
//   be a betrayal), and one already in flight when the caller's siege starts bounces.
// - `siege`: support the caller's siege. Only the besieger may reinforce a garrison, so an ally
//   holds the conquest instead: defenders that land inside the window once the target is the
//   caller's (a support to a besieged city is refused, and one launched before bounces).
// - `hold`: defenders for one of the caller's cities, landing inside the window.
//
// Trust: calls, answers and cancels are read from private messages of current allies only (a public
// message, the seat's own and a non-ally's are ignored, however well formed), at most a few tags
// per message from its first characters. A call is declined when it would help against the seat,
// an ally or a pact partner, when its caller is distrusted (one of its attacks on its way to the
// seat, a betrayal), when its target does not fit its role, or when the seat cannot land in time.
// Calls, answers and the seat's own calls live in the notes as compact memo lines `wc …`, written
// after the other memo lines (the notes keep the newest), which expire an hour after their window.

import {
  compareIds,
  type Briefing,
  type CityId,
  type IslandId,
  type Json,
  type JsonObject,
  type PlayerId,
  type UnitCounts,
} from "@perfidia/protocol";
import { dayOf, DAY, fmtTime, groupTravel, power } from "./kit.ts";
import { MEMO_MAX_CHARS, memoLine, type Memory } from "./memory.ts";
import { besiegedExt } from "./relief.ts";
import type { OwnCity, World } from "./world.ts";

export const WAR_ROLES = Object.freeze(["strike", "siege", "hold"] as const);
export type WarRole = (typeof WAR_ROLES)[number];

export const WAR_LIMITS = Object.freeze({
  /** Longest war message: a briefing shows at least this much of any message body. */
  text: 100,
  /** Longest window a call may ask for, in seconds. */
  window: 6 * 3600,
  /** Characters of a message the parser reads, and tags it parses per message at most. */
  scan: 600,
  tags: 4,
  /** Characters of a call id, and of a reason given with an answer or a cancel. */
  id: 8,
  why: 24,
  /** Entries the notes keep at most, and how long after its window an entry stays. */
  book: 6,
  keep: 3600,
});

/**
 * Messages a seat keeps in hand before each kind of war message (the daily cap, perfidia-1 §11.1):
 * a yes is sent while more than `yes` are left, a call or a cancel while more than `call`, a no only
 * while more than `no` (a silent no costs nothing: the caller plans without that ally).
 */
export const WAR_RESERVE = Object.freeze({ yes: 1, call: 2, no: 6 });

export interface WarCall {
  /** 1 to `WAR_LIMITS.id` lowercase letters and digits, unique among the caller's open calls. */
  readonly id: string;
  readonly role: WarRole;
  readonly target: CityId;
  /** The landing window, in game-seconds: `t0 ≤ t1 ≤ t0 + WAR_LIMITS.window`. */
  readonly t0: number;
  readonly t1: number;
  /** The target's owner as the caller names it (for readers; never trusted), or null. */
  readonly vs: PlayerId | null;
  /** When the caller says it lands itself, or null. */
  readonly lands: number | null;
}

export interface WarAck {
  readonly id: string;
  readonly yes: boolean;
  /** The landing announced with its day, or null. */
  readonly lands: number | null;
  /** The landing announced without its day (seconds into a day), resolved by `ackLanding`. */
  readonly landsTod: number | null;
  readonly why: string | null;
}

export interface WarCancel {
  readonly id: string;
  readonly why: string | null;
}

export type WarItem =
  | { readonly kind: "call"; readonly call: WarCall }
  | { readonly kind: "ack"; readonly ack: WarAck }
  | { readonly kind: "cancel"; readonly cancel: WarCancel };

const ID = /^[a-z0-9]{1,8}$/;
const CITY = /^c[1-9][0-9]{0,5}$/;
const PLAYER = /^p[1-9][0-9]{0,3}$/;
const isCity = (s: string): s is CityId => CITY.test(s);
const isPlayer = (s: string): s is PlayerId => PLAYER.test(s);
const isRole = (s: string): s is WarRole => (WAR_ROLES as readonly string[]).includes(s);

/** A call id from a per-caller counter (≥ 1): `k1`, `k2`, …, `kz`, `k10`, … in base 36. */
export function warId(seq: number): string {
  const n = Number.isSafeInteger(seq) && seq >= 1 ? seq : 1;
  return `k${n.toString(36)}`.slice(0, WAR_LIMITS.id);
}

// Composing.

/** A reason as a war message carries it: lowercase letters, digits and `,.-` spaces, cut short. */
export function warWhy(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9 ,.-]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, WAR_LIMITS.why)
    .trim();
}

/**
 * `t` on the game clock, without its day when the parser would put it back on that day: on the day
 * of `anchor` and not 12 h or more before it (`resolveTod`).
 */
function clockNear(t: number, anchor: number): string {
  const text = fmtTime(t);
  if (dayOf(t) !== dayOf(anchor) || t < anchor - DAY / 2) return text;
  return text.slice(text.indexOf(" ") + 1);
}

/** `WAR#k3 strike c12 vs p5 land D3 14:00-14:20 (I land 14:05)`. */
export function composeCall(c: WarCall): string {
  const vs = c.vs === null ? "" : ` vs ${c.vs}`;
  const own = c.lands === null ? "" : ` (I land ${clockNear(c.lands, c.t0)})`;
  return `WAR#${c.id} ${c.role} ${c.target}${vs} land ${fmtTime(c.t0)}-${clockNear(c.t1, c.t0)}${own}`;
}

/** `WAR#k3 yes, landing D3 14:12`, `WAR#k3 yes`, `WAR#k3 no` or `WAR#k3 no: too far`. */
export function composeAck(id: string, yes: boolean, lands: number | null, why = ""): string {
  const reason = warWhy(why);
  const landing = yes && lands !== null ? `, landing ${fmtTime(lands)}` : "";
  return `WAR#${id} ${yes ? "yes" : "no"}${landing}${reason === "" ? "" : `: ${reason}`}`;
}

/** `WAR#k3 cancel` or `WAR#k3 cancel: siege broken`. */
export function composeCancel(id: string, why = ""): string {
  const reason = warWhy(why);
  return `WAR#${id} cancel${reason === "" ? "" : `: ${reason}`}`;
}

/** War texts joined by `; ` into one message of at most `max` characters, the first ones first. */
export function joinWar(texts: readonly string[], max: number = WAR_LIMITS.text): string {
  let out = "";
  for (const t of texts) {
    const next = out === "" ? t : `${out}; ${t}`;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

// Parsing.

/** A clock time: `D3 14:05[:SS]` (with its day) or `14:05[:SS]` (day null). */
const TIME = String.raw`(?:d(\d{1,4})\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?`;

interface Clock {
  readonly day: number | null;
  /** Seconds into the day. */
  readonly tod: number;
}

function clockOf(
  day: string | undefined,
  hh: string | undefined,
  mm: string | undefined,
  ss: string | undefined,
): Clock | null {
  if (hh === undefined || mm === undefined) return null;
  const h = Number(hh);
  const m = Number(mm);
  const s = ss === undefined ? 0 : Number(ss);
  if (h > 23 || m > 59 || s > 59) return null;
  const d = day === undefined ? null : Number(day);
  if (d !== null && d < 1) return null;
  return { day: d, tod: h * 3600 + m * 60 + s };
}

/**
 * A time of day near `anchor`: on the anchor's day, or the next day when that would be 12 h or more
 * before the anchor (a window ending past midnight).
 */
export function resolveTod(tod: number, anchor: number): number {
  const t = dayOf(anchor) * DAY + tod;
  return t < anchor - DAY / 2 ? t + DAY : t;
}

const absolute = (c: Clock, anchor: number): number =>
  c.day === null ? resolveTod(c.tod, anchor) : (c.day - 1) * DAY + c.tod;

function parseCall(id: string, body: string): WarCall | null {
  const re = new RegExp(
    String.raw`^\s+(strike|siege|hold)\s+(c\d{1,7})(?:\s+vs\s+(p\d{1,5}))?\s+land\s+${TIME}\s*-\s*${TIME}(?:\s*\(\s*i\s+land\s+${TIME}\s*\))?`,
    "i",
  );
  const m = re.exec(body);
  if (m === null) return null;
  const role = (m[1] ?? "").toLowerCase();
  const target = (m[2] ?? "").toLowerCase();
  const vs = m[3] === undefined ? null : m[3].toLowerCase();
  if (!isRole(role) || !isCity(target) || (vs !== null && !isPlayer(vs))) return null;
  const start = clockOf(m[4], m[5], m[6], m[7]);
  const end = clockOf(m[8], m[9], m[10], m[11]);
  if (start === null || start.day === null || end === null) return null;
  const t0 = absolute(start, 0);
  const t1 = absolute(end, t0);
  if (t1 < t0 || t1 - t0 > WAR_LIMITS.window) return null;
  let lands: number | null = null;
  if (m[13] !== undefined) {
    const own = clockOf(m[12], m[13], m[14], m[15]);
    if (own === null) return null;
    lands = absolute(own, t0);
  }
  return { id, role, target, t0, t1, vs: vs !== null && isPlayer(vs) ? vs : null, lands };
}

function parseAck(id: string, body: string): WarAck | null {
  const re = new RegExp(
    String.raw`^\s*[:,]?\s*(yes|no)\b(?:\s*,?\s*landing\s+${TIME})?(?:\s*:\s*([^;\n]{1,60}))?`,
    "i",
  );
  const m = re.exec(body);
  if (m === null) return null;
  const yes = (m[1] ?? "").toLowerCase() === "yes";
  let lands: number | null = null;
  let landsTod: number | null = null;
  if (m[3] !== undefined) {
    const c = clockOf(m[2], m[3], m[4], m[5]);
    if (c === null) return null;
    if (c.day === null) landsTod = c.tod;
    else lands = absolute(c, 0);
  }
  const why = m[6] === undefined ? "" : warWhy(m[6]);
  return { id, yes, lands, landsTod, why: why === "" ? null : why };
}

function parseCancel(id: string, body: string): WarCancel | null {
  const m = /^\s*[:,]?\s*cancel(?:led|s)?\b(?:\s*:\s*([^;\n]{1,60}))?/i.exec(body);
  if (m === null) return null;
  const why = m[1] === undefined ? "" : warWhy(m[1]);
  return { id, why: why === "" ? null : why };
}

/**
 * The war items of a message text: at most `WAR_LIMITS.tags` tags among its first
 * `WAR_LIMITS.scan` characters, each read up to the next tag; a tag whose text is none of the
 * three forms, or whose numbers are out of range, is skipped, and an id seen twice keeps its first
 * item. Never throws, whatever the text.
 */
export function parseWar(text: string): WarItem[] {
  const s = text.slice(0, WAR_LIMITS.scan);
  const tags: { id: string; from: number; to: number }[] = [];
  for (const m of s.matchAll(/war#([a-z0-9]{1,8})(?![a-z0-9])/gi)) {
    if (tags.length > WAR_LIMITS.tags) break;
    const at = m.index;
    const prev = tags.at(-1);
    if (prev !== undefined) prev.to = at;
    tags.push({ id: (m[1] ?? "").toLowerCase(), from: at + m[0].length, to: s.length });
  }
  const out: WarItem[] = [];
  const seen = new Set<string>();
  for (const tag of tags.slice(0, WAR_LIMITS.tags)) {
    if (!ID.test(tag.id) || seen.has(tag.id)) continue;
    const body = s.slice(tag.from, Math.min(tag.to, tag.from + 160));
    const call = parseCall(tag.id, body);
    const ack = call === null ? parseAck(tag.id, body) : null;
    const cancel = call === null && ack === null ? parseCancel(tag.id, body) : null;
    if (call !== null) out.push({ kind: "call", call });
    else if (ack !== null) out.push({ kind: "ack", ack });
    else if (cancel !== null) out.push({ kind: "cancel", cancel });
    else continue;
    seen.add(tag.id);
  }
  return out;
}

/** The landing an answer announces, on the game clock of the call it answers; null when none. */
export function ackLanding(ack: WarAck, call: WarCall): number | null {
  if (ack.lands !== null) return ack.lands;
  return ack.landsTod === null ? null : resolveTod(ack.landsTod, call.t0);
}

type BriefingMessage = Briefing["msgs"][number];

export interface WarHeard {
  readonly from: PlayerId;
  readonly item: WarItem;
}

export interface WarInbox {
  readonly heard: readonly WarHeard[];
  /** Messages with a war tag that were ignored: public, the seat's own, or from a non-ally. */
  readonly ignored: number;
}

/**
 * The war items of the briefing's messages the seat may act on: private messages to the seat from a
 * current ally, in the briefing's order (oldest first). Anything else carrying a tag is counted in
 * `ignored` and never read further: a non-ally, or a public message, can send fake calls.
 */
export function hearWar(
  msgs: readonly BriefingMessage[],
  seat: PlayerId,
  relations: ReadonlyMap<PlayerId, "ally" | "pact">,
): WarInbox {
  const heard: WarHeard[] = [];
  let ignored = 0;
  for (const m of msgs) {
    if (!/war#/i.test(m.text.slice(0, WAR_LIMITS.scan))) continue;
    const trusted =
      m.from !== seat && m.to !== "all" && m.to.includes(seat) && relations.get(m.from) === "ally";
    if (!trusted) {
      ignored += 1;
      continue;
    }
    for (const item of parseWar(m.text)) heard.push({ from: m.from, item });
  }
  return { heard, ignored };
}

// The notes: one memo line per call, `wc <caller> <id> <role> <target> <t0> <t1> <state> <at|->`
// followed, for the seat's own calls, by each ally's answer `<player>=<landing|n>`.

export type WarState = "open" | "yes" | "no" | "sent" | "cancelled";

export interface WarEntry {
  /** The caller: an ally, or the seat itself for its own calls. */
  readonly from: PlayerId;
  readonly call: WarCall;
  readonly state: WarState;
  /** `yes`: the planned launch; `sent`: the planned landing; otherwise null. */
  readonly at: number | null;
  /** The seat's own calls: each ally's answer, its landing (0 when it gave none) or `no`. */
  readonly answers: Readonly<Record<string, number | "no">>;
}

const PREFIX = "wc ";
const ROLE_CODE: Readonly<Record<WarRole, string>> = Object.freeze({
  strike: "s",
  siege: "g",
  hold: "h",
});
const STATE_CODE: Readonly<Record<WarState, string>> = Object.freeze({
  open: "o",
  yes: "y",
  no: "n",
  sent: "s",
  cancelled: "c",
});
const roleOfCode = (c: string): WarRole | null => WAR_ROLES.find((r) => ROLE_CODE[r] === c) ?? null;
const STATES: readonly WarState[] = Object.freeze(["open", "yes", "no", "sent", "cancelled"]);
const stateOfCode = (c: string): WarState | null => STATES.find((s) => STATE_CODE[s] === c) ?? null;
const TIME_TOKEN = /^(0|[1-9][0-9]{0,9})$/;

/** The memo line of an entry; answers that would not fit in a memo line are left out. */
export function encodeEntry(e: WarEntry): string {
  const c = e.call;
  let line = `${PREFIX}${e.from} ${c.id} ${ROLE_CODE[c.role]} ${c.target} ${c.t0} ${c.t1} ${STATE_CODE[e.state]} ${e.at ?? "-"}`;
  for (const p of Object.keys(e.answers).toSorted(compareIds)) {
    const a = e.answers[p];
    const next = `${line} ${p}=${a === "no" ? "n" : String(a)}`;
    if (next.length > MEMO_MAX_CHARS) break;
    line = next;
  }
  return memoLine(line);
}

/** The entry of a memo line, or null when the line is not one (any other text, or cut short). */
export function decodeEntry(line: string): WarEntry | null {
  if (!line.startsWith(PREFIX)) return null;
  const [from, id, role, target, t0s, t1s, state, ats, ...rest] = line
    .slice(PREFIX.length)
    .split(" ");
  if (from === undefined || !isPlayer(from) || id === undefined || !ID.test(id)) return null;
  const r = roleOfCode(role ?? "");
  const s = stateOfCode(state ?? "");
  if (r === null || s === null || target === undefined || !isCity(target)) return null;
  if (!TIME_TOKEN.test(t0s ?? "") || !TIME_TOKEN.test(t1s ?? "")) return null;
  const t0 = Number(t0s);
  const t1 = Number(t1s);
  if (t1 < t0 || t1 - t0 > WAR_LIMITS.window) return null;
  if (ats !== "-" && !TIME_TOKEN.test(ats ?? "")) return null;
  const answers: Record<string, number | "no"> = {};
  for (const token of rest) {
    const m = /^(p[1-9][0-9]{0,3})=(n|0|[1-9][0-9]{0,9})$/.exec(token);
    if (m === null) return null;
    answers[m[1]!] = m[2] === "n" ? "no" : Number(m[2]);
  }
  return {
    from,
    call: { id, role: r, target, t0, t1, vs: null, lands: null },
    state: s,
    at: ats === "-" ? null : Number(ats),
    answers,
  };
}

const sameCall = (a: WarCall, b: WarCall): boolean =>
  a.role === b.role && a.target === b.target && a.t0 === b.t0 && a.t1 === b.t1;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const entryOrder = (a: WarEntry, b: WarEntry): number =>
  a.call.t0 - b.call.t0 || compareIds(a.from, b.from) || byCodeUnit(a.call.id, b.call.id);

/** The war entries of the notes, by window then caller and id; a caller's id given twice keeps its last line. */
export function readBook(memory: Memory): WarEntry[] {
  const byKey = new Map<string, WarEntry>();
  for (const line of memory.m) {
    const e = decodeEntry(line);
    if (e !== null) byKey.set(`${e.from}/${e.call.id}`, e);
  }
  return [...byKey.values()].toSorted(entryOrder);
}

/**
 * `memory` with its war lines replaced by `book`: entries whose window ended more than
 * `WAR_LIMITS.keep` before `now` are dropped, then the `WAR_LIMITS.book` with the latest windows
 * are kept. Memo lines that are not war lines are kept as they are, before the war lines.
 */
export function writeBook(memory: Memory, book: readonly WarEntry[], now: number): Memory {
  const live = book
    .filter((e) => e.call.t1 + WAR_LIMITS.keep >= now)
    .toSorted((a, b) => b.call.t1 - a.call.t1 || entryOrder(a, b))
    .slice(0, WAR_LIMITS.book)
    .toSorted(entryOrder);
  const others = memory.m.filter((line) => !line.startsWith(PREFIX));
  return { ...memory, m: [...others, ...live.map(encodeEntry)] };
}

/**
 * The book once `heard` is taken in (`hearWar`, oldest first): a call from an ally is added open,
 * or replaces an earlier one of the same id that asked something else (an unchanged call keeps its
 * state); a cancel closes the caller's own call of that id; an answer to one of the seat's own calls
 * records that ally's landing or its no. Items about calls the book does not hold are dropped.
 */
export function absorbWar(
  book: readonly WarEntry[],
  heard: readonly WarHeard[],
  seat: PlayerId,
): WarEntry[] {
  const byKey = new Map<string, WarEntry>(book.map((e) => [`${e.from}/${e.call.id}`, e]));
  for (const { from, item } of heard) {
    if (from === seat) continue;
    if (item.kind === "call") {
      const key = `${from}/${item.call.id}`;
      const old = byKey.get(key);
      if (old !== undefined && sameCall(old.call, item.call)) continue;
      byKey.set(key, { from, call: item.call, state: "open", at: null, answers: {} });
    } else if (item.kind === "cancel") {
      const key = `${from}/${item.cancel.id}`;
      const old = byKey.get(key);
      if (old !== undefined) byKey.set(key, { ...old, state: "cancelled" });
    } else {
      const key = `${seat}/${item.ack.id}`;
      const old = byKey.get(key);
      if (old === undefined || old.state === "cancelled") continue;
      const lands = item.ack.yes ? (ackLanding(item.ack, old.call) ?? 0) : "no";
      byKey.set(key, { ...old, answers: { ...old.answers, [from]: lands } });
    }
  }
  return [...byKey.values()].toSorted(entryOrder);
}

// Timing.

export interface Launch {
  /** When to leave: now, or at a self-wake at least `minDelay` ahead. */
  readonly at: number;
  readonly lands: number;
}

export interface LaunchOptions {
  /** Shortest self-wake delay (the gateway's `selfWake.min`). */
  readonly minDelay: number;
  /** No launch before this time (attacks: `time.attackFrom`). */
  readonly earliest?: number;
  /** Where in the window to aim, ‰ of its length from its start (default the middle). */
  readonly aimPm?: number;
}

/**
 * When a group that travels `travel` seconds should leave to land inside the call's window: now,
 * or a time the seat can wake at (at least `minDelay` ahead), not before `earliest`, landing as
 * near the aim as it can (ties: the earlier launch). Null when no such launch lands in the window.
 */
export function launchTime(
  call: WarCall,
  travel: number,
  now: number,
  o: LaunchOptions,
): Launch | null {
  if (!Number.isSafeInteger(travel) || travel < 0) return null;
  const aimPm = Math.max(0, Math.min(1000, o.aimPm ?? 500));
  const aim = call.t0 + Math.floor(((call.t1 - call.t0) * aimPm) / 1000);
  const earliest = o.earliest ?? 0;
  const wake = now + Math.max(0, o.minDelay);
  const candidates = [now, wake, aim - travel, call.t0 - travel, call.t1 - travel, earliest];
  let best: Launch | null = null;
  for (const at of candidates) {
    if (at !== now && at < wake) continue;
    if (at < earliest) continue;
    const lands = at + travel;
    if (lands < call.t0 || lands > call.t1) continue;
    const off = Math.abs(lands - aim);
    if (
      best === null ||
      off < Math.abs(best.lands - aim) ||
      (off === Math.abs(best.lands - aim) && at < best.at)
    ) {
      best = { at, lands };
    }
  }
  return best;
}

/** True when two windows overlap, or come within `margin` seconds of each other. */
export function overlaps(a: WarCall, b: WarCall, margin = 0): boolean {
  return a.t0 <= b.t1 + margin && b.t0 <= a.t1 + margin;
}

// Judging a call.

/** A call's target as the map shows it. */
export interface WarTarget {
  readonly id: CityId;
  readonly island: IslandId;
  readonly owner: PlayerId | null;
  readonly besieged: boolean;
  /** The besieger (public extras, hints), or null when not besieged or unknown. */
  readonly by: PlayerId | null;
}

export type WarWhy =
  | "not allied"
  | "distrust"
  | "own city"
  | "ally city"
  | "pact city"
  | "neutral"
  | "unknown city"
  | "besieged"
  | "not theirs"
  | "too early"
  | "too late"
  | "under attack"
  | "too weak"
  | "no launches";

export type WarVerdict =
  | { readonly accept: true }
  | { readonly accept: false; readonly why: WarWhy };

export interface WarJudgeInput {
  readonly seat: PlayerId;
  readonly now: number;
  readonly from: PlayerId;
  readonly call: WarCall;
  readonly relations: ReadonlyMap<PlayerId, "ally" | "pact">;
  /** The target on the map, or null when the seat does not know the city. */
  readonly target: WarTarget | null;
  /** Players the seat does not trust (`distrustOf`, plus the strategy's own). */
  readonly distrust: ReadonlySet<PlayerId>;
  /** The best launch the seat found, or null when none lands in the window. */
  readonly launch: Launch | null;
  /** What it would send (attack for a strike, defense otherwise), and the least worth sending. */
  readonly force: number;
  readonly minForce: number;
  /** Attack launches left today (a strike needs one). */
  readonly attacksLeft: number;
  /** An attack is on its way to one of the seat's cities: its army stays home. */
  readonly threatened: boolean;
  /** Calls whose window starts more than this far ahead are declined (default 1 day). */
  readonly maxAhead?: number;
}

const no = (why: WarWhy): WarVerdict => ({ accept: false, why });

/**
 * Whether to answer a call yes. Never against the seat, an ally or a pact partner, never for a
 * non-ally or a distrusted caller; a strike only at a city owned by another player and not
 * besieged; a `hold` only of the caller's own city not besieged, a `siege` only of a city the caller
 * besieges or already took; then the window must be in reach and the seat's force worth sending.
 */
export function judgeCall(i: WarJudgeInput): WarVerdict {
  const { call, target, seat, from } = i;
  if (from === seat || i.relations.get(from) !== "ally") return no("not allied");
  if (i.distrust.has(from)) return no("distrust");
  if (target === null || target.id !== call.target) return no("unknown city");
  const owner = target.owner;
  if (call.role === "strike") {
    if (owner === seat) return no("own city");
    if (owner === null) return no("neutral");
    const rel = i.relations.get(owner);
    if (rel === "ally") return no("ally city");
    if (rel === "pact") return no("pact city");
    if (target.besieged) return no("besieged");
  } else if (call.role === "hold") {
    if (owner !== from || target.besieged) return no("not theirs");
  } else {
    const taken = owner === from && !target.besieged;
    const held = target.besieged && target.by === from;
    if (!taken && !held) return no("not theirs");
  }
  if (call.t0 > i.now + (i.maxAhead ?? DAY)) return no("too early");
  if (i.launch === null) return no("too late");
  if (i.threatened) return no("under attack");
  if (call.role === "strike" && i.attacksLeft <= 0) return no("no launches");
  if (i.force <= 0 || i.force < i.minForce) return no("too weak");
  return { accept: true };
}

/** A call the seat can answer yes, with its launch. */
export interface WarCandidate {
  readonly from: PlayerId;
  readonly call: WarCall;
  readonly launch: Launch;
}

const ROLE_RANK: Readonly<Record<WarRole, number>> = Object.freeze({
  strike: 0,
  siege: 1,
  hold: 2,
});

/**
 * The call to answer yes when several pass `judgeCall`: one against a player of `prefer` (the
 * seat's own enemies) first, then strikes before sieges before holds, then the earliest landing,
 * then by caller and id. The order of `cands` does not matter.
 */
export function pickCall(
  cands: readonly WarCandidate[],
  prefer: ReadonlySet<PlayerId> = new Set(),
  ownerOf: (c: CityId) => PlayerId | null = () => null,
): WarCandidate | null {
  const preferred = (c: WarCandidate): number => {
    const owner = ownerOf(c.call.target);
    return owner !== null && prefer.has(owner) ? 0 : 1;
  };
  const sorted = cands.toSorted(
    (a, b) =>
      preferred(a) - preferred(b) ||
      ROLE_RANK[a.call.role] - ROLE_RANK[b.call.role] ||
      a.launch.lands - b.launch.lands ||
      compareIds(a.from, b.from) ||
      byCodeUnit(a.call.id, b.call.id),
  );
  return sorted[0] ?? null;
}

/** Whether a war message of `kind` may be sent with `messagesLeft` sends left today (`WAR_RESERVE`). */
export function mayMessage(kind: "yes" | "no" | "call" | "cancel", messagesLeft: number): boolean {
  const keep = kind === "yes" ? WAR_RESERVE.yes : kind === "no" ? WAR_RESERVE.no : WAR_RESERVE.call;
  return messagesLeft > keep;
}

// World adapters.

const isPlayerId = (v: unknown): v is PlayerId => typeof v === "string" && isPlayer(v);

function extAt(ext: JsonObject | undefined, path: readonly string[]): Json | undefined {
  let cur: Json | undefined = ext;
  for (const key of path) {
    if (cur === undefined || cur === null || typeof cur !== "object" || Array.isArray(cur)) {
      return undefined;
    }
    if (!Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** A city as the map shows it (owner, siege and besieger from the public extras), or null. */
export function warTarget(w: World, city: CityId): WarTarget | null {
  const row = w.map?.cities.find((c) => c.id === city);
  if (row === undefined) return null;
  const path = w.hints.siege?.by;
  const by = path === undefined ? undefined : extAt(row.ext, path);
  return {
    id: row.id,
    island: row.island,
    owner: row.owner,
    besieged: besiegedExt(w, row.ext),
    by: isPlayerId(by) ? by : null,
  };
}

/**
 * Players the seat does not trust this turn: the owner of an attack on its way to one of its cities
 * (an ally's included: "it's only a fake" is how a betrayal starts) and every betrayer the briefing
 * reports.
 */
export function distrustOf(w: World): Set<PlayerId> {
  const out = new Set<PlayerId>();
  const own = new Set<string>(w.cities.map((c) => c.id));
  for (const inc of w.briefing.incoming) {
    if (inc.kind !== "attack" || !own.has(inc.to) || inc.by === w.seat) continue;
    if (inc.foe !== undefined && inc.foe !== null && inc.foe !== w.seat) continue;
    out.add(inc.by);
  }
  for (const e of [...w.briefing.events, ...w.briefing.news]) {
    const by = e["by"];
    if (e.type === "betrayal" && isPlayerId(by) && by !== w.seat) out.add(by);
  }
  return out;
}

/** True when an attack whose foe is the seat is on its way to one of its cities. */
export function threatened(w: World): boolean {
  const own = new Set<string>(w.cities.map((c) => c.id));
  return w.briefing.incoming.some(
    (inc) =>
      inc.kind === "attack" &&
      own.has(inc.to) &&
      inc.arrive[0] > w.t &&
      (inc.foe === undefined || inc.foe === null || inc.foe === w.seat),
  );
}

/** A launch from an own city to a call's target for a group of `units` (its pace), or null. */
export function launchFrom(
  w: World,
  call: WarCall,
  target: WarTarget,
  from: OwnCity,
  units: Readonly<UnitCounts>,
  aimPm?: number,
): Launch | null {
  const row = w.travelRow(from.id, target.island);
  const travel = row === null ? null : groupTravel(w.kit, row, units);
  if (travel === null) return null;
  const strike = call.role === "strike";
  return launchTime(call, travel, w.t, {
    minDelay: w.kit.gateway.selfWake.min,
    ...(strike ? { earliest: w.kit.rules.time.attackFrom } : {}),
    ...(aimPm === undefined ? {} : { aimPm }),
  });
}

/** One own city's share of an answer: what it would send and when it would leave. */
export interface WarOption {
  readonly city: CityId;
  readonly units: UnitCounts;
  /** Land attack (a strike) or land defense (otherwise) of `units`. */
  readonly force: number;
  readonly launch: Launch;
}

/**
 * What the seat could send to a call: from each own city that can act and land in the window,
 * `sharePm` ‰ of its land units at home that fit the role (for a strike, those with more attack
 * than defense; otherwise the others; founders never), most force first. Carriers are the
 * strategy's business when it launches; the travel is timed at the pace of a group with them
 * across water.
 */
export function warOptions(
  w: World,
  call: WarCall,
  target: WarTarget,
  sharePm: number,
): WarOption[] {
  const kit = w.kit;
  const strike = call.role === "strike";
  const stat = strike ? "attack" : "defense";
  const out: WarOption[] = [];
  for (const c of w.cities) {
    if (c.blocked || c.id === target.id) continue;
    const units: Record<string, number> = {};
    for (const row of kit.rules.units) {
      if (row.domain !== "land" || row.id === kit.roles.founder || row[stat] <= 0) continue;
      if (strike ? row.attack <= row.defense : row.defense < row.attack) continue;
      const n = Math.floor(((c.units[row.id] ?? 0) * Math.max(0, Math.min(1000, sharePm))) / 1000);
      if (n > 0) units[row.id] = n;
    }
    const force = power(kit, units, stat, true);
    if (force <= 0) continue;
    const carrier = kit.roles.carrier;
    const paced =
      carrier === null || c.island === target.island ? units : { ...units, [carrier]: 1 };
    const launch = launchFrom(w, call, target, c, paced);
    if (launch === null) continue;
    out.push({ city: c.id, units, force, launch });
  }
  return out.toSorted((a, b) => b.force - a.force || compareIds(a.city, b.city));
}

/**
 * `judgeCall` on the world: the target from the map, the distrusted players and threats from the
 * briefing, the force of `warOptions` (summed over the cities that can land) and the best city's
 * launch. Returns the verdict and the options.
 */
export function judgeWar(
  w: World,
  from: PlayerId,
  call: WarCall,
  o: {
    readonly sharePm: number;
    readonly minForce: number;
    readonly attacksLeft: number;
    readonly distrust?: ReadonlySet<PlayerId>;
  },
): { readonly verdict: WarVerdict; readonly options: WarOption[] } {
  const target = warTarget(w, call.target);
  const options = target === null ? [] : warOptions(w, call, target, o.sharePm);
  const distrust = distrustOf(w);
  for (const p of o.distrust ?? []) distrust.add(p);
  const verdict = judgeCall({
    seat: w.seat,
    now: w.t,
    from,
    call,
    relations: w.relations,
    target,
    distrust,
    launch: options[0]?.launch ?? null,
    force: options.reduce((a, x) => a + x.force, 0),
    minForce: o.minForce,
    attacksLeft: o.attacksLeft,
    threatened: threatened(w),
  });
  return { verdict, options };
}
