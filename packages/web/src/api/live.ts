import {
  ServerMsgSchema,
  type MatchStatus,
  type PublicReason,
  type ServerMsg,
  type Step,
} from "@perfidia/protocol/spectator";
import { parseOrReport } from "./client.ts";

// The WebSocket client (phase-3 design §3.2, docs/phase3.md §7): one match per socket, a resumable
// cursor (the last line the client holds). It subscribes with its cursor on every (re)connection,
// applies only `steps` messages that continue it (`from ≤ cursor < to`), and on a gap (`from` past
// the cursor) never applies the message and subscribes again with its cursor, once, until the
// missing range arrives. Reconnects back off from 1 s to 30 s with jitter. `resync` reasons other
// than `backpressure` (retried here after a pause) go to the caller, which re-syncs over REST. A
// message that fails the protocol schema is dropped, reported, and handed over as a re-sync.

export type LiveEvent =
  | {
      readonly type: "steps";
      readonly from: number;
      readonly to: number;
      readonly steps: readonly Step[];
    }
  | { readonly type: "status"; readonly status: MatchStatus; readonly reason: PublicReason | null }
  | {
      readonly type: "clock";
      readonly t: number;
      readonly speed: readonly [number, number] | null;
      readonly cap: number;
      /** Client time of receipt (ms). */
      readonly at: number;
    }
  | { readonly type: "annot"; readonly msg: Extract<ServerMsg, { type: "annot" }> }
  | {
      readonly type: "resync";
      readonly reason: "gap" | "log_replaced" | "timeline" | "behind" | "invalid";
    }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | {
      readonly type: "connection";
      readonly state: "connecting" | "open" | "closed";
      readonly retryMs: number | null;
    };

/** The part of a WebSocket the client uses (a browser `WebSocket` fits). */
export interface SocketLike {
  addEventListener(type: string, listener: (ev: Event) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Timers {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface LiveOptions {
  /** `ws(s)://host/api/live`. */
  readonly url: string;
  readonly match: string;
  readonly timeline: string;
  /** The last line the client holds. */
  readonly cursor: number;
  readonly onEvent: (e: LiveEvent) => void;
  readonly connect?: (url: string) => SocketLike;
  readonly timers?: Timers;
  /** Client time in ms (`performance.now()`). */
  readonly now?: () => number;
  readonly random?: () => number;
}

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** A gap re-subscribe is not repeated before this long without the missing range. */
export const GAP_RETRY_MS = 5_000;
/** Pause before subscribing again after `resync {backpressure}`. */
export const BACKPRESSURE_RETRY_MS = 2_000;

/** The reconnect delay after `attempt` failures (0-based): 1 s doubling to 30 s, jittered ×0.5–1. */
export function backoffMs(attempt: number, random: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.5 + 0.5 * Math.min(1, Math.max(0, random))));
}

/** The live URL of the page's own origin. */
export function liveUrl(loc: { readonly protocol: string; readonly host: string }): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/api/live`;
}

const browserTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (h) => window.clearTimeout(h),
};

export class LiveConnection {
  private readonly o: LiveOptions;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly random: () => number;
  private socket: SocketLike | null = null;
  private cursorV: number;
  private attempt = 0;
  private stopped = true;
  private retryTimer: number | null = null;
  /** A gap re-subscribe is in flight since this client time (ms). */
  private gapSince: number | null = null;

  constructor(o: LiveOptions) {
    this.o = o;
    this.cursorV = o.cursor;
    this.timers = o.timers ?? browserTimers;
    this.now = o.now ?? (() => performance.now());
    this.random = o.random ?? Math.random;
  }

  get cursor(): number {
    return this.cursorV;
  }

  get connected(): boolean {
    return this.socket !== null && !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) this.timers.clear(this.retryTimer);
    this.retryTimer = null;
    const s = this.socket;
    this.socket = null;
    s?.close(1000, "bye");
  }

  /** Continues from `cursor` (after a catch-up over REST): subscribes again. */
  resubscribe(cursor: number): void {
    this.cursorV = Math.max(this.cursorV, cursor);
    this.gapSince = null;
    this.subscribe();
  }

  private open(): void {
    if (this.stopped) return;
    this.o.onEvent({ type: "connection", state: "connecting", retryMs: null });
    const connect = this.o.connect ?? ((url: string) => new WebSocket(url));
    let s: SocketLike;
    try {
      s = connect(this.o.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = s;
    // Events of a socket this connection has let go of (stopped, or replaced) are ignored.
    s.addEventListener("open", () => {
      if (this.socket !== s) return;
      this.o.onEvent({ type: "connection", state: "open", retryMs: null });
      this.gapSince = null;
      this.subscribe();
    });
    s.addEventListener("message", (ev) => {
      if (this.socket !== s) return;
      this.handle(ev instanceof MessageEvent && typeof ev.data === "string" ? ev.data : "");
    });
    s.addEventListener("close", () => {
      if (this.socket !== s) return;
      this.socket = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const ms = backoffMs(this.attempt, this.random());
    this.attempt += 1;
    this.o.onEvent({ type: "connection", state: "closed", retryMs: ms });
    if (this.retryTimer !== null) this.timers.clear(this.retryTimer);
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = null;
      this.open();
    }, ms);
  }

  private subscribe(): void {
    const s = this.socket;
    if (s === null || this.stopped) return;
    s.send(
      JSON.stringify({
        type: "subscribe",
        match: this.o.match,
        timeline: this.o.timeline,
        after: this.cursorV,
      }),
    );
  }

  /** One message from the server (exposed for tests). */
  handle(text: string): void {
    let msg: ServerMsg;
    try {
      msg = parseOrReport("live message", ServerMsgSchema, JSON.parse(text) as unknown);
    } catch {
      this.o.onEvent({ type: "resync", reason: "invalid" });
      return;
    }
    if ("match" in msg && msg.match !== this.o.match) return;
    switch (msg.type) {
      case "hello":
      case "pong":
        return;
      case "steps":
        this.onSteps(msg);
        return;
      case "status":
        this.attempt = 0;
        this.o.onEvent({ type: "status", status: msg.status, reason: msg.reason });
        return;
      case "clock":
        this.o.onEvent({ type: "clock", t: msg.t, speed: msg.speed, cap: msg.cap, at: this.now() });
        return;
      case "annot":
        this.o.onEvent({ type: "annot", msg });
        return;
      case "resync":
        if (msg.reason === "backpressure") {
          if (this.retryTimer !== null) this.timers.clear(this.retryTimer);
          this.retryTimer = this.timers.set(() => {
            this.retryTimer = null;
            this.subscribe();
          }, BACKPRESSURE_RETRY_MS);
          return;
        }
        this.o.onEvent({ type: "resync", reason: msg.reason });
        return;
      case "error":
        this.o.onEvent({ type: "error", code: msg.code, message: msg.message });
        return;
    }
  }

  private onSteps(msg: Extract<ServerMsg, { type: "steps" }>): void {
    if (msg.timeline !== this.o.timeline) {
      this.o.onEvent({ type: "resync", reason: "timeline" });
      return;
    }
    this.attempt = 0;
    if (msg.to <= this.cursorV) return;
    if (msg.from > this.cursorV) {
      const now = this.now();
      if (this.gapSince === null || now - this.gapSince >= GAP_RETRY_MS) {
        this.gapSince = now;
        this.subscribe();
      }
      return;
    }
    const from = this.cursorV;
    const steps = msg.steps.filter((s) => s.seq > from && s.seq <= msg.to);
    this.cursorV = msg.to;
    this.gapSince = null;
    this.o.onEvent({ type: "steps", from, to: msg.to, steps });
  }
}
