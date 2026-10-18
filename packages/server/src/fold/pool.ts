import { Worker } from "node:worker_threads";
import type { MatchId } from "@perfidia/protocol/spectator";
import type { FoldBatch, FromWorker, ToWorker } from "./messages.ts";

// The fold workers (phase-3 design §2.5): at most `size` worker threads, each holding the folds of
// several logs; a new fold goes to the worker with the fewest. The main thread never folds: it sends
// raw lines and receives batches. A worker that crashes fails all its folds (their owners refold
// from the first line on a fresh worker: the steps are the same).

export interface FoldSink {
  batch(batch: FoldBatch): void;
  failed(reason: string): void;
}

export interface FoldHandle {
  readonly key: number;
  /** Sends lines to fold, in log order. */
  send(lines: readonly string[]): void;
  /** Lines sent and not yet folded (as the last batch reported). */
  pending(): number;
  close(): void;
}

interface Slot {
  readonly worker: Worker;
  readonly sinks: Map<number, Handle>;
}

class Handle implements FoldHandle {
  readonly key: number;
  readonly sink: FoldSink;
  private readonly pool: FoldPool;
  readonly slot: Slot;
  sent = 0;
  folded = 0;
  closed = false;

  constructor(pool: FoldPool, slot: Slot, key: number, sink: FoldSink) {
    this.pool = pool;
    this.slot = slot;
    this.key = key;
    this.sink = sink;
  }

  send(lines: readonly string[]): void {
    if (this.closed || lines.length === 0) return;
    this.sent += lines.length;
    this.pool.post(this.slot, { type: "lines", key: this.key, lines });
  }

  pending(): number {
    return this.sent - this.folded;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.slot.sinks.delete(this.key);
    this.pool.post(this.slot, { type: "close", key: this.key });
  }
}

export class FoldPool {
  private readonly size: number;
  private readonly slots: Slot[] = [];
  private nextKey = 1;
  private stopped = false;

  constructor(size: number) {
    this.size = Math.max(1, size);
  }

  /** Opens a fold of a match's log; batches and failures go to `sink`. */
  open(match: MatchId, sink: FoldSink): FoldHandle {
    const slot = this.pick();
    const key = this.nextKey;
    this.nextKey += 1;
    const handle = new Handle(this, slot, key, sink);
    slot.sinks.set(key, handle);
    this.post(slot, { type: "open", key, match });
    return handle;
  }

  /** Folds with lines still to fold. */
  folding(): number {
    let n = 0;
    for (const s of this.slots) for (const h of s.sinks.values()) if (h.pending() > 0) n += 1;
    return n;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const workers = this.slots.splice(0).map((s) => s.worker);
    await Promise.all(workers.map((w) => w.terminate()));
  }

  post(slot: Slot, msg: ToWorker): void {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker thread, not a window
    if (!this.stopped) slot.worker.postMessage(msg);
  }

  private pick(): Slot {
    if (this.slots.length < this.size) return this.spawn();
    let best = this.slots[0];
    for (const s of this.slots) if (best === undefined || s.sinks.size < best.sinks.size) best = s;
    return best ?? this.spawn();
  }

  private spawn(): Slot {
    const worker = new Worker(new URL("./worker.ts", import.meta.url));
    const slot: Slot = { worker, sinks: new Map() };
    worker.on("message", (msg: FromWorker) => {
      const h = slot.sinks.get(msg.key);
      if (h === undefined) return;
      if (msg.type === "batch") {
        h.folded = msg.batch.lastSeq + 1;
        h.sink.batch(msg.batch);
      } else {
        h.close();
        h.sink.failed(msg.reason);
      }
    });
    const crash = (): void => {
      const i = this.slots.indexOf(slot);
      if (i >= 0) this.slots.splice(i, 1);
      const handles = [...slot.sinks.values()];
      slot.sinks.clear();
      if (this.stopped) return;
      for (const h of handles) {
        h.closed = true;
        h.sink.failed("worker stopped");
      }
    };
    worker.on("error", crash);
    worker.on("exit", crash);
    // A worker never keeps the server alive on its own.
    worker.unref();
    this.slots.push(slot);
    return slot;
  }
}
