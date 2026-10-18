import type { Frame, Step } from "@perfidia/protocol/spectator";
import { DEFAULT_SPEED, SPEEDS } from "../lib/time.ts";
import { clockCapped, clockNow, type ClockAnchor } from "./clock.ts";
import { Timeline, type FeedEntry, type Position } from "./timeline.ts";

// The playback engine (phase-3 design §4.4), pure: the caller passes the time (`performance.now()`)
// and feeds it frames and steps; it holds the playhead and the frame shown.
//
// - Replay: the playhead advances by wall time × speed (5 min/s to 6 h/s); the frame applies every
//   step with `t ≤ playhead`. Seeking finds the position by binary search on `t` and reduces from
//   the nearest client keyframe (one every 500 steps) or a server frame.
// - Live: the playhead is the head: in lockstep the last step's time (game time stands still while
//   the agents think); in real time the server's clock anchored on receipt, capped. Pausing switches
//   to replay over the steps already held; `goLive` comes back. A replay that reaches the head of a
//   running match goes live again.

export type Mode = "live" | "replay";

const MIN_SPEED = SPEEDS[0];
const MAX_SPEED = SPEEDS[SPEEDS.length - 1] ?? DEFAULT_SPEED;

export interface PlaybackOptions {
  /** A real-time match (the live playhead follows the server's clock), else lockstep. */
  readonly realtime: boolean;
  /** The match is still running (live mode is possible). */
  readonly running: boolean;
}

export interface PlaybackView {
  readonly frame: Frame | null;
  readonly playhead: number;
  readonly mode: Mode;
  readonly playing: boolean;
  readonly speed: number;
  /** The frame shown is exact for the playhead (false while the lines there are loading). */
  readonly known: boolean;
  /** Live, real time: the clock reached its cap without newer lines (waiting for the server). */
  readonly waiting: boolean;
}

export class Playback {
  readonly timeline = new Timeline();
  private realtime: boolean;
  private running: boolean;
  private modeV: Mode = "replay";
  private playingV = false;
  private speedV: number = DEFAULT_SPEED;
  private playheadV = 0;
  private clock: ClockAnchor | null = null;
  private pos: Position | null = null;
  /** `timeline.structure` when `pos` was taken. */
  private posStructure = -1;
  private frameV: Frame | null = null;
  private knownV = true;
  private lastNow: number | null = null;
  /** The time the replay stops at (a finished match's last step); null: the head held. */
  private endAt: number | null = null;
  /** A live match just ended: the last lines may still arrive, and the playhead follows them. */
  private followHead = false;

  constructor(o: PlaybackOptions) {
    this.realtime = o.realtime;
    this.running = o.running;
  }

  get mode(): Mode {
    return this.modeV;
  }

  get playing(): boolean {
    return this.playingV;
  }

  get speed(): number {
    return this.speedV;
  }

  get playhead(): number {
    return this.playheadV;
  }

  get frame(): Frame | null {
    return this.frameV;
  }

  get known(): boolean {
    return this.knownV;
  }

  get isRunning(): boolean {
    return this.running;
  }

  view(nowMs: number): PlaybackView {
    return {
      frame: this.frameV,
      playhead: this.playheadV,
      mode: this.modeV,
      playing: this.playingV,
      speed: this.speedV,
      known: this.knownV,
      waiting: this.modeV === "live" && this.clock !== null && clockCapped(this.clock, nowMs),
    };
  }

  /**
   * The match stopped running (an end line, or a final status): live mode ends. A viewer who was
   * live stays at the head, also for the last lines that arrive after the status (the result).
   */
  setRunning(running: boolean): void {
    this.running = running;
    if (!running && this.modeV === "live") {
      this.modeV = "replay";
      this.playingV = false;
      this.followHead = true;
      this.playheadV = Math.max(this.playheadV, this.timeline.headT);
      this.reposition();
    }
  }

  setRealtime(realtime: boolean): void {
    this.realtime = realtime;
  }

  /** The last time a replay plays to (a finished match: its last line's time). */
  setEnd(t: number | null): void {
    this.endAt = t;
  }

  // Data -------------------------------------------------------------------------------------------

  /** A known frame (keyframe, `/latest`). */
  addFrame(frame: Frame): void {
    const first = this.timeline.empty;
    this.timeline.addFrame(frame);
    if (first) {
      this.playheadV = frame.t;
      this.reposition();
    } else if (!this.knownV) {
      this.reposition();
    }
  }

  /** Steps of `(from, to]`; false when they do not join what is held (fetch the gap). */
  addSteps(from: number, to: number, steps: readonly Step[]): boolean {
    const ok = this.timeline.addSteps(from, to, steps);
    if (!ok) return false;
    if (this.modeV === "live" && !this.realtime) this.playheadV = this.timeline.headT;
    if (this.followHead) this.playheadV = Math.max(this.playheadV, this.timeline.headT);
    this.reposition();
    return true;
  }

  /** A `clock` message of a real-time match, received at `nowMs`. */
  setClock(a: ClockAnchor | null): void {
    this.clock = a;
  }

  // Controls ---------------------------------------------------------------------------------------

  play(nowMs?: number): void {
    this.followHead = false;
    if (this.modeV === "replay" && this.atEnd() && !this.running) {
      this.playheadV = this.timeline.startT;
      this.reposition();
    }
    this.playingV = true;
    this.lastNow = nowMs ?? null;
  }

  /** Pauses; live mode becomes replay over the steps held. */
  pause(): void {
    this.followHead = false;
    this.playingV = false;
    if (this.modeV === "live") this.modeV = "replay";
    this.lastNow = null;
  }

  toggle(nowMs?: number): void {
    if (this.playingV) this.pause();
    else this.play(nowMs);
  }

  /** Replay speed in game-seconds per wall-second, clamped to 5 min/s … 6 h/s. */
  setSpeed(s: number): void {
    if (!Number.isFinite(s)) return;
    this.speedV = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(s)));
  }

  /** One step faster or slower among the offered speeds. */
  stepSpeed(dir: 1 | -1): void {
    const i = SPEEDS.findIndex((v) => v >= this.speedV);
    const at = i < 0 ? SPEEDS.length - 1 : i;
    const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, at + dir))];
    if (next !== undefined) this.speedV = next;
  }

  /** Back to the live head of a running match. */
  goLive(nowMs: number): void {
    if (!this.running) return;
    this.followHead = false;
    this.modeV = "live";
    this.playingV = true;
    this.playheadV = this.liveHead(nowMs);
    this.reposition();
  }

  /** Moves the playhead to game time `t` (live becomes replay). */
  seek(t: number): void {
    this.followHead = false;
    if (this.modeV === "live") {
      this.modeV = "replay";
      this.playingV = false;
    }
    this.playheadV = Math.max(0, t);
    this.reposition();
  }

  /** Moves to just after line `seq` (its time; the frame holds exactly the lines up to it). */
  seekSeq(seq: number): boolean {
    const pos = this.timeline.locateSeq(seq);
    if (pos === null) return false;
    this.followHead = false;
    if (this.modeV === "live") {
      this.modeV = "replay";
      this.playingV = false;
    }
    this.playheadV = this.timeline.timeAt(pos);
    this.moveTo(pos, true);
    return true;
  }

  // Time -------------------------------------------------------------------------------------------

  /** The live head's time: lockstep, the last step; real time, the anchored clock (capped). */
  liveHead(nowMs: number): number {
    const head = this.timeline.headT;
    if (!this.realtime || this.clock === null) return head;
    return Math.max(head, clockNow(this.clock, nowMs));
  }

  /** Whether the replay stands at its end. */
  atEnd(): boolean {
    return this.playheadV >= this.replayEnd();
  }

  private replayEnd(): number {
    return this.endAt ?? this.timeline.headT;
  }

  /**
   * Advances to `nowMs` (client time, ms). Returns true when the frame changed. Replay: the
   * playhead moves by the elapsed time × speed, held at the end of what is loaded; a running match
   * reaching its head goes live; a finished one stops at its end.
   */
  tick(nowMs: number): boolean {
    const before = this.frameV;
    const prevNow = this.lastNow;
    this.lastNow = nowMs;
    if (this.modeV === "live") {
      this.playheadV = this.liveHead(nowMs);
      this.reposition();
      return this.frameV !== before;
    }
    if (!this.playingV || prevNow === null) return false;
    const dt = Math.max(0, Math.min(1_000, nowMs - prevNow)) / 1000;
    let next = this.playheadV + dt * this.speedV;
    const end = this.replayEnd();
    if (next >= end) {
      next = end;
      if (this.running) {
        this.goLive(nowMs);
        return this.frameV !== before;
      }
      this.playingV = false;
    }
    this.playheadV = next;
    this.reposition();
    return this.frameV !== before;
  }

  // Frames -----------------------------------------------------------------------------------------

  private reposition(): void {
    const found = this.timeline.locate(this.playheadV);
    if (found === null) return;
    this.knownV = found.known;
    this.moveTo(found.pos, false);
  }

  private moveTo(pos: Position, force: boolean): void {
    const cur = this.posStructure === this.timeline.structure ? this.pos : null;
    if (
      !force &&
      cur !== null &&
      cur.segment === pos.segment &&
      cur.index === pos.index &&
      this.frameV !== null
    ) {
      return;
    }
    const from =
      cur !== null && this.frameV !== null ? { pos: cur, frame: this.frameV } : undefined;
    const frame = this.timeline.frameAt(pos, from);
    if (frame === null) return;
    this.pos = pos;
    this.posStructure = this.timeline.structure;
    this.frameV = frame;
  }

  /** Feed entries up to the frame shown. */
  feed(): FeedEntry[] {
    return this.frameV === null ? [] : this.timeline.feedUntil(this.frameV.seq);
  }
}
