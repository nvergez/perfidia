import { parentPort } from "node:worker_threads";
import { LogLineSchema, type HeaderLine } from "@perfidia/protocol";
import type {
  MatchId,
  ReportDetail,
  Step,
  TimelineId,
  Verified,
} from "@perfidia/protocol/spectator";
import { createSpectatorFold, type SpectatorFold } from "@perfidia/spectator";
import type { FoldBatch, FromWorker, SeatAux, ToWorker } from "./messages.ts";

// A fold worker (phase-3 design §2.5): the only place where the server runs the spectator fold
// (the engine's Level E replay, the gateway fold and the projection), so a long fold never blocks
// the main thread's sockets and health check. One worker holds several folds, one per open log.
// Each `lines` message is folded line by line; a batch of what the lines added goes back after at
// most `SLICE_MS` of work and at the end of the message. A line that is not valid JSON or fails its
// schema makes the match unverifiable, with a status step at that line (as a replay divergence
// does): later lines are counted, never folded.

const SLICE_MS = 50;

interface Slot {
  readonly match: MatchId;
  readonly timeline: TimelineId;
  fold: SpectatorFold | null;
  /** Lines received (the header is line 0): the next line's cursor. */
  lines: number;
  lastT: number;
  bad: Verified | null;
  sentSteps: number;
  sentKeyframes: number;
  sentMoments: number;
  mapSent: boolean;
  readonly notes: Map<string, string>;
  readonly counts: Map<string, string>;
}

const slots = new Map<number, Slot>();

function post(msg: FromWorker): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker thread, not a window
  parentPort?.postMessage(msg);
}

function reportsOf(fold: SpectatorFold, steps: readonly Step[]): ReportDetail[] {
  const ids = new Set<string>();
  for (const step of steps) {
    for (const item of step.items ?? []) {
      if (item.k === "battle") for (const r of item.reports) ids.add(r);
      else if (item.k === "spy" && item.report !== null) ids.add(item.report);
    }
  }
  const out: ReportDetail[] = [];
  for (const id of ids) {
    const r = fold.report(id);
    if (r !== null) out.push(r);
  }
  return out;
}

function batchOf(slot: Slot, idle: boolean): FoldBatch {
  const fold = slot.fold;
  if (fold === null) {
    return {
      lastSeq: Math.max(0, slot.lines - 1),
      lastT: slot.lastT,
      status: "unverifiable",
      verified: slot.bad ?? { ok: false, divergence: "the log has no header line" },
      map: null,
      steps: [],
      keyframes: [],
      moments: [],
      reports: [],
      seats: [],
      drift: null,
      idle,
    };
  }
  const steps = fold.steps.slice(slot.sentSteps);
  const keyframes = fold.keyframes.slice(slot.sentKeyframes);
  const moments = fold.moments.slice(slot.sentMoments);
  slot.sentSteps = fold.steps.length;
  slot.sentKeyframes = fold.keyframes.length;
  slot.sentMoments = fold.moments.length;
  const seats: SeatAux[] = [];
  for (const s of fold.header.setup.seats) {
    const notes = fold.notes(s.id) ?? "";
    const counts = fold.counts(s.id) ?? { turns: 0, messagesSent: 0, messagesReceived: 0 };
    const countsKey = `${JSON.stringify(counts)}:${fold.seriesKey(s.id)}`;
    if (slot.notes.get(s.id) !== notes || slot.counts.get(s.id) !== countsKey) {
      slot.notes.set(s.id, notes);
      slot.counts.set(s.id, countsKey);
      seats.push({
        seat: s.id,
        notes,
        counts,
        hourly: fold.hourly(s.id),
        notebook: fold.notebook(s.id),
      });
    }
  }
  const map = slot.mapSent ? null : fold.map();
  slot.mapSent = true;
  return {
    lastSeq: Math.max(0, slot.lines - 1),
    lastT: Math.max(slot.lastT, fold.lastT),
    status: slot.bad !== null ? "unverifiable" : fold.status,
    verified: slot.bad ?? fold.verified(),
    map,
    steps,
    keyframes,
    moments,
    reports: reportsOf(fold, steps),
    seats,
    drift: fold.gatewayDrift(),
    idle,
  };
}

function parseLine(raw: string): ReturnType<typeof LogLineSchema.safeParse> | null {
  try {
    return LogLineSchema.safeParse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function foldLines(key: number, slot: Slot, lines: readonly string[]): void {
  let started = performance.now();
  for (const raw of lines) {
    const seq = slot.lines;
    slot.lines += 1;
    if (slot.bad === null) {
      const parsed = parseLine(raw);
      if (parsed === null || !parsed.success) {
        slot.bad = { ok: false, divergence: `line ${seq} is not a valid log line` };
        slot.fold?.invalid();
      } else if (slot.fold === null) {
        if (parsed.data.k !== "header") {
          slot.bad = { ok: false, divergence: "the log does not start with a header line" };
        } else {
          slot.fold = createSpectatorFold(parsed.data satisfies HeaderLine, {
            match: slot.match,
            timeline: slot.timeline,
          });
        }
      } else {
        if (parsed.data.k !== "header") slot.lastT = Math.max(slot.lastT, parsed.data.t);
        slot.fold.push(parsed.data);
      }
    }
    if (performance.now() - started >= SLICE_MS) {
      post({ type: "batch", key, batch: batchOf(slot, false) });
      started = performance.now();
    }
  }
  post({ type: "batch", key, batch: batchOf(slot, true) });
}

function handle(msg: ToWorker): void {
  switch (msg.type) {
    case "open":
      slots.set(msg.key, {
        match: msg.match,
        timeline: msg.timeline,
        fold: null,
        lines: 0,
        lastT: 0,
        bad: null,
        sentSteps: 0,
        sentKeyframes: 0,
        sentMoments: 0,
        mapSent: false,
        notes: new Map(),
        counts: new Map(),
      });
      return;
    case "lines": {
      const slot = slots.get(msg.key);
      if (slot === undefined) return;
      try {
        foldLines(msg.key, slot, msg.lines);
      } catch (e) {
        slots.delete(msg.key);
        post({
          type: "failed",
          key: msg.key,
          reason: e instanceof Error ? e.name : "fold error",
        });
      }
      return;
    }
    case "close":
      slots.delete(msg.key);
      return;
  }
}

parentPort?.on("message", (msg: ToWorker) => {
  handle(msg);
});
