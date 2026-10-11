import {
  ENGINE_VERSION,
  HOUR,
  type ApplyOutput,
  type Match,
  type StepOutput,
} from "@perfidia/engine/kernel";
import {
  JsonObjectSchema,
  LOG_FORMAT,
  MatchSetupSchema,
  type Action,
  type ClockSpec,
  type GameTime,
  type Json,
  type LogLine,
  type PlayerId,
  type Snapshot,
  type TurnEnd,
  type ViolationDetails,
} from "@perfidia/protocol";

// A minimal log writer for engine tests (docs/architecture.md §10.2): it drives a `Match` and writes
// the lines a host would, in the order of §10.2 — the `ev` and `ckpt` lines of an advance before the
// next line stamped at that time, an `act` line before the `ev` lines of its events — plus the
// lines that do not touch the engine (`wake`, `batch`, `gw`, `obs`, `note`, `turn`, `defer`,
// `controller`), so replay tests can exercise every line kind before the gateway exists.

export interface RecorderOptions {
  /** Controller labels at t = 0; default `test:<seat>` for every seat. */
  readonly controllers?: Readonly<Record<string, string>>;
  /** Default lockstep with 3 turns per second. */
  readonly clock?: ClockSpec;
  /** Snapshot every this many game hours (at checkpoints); 0 = only the final one. Default 0. */
  readonly snapshotEvery?: number;
}

export class LogRecorder {
  readonly match: Match;
  readonly lines: LogLine[] = [];
  readonly snapshots: Snapshot[] = [];
  private readonly every: number;
  private n = 0;
  private readonly turns = new Map<PlayerId, number>();

  constructor(match: Match, o: RecorderOptions = {}) {
    this.match = match;
    this.every = o.snapshotEvery ?? 0;
    const controllers: Record<string, string> = {};
    for (const seat of match.setup.seats)
      controllers[seat.id] = o.controllers?.[seat.id] ?? `test:${seat.id}`;
    this.lines.push({
      k: "header",
      format: LOG_FORMAT,
      engine: ENGINE_VERSION,
      setup: MatchSetupSchema.parse(match.setup),
      config: JsonObjectSchema.parse(match.config),
      configHash: match.configHash,
      rulesHash: match.rulesHash,
      controllers,
      clock: o.clock ?? { kind: "lockstep", maxTurnsPerSecond: 3 },
      initialHash: match.hash(),
    });
  }

  /** The `n` of the last numbered line written (0 when none). */
  get lastN(): number {
    return this.n;
  }

  /** Advances to `t`, split at every hour, writing the `ev` and `ckpt` lines and the due snapshots. */
  advanceTo(t: GameTime): void {
    const m = this.match;
    while (!m.ended) {
      const ck = (Math.floor(m.now / HOUR) + 1) * HOUR;
      if (ck > t) break;
      this.write(m.advanceTo(ck));
    }
    this.write(m.advanceTo(t));
  }

  private write(out: StepOutput): void {
    for (const e of out.events) this.lines.push({ k: "ev", t: e.t, e });
    for (const c of out.checkpoints) {
      this.lines.push({ k: "ckpt", t: c.t, hour: c.hour, h: c.h });
      if (this.every > 0 && c.hour % this.every === 0)
        this.snapshots.push(this.match.snapshot(this.n));
    }
  }

  private turnOf(seat: PlayerId): number {
    return this.turns.get(seat) ?? 1;
  }

  /** Applies `a` for `seat` at the current time and writes its `act` line and the `ev` lines of its events. */
  act(
    seat: PlayerId,
    a: Action,
    o: { readonly tool?: string; readonly rt?: number; readonly i?: number } = {},
  ): ApplyOutput {
    const out = this.match.apply(seat, a);
    this.n += 1;
    this.lines.push({
      k: "act",
      n: this.n,
      t: this.match.now,
      seat,
      turn: this.turnOf(seat),
      rt: o.rt ?? 0,
      tool: o.tool ?? a.type,
      i: o.i ?? 0,
      a,
      r: out.ok ? { ok: true } : { ok: false, code: out.violation.code },
    });
    if (out.ok) for (const e of out.events) this.lines.push({ k: "ev", t: e.t, e });
    return out;
  }

  /** A call rejected by the gateway. */
  gw(seat: PlayerId, tool: string, code: string, details?: ViolationDetails): void {
    this.n += 1;
    const r =
      details === undefined ? { ok: false as const, code } : { ok: false as const, code, details };
    this.lines.push({
      k: "gw",
      n: this.n,
      t: this.match.now,
      seat,
      turn: this.turnOf(seat),
      rt: 0,
      tool,
      r,
    });
  }

  /** A read tool call. */
  obs(seat: PlayerId, tool: string, args: Json, bytes = 100): void {
    this.n += 1;
    this.lines.push({
      k: "obs",
      n: this.n,
      t: this.match.now,
      seat,
      turn: this.turnOf(seat),
      rt: 0,
      tool,
      args,
      bytes,
    });
  }

  note(seat: PlayerId, text: string, mode: "append" | "replace" = "replace"): void {
    this.n += 1;
    this.lines.push({
      k: "note",
      n: this.n,
      t: this.match.now,
      seat,
      turn: this.turnOf(seat),
      mode,
      text,
    });
  }

  wake(seat: PlayerId, reasons: readonly string[] = ["start"]): void {
    const t = this.match.now;
    this.lines.push({
      k: "wake",
      t,
      seat,
      turn: this.turnOf(seat),
      reasons: [...reasons],
      urgent: false,
      charge: null,
      day: Math.floor(t / 86400),
      used: { own: 0, social: 0 },
    });
  }

  turn(seat: PlayerId, why: TurnEnd = "end_turn", selfAt: GameTime | null = null): void {
    const turn = this.turnOf(seat);
    this.lines.push({
      k: "turn",
      t: this.match.now,
      seat,
      turn,
      rounds: 1,
      calls: 1,
      why,
      selfAt,
      next: selfAt === null ? null : { at: selfAt, kind: "self" },
    });
    this.turns.set(seat, turn + 1);
  }

  batch(b: number, order: readonly PlayerId[]): void {
    this.lines.push({ k: "batch", t: this.match.now, b, order: [...order] });
  }

  defer(seat: PlayerId, to: GameTime): void {
    this.lines.push({ k: "defer", t: this.match.now, seat, to });
  }

  controller(seat: PlayerId, label: string): void {
    this.lines.push({ k: "controller", t: this.match.now, seat, label });
  }

  /** Advances to the end of the match, writes the `end` line and takes the final snapshot. */
  end(): void {
    this.advanceTo(Math.max(this.match.now, this.match.rules.time.matchEnd));
    const result = this.match.result;
    if (result === null) throw new Error("LogRecorder.end: the match has not ended");
    this.lines.push({ k: "end", t: this.match.now, h: this.match.hash(), result });
    this.snapshots.push(this.match.snapshot(this.n));
  }
}
