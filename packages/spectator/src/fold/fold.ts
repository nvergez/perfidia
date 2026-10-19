import { createReplay, findRuleset, type AnyRuleset, type Replay } from "@perfidia/engine";
import { fmtTime, own } from "@perfidia/engine/core";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { relation, unitsPop } from "@perfidia/engine/std";
import { visibilityOf, type SeatVisibility } from "@perfidia/gateway/present";
import { createGatewayFold, type GatewayFold } from "@perfidia/gateway/runtime";
import {
  ReportIdSchema,
  SPECTATOR_FORMAT,
  type Alliance,
  type CityEnt,
  type DomainEvent,
  type FeedItem,
  type Frame,
  type FramePact,
  type FrameProposal,
  type FrameResult,
  type GameTime,
  type HeaderLine,
  type HourPoint,
  type JsonObject,
  type LogLine,
  type MatchId,
  type MatchStatus,
  type MessageId,
  type Moment,
  type MovementEnt,
  type NotebookHistory,
  type Patch,
  type PlayerEnt,
  type PlayerId,
  type QueueEnt,
  type ReportDetail,
  type SeatEnt,
  type Seq,
  type Sha256,
  type SpectatorMap,
  type Step,
  type TimelineId,
  type TurnCall,
  type Verified,
} from "@perfidia/protocol";
import { TOOL_NAME_MAX_CHARS, cleanText, cutText } from "../clean.ts";
import { logIdOf, timelineIdOf } from "../version.ts";
import { EntityCache, ValueCache } from "./diff.ts";
import { FeedState, type FeedDraft, type FeedEnv } from "./feed.ts";
import { momentOf } from "./moments.ts";
import {
  allianceEnt,
  armies,
  cityEnt,
  movementEnt,
  pactEnts,
  playerEnt,
  popUsedByCity,
  proposalEnts,
  queueEnts,
  standingsOf,
  turnedAtOf,
} from "./project.ts";
import { rulesetEvents } from "./rulesets.ts";
import { SeatSeries } from "./series.ts";

// The spectator fold (phase-3 design §2.5–§2.7): `match.jsonl`, line by line, into frames, steps,
// feed items, moments and keyframes. Each line goes through the engine's incremental Level E
// replay and the gateway's incremental fold; a line where the engine state changed (an act applied,
// or a scheduled event ran: `changed`) is projected and diffed entity by entity, a seat line or an
// `ev` line refreshes the seats. A line yields a step when it changed the projection or yields feed
// items, and every `ckpt` line yields one (the game clock's tick). Steps depend on the log prefix
// only, never on side files or on how the file was read, so a live match and its replay give the
// same steps. Keyframes are full frames at seq 0, at every `ckpt` line of an hour divisible by 6
// and every `keyframeEvery` steps; each sits at a step's cursor. Pure: no I/O, no clock.
//
// After a divergence (or a schema-valid line the replay rejects) the match is `unverifiable`: the
// frames stay at the last good line, later lines are counted, nothing more is projected. A `fatal`
// line ends a crashed match (`fatal`). The divergence is named in a fixed wording, never with the
// replay's expected and actual texts (a config divergence prints the header's setup, `idKey`
// included).

/** Every this many steps a keyframe, besides those every 6 game hours. */
export const KEYFRAME_STEPS = 1000;
/** The longest public thought kept. */
export const THOUGHT_MAX_CHARS = 400;
/** The seat whose view `publicCity` is asked for (its output must not depend on the viewer). */
const VIEWER: PlayerId = "p1";

export interface SpectatorFoldOptions {
  readonly match: MatchId;
  /** The header's ruleset; default the registry (`findRuleset`). */
  readonly resolve?: (ref: string) => AnyRuleset | undefined;
  readonly keyframeEvery?: number;
  /**
   * The timeline id the frames carry; default `timelineIdOf(logId)`. A server gives another one to
   * a log that replaced a different log with the same header, so the two never share immutable URLs.
   */
  readonly timeline?: TimelineId;
}

export interface Keyframe {
  readonly seq: Seq;
  readonly frame: Frame;
}

export interface SeatCounts {
  readonly turns: number;
  readonly messagesSent: number;
  readonly messagesReceived: number;
}

export interface SpectatorFold {
  readonly match: MatchId;
  readonly header: HeaderLine;
  readonly logId: Sha256;
  readonly timeline: TimelineId;
  /** The cursor of the last line folded (the header is 0). */
  readonly lastSeq: Seq;
  readonly lastT: GameTime;
  readonly status: MatchStatus;
  /** Every step so far, in cursor order (append-only). */
  readonly steps: readonly Step[];
  readonly keyframes: readonly Keyframe[];
  readonly moments: readonly Moment[];
  /** Folds the next line of the log; returns its step, if it has one. */
  push(line: LogLine): Step | null;
  /**
   * Counts the next line of the log as one that is not a valid log line (bad JSON or schema): the
   * match is unverifiable from here, and that line's step says so.
   */
  invalid(): Step | null;
  /** The frame after the last step (a fresh object; entities are shared with the steps: never mutate). */
  frame(): Frame;
  verified(): Verified;
  map(): SpectatorMap;
  /** A seat's notebook now. */
  notes(seat: PlayerId): string | null;
  counts(seat: PlayerId): SeatCounts | null;
  /** A seat's score and cities at every hourly checkpoint so far (`fold/series.ts`). */
  hourly(seat: PlayerId): HourPoint[];
  /** A seat's notebook versions, the newest kept (`fold/series.ts`). */
  notebook(seat: PlayerId): NotebookHistory;
  /** Changes whenever a seat's hourly points or notebook history change. */
  seriesKey(seat: PlayerId): string;
  /** A report copy and the ids of the other copies of the same battle. */
  report(id: string): ReportDetail | null;
  /** Where the gateway fold stopped folding seat lines, if it did (seats freeze there). */
  gatewayDrift(): string | null;
}

interface SeatLine {
  round: number | null;
  wakeT: GameTime | null;
  reasons: string[];
  urgent: boolean;
  lastThought: SeatEnt["lastThought"];
  handoff: SeatEnt["handoff"];
}

interface TurnAcc {
  readonly turn: number;
  readonly wakeT: GameTime;
  readonly reasons: readonly string[];
  readonly urgent: boolean;
  accepted: number;
  readonly rejected: Map<string, number>;
  readonly messages: MessageId[];
  /** The turn's calls and their verdicts, in log order (`TurnItem.results`). */
  readonly results: TurnCall[];
}

/**
 * Adds one call line to a turn's results: a line whose batch item index `i` is 0 or absent starts a
 * call, a later item of the same round and tool joins the call before it (`TurnCallSchema`).
 */
export function addResult(
  results: TurnCall[],
  rt: number | null,
  tool: string,
  i: number | undefined,
  code: string | null,
): void {
  const name = cutText(cleanText(tool), TOOL_NAME_MAX_CHARS);
  const last = results.at(-1);
  if (i !== undefined && i > 0 && last !== undefined && last.rt === rt && last.tool === name) {
    results[results.length - 1] = {
      ...last,
      items: last.items + 1,
      ok: last.ok + (code === null ? 1 : 0),
      codes: code === null || last.codes.includes(code) ? last.codes : [...last.codes, code],
    };
    return;
  }
  results.push({
    rt,
    tool: name,
    items: 1,
    ok: code === null ? 1 : 0,
    codes: code === null ? [] : [code],
  });
}

class Fold implements SpectatorFold {
  readonly match: MatchId;
  readonly header: HeaderLine;
  readonly logId: Sha256;
  readonly timeline: TimelineId;
  readonly steps: Step[] = [];
  readonly keyframes: Keyframe[] = [];
  readonly moments: Moment[] = [];
  lastSeq = 0;
  lastT = 0;
  status: MatchStatus = "live";

  private readonly replay: Replay;
  private readonly gw: GatewayFold;
  private readonly feed: FeedState;
  private readonly keyframeEvery: number;
  private readonly spectatorMap: SpectatorMap;
  private halted = false;
  private divergence: string | null = null;
  private result: FrameResult | null = null;
  private frameSeq = 0;
  private frameT = 0;
  private stepsSinceKeyframe = 0;

  private readonly cities = new EntityCache<CityEnt>();
  private readonly queues = new EntityCache<QueueEnt>();
  private readonly movements = new EntityCache<MovementEnt>();
  private readonly players = new EntityCache<PlayerEnt>();
  private readonly seats = new EntityCache<SeatEnt>();
  private readonly alliances = new EntityCache<Alliance>();
  private readonly pacts = new ValueCache<FramePact[]>([]);
  private readonly proposals = new ValueCache<FrameProposal[]>([]);
  private readonly ext = new ValueCache<JsonObject>({});

  /** Engine events produced and not yet carried by an `ev` line (a battle reads ahead in them). */
  private readonly ahead: DomainEvent[] = [];
  private readonly controllers = new Map<PlayerId, string>();
  private readonly seatLines = new Map<PlayerId, SeatLine>();
  private readonly turns = new Map<PlayerId, TurnAcc>();
  private readonly lastAct = new Map<PlayerId, { readonly t: GameTime; readonly turn: number }>();
  private readonly sent = new Map<PlayerId, number>();
  private readonly received = new Map<PlayerId, number>();
  private readonly series: SeatSeries;

  constructor(header: HeaderLine, o: SpectatorFoldOptions) {
    this.match = o.match;
    this.header = header;
    this.logId = logIdOf(header);
    this.timeline = o.timeline ?? timelineIdOf(this.logId);
    this.keyframeEvery = o.keyframeEvery ?? KEYFRAME_STEPS;
    const events = rulesetEvents(header.setup.ruleset);
    this.feed = new FeedState(events);
    this.series = new SeatSeries(header.setup.seats.map((s) => s.id));
    for (const s of header.setup.seats) {
      const label = header.controllers[s.id] ?? "";
      this.controllers.set(s.id, label);
      this.feed.controller(s.id, label);
      this.seatLines.set(s.id, {
        round: null,
        wakeT: null,
        reasons: [],
        urgent: false,
        lastThought: null,
        handoff: null,
      });
    }
    const resolve = o.resolve ?? ((ref: string) => findRuleset(ref));
    this.replay = createReplay(header, resolve, { invariants: "off" });
    this.gw = createGatewayFold();
    if (this.replay.divergence !== null) {
      this.diverged();
      this.spectatorMap = { width: 0, height: 0, islands: [] };
    } else {
      const r = this.replay.read();
      this.gw.line(header, r, undefined);
      this.spectatorMap = mapOf(r);
      this.projectEngine(r, {}, [], 0);
      this.projectSeats(
        {},
        header.setup.seats.map((s) => s.id),
      );
    }
    this.keyframes.push({ seq: 0, frame: this.frame() });
  }

  push(line: LogLine): Step | null {
    this.lastSeq += 1;
    const seq = this.lastSeq;
    if (line.k !== "header") this.lastT = Math.max(this.lastT, line.t);
    if (this.halted) return null;
    const t = line.k === "header" ? this.lastT : line.t;
    const patch: Patch = {};
    const drafts: FeedDraft[] = [];
    if (line.k === "fatal") {
      this.halted = true;
      this.status = "fatal";
      patch.status = "fatal";
      return this.emit(seq, t, patch, drafts, false);
    }
    const out = this.replay.push(line);
    if (!out.ok) {
      this.diverged();
      patch.status = "unverifiable";
      return this.emit(seq, t, patch, drafts, false);
    }
    const r = this.replay.read();
    this.gw.line(line, r, out.applied);
    this.ahead.push(...out.events);
    let seats: readonly PlayerId[] = [];
    switch (line.k) {
      case "wake": {
        const s = this.seatLine(line.seat);
        s.round = null;
        s.wakeT = line.t;
        s.reasons = line.reasons.map(cleanText);
        s.urgent = line.urgent;
        this.turns.set(line.seat, {
          turn: line.turn,
          wakeT: line.t,
          reasons: s.reasons,
          urgent: line.urgent,
          accepted: 0,
          rejected: new Map(),
          messages: [],
          results: [],
        });
        seats = [line.seat];
        break;
      }
      case "act": {
        this.seatLine(line.seat).round = line.rt;
        this.lastAct.set(line.seat, { t: line.t, turn: line.turn });
        const acc = this.turns.get(line.seat);
        if (acc !== undefined) {
          if (line.r.ok) acc.accepted += 1;
          else acc.rejected.set(line.r.code, (acc.rejected.get(line.r.code) ?? 0) + 1);
          addResult(acc.results, line.rt, line.tool, line.i, line.r.ok ? null : line.r.code);
        }
        seats = [line.seat];
        break;
      }
      case "gw": {
        this.seatLine(line.seat).round = line.rt;
        const acc = this.turns.get(line.seat);
        if (acc !== undefined) {
          acc.rejected.set(line.r.code, (acc.rejected.get(line.r.code) ?? 0) + 1);
          addResult(acc.results, line.rt, line.tool, line.i, line.r.code);
        }
        seats = [line.seat];
        break;
      }
      case "obs": {
        this.seatLine(line.seat).round = line.rt;
        const acc = this.turns.get(line.seat);
        if (acc !== undefined) addResult(acc.results, line.rt, line.tool, undefined, null);
        seats = [line.seat];
        break;
      }
      case "note": {
        const notes = this.notes(line.seat);
        if (notes !== null && this.gw.drift === null) {
          this.series.note(line.seat, line.t, line.turn, line.mode, notes);
        }
        const acc = this.turns.get(line.seat);
        if (acc !== undefined && acc.turn === line.turn) {
          addResult(acc.results, null, "write_note", undefined, null);
        }
        seats = [line.seat];
        break;
      }
      case "defer":
        seats = [line.seat];
        break;
      case "turn":
        drafts.push(this.turnItem(line));
        seats = [line.seat];
        break;
      case "controller": {
        const from = this.controllers.get(line.seat) ?? "";
        this.controllers.set(line.seat, line.label);
        this.feed.controller(line.seat, line.label);
        this.seatLine(line.seat).handoff = { t: line.t, label: line.label };
        drafts.push({
          k: "handoff",
          t: line.t,
          players: [line.seat],
          importance: 2,
          seat: line.seat,
          label: line.label,
          from,
        });
        seats = [line.seat];
        break;
      }
      case "ev": {
        this.ahead.shift();
        drafts.push(...this.feed.event(line.e, this.env(r), this.ahead, seq));
        seats = this.header.setup.seats.map((s) => s.id);
        break;
      }
      case "end": {
        this.status = "ended";
        this.result = { reason: line.result.reason, winners: [...line.result.winners] };
        patch.status = "ended";
        patch.result = this.result;
        drafts.push({
          k: "end",
          t: line.t,
          players: [...line.result.winners],
          importance: 3,
          reason: line.result.reason,
          winners: [...line.result.winners],
        });
        seats = this.header.setup.seats.map((s) => s.id);
        break;
      }
      case "header":
      case "batch":
      case "ckpt":
        break;
    }
    if (out.changed || line.k === "end")
      this.projectEngine(r, patch, drafts, line.k === "header" ? 0 : line.t);
    this.projectSeats(patch, seats);
    if (line.k === "ckpt" || line.k === "end") {
      this.series.checkpoint(line.t, (p) => this.players.get(p));
    }
    const step = this.emit(seq, t, patch, drafts, line.k === "ckpt");
    if (
      (line.k === "ckpt" && line.hour % 6 === 0) ||
      this.stepsSinceKeyframe >= this.keyframeEvery
    ) {
      if (step !== null) this.keyframe();
    }
    return step;
  }

  invalid(): Step | null {
    this.lastSeq += 1;
    const seq = this.lastSeq;
    if (this.halted) return null;
    this.halted = true;
    this.status = "unverifiable";
    this.divergence = `line ${seq} is not a valid log line`;
    return this.emit(seq, this.lastT, { status: "unverifiable" }, [], false);
  }

  frame(): Frame {
    return {
      format: SPECTATOR_FORMAT,
      match: this.match,
      timeline: this.timeline,
      seq: this.frameSeq,
      t: this.frameT,
      status: this.status,
      result: this.result,
      ext: this.ext.value,
      cities: this.cities.record(),
      queues: this.queues.record(),
      movements: this.movements.record(),
      players: this.players.record(),
      seats: this.seats.record(),
      alliances: this.alliances.record(),
      pacts: this.pacts.value,
      proposals: this.proposals.value,
    };
  }

  verified(): Verified {
    return { ok: this.divergence === null, divergence: this.divergence };
  }

  map(): SpectatorMap {
    return this.spectatorMap;
  }

  notes(seat: PlayerId): string | null {
    const s = Object.hasOwn(this.gw.gw.seats, seat) ? this.gw.gw.seats[seat] : undefined;
    return s === undefined ? null : cleanText(s.notes);
  }

  counts(seat: PlayerId): SeatCounts | null {
    const s = Object.hasOwn(this.gw.gw.seats, seat) ? this.gw.gw.seats[seat] : undefined;
    if (s === undefined) return null;
    return {
      turns: s.turns,
      messagesSent: this.sent.get(seat) ?? 0,
      messagesReceived: this.received.get(seat) ?? 0,
    };
  }

  hourly(seat: PlayerId): HourPoint[] {
    return this.series.hourly(seat);
  }

  notebook(seat: PlayerId): NotebookHistory {
    return this.series.notebook(seat);
  }

  seriesKey(seat: PlayerId): string {
    return this.series.key(seat);
  }

  report(id: string): ReportDetail | null {
    const parsed = ReportIdSchema.safeParse(id);
    return parsed.success ? (this.feed.reports.get(parsed.data) ?? null) : null;
  }

  gatewayDrift(): string | null {
    const d = this.gw.drift;
    return d === null ? null : `${d.k} line ${d.index} at ${fmtTime(d.t)}`;
  }

  // ---------------------------------------------------------------------------------------------

  private diverged(): void {
    const d = this.replay.divergence;
    this.halted = true;
    this.status = "unverifiable";
    this.divergence =
      d === null
        ? "the log could not be replayed"
        : `${d.kind} divergence at ${fmtTime(d.t)}${d.n === undefined ? "" : ` (n ${d.n})`}${d.hour === undefined ? "" : ` (hour ${d.hour})`}`;
  }

  private seatLine(seat: PlayerId): SeatLine {
    let s = this.seatLines.get(seat);
    if (s === undefined) {
      s = {
        round: null,
        wakeT: null,
        reasons: [],
        urgent: false,
        lastThought: null,
        handoff: null,
      };
      this.seatLines.set(seat, s);
    }
    return s;
  }

  private env(r: ReadCtx): FeedEnv {
    return {
      city: (city) => {
        const c = own(r.state.cities, city);
        return c === undefined ? null : { owner: c.owner, tag: c.tag };
      },
      turnOf: (seat, t) => {
        const a = this.lastAct.get(seat);
        return a !== undefined && a.t === t ? a.turn : null;
      },
    };
  }

  private turnItem(line: Extract<LogLine, { k: "turn" }>): FeedDraft {
    const acc = this.turns.get(line.seat);
    this.turns.delete(line.seat);
    const llm = (this.controllers.get(line.seat) ?? "").startsWith("llm:");
    const thought =
      line.thought === undefined ? null : cutText(cleanText(line.thought), THOUGHT_MAX_CHARS);
    const s = this.seatLine(line.seat);
    s.round = null;
    if (thought !== null) s.lastThought = { turn: line.turn, t: line.t, text: thought };
    const sameTurn = acc !== undefined && acc.turn === line.turn;
    return {
      k: "turn",
      t: line.t,
      players: [line.seat],
      importance: llm ? 1 : 0,
      seat: line.seat,
      turn: line.turn,
      llm,
      wakeT: sameTurn ? acc.wakeT : null,
      reasons: sameTurn ? [...acc.reasons] : [],
      urgent: sameTurn ? acc.urgent : false,
      why: line.why,
      rounds: line.rounds,
      calls: line.calls,
      accepted: sameTurn ? acc.accepted : 0,
      rejected: sameTurn
        ? [...acc.rejected]
            .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .map(([code, count]) => ({ code, count }))
        : [],
      messages: sameTurn ? [...acc.messages] : [],
      thought,
      ...(llm ? { results: sameTurn ? [...acc.results] : [] } : {}),
    };
  }

  /** Projects the engine state, diffs it into `patch`, and adds the launches of new movements. */
  private projectEngine(r: ReadCtx, patch: Patch, drafts: FeedDraft[], t: GameTime): void {
    const state = r.state;
    const vis = visibilityOf(r);
    const pop = popUsedByCity(r);
    const cities = new Map<string, CityEnt>();
    const queues = new Map<string, QueueEnt>();
    for (const c of Object.values(state.cities)) {
      cities.set(c.id, cityEnt(r, vis, c, pop.get(c.id) ?? 0, VIEWER));
      queueEnts(r, c, queues);
    }
    const movements = new Map<string, MovementEnt>();
    for (const m of Object.values(state.movements)) {
      const prev = this.movements.get(m.id);
      let turnedAt: MovementEnt["turnedAt"] = null;
      if (m.back !== null) {
        turnedAt =
          prev !== undefined && prev.back === null
            ? turnedAtOf(prev, m.back.at, state.islands)
            : (prev?.turnedAt ?? null);
      }
      const ent = movementEnt(m, turnedAt);
      movements.set(m.id, ent);
      if (prev === undefined && m.kind !== "return") drafts.push(this.launch(r, ent, t));
    }
    const standings = standingsOf(r);
    const armyOf = armies(r);
    const players = new Map<string, PlayerEnt>();
    for (const p of Object.values(state.players)) {
      const standing = standings.find((s) => s.player === p.id);
      players.set(p.id, playerEnt(r, vis, p, standing, armyOf.get(p.id)));
    }
    const alliances = new Map<string, Alliance>();
    for (const a of Object.values(state.alliances)) alliances.set(a.id, allianceEnt(a));

    const c = this.cities.replace(cities, { fields: true });
    if (c.whole !== null) patch.cities = c.whole;
    if (c.fields !== null) patch.cityFields = c.fields;
    const q = this.queues.replace(queues, { fields: true });
    if (q.whole !== null) patch.queues = q.whole;
    if (q.fields !== null) patch.queueFields = q.fields;
    const m = this.movements.replace(movements, { fields: false });
    if (m.whole !== null) patch.movements = m.whole;
    const p = this.players.replace(players, { fields: true });
    if (p.whole !== null) patch.players = p.whole;
    if (p.fields !== null) patch.playerFields = p.fields;
    const a = this.alliances.replace(alliances, { fields: false });
    if (a.whole !== null) patch.alliances = a.whole;
    const pacts = this.pacts.replace(pactEnts(r));
    if (pacts !== undefined) patch.pacts = pacts;
    const proposals = this.proposals.replace(proposalEnts(r));
    if (proposals !== undefined) patch.proposals = proposals;
    const ext = this.ext.replace(publicMatch(vis));
    if (ext !== undefined) patch.ext = ext;
  }

  /**
   * The launch item of a new movement. An attack fights the foe the engine recorded at launch
   * (`party`): the besieger when the target is besieged, so an attack sent to free a besieged
   * city is a relief (importance 2), and it is "against an ally" only when that foe is the
   * attacker's ally or pact partner.
   */
  private launch(r: ReadCtx, m: MovementEnt, t: GameTime): FeedDraft {
    const target =
      m.to === null || !Object.hasOwn(r.state.cities, m.to)
        ? null
        : (r.state.cities[m.to]?.owner ?? null);
    const foe = m.kind === "attack" ? m.party : null;
    const rel = foe !== null && foe !== m.owner ? relation(r, m.owner, foe) : "none";
    const againstAlly = rel === "ally" || rel === "pact" ? rel : null;
    const relief = foe !== null && foe !== target;
    const settlers = (m.units[r.rules.roles.settler] ?? 0) > 0;
    const importance =
      againstAlly !== null ? 3 : m.kind === "attack" ? (settlers || relief ? 2 : 1) : 0;
    const players = [m.owner];
    for (const p of [target, foe]) if (p !== null && !players.includes(p)) players.push(p);
    return {
      k: "launch",
      t,
      players,
      importance,
      movement: m.id,
      kind: m.kind,
      owner: m.owner,
      from: m.from,
      to: m.to,
      toIsland: m.toIsland,
      target,
      departAt: m.departAt,
      arriveAt: m.arriveAt,
      units: m.units,
      pop: unitsPop(r.rules, m.units),
      settlers,
      foe,
      againstAlly,
      context:
        againstAlly === null || foe === null
          ? null
          : this.feed.context(m.owner, foe, againstAlly, t),
    };
  }

  /** Refreshes the seats in `which` from the gateway fold and the seat lines. */
  private projectSeats(patch: Patch, which: readonly PlayerId[]): void {
    if (which.length === 0 || this.gw.drift !== null) return;
    const ended = this.status === "ended";
    const next = new Map<string, SeatEnt>();
    for (const seat of which) {
      const s = Object.hasOwn(this.gw.gw.seats, seat) ? this.gw.gw.seats[seat] : undefined;
      if (s === undefined) continue;
      const line = this.seatLine(seat);
      const peek = ended || !s.alive ? null : (this.gw.wake?.peek(seat) ?? null);
      next.set(seat, {
        seat,
        controller: this.controllers.get(seat) ?? "",
        inTurn: s.wake.inTurn,
        turn: s.turns,
        round: s.wake.inTurn ? line.round : null,
        wakeT: line.wakeT,
        reasons: [...line.reasons],
        urgent: line.urgent,
        next: peek === null ? null : { at: peek.at, kind: peek.kind },
        lastThought: line.lastThought,
        notesChars: s.notes.length,
        handoff: line.handoff,
      });
    }
    const changed = this.seats.merge(next, { fields: true });
    if (changed.whole !== null) patch.seats = { ...patch.seats, ...changed.whole };
    if (changed.fields !== null) patch.seatFields = { ...patch.seatFields, ...changed.fields };
  }

  /** The step of a line, if it has one; ids are given to its items, moments recorded. */
  private emit(
    seq: Seq,
    t: GameTime,
    patch: Patch,
    drafts: readonly FeedDraft[],
    tick: boolean,
  ): Step | null {
    const hasPatch = Object.keys(patch).length > 0;
    if (!hasPatch && drafts.length === 0 && !tick) return null;
    const items: FeedItem[] = drafts.map((d, i) => ({ ...d, id: `${seq}:${i}` }));
    for (const item of items) {
      if (item.k === "message") {
        this.feed.noteMessage(item);
        this.sent.set(item.from, (this.sent.get(item.from) ?? 0) + 1);
        const to = item.to === "all" ? this.header.setup.seats.map((s) => s.id) : item.to;
        for (const p of to)
          if (p !== item.from) this.received.set(p, (this.received.get(p) ?? 0) + 1);
        const acc = this.turns.get(item.from);
        if (acc !== undefined && item.turn === acc.turn) acc.messages.push(item.message);
      } else if (item.k === "turn" && item.thought !== null) {
        this.feed.noteThought(item.seat, item.turn, item.t, item.thought);
      }
      const moment = momentOf(item, seq);
      if (moment !== null) this.moments.push(moment);
    }
    const step: Step = {
      seq,
      t,
      ...(hasPatch ? { patch } : {}),
      ...(items.length > 0 ? { items } : {}),
    };
    this.steps.push(step);
    this.frameSeq = seq;
    this.frameT = t;
    this.stepsSinceKeyframe += 1;
    return step;
  }

  private keyframe(): void {
    const last = this.keyframes.at(-1);
    if (last?.seq === this.frameSeq) return;
    this.keyframes.push({ seq: this.frameSeq, frame: this.frame() });
    this.stepsSinceKeyframe = 0;
  }
}

function publicMatch(vis: SeatVisibility): JsonObject {
  return vis.publicMatch();
}

/** The islands and the box that holds them, with the margin of the nearest side on the other. */
function mapOf(r: ReadCtx): SpectatorMap {
  const islands = Object.values(r.state.islands).map((i) => ({
    id: i.id,
    kind: i.kind,
    x: i.x,
    y: i.y,
    slots: i.slots,
    richnessPm: i.richnessPm,
  }));
  let maxX = 0;
  let maxY = 0;
  let minX = Number.MAX_SAFE_INTEGER;
  let minY = Number.MAX_SAFE_INTEGER;
  for (const i of islands) {
    maxX = Math.max(maxX, i.x);
    maxY = Math.max(maxY, i.y);
    minX = Math.min(minX, i.x);
    minY = Math.min(minY, i.y);
  }
  if (islands.length === 0) return { width: 0, height: 0, islands };
  return {
    width: maxX + Math.max(0, minX),
    height: maxY + Math.max(0, minY),
    islands,
  };
}

/** A new fold of a log, from its header. */
export function createSpectatorFold(header: HeaderLine, o: SpectatorFoldOptions): SpectatorFold {
  return new Fold(header, o);
}

/** Folds a whole log (its first line must be the header); throws on an empty log or no header. */
export function foldLog(lines: Iterable<LogLine>, o: SpectatorFoldOptions): SpectatorFold {
  let fold: SpectatorFold | null = null;
  for (const line of lines) {
    if (fold === null) {
      if (line.k !== "header")
        throw new Error("foldLog: the log does not start with a header line");
      fold = new Fold(line, o);
    } else {
      fold.push(line);
    }
  }
  if (fold === null) throw new Error("foldLog: an empty log");
  return fold;
}
