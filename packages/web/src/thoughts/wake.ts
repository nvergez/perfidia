// Why a seat woke (a turn's `reasons`, e.g. "queue_empty c24", "message p3", "self"), in words and
// as one of a few generic kinds the thoughts column draws as icons. The reasons are the harness's
// wake vocabulary plus event types; any reason not listed reads as a plain event.

export type WakeKind =
  | "start"
  | "alarm"
  | "message"
  | "diplomacy"
  | "danger"
  | "battle"
  | "spy"
  | "build"
  | "event";

const KINDS: Readonly<Record<string, WakeKind>> = Object.freeze({
  start: "start",
  self: "alarm",
  message: "message",
  proposal: "diplomacy",
  proposal_answered: "diplomacy",
  incoming_attack: "danger",
  battle_report: "battle",
  city_conquered: "battle",
  spy_report: "spy",
  spy_failed: "spy",
  spy_detected: "spy",
  queue_empty: "build",
});

const WORDS: Readonly<Record<string, string>> = Object.freeze({
  start: "the start of the match",
  self: "its own alarm",
  message: "a message",
  proposal: "a proposal",
  proposal_answered: "an answer to its proposal",
  incoming_attack: "an attack on its way",
  battle_report: "a battle report",
  queue_empty: "a queue running empty",
});

/** The first word of a reason ("queue_empty" of "queue_empty c24"). */
function headOf(reason: string): string {
  return reason.split(" ")[0] ?? reason;
}

export function wakeKind(reason: string): WakeKind {
  const head = headOf(reason);
  return Object.hasOwn(KINDS, head) ? (KINDS[head] ?? "event") : "event";
}

/** "a queue running empty (c24)", "a message (p3)", "siege started (p6)". */
export function wakeWords(reason: string): string {
  const head = headOf(reason);
  const rest = reason.slice(head.length).trim();
  const words = Object.hasOwn(WORDS, head) ? (WORDS[head] ?? head) : head.replaceAll("_", " ");
  return rest === "" ? words : `${words} (${rest})`;
}

/** The distinct kinds of a turn's reasons, in order. */
export function wakeKinds(reasons: readonly string[]): WakeKind[] {
  const out: WakeKind[] = [];
  for (const r of reasons) {
    const k = wakeKind(r);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}
