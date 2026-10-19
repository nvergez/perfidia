import {
  ClientMsgSchema,
  SPECTATOR_FORMAT,
  type ClientMsg,
  type MatchId,
  type ServerMsg,
  type TimelineId,
} from "@perfidia/protocol/spectator";
import type { ReplyLine } from "@perfidia/protocol";
import type { AnnotationFold } from "@perfidia/spectator/annotations";
import type { Limits } from "../config.ts";
import type { Appended, Timeline, TimelineSummary } from "../timeline/timeline.ts";
import type { MatchEntry } from "./matches.ts";

// The live channel (phase-3 design §3.2, §3.4), framework-free: one WebSocket follows one match.
// A client subscribes with the timeline it holds and its cursor (the last line it holds); the
// server answers with the match's status, its clock (real time), the open turns' annotations, then
// the missing steps in chunks of `CATCH_UP_STEPS`, waiting for the socket to drain whenever it
// reports backpressure. Only once the client's cursor equals the timeline's tail does its socket
// join the match's topic, where each new range of lines is published once, as `steps {from, to}`:
// the check and the join happen in one synchronous step, so no range is missed or sent twice. A
// client that sees `from` differ from its cursor subscribes again with its cursor. A different
// timeline (a new log, a new fold version) gets `resync`; a match that is hidden gets
// `status: unpublished`.
//
// Catch-up is bounded (design §3.4, review): a cursor more than `catchUpSteps` steps behind gets
// `resync {behind}` (the gzipped REST pages and keyframes are the way to catch up from far), a
// cursor beyond the tail of a finished match gets `resync {gap}`, a socket that does not drain
// within `drainTimeoutMs` is closed (it resumes from its cursor later), and the catch-up messages
// waiting in all sockets' buffers stay under `catchUpBudgetBytes` (a new one beyond it gets
// `resync {backpressure}`), so sockets that stop reading cannot pin the server's memory.

/** What the hub needs of a WebSocket (Bun's `send`: > 0 sent, -1 queued, 0 dropped). */
export interface LiveSocket {
  readonly ip: string;
  send(text: string): number;
  close(code: number, reason: string): void;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
}

export type Publish = (topic: string, text: string) => void;

/** What the hub reads of the registry. */
export interface LiveSource {
  get(id: string): MatchEntry | null;
  /** The timeline (read back from the cache if it was evicted). */
  timelineOf(e: MatchEntry): Timeline | null;
  /** The timeline's summary (never read back from the cache). */
  summaryOf(e: MatchEntry): TimelineSummary | null;
  annotationsOf(e: MatchEntry): AnnotationFold;
  clockOf(e: MatchEntry): { t: number; speed: [number, number]; cap: number } | null;
}

/**
 * Steps per catch-up message (design §3.2: at most 500). Small, so a socket that stops reading
 * holds little in its send buffer, and a burst of subscribes costs little to serialise.
 */
export const CATCH_UP_STEPS = 200;

const topicOf = (id: MatchId): string => `m:${id}`;

interface Session {
  readonly sock: LiveSocket;
  match: MatchId | null;
  timeline: TimelineId | null;
  cursor: number;
  subscribed: boolean;
  /** The client's cursor is beyond the timeline (a server restarted from an older cache). */
  ahead: boolean;
  /** A subscribe waiting for the match to load. */
  pending: Extract<ClientMsg, { type: "subscribe" }> | null;
  /** Bumped by every new subscription: a stale catch-up loop stops. */
  gen: number;
  drained: (() => void) | null;
  /** The timeline a catch-up reads (held while it runs, even if the registry evicts it). */
  t: Timeline | null;
  /** Bytes of a catch-up message waiting in the socket's buffer (counted in the hub's budget). */
  queued: number;
  drainTimer: ReturnType<typeof setTimeout> | null;
  readonly sent: number[];
  closed: boolean;
}

export class LiveHub {
  private readonly registry: LiveSource;
  private readonly limits: Limits;
  private readonly now: () => number;
  private publish: Publish = () => undefined;
  private readonly sessions = new Map<unknown, Session>();
  private readonly byMatch = new Map<MatchId, Set<Session>>();
  private readonly perIp = new Map<string, number>();
  private readonly subscribesByIp = new Map<string, number[]>();
  /** Bytes of catch-up messages waiting in sockets' buffers. */
  private queuedBytes = 0;

  constructor(registry: LiveSource, limits: Limits, now: () => number) {
    this.registry = registry;
    this.limits = limits;
    this.now = now;
  }

  setPublisher(publish: Publish): void {
    this.publish = publish;
  }

  get count(): number {
    return this.sessions.size;
  }

  /** Bytes of catch-up messages waiting in sockets' buffers now. */
  get catchUpQueued(): number {
    return this.queuedBytes;
  }

  /** Whether a new socket from `ip` may open (§3.4: per IP and server-wide caps). */
  allowUpgrade(ip: string): boolean {
    return (
      this.sessions.size < this.limits.maxSockets &&
      (this.perIp.get(ip) ?? 0) < this.limits.socketsPerIp
    );
  }

  open(key: unknown, sock: LiveSocket): void {
    const s: Session = {
      sock,
      match: null,
      timeline: null,
      cursor: -1,
      subscribed: false,
      ahead: false,
      pending: null,
      gen: 0,
      drained: null,
      t: null,
      queued: 0,
      drainTimer: null,
      sent: [],
      closed: false,
    };
    this.sessions.set(key, s);
    this.perIp.set(sock.ip, (this.perIp.get(sock.ip) ?? 0) + 1);
    this.send(s, { type: "hello", format: SPECTATOR_FORMAT });
  }

  close(key: unknown): void {
    const s = this.sessions.get(key);
    if (s === undefined) return;
    s.closed = true;
    this.leave(s);
    s.drained?.();
    this.sessions.delete(key);
    const n = (this.perIp.get(s.sock.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(s.sock.ip);
    else this.perIp.set(s.sock.ip, n);
  }

  drain(key: unknown): void {
    const s = this.sessions.get(key);
    if (s === undefined) return;
    this.release(s);
    const resolve = s.drained;
    if (resolve !== null) {
      s.drained = null;
      resolve();
    }
  }

  message(key: unknown, data: string): void {
    const s = this.sessions.get(key);
    if (s === undefined) return;
    const now = this.now();
    s.sent.push(now);
    while ((s.sent[0] ?? now) <= now - this.limits.socketWindowMs) s.sent.shift();
    if (s.sent.length > this.limits.socketMessages) {
      s.sock.close(1008, "too many messages");
      return;
    }
    let msg: ClientMsg;
    try {
      const parsed = ClientMsgSchema.safeParse(JSON.parse(data));
      if (!parsed.success) throw new Error("schema");
      msg = parsed.data;
    } catch {
      this.send(s, {
        type: "error",
        code: "BAD_MESSAGE",
        message:
          'expected {"type":"subscribe","match","timeline","after"} or {"type":"ping","n"} as JSON',
      });
      return;
    }
    if (msg.type === "ping") {
      this.send(s, { type: "pong", n: msg.n });
      return;
    }
    if (!this.allowSubscribe(s.sock.ip, now)) {
      this.send(s, {
        type: "error",
        code: "RATE_LIMITED",
        message: `more than ${this.limits.subscribesPerMinute} subscribes in a minute from your address: wait a minute`,
      });
      return;
    }
    this.subscribe(s, msg);
  }

  // Registry events -------------------------------------------------------------------------------

  steps(e: MatchEntry, a: Appended): void {
    const t = e.timeline;
    if (t === null || !e.visible) return;
    const sessions = this.byMatch.get(e.id);
    if (sessions === undefined || sessions.size === 0) return;
    for (const s of sessions) if (s.ahead) s.t = t;
    const msg: ServerMsg = {
      type: "steps",
      match: e.id,
      timeline: t.timeline,
      from: a.from,
      to: a.to,
      steps: [...a.steps],
    };
    this.publish(topicOf(e.id), JSON.stringify(msg));
    for (const s of sessions) {
      if (s.ahead && t.lastSeq >= s.cursor) {
        s.ahead = false;
        void this.catchUp(s, s.gen);
      }
    }
  }

  status(e: MatchEntry): void {
    for (const s of this.byMatch.get(e.id) ?? []) {
      this.send(s, {
        type: "status",
        match: e.id,
        status: e.status.status,
        reason: e.status.reason,
      });
    }
  }

  reset(e: MatchEntry): void {
    for (const s of Array.from(this.byMatch.get(e.id) ?? [])) {
      this.send(s, { type: "resync", match: e.id, reason: "log_replaced" });
      this.leave(s);
    }
  }

  hidden(id: MatchId): void {
    for (const s of Array.from(this.byMatch.get(id) ?? [])) {
      this.send(s, { type: "status", match: id, status: "unpublished", reason: null });
      this.leave(s);
    }
  }

  ready(e: MatchEntry): void {
    for (const s of Array.from(this.byMatch.get(e.id) ?? [])) {
      const p = s.pending;
      if (p !== null) {
        s.pending = null;
        this.subscribe(s, p);
      }
    }
  }

  reply(e: MatchEntry, line: ReplyLine): void {
    if (!e.visible || (this.byMatch.get(e.id)?.size ?? 0) === 0) return;
    const a = this.registry.annotationsOf(e).turn(line.seat, line.turn);
    const r = a?.rounds.find((x) => x.round === line.round && x.kind === line.kind);
    if (a === null || r === undefined) return;
    const msg: ServerMsg = {
      type: "annot",
      match: e.id,
      seat: line.seat,
      turn: line.turn,
      round: line.round,
      kind: line.kind,
      reasoning: r.reasoning,
      text: r.text,
      calls: r.calls,
      complete: a.complete,
    };
    this.publish(topicOf(e.id), JSON.stringify(msg));
  }

  /** Sends `clock` to the followers of real-time matches (§3.2). */
  tickClock(): void {
    for (const [id, sessions] of this.byMatch) {
      if (sessions.size === 0) continue;
      const e = this.registry.get(id);
      const c = e === null ? null : this.registry.clockOf(e);
      if (c === null) continue;
      const msg: ServerMsg = { type: "clock", match: id, t: c.t, speed: c.speed, cap: c.cap };
      this.publish(topicOf(id), JSON.stringify(msg));
    }
  }

  // Sessions --------------------------------------------------------------------------------------

  private send(s: Session, msg: ServerMsg): number {
    if (s.closed) return 0;
    return s.sock.send(JSON.stringify(msg));
  }

  private allowSubscribe(ip: string, now: number): boolean {
    const times = this.subscribesByIp.get(ip) ?? [];
    while ((times[0] ?? now) <= now - 60_000) times.shift();
    if (times.length >= this.limits.subscribesPerMinute) {
      this.subscribesByIp.set(ip, times);
      return false;
    }
    times.push(now);
    this.subscribesByIp.set(ip, times);
    if (this.subscribesByIp.size > 10_000) {
      for (const [k, v] of this.subscribesByIp)
        if ((v.at(-1) ?? 0) <= now - 60_000) this.subscribesByIp.delete(k);
    }
    return true;
  }

  /** The session's queued catch-up bytes leave the budget; its drain timer stops. */
  private release(s: Session): void {
    this.queuedBytes -= s.queued;
    s.queued = 0;
    if (s.drainTimer !== null) clearTimeout(s.drainTimer);
    s.drainTimer = null;
  }

  private leave(s: Session): void {
    s.gen += 1;
    s.pending = null;
    s.ahead = false;
    if (s.match !== null) {
      if (s.subscribed) s.sock.unsubscribe(topicOf(s.match));
      this.byMatch.get(s.match)?.delete(s);
    }
    s.subscribed = false;
    s.match = null;
    s.timeline = null;
    s.t = null;
    this.release(s);
    s.drained?.();
    s.drained = null;
  }

  private subscribe(s: Session, msg: Extract<ClientMsg, { type: "subscribe" }>): void {
    this.leave(s);
    const e = this.registry.get(msg.match);
    if (e === null) {
      this.send(s, {
        type: "error",
        code: "NOT_FOUND",
        message: `no public match ${msg.match}: GET /api/matches lists them`,
      });
      return;
    }
    s.match = e.id;
    let set = this.byMatch.get(e.id);
    if (set === undefined) {
      set = new Set();
      this.byMatch.set(e.id, set);
    }
    set.add(s);
    const summary = this.registry.summaryOf(e);
    if (summary === null || summary.lastSeq < 0 || summary.map === null) {
      s.pending = msg;
      this.send(s, { type: "status", match: e.id, status: "loading", reason: null });
      return;
    }
    if (msg.timeline !== summary.timeline) {
      this.send(s, { type: "resync", match: e.id, reason: "timeline" });
      this.leave(s);
      return;
    }
    if (summary.final && msg.after > summary.lastSeq) {
      // A finished timeline never reaches this cursor.
      this.send(s, { type: "resync", match: e.id, reason: "gap" });
      this.leave(s);
      return;
    }
    let t: Timeline | null = null;
    if (msg.after < summary.lastSeq) {
      t = this.registry.timelineOf(e);
      if (t === null) {
        s.pending = msg;
        this.send(s, { type: "status", match: e.id, status: "loading", reason: null });
        return;
      }
      if (t.stepsAfter(msg.after) > this.limits.catchUpSteps) {
        this.send(s, { type: "resync", match: e.id, reason: "behind" });
        this.leave(s);
        return;
      }
    }
    s.timeline = summary.timeline;
    s.t = t ?? e.timeline;
    s.cursor = msg.after;
    this.send(s, { type: "status", match: e.id, status: e.status.status, reason: e.status.reason });
    const c = this.registry.clockOf(e);
    if (c !== null)
      this.send(s, { type: "clock", match: e.id, t: c.t, speed: c.speed, cap: c.cap });
    if (!summary.final) this.openTurns(s, e, summary);
    if (s.t === null) {
      // A finished match evicted from memory, and the client holds it all: nothing to send.
      s.sock.subscribe(topicOf(e.id));
      s.subscribed = true;
      return;
    }
    void this.catchUp(s, s.gen);
  }

  /** The annotations of the turns open now (the live part of a client's view). */
  private openTurns(s: Session, e: MatchEntry, summary: TimelineSummary): void {
    const frame = summary.tail();
    if (frame === null) return;
    for (const seat of Object.values(frame.seats)) {
      if (!seat.inTurn) continue;
      const a = this.registry.annotationsOf(e).turn(seat.seat, seat.turn);
      for (const r of a?.rounds ?? []) {
        this.send(s, {
          type: "annot",
          match: e.id,
          seat: seat.seat,
          turn: seat.turn,
          round: r.round,
          kind: r.kind,
          reasoning: r.reasoning,
          text: r.text,
          calls: r.calls,
          complete: a?.complete ?? false,
        });
      }
    }
  }

  /** Sends the steps after the session's cursor, then joins the topic at the tail. */
  private async catchUp(s: Session, gen: number): Promise<void> {
    for (;;) {
      if (s.closed || s.gen !== gen || s.match === null) return;
      const e = this.registry.get(s.match);
      // The timeline held since the subscribe: a running match's is the registry's own (it grows);
      // a finished one stays readable even if the registry evicts it meanwhile.
      const t = s.t ?? (e === null ? null : e.timeline);
      if (e === null || t === null || e.timelineId !== s.timeline || t.timeline !== s.timeline) {
        if (e !== null) this.send(s, { type: "resync", match: e.id, reason: "timeline" });
        this.leave(s);
        return;
      }
      s.t = t;
      if (s.cursor >= t.lastSeq) {
        if (s.cursor > t.lastSeq) {
          if (t.final) {
            this.send(s, { type: "resync", match: e.id, reason: "gap" });
            this.leave(s);
            return;
          }
          s.ahead = true;
          return;
        }
        s.sock.subscribe(topicOf(t.match));
        s.subscribed = true;
        // A finished timeline is no longer needed by this socket (nothing more is published).
        if (t.final) s.t = null;
        return;
      }
      if (this.queuedBytes >= this.limits.catchUpBudgetBytes) {
        this.send(s, { type: "resync", match: e.id, reason: "backpressure" });
        this.leave(s);
        return;
      }
      const page = t.page(s.cursor, CATCH_UP_STEPS);
      const text = JSON.stringify({
        type: "steps",
        match: t.match,
        timeline: t.timeline,
        from: page.from,
        to: page.to,
        steps: page.steps,
      } satisfies ServerMsg);
      if (this.queuedBytes + text.length > this.limits.catchUpBudgetBytes) {
        this.send(s, { type: "resync", match: e.id, reason: "backpressure" });
        this.leave(s);
        return;
      }
      const sent = s.closed ? 0 : s.sock.send(text);
      if (sent === 0) return;
      s.cursor = page.to;
      if (sent < 0) {
        s.queued = text.length;
        this.queuedBytes += text.length;
        s.drainTimer = setTimeout(() => {
          s.drainTimer = null;
          if (s.closed || s.gen !== gen || s.queued === 0) return;
          s.sock.close(1013, "catch-up stalled: resume later");
          this.release(s);
        }, this.limits.drainTimeoutMs);
        // oxlint-disable-next-line no-await-in-loop -- one message at a time: wait for the socket to drain
        await new Promise<void>((resolve) => {
          s.drained = resolve;
        });
      }
    }
  }
}
