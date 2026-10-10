import { fmtTime } from "@perfidia/engine/core";
import {
  READ_NOTES_MAX_HITS,
  type ArchiveEntry,
  type ArchiveHit,
  type DomainEvent,
  type Json,
  type PlayerId,
} from "@perfidia/protocol";
import { seatOf } from "./state.ts";
import { copyEvent, cut, foldAscii, stripControl } from "./text.ts";
import type { ArchiveQuery, Delivered, GatewayState } from "./types.ts";

// `read_notes` over the seat's archive and the public feed (§8.4): search with scopes and filters,
// and `open` by message or report id. Deterministic: no Intl, ASCII case folding only (§6.5).

/** Maximum length of a summary line, and of the text quoted in it. */
const SUMMARY_MAX = 240;
const SUMMARY_TEXT_MAX = 80;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function render(value: Json): string {
  if (typeof value === "string") return stripControl(value);
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map(render).join(",")}]`;
  return `{${Object.keys(value)
    .toSorted(byCodeUnit)
    .map((k) => `${k}:${render(value[k] ?? null)}`)
    .join(",")}}`;
}

/**
 * A deterministic one-line summary: the type, `(public)` for a public event, the data fields as
 * `key=value` in code-unit order, then the player-authored `text`, quoted and cut.
 */
export function summarizeEvent(ev: DomainEvent): string {
  const parts: string[] = [ev.public ? `${ev.type} (public)` : ev.type];
  for (const key of Object.keys(ev.data).toSorted(byCodeUnit)) {
    if (key === "text") continue;
    parts.push(`${key}=${render(ev.data[key] ?? null)}`);
  }
  const text = ev.data.text;
  if (typeof text === "string") parts.push(`text="${cut(stripControl(text), SUMMARY_TEXT_MAX)}"`);
  return cut(parts.join(" "), SUMMARY_MAX);
}

/** The message or report id an entry can be opened by, or `null`. */
export function entryId(ev: DomainEvent): string | null {
  for (const key of ["message", "report"] as const) {
    const value = ev.data[key];
    if (typeof value === "string") return value;
  }
  return null;
}

/** Keys whose values are player-authored text, never a counterpart. */
const isAuthoredKey = (key: string): boolean => key === "text" || key === "name";

function mentions(value: Json, p: PlayerId): boolean {
  if (typeof value === "string") return value === p;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => mentions(v, p));
  return Object.keys(value).some((k) => !isAuthoredKey(k) && mentions(value[k] ?? null, p));
}

/**
 * Whether `viewer` can tell that the event involves `p`: `p` is named in its data (authored text
 * aside), or `p` is the viewer itself and among the recipients. The other recipients are routing
 * metadata that the engine may compute from hidden data (a `stationed` audience, an ally list), so
 * they never count, nor are they shown (fog of war, §8.1).
 */
export function involves(ev: DomainEvent, p: PlayerId, viewer: PlayerId): boolean {
  return mentions(ev.data, p) || (p === viewer && ev.to.some((r) => r.p === viewer));
}

/** Entries of `scope`, in delivery order, each once. */
function pool(gw: GatewayState, seat: PlayerId, scope: "mine" | "public" | "all"): Delivered[] {
  const mine = seatOf(gw, seat).archive;
  if (scope === "mine") return mine;
  if (scope === "public") return gw.feed;
  const merged: Delivered[] = [];
  let i = 0;
  let j = 0;
  while (i < mine.length || j < gw.feed.length) {
    const a = mine[i];
    const b = gw.feed[j];
    if (b === undefined || (a !== undefined && a.e < b.e)) {
      merged.push(a!);
      i += 1;
    } else if (a === undefined || b.e < a.e) {
      merged.push(b);
      j += 1;
    } else {
      merged.push(a);
      i += 1;
      j += 1;
    }
  }
  return merged;
}

function toHit(d: Delivered): ArchiveHit {
  const ev = d.event;
  return {
    e: d.e,
    t: [ev.t, fmtTime(ev.t)],
    type: ev.type,
    public: ev.public,
    id: entryId(ev),
    summary: summarizeEvent(ev),
  };
}

export interface ArchiveSearch {
  /** Newest first by `(t, e)`, at most `limit` (default and maximum 20). */
  hits: ArchiveHit[];
  /** More entries matched than `hits` shows (the `more` of the `read_notes` result). */
  more: boolean;
}

/**
 * Searches the seat's archive (`mine`), the public feed (`public`) or both (`all`, the default; an
 * event both public and addressed to the seat appears once). `text` is an ASCII case-insensitive
 * substring of the event's `text` field or of its summary; `kinds` filters by type (an empty list
 * filters nothing); `with` keeps events that visibly involve that player (`involves`); `since`
 * and `until` bound `t`, inclusive. Returns the hits and whether more matched (an addition to
 * §8.4, for the `more` of the `read_notes` result; `searchArchive` keeps §8.4's signature).
 */
export function searchArchivePage(
  gw: GatewayState,
  seat: PlayerId,
  q: ArchiveQuery,
): ArchiveSearch {
  const needle = q.text === undefined ? null : foldAscii(q.text);
  const kinds = q.kinds !== undefined && q.kinds.length > 0 ? q.kinds : null;
  const limit = Math.min(READ_NOTES_MAX_HITS, Math.max(1, q.limit ?? READ_NOTES_MAX_HITS));
  const matches = pool(gw, seat, q.scope ?? "all").filter(({ event: ev }) => {
    if (q.since !== undefined && ev.t < q.since) return false;
    if (q.until !== undefined && ev.t > q.until) return false;
    if (kinds !== null && !kinds.includes(ev.type)) return false;
    if (q.with !== undefined && !involves(ev, q.with, seat)) return false;
    if (needle !== null) {
      const text = ev.data.text;
      const inText = typeof text === "string" && foldAscii(text).includes(needle);
      if (!inText && !foldAscii(summarizeEvent(ev)).includes(needle)) return false;
    }
    return true;
  });
  matches.sort((a, b) => b.event.t - a.event.t || b.e - a.e);
  return { hits: matches.slice(0, limit).map(toHit), more: matches.length > limit };
}

/** `searchArchivePage`'s hits alone: newest first by `(t, e)`, at most 20 (§8.4). */
export function searchArchive(gw: GatewayState, seat: PlayerId, q: ArchiveQuery): ArchiveHit[] {
  return searchArchivePage(gw, seat, q).hits;
}

/**
 * The full entry with message or report id `id`, from the seat's archive or the public feed;
 * `null` when the seat has none (a hidden id reads exactly like a missing one). `to` holds only the
 * seat's own recipient entry (its role), empty for a public entry not addressed to it: the other
 * recipients are routing metadata, never shown (see `involves`).
 */
export function openArchive(gw: GatewayState, seat: PlayerId, id: string): ArchiveEntry | null {
  const d = pool(gw, seat, "all").find((entry) => entryId(entry.event) === id);
  if (d === undefined) return null;
  const ev = copyEvent(d.event);
  return {
    e: d.e,
    t: [ev.t, fmtTime(ev.t)],
    type: ev.type,
    public: ev.public,
    id,
    data: ev.data,
    to: ev.to.filter((r) => r.p === seat),
  };
}
