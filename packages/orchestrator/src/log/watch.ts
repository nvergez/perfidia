import { fmtTime } from "@perfidia/engine/core";
import type { Json, JsonObject, LogLine } from "@perfidia/protocol";

// `arena run --watch` (phase-2 design §6): a fold from `match.jsonl` lines to readable lines, fed
// live from a tee of the log sink (the file on disk is flushed only at checkpoints), and written
// whole to `feed.txt` at the end. `watchLines` reads one line; `watchFold` also follows hand-offs,
// so a seat a bot took over is shown with that bot's label, not its profile's name. The spectator
// feed proper (file, schema, filters) is phase 3's.

export interface WatchContext {
  /** Spectator names of the LLM seats' profiles, e.g. `{ p3: "Odysseus" }`. */
  readonly names: Readonly<Record<string, string>>;
  /** Player text (messages, proposals, names) is cut to this many characters; default 120. */
  readonly cut?: number;
  /** Public thoughts are cut to this many characters; default 400, a thought's longest. */
  readonly thoughtCut?: number;
}

/** A thought's longest (seat/thought.ts). */
const THOUGHT_CUT = 400;

const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");

function quote(text: string, cut: number): string {
  const one = text.replaceAll(/\s+/g, " ").trim();
  return JSON.stringify(one.length > cut ? `${one.slice(0, cut - 1)}…` : one);
}

function who(seat: string, ctx: WatchContext): string {
  const name = Object.hasOwn(ctx.names, seat) ? ctx.names[seat] : undefined;
  return name === undefined ? seat : `${seat} ${name}`;
}

function recipients(to: Json | undefined): string {
  if (to === "all") return "all";
  return Array.isArray(to) ? to.map((x) => str(x)).join(",") : "?";
}

function eventLine(type: string, d: JsonObject, isPublic: boolean, cut: number): string | null {
  switch (type) {
    case "message": {
      const to = recipients(d["to"]);
      const scope = to === "all" || isPublic ? "public" : "private";
      return `${str(d["from"])} → ${to} (${scope}): ${quote(str(d["text"]), cut)}`;
    }
    case "proposal": {
      const name = str(d["name"]);
      return `${str(d["from"])} proposes ${str(d["kind"])} to ${str(d["to"])}${name === "" ? "" : ` (${quote(name, cut)})`}: ${quote(str(d["text"]), cut)}`;
    }
    case "proposal_answered":
      return `${str(d["to"])} ${d["accept"] === true ? "accepts" : "rejects"} ${str(d["from"])}'s ${str(d["kind"])}`;
    case "alliance_formed": {
      const members = Array.isArray(d["members"]) ? d["members"].map((m) => str(m)).join(", ") : "";
      return `alliance ${quote(str(d["name"]), cut)} formed: ${members}`;
    }
    case "alliance_left":
      return `${str(d["player"])} leaves alliance ${str(d["alliance"])} (${str(d["cause"])})`;
    case "pact_signed":
      return `pact signed: ${str(d["a"])} and ${str(d["b"])}`;
    case "pact_ended":
      return `pact ended: ${str(d["a"])} and ${str(d["b"])} (${str(d["cause"])})`;
    case "betrayal":
      return `BETRAYAL: ${str(d["by"])} attacks ${str(d["against"])} (${str(d["relation"])}) at ${str(d["city"])}`;
    case "battle":
      return `battle at ${str(d["city"])} (${str(d["kind"])}): ${str(d["attacker"])} against ${str(d["defender"])}, the ${str(d["winner"])} wins`;
    case "city_conquered": {
      const from = d["from"] === null ? "neutral" : str(d["from"]);
      return `${str(d["to"])} takes ${str(d["city"])} from ${from}`;
    }
    case "player_eliminated":
      return `${str(d["player"])} is eliminated`;
    case "match_ended": {
      const winners = Array.isArray(d["winners"]) ? d["winners"].map((w) => str(w)).join(", ") : "";
      return `match ended (${str(d["reason"])}): ${winners === "" ? "no winner" : winners}`;
    }
    default:
      return null;
  }
}

/** The readable lines of one `match.jsonl` line (most lines give none). */
export function watchLines(line: LogLine, ctx: WatchContext): string[] {
  const cut = ctx.cut ?? 120;
  if (line.k === "turn") {
    const out: string[] = [];
    const at = fmtTime(line.t);
    if (line.thought !== undefined) {
      out.push(
        `${at}  ${who(line.seat, ctx)} thinks: ${quote(line.thought, ctx.thoughtCut ?? THOUGHT_CUT)}`,
      );
    }
    if (line.why === "error" || line.why === "timeout") {
      out.push(`${at}  ${who(line.seat, ctx)} turn ${line.turn} closed: ${line.why}`);
    }
    return out;
  }
  if (line.k === "controller") {
    return [`${fmtTime(line.t)}  ${who(line.seat, ctx)} handed to ${line.label}`];
  }
  if (line.k === "ev") {
    const text = eventLine(line.e.type, line.e.data, line.e.public, cut);
    return text === null ? [] : [`${fmtTime(line.t)}  ${text}`];
  }
  if (line.k === "fatal") {
    return [`${fmtTime(line.t)}  FATAL ${line.error.kind}: ${line.error.message}`];
  }
  return [];
}

/**
 * `watchLines` over a whole log, in order: after a `controller` line (a hand-off), the seat is
 * shown as `p2 [bot:conqueror@3]`, so a bot's thoughts never carry the profile's name.
 */
export function watchFold(ctx: WatchContext): (line: LogLine) => string[] {
  const names: Record<string, string> = { ...ctx.names };
  const now: WatchContext = { ...ctx, names };
  return (line) => {
    const out = watchLines(line, now);
    if (line.k === "controller") names[line.seat] = `[${line.label}]`;
    return out;
  };
}
