import {
  STANDARD_EVENT_DATA,
  type DeepReadonly,
  type DomainEvent,
  type Json,
  type JsonObject,
} from "@perfidia/protocol";
import { byCodeUnit, isJsonArray, setOwn, stripControl, timePair } from "./common.ts";

// Events as agents read them in a briefing (docs/architecture.md §8.2, §8.6). Each copy the seat
// received is already its own audience's payload (the engine emits one copy per audience), so the
// rendering only shapes it: the type and the data fields, flattened; times as pairs; player-authored
// text as a typed field with control characters stripped and a message body cut at 300 characters.
// The recipient list is never shown: it is routing metadata the engine may compute from hidden data.

/** A message body in a briefing is cut at this many characters (`cut: true`). */
export const MESSAGE_CUT = 300;

/**
 * Whether a data key holds a game time, which agents see as a pair: `at`, `t`, `until`, `since`,
 * and every camelCase key ending in `At` (`arriveAt`, `expiresAt`, `endsAt`, …).
 */
export function isTimeKey(key: string): boolean {
  return (
    key === "at" || key === "t" || key === "until" || key === "since" || /^[a-z]\w*At$/.test(key)
  );
}

function renderValue(key: string | null, value: DeepReadonly<Json>): Json {
  if (typeof value === "string") return stripControl(value);
  if (key !== null && isTimeKey(key) && typeof value === "number" && Number.isSafeInteger(value)) {
    return value >= 0 ? timePair(value) : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (isJsonArray(value)) return value.map((v) => renderValue(null, v));
  const out: JsonObject = {};
  for (const k of Object.keys(value).toSorted(byCodeUnit)) {
    const v = value[k];
    if (v !== undefined) setOwn(out, k, renderValue(k, v));
  }
  return out;
}

/**
 * An event's data as agents see it: strings stripped of control characters, times as pairs, and a
 * `text` field longer than `MESSAGE_CUT` cut with `cut: true`. A fresh object.
 */
export function renderData(data: DeepReadonly<JsonObject>): JsonObject {
  const rendered = renderValue(null, data);
  const out: JsonObject =
    rendered !== null && typeof rendered === "object" && !Array.isArray(rendered) ? rendered : {};
  const text = out["text"];
  if (typeof text === "string" && text.length > MESSAGE_CUT) {
    out["text"] = text.slice(0, MESSAGE_CUT);
    out["cut"] = true;
  }
  return out;
}

/**
 * Standard reports are summarised to their standard fields (the battle headline, or the city
 * spied): the ruleset's details can be long, and `read_notes {open: report}` returns them whole.
 */
const SUMMARISED: Readonly<Record<string, readonly string[]>> = {
  battle_report: Object.keys(STANDARD_EVENT_DATA.battle_report.shape),
  spy_report: Object.keys(STANDARD_EVENT_DATA.spy_report.shape),
};

/** One briefing entry of `events` or `news`: `{type, ...data}`. */
export function renderEvent(ev: DeepReadonly<DomainEvent>): JsonObject & { type: string } {
  const keep = Object.hasOwn(SUMMARISED, ev.type) ? SUMMARISED[ev.type] : undefined;
  const source: DeepReadonly<JsonObject> =
    keep === undefined
      ? ev.data
      : Object.fromEntries(Object.entries(ev.data).filter(([k]) => keep.includes(k)));
  const data = renderData(source);
  const out: JsonObject & { type: string } = { type: ev.type };
  for (const [k, v] of Object.entries(data)) {
    if (k !== "type") setOwn(out, k, v);
  }
  return out;
}
