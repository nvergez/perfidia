import { parseBotLabel } from "@perfidia/bots";
import { DAY, canonicalJson, fmtTime } from "@perfidia/engine/core";
import type {
  ClockSpec,
  GameTime,
  JsonObject,
  LogLine,
  MatchResult,
  PlayerId,
  WakeLine,
} from "@perfidia/protocol";

// The match summary (docs/architecture.md §12.2): a pure fold over the log lines. Winner, reason and
// end time; final standings with each seat's controllers (hand-offs from `controller` lines);
// battles, conquests, foundings, eliminations, sieges, alliances, pacts, betrayals and messages from
// the `ev` lines; wake-ups per seat per game day by class with the deferred turns of `defer` lines;
// `INTERNAL` failures from `gw` lines; round trips and calls per wake; rejections by code and layer;
// engine events, lines and log size. Wall time is not in the log, so the caller passes it.

export const SUMMARY_FORMAT = "perfidia-summary/1";

/** A seat's wakes on one game day, by class (§8.5, §12.2), and the turns the per-second cap deferred. */
export interface WakeDay {
  urgent: number;
  own: number;
  social: number;
  safety: number;
  start: number;
  deferred: number;
}

export type WakeClass = "start" | "urgent" | "own" | "social" | "safety";

/** A wake's class, with the precedence the host counts by: start, urgent, own, social, then safety. */
export function wakeClass(line: Pick<WakeLine, "reasons" | "urgent" | "charge">): WakeClass {
  if (line.reasons.includes("start")) return "start";
  if (line.urgent) return "urgent";
  if (line.charge === "own") return "own";
  if (line.charge === "social") return "social";
  return "safety";
}

export interface ControllerSpan {
  readonly label: string;
  /** Game time from which the controller played the seat (0 for the header's). */
  readonly from: GameTime;
}

export interface SeatSummary {
  readonly seat: PlayerId;
  /** The header's controller, then one entry per `controller` line. */
  readonly controllers: ControllerSpan[];
  /** `bot:expander@1`, or with hand-offs `llm:x → bot:turtle@1 at D3 06:00`. */
  readonly controller: string;
  /** The final controller's bot strategy, or its label when it is not a bot of this build. */
  readonly strategy: string;
  /** From the end line's standings; null when the log has no end line. */
  readonly rank: number | null;
  readonly score: number | null;
  readonly cities: number | null;
  readonly alive: boolean | null;
  readonly parts: Readonly<Record<string, number>>;
  readonly eliminatedAt: GameTime | null;
  /** Per game day, `floor(t / 86400)`. */
  readonly wakes: WakeDay[];
  readonly turns: number;
  readonly calls: number;
}

export interface Distribution {
  readonly mean: number;
  /** Nearest-rank 95th percentile. */
  readonly p95: number;
  readonly max: number;
}

export interface EventCounts {
  battles: number;
  conquests: number;
  foundings: number;
  eliminations: number;
  /** `perfidia-1` sieges: started, held until a conquest, broken. */
  siegesStarted: number;
  siegesHeld: number;
  siegesBroken: number;
  alliancesFormed: number;
  alliancesJoined: number;
  alliancesLeft: number;
  pactsSigned: number;
  pactsRenewed: number;
  pactsEnded: number;
  pactsExpired: number;
  betrayals: number;
  messages: number;
  proposals: number;
  spyReports: number;
}

export interface MatchSummary {
  readonly format: typeof SUMMARY_FORMAT;
  readonly ruleset: string;
  readonly engine: string;
  readonly seed: number;
  readonly players: number;
  readonly configHash: string;
  readonly rulesHash: string;
  readonly clock: ClockSpec;
  /** `ended` (an end line), `fatal` (a fatal line) or `incomplete` (neither: a killed run). */
  readonly status: "ended" | "fatal" | "incomplete";
  readonly fatal: { readonly t: GameTime; readonly kind: string; readonly message: string } | null;
  /** The end line's time, else the last line's. */
  readonly lastT: GameTime;
  readonly endedAt: GameTime | null;
  /** `endedAt / 86400`. */
  readonly endDay: number | null;
  readonly reason: string | null;
  readonly winners: PlayerId[];
  readonly finalHash: string | null;
  readonly seats: SeatSummary[];
  readonly events: EventCounts;
  readonly wakes: {
    /** Game days covered, `max(1, ceil(lastT / 86400))` (and every day a wake or defer line names). */
    readonly days: number;
    readonly total: WakeDay;
    /** Wakes (deferred turns excluded) per seat per game day. */
    readonly perSeatPerDay: { readonly mean: number; readonly max: number };
  };
  /** `gw` lines with code `INTERNAL`; must be zero. */
  readonly internal: number;
  readonly turns: number;
  readonly rounds: number;
  readonly calls: number;
  readonly perWake: { readonly rounds: Distribution; readonly calls: Distribution };
  /** Rejections by code: `gateway` from `gw` lines, `engine` from rejected `act` lines. */
  readonly rejections: {
    readonly gateway: Readonly<Record<string, number>>;
    readonly engine: Readonly<Record<string, number>>;
  };
  /** `ev` lines. */
  readonly engineEvents: number;
  readonly lines: number;
  /** Bytes of the canonical JSONL text. */
  readonly logBytes: number;
  readonly wallStart: string | null;
  readonly wallMs: number | null;
  readonly eventsPerSecond: number | null;
}

/** Lines that cannot be a match log: no header first, a second header, a seat the header lacks. */
export class LogShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogShapeError";
  }
}

export interface SummaryOptions {
  /** Wall duration of the run, when the caller measured it. */
  readonly wallMs?: number | null;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { mean: 0, p95: 0, max: 0 };
  const sorted = values.toSorted((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const p95 = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] ?? 0;
  return { mean: round2(sum / sorted.length), p95, max: sorted.at(-1) ?? 0 };
}

/** Bytes of `s` in UTF-8. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

const zeroDay = (): WakeDay => ({ urgent: 0, own: 0, social: 0, safety: 0, start: 0, deferred: 0 });

const wakesOf = (d: WakeDay): number => d.urgent + d.own + d.social + d.safety + d.start;

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

function sortedRecord(rec: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(rec).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[k] = rec[k] ?? 0;
  }
  return out;
}

/** The text of a seat's controllers: `a`, or `a → b at D3 06:00 → …` with hand-offs. */
export function controllerText(spans: readonly ControllerSpan[]): string {
  return spans.map((c, i) => (i === 0 ? c.label : `${c.label} at ${fmtTime(c.from)}`)).join(" → ");
}

/** The bot strategy of a controller label, or the label itself. */
export function strategyOf(label: string): string {
  return parseBotLabel(label)?.strategy ?? label;
}

/** A string field of an event's data, or undefined. */
function stringField(data: JsonObject, key: string): string | undefined {
  const v = Object.hasOwn(data, key) ? data[key] : undefined;
  return typeof v === "string" ? v : undefined;
}

interface SeatAcc {
  controllers: ControllerSpan[];
  wakes: WakeDay[];
  turns: number;
  calls: number;
  eliminatedAt: GameTime | null;
}

/**
 * Folds a log into its summary (§12.2). Pure: the same lines always give the same summary. The
 * lines must start with the header; the log may stop anywhere (a killed run) or with a fatal line.
 */
export function summarize(lines: Iterable<LogLine>, o: SummaryOptions = {}): MatchSummary {
  const it = lines[Symbol.iterator]();
  const first = it.next();
  if (first.done === true || first.value.k !== "header") {
    throw new LogShapeError("a log starts with its header line");
  }
  const header = first.value;
  const seatIds = header.setup.seats.map((s) => s.id);
  const seats = new Map<string, SeatAcc>();
  for (const id of seatIds) {
    seats.set(id, {
      controllers: [{ label: header.controllers[id] ?? "", from: 0 }],
      wakes: [],
      turns: 0,
      calls: 0,
      eliminatedAt: null,
    });
  }
  const seat = (id: string): SeatAcc => {
    const s = seats.get(id);
    if (s === undefined)
      throw new LogShapeError(`the log names ${id}, which is not a seat of its header`);
    return s;
  };
  const day = (s: SeatAcc, t: GameTime): WakeDay => {
    const d = Math.floor(t / DAY);
    while (s.wakes.length <= d) s.wakes.push(zeroDay());
    return s.wakes[d] ?? zeroDay();
  };

  const events: EventCounts = {
    battles: 0,
    conquests: 0,
    foundings: 0,
    eliminations: 0,
    siegesStarted: 0,
    siegesHeld: 0,
    siegesBroken: 0,
    alliancesFormed: 0,
    alliancesJoined: 0,
    alliancesLeft: 0,
    pactsSigned: 0,
    pactsRenewed: 0,
    pactsEnded: 0,
    pactsExpired: 0,
    betrayals: 0,
    messages: 0,
    proposals: 0,
    spyReports: 0,
  };
  const openSieges = new Set<string>();
  const gateway: Record<string, number> = {};
  const engine: Record<string, number> = {};
  const roundsPerWake: number[] = [];
  const callsPerWake: number[] = [];
  let internal = 0;
  let engineEvents = 0;
  let count = 1;
  let bytes = utf8Length(canonicalJson(header)) + 1;
  let lastT = 0;
  let result: MatchResult | null = null;
  let finalHash: string | null = null;
  let fatal: MatchSummary["fatal"] = null;

  for (let next = it.next(); next.done !== true; next = it.next()) {
    const line = next.value;
    if (line.k === "header") throw new LogShapeError("a log has one header line, first");
    count += 1;
    bytes += utf8Length(canonicalJson(line)) + 1;
    lastT = Math.max(lastT, line.t);
    switch (line.k) {
      case "wake": {
        const d = day(seat(line.seat), line.t);
        d[wakeClass(line)] += 1;
        break;
      }
      case "defer":
        day(seat(line.seat), line.t).deferred += 1;
        break;
      case "controller":
        seat(line.seat).controllers.push({ label: line.label, from: line.t });
        break;
      case "turn": {
        const s = seat(line.seat);
        s.turns += 1;
        s.calls += line.calls;
        roundsPerWake.push(line.rounds);
        callsPerWake.push(line.calls);
        break;
      }
      case "gw":
        bump(gateway, line.r.code);
        if (line.r.code === "INTERNAL") internal += 1;
        break;
      case "act":
        if (!line.r.ok) bump(engine, line.r.code);
        break;
      case "ev": {
        engineEvents += 1;
        const e = line.e;
        const city = stringField(e.data, "city");
        switch (e.type) {
          case "battle":
            events.battles += 1;
            break;
          case "city_conquered":
            events.conquests += 1;
            if (city !== undefined && openSieges.delete(city)) events.siegesHeld += 1;
            break;
          case "city_founded":
            events.foundings += 1;
            break;
          case "player_eliminated": {
            events.eliminations += 1;
            const p = stringField(e.data, "player");
            const s = p === undefined ? undefined : seats.get(p);
            if (s !== undefined && s.eliminatedAt === null) s.eliminatedAt = line.t;
            break;
          }
          case "siege_started":
            events.siegesStarted += 1;
            if (city !== undefined) openSieges.add(city);
            break;
          case "siege_broken":
            events.siegesBroken += 1;
            if (city !== undefined) openSieges.delete(city);
            break;
          case "alliance_formed":
            events.alliancesFormed += 1;
            break;
          case "alliance_joined":
            events.alliancesJoined += 1;
            break;
          case "alliance_left":
            events.alliancesLeft += 1;
            break;
          case "pact_signed":
            events.pactsSigned += 1;
            break;
          case "pact_renewed":
            events.pactsRenewed += 1;
            break;
          case "pact_ended":
            events.pactsEnded += 1;
            break;
          case "pact_expired":
            events.pactsExpired += 1;
            break;
          case "betrayal":
            events.betrayals += 1;
            break;
          case "message":
            events.messages += 1;
            break;
          case "proposal":
            events.proposals += 1;
            break;
          case "spy_report":
            events.spyReports += 1;
            break;
          default:
            break;
        }
        break;
      }
      case "end":
        result = line.result;
        finalHash = line.h;
        break;
      case "fatal":
        fatal = { t: line.t, kind: line.error.kind, message: line.error.message };
        break;
      case "batch":
      case "obs":
      case "note":
      case "ckpt":
        break;
    }
  }

  let days = Math.max(1, Math.ceil(lastT / DAY));
  for (const s of seats.values()) days = Math.max(days, s.wakes.length);
  const total = zeroDay();
  const perSeatDay: number[] = [];
  const standings = new Map((result?.standings ?? []).map((st) => [st.player, st]));
  const seatSummaries: SeatSummary[] = seatIds.map((id) => {
    const s = seat(id);
    while (s.wakes.length < days) s.wakes.push(zeroDay());
    for (const d of s.wakes) {
      for (const k of ["urgent", "own", "social", "safety", "start", "deferred"] as const) {
        total[k] += d[k];
      }
      perSeatDay.push(wakesOf(d));
    }
    const st = standings.get(id);
    const last = s.controllers.at(-1)?.label ?? "";
    return {
      seat: id,
      controllers: s.controllers,
      controller: controllerText(s.controllers),
      strategy: strategyOf(last),
      rank: st?.rank ?? null,
      score: st?.score ?? null,
      cities: st?.cities ?? null,
      alive: st?.alive ?? null,
      parts: st === undefined ? {} : sortedRecord(st.parts),
      eliminatedAt: s.eliminatedAt,
      wakes: s.wakes,
      turns: s.turns,
      calls: s.calls,
    };
  });
  const wakeSum = perSeatDay.reduce((a, b) => a + b, 0);
  const wallMs = o.wallMs ?? null;
  return {
    format: SUMMARY_FORMAT,
    ruleset: header.setup.ruleset,
    engine: header.engine,
    seed: header.setup.seed,
    players: seatIds.length,
    configHash: header.configHash,
    rulesHash: header.rulesHash,
    clock: header.clock,
    status: result !== null ? "ended" : fatal !== null ? "fatal" : "incomplete",
    fatal,
    lastT,
    endedAt: result?.endedAt ?? null,
    endDay: result === null ? null : round2(result.endedAt / DAY),
    reason: result?.reason ?? null,
    winners: result === null ? [] : [...result.winners],
    finalHash,
    seats: seatSummaries,
    events,
    wakes: {
      days,
      total,
      perSeatPerDay: {
        mean: perSeatDay.length === 0 ? 0 : round2(wakeSum / perSeatDay.length),
        max: Math.max(0, ...perSeatDay),
      },
    },
    internal,
    turns: roundsPerWake.length,
    rounds: roundsPerWake.reduce((a, b) => a + b, 0),
    calls: callsPerWake.reduce((a, b) => a + b, 0),
    perWake: { rounds: distribution(roundsPerWake), calls: distribution(callsPerWake) },
    rejections: { gateway: sortedRecord(gateway), engine: sortedRecord(engine) },
    engineEvents,
    lines: count,
    logBytes: bytes,
    wallStart: header.wallStart ?? null,
    wallMs,
    eventsPerSecond:
      wallMs === null || wallMs <= 0 ? null : Math.round((engineEvents * 1000) / wallMs),
  };
}
