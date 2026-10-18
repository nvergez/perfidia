import { lstatSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  LlmLogLineSchema,
  ReplyLineSchema,
  type EndLine,
  type HeaderLine,
  type PlayerId,
  type ReplyLine,
  type SeatsFile,
  type Sha256,
} from "@perfidia/protocol";
import {
  SPECTATOR_FORMAT,
  type MatchId,
  type MatchListItem,
  type MatchMeta,
  type MatchStatus,
  type PublicReason,
  type SeatInfo,
  type TimelineId,
} from "@perfidia/protocol/spectator";
import { logIdOf, timelineIdOf } from "@perfidia/spectator";
import {
  createAnnotationFold,
  type AnnotationFold,
  type AnnotationPolicy,
} from "@perfidia/spectator/annotations";
import { standingsOf } from "@perfidia/spectator/reduce";
import type { ServeConfig } from "../config.ts";
import type { FoldBatch } from "../fold/messages.ts";
import type { FoldHandle, FoldPool } from "../fold/pool.ts";
import { discoverRuns, type RunRef } from "../store/discover.ts";
import type { PublishList } from "../store/publish.ts";
import {
  ARENA_FILE,
  CALLS_FILE,
  REPLIES_FILE,
  SEATS_FILE,
  SUMMARY_FILE,
  fileStamp,
  parseEnd,
  parseHeader,
  readArenaFile,
  readSeatsFile,
  readSummaryFile,
  type ArenaInfo,
  type SummaryInfo,
} from "../store/rundir.ts";
import { isFinal, matchStatus, type StatusOut } from "../store/status.ts";
import { LineTail, readFirstLine, readGzLines, readLastLine } from "../store/tail.ts";
import type { TimelineCache } from "../timeline/cache.ts";
import { Lru } from "../timeline/lru.ts";
import { Timeline, type Appended } from "../timeline/timeline.ts";
import { seatInfos } from "./seats.ts";

// The matches the server knows (phase-3 design §2.4, §2.5): one entry per run directory found under
// the runs root, followed from discovery to its last line. An entry reads its header itself (to name
// the log and its timeline), then its timeline comes from the cache or from a fold in a worker, fed
// with the log's complete lines as they are appended; side files feed the annotations and the
// status. Every visible match is folded (or loaded from the cache) in the background at startup, at
// most `workers` from scratch at a time, so a request never starts a fold. Finished timelines stay
// in memory in an LRU of 8 in front of the disk cache; running ones always stay in memory.
//
// Visibility: a match is visible when `publish.json` lists it (or no file is given), when it is
// verifiable (unless no file is given: local development lists everything), and, for an
// `after_end` match, once its log has an end line. A match that stops being visible is hidden from
// every route and its sockets are told.

export interface RegistryHooks {
  /** A fold batch added lines (and maybe steps) to a timeline. */
  steps(entry: MatchEntry, appended: Appended): void;
  /** The status (or the visibility) of a match may have changed. */
  status(entry: MatchEntry): void;
  /** The log was replaced: everything a client holds of it is void. */
  reset(entry: MatchEntry): void;
  /** A model reply arrived (`replies.jsonl`). */
  reply(entry: MatchEntry, line: ReplyLine): void;
  /** The timeline of a match is available (its header was folded). */
  ready(entry: MatchEntry): void;
  /** A match is no longer visible. */
  hidden(id: MatchId): void;
}

export interface RegistryDeps {
  readonly config: ServeConfig;
  readonly pool: FoldPool;
  readonly cache: TimelineCache | null;
  readonly publish: PublishList;
  readonly now: () => number;
  readonly warn: (message: string) => void;
}

/** Finished timelines kept in memory (§3.4). */
const LRU_SIZE = 8;
/** Fold failures of one log before it is given up as unverifiable. */
const MAX_FOLD_FAILURES = 3;
/** A turn's annotation is complete this long (wall ms) after its `turn` line was seen (§2.4). */
const ANNOTATION_SETTLE_MS = 10 * 60_000;
/** Polls between two reads of a finished match's side files. */
const FINISHED_POLL_EVERY = 20;

export class MatchEntry {
  readonly id: MatchId;
  ref: RunRef;
  header: HeaderLine | null = null;
  logId: Sha256 | null = null;
  timelineId: TimelineId | null = null;
  /** Why the run cannot be served (no valid header), if it cannot. */
  broken: string | null = null;
  timeline: Timeline | null = null;
  /** A final timeline of this log is in the cache (the memory copy may be evicted). */
  onDisk = false;
  fold: FoldHandle | null = null;
  foldFailures = 0;
  logTail: LineTail | null = null;
  /** The last read of the log stopped at its size cap: bytes are still unread. */
  tailMore = false;
  gzRead = false;
  calls: LineTail;
  replies: LineTail;
  annotations: AnnotationFold;
  seatsFile: SeatsFile | null = null;
  arena: ArenaInfo | null = null;
  summary: SummaryInfo | null = null;
  readonly stamps = new Map<string, string | null>();
  /** Wall ms when the log last grew. */
  lastGrowth: number;
  /** The end line found at discovery (a finished run, before or without its fold). */
  endLine: EndLine | null = null;
  status: StatusOut = { status: "loading", reason: null };
  visible = false;
  /** Still in its first fold up to the tail. */
  loading = true;
  lastCacheWrite = 0;
  /** Wall ms when each LLM turn's `turn` item was seen, by `seat:turn`. */
  readonly turnSeen = new Map<string, number>();
  /** What the listing needs when the timeline is not in memory. */
  known: { ended: boolean; unverifiable: boolean; lastT: number; leader: PlayerId | null } = {
    ended: false,
    unverifiable: false,
    lastT: 0,
    leader: null,
  };
  watcher: FSWatcher | null = null;
  pollTick = 0;
  /** The log file's identity when its fold finished (a finished run is no longer tailed). */
  logStamp: string | null = null;

  constructor(ref: RunRef, policy: AnnotationPolicy, now: number) {
    this.id = ref.id;
    this.ref = ref;
    this.calls = new LineTail(join(ref.dir, CALLS_FILE));
    this.replies = new LineTail(join(ref.dir, REPLIES_FILE));
    this.annotations = createAnnotationFold(policy);
    // The log's modification time, so a match that went silent before a restart still stalls.
    let mtime = now;
    try {
      mtime = lstatSync(ref.log).mtimeMs;
    } catch {
      mtime = now;
    }
    this.lastGrowth = Math.min(now, Math.floor(mtime));
  }

  /** The seats as spectators see them. */
  seats(): SeatInfo[] {
    return this.header === null ? [] : seatInfos(this.header, this.seatsFile, this.arena);
  }

  /** The match end in game seconds (the header's effective `time.matchEnd`). */
  matchEnd(): number {
    const time = this.header?.config["time"];
    const end =
      time !== null && typeof time === "object" && !Array.isArray(time)
        ? time["matchEnd"]
        : undefined;
    return typeof end === "number" ? end : 0;
  }

  hasEnd(): boolean {
    return this.endLine !== null || this.timeline?.status === "ended" || this.known.ended;
  }
}

export class Registry {
  private readonly deps: RegistryDeps;
  private readonly hooks: RegistryHooks;
  readonly entries = new Map<MatchId, MatchEntry>();
  private readonly lru = new Lru<MatchId>(LRU_SIZE);
  private readonly waiting: MatchEntry[] = [];
  private readonly backfilling = new Set<MatchEntry>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private rootWatcher: FSWatcher | null = null;
  private publishWatcher: FSWatcher | null = null;
  private stopped = false;
  private readonly started: number;

  constructor(deps: RegistryDeps, hooks: RegistryHooks) {
    this.deps = deps;
    this.hooks = hooks;
    this.started = deps.now();
  }

  get uptimeMs(): number {
    return this.deps.now() - this.started;
  }

  /** Loads the public list, discovers the runs and starts following them. */
  start(): void {
    const { config } = this.deps;
    if (!this.deps.publish.open) this.deps.publish.load({ first: true });
    this.rescan();
    const t = config.timing;
    this.timers.push(setInterval(() => this.poll(), t.pollMs));
    this.timers.push(setInterval(() => this.rescan(), t.rescanMs));
    if (!this.deps.publish.open)
      this.timers.push(setInterval(() => this.reloadPublish(), t.publishMs));
    try {
      this.rootWatcher = watch(config.runs, () => this.rescan());
    } catch {
      this.rootWatcher = null;
    }
    const path = this.deps.publish.path;
    if (path !== null) {
      try {
        this.publishWatcher = watch(path, () => this.reloadPublish());
      } catch {
        this.publishWatcher = null;
      }
    }
  }

  /** Stops following the runs; running matches' timelines are written to the cache first. */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.splice(0)) clearInterval(t);
    this.rootWatcher?.close();
    this.publishWatcher?.close();
    for (const e of this.entries.values()) {
      e.watcher?.close();
      if (e.fold !== null && e.timeline !== null && e.timeline.lastSeq > 0 && !e.loading) {
        this.save(e.timeline);
      }
      e.fold?.close();
    }
  }

  /** Folds with lines still to fold. */
  folding(): number {
    return this.deps.pool.folding();
  }

  /** Re-reads `publish.json`; hides and shows matches accordingly (the kill switch). */
  reloadPublish(): void {
    if (this.stopped) return;
    const changed = this.deps.publish.load();
    if (this.deps.publish.error !== null) this.deps.warn(this.deps.publish.error);
    if (changed) for (const e of this.entries.values()) this.refresh(e);
  }

  /** Finds new run directories (and drops vanished ones). */
  rescan(): void {
    if (this.stopped) return;
    const found = discoverRuns(this.deps.config.runs);
    const ids = new Set(found.map((r) => r.id));
    for (const ref of found) {
      const e = this.entries.get(ref.id);
      if (e === undefined) this.add(ref);
      else if (e.ref.log !== ref.log) {
        this.remove(e);
        this.add(ref);
      }
    }
    for (const e of Array.from(this.entries.values())) if (!ids.has(e.id)) this.remove(e);
  }

  /** A visible match. */
  get(id: string): MatchEntry | null {
    const e = this.entries.get(id);
    return e !== undefined && e.visible ? e : null;
  }

  /** The visible matches, sorted by id. */
  list(): MatchEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.visible)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** A match's timeline, read back from the cache when it was evicted from memory. */
  timelineOf(e: MatchEntry): Timeline | null {
    if (e.timeline !== null) {
      if (e.onDisk && e.fold === null) this.touch(e);
      return e.timeline;
    }
    if (!e.onDisk || this.deps.cache === null || e.logId === null || e.timelineId === null)
      return null;
    const t = this.deps.cache.load(e.id, e.logId, e.timelineId);
    if (t === null) {
      e.onDisk = false;
      this.load(e);
      return e.timeline;
    }
    e.timeline = t;
    this.touch(e);
    return t;
  }

  /** The list item of a visible match (never starts a fold). */
  listItem(e: MatchEntry): MatchListItem {
    const t = e.timeline;
    const tail = t?.tail() ?? null;
    const standings = tail === null ? [] : standingsOf(tail);
    const lastT = t?.lastT ?? e.endLine?.t ?? e.known.lastT;
    const winners = tail?.result?.winners ?? e.endLine?.result.winners ?? null;
    const p = this.deps.publish.entry(e.id);
    return {
      id: e.id,
      title: p?.title ?? e.id,
      status: e.status.status,
      reason: e.status.reason,
      ruleset: e.header?.setup.ruleset ?? "unknown@0.0.0",
      players: e.header?.setup.seats.length ?? 0,
      lastT,
      day: Math.floor(lastT / 86_400) + 1,
      leader: standings[0]?.player ?? e.endLine?.result.standings[0]?.player ?? e.known.leader,
      winners: winners === null ? null : [...winners],
      featured: p?.featured ?? false,
      seats: e.seats().map((s) => ({
        seat: s.seat,
        name: s.name,
        kind: s.kind,
        model: s.model,
        fake: s.fake,
      })),
    };
  }

  /** The meta of a visible match whose timeline has its header folded, else null. */
  meta(e: MatchEntry, t: Timeline): MatchMeta | null {
    const h = e.header;
    if (h === null || t.map === null || e.logId === null) return null;
    const p = this.deps.publish.entry(e.id);
    return {
      format: SPECTATOR_FORMAT,
      id: e.id,
      title: p?.title ?? e.id,
      description: p?.description ?? null,
      ruleset: h.setup.ruleset,
      engine: h.engine,
      configHash: h.configHash,
      rulesHash: h.rulesHash,
      config: h.config,
      clock: h.clock,
      matchEnd: e.matchEnd(),
      seats: e.seats(),
      map: t.map,
      status: e.status.status,
      reason: e.status.reason,
      wallStart: h.wallStart ?? null,
      lastSeq: Math.max(0, t.lastSeq),
      lastT: t.lastT,
      logId: e.logId,
      timeline: t.timeline,
      keyframes: t.keyframes.map((k) => k.seq),
      verified: t.verified,
    };
  }

  /** Whether a turn's annotation can no longer change. */
  annotationFinal(e: MatchEntry, seat: PlayerId, turn: number): boolean {
    if (isFinal(e.status.status) || e.status.status === "unverifiable") return true;
    const seen = e.turnSeen.get(`${seat}:${turn}`);
    return seen !== undefined && this.deps.now() - seen >= ANNOTATION_SETTLE_MS;
  }

  /** Game time now of a running real-time match, for `clock` messages (§3.2); else null. */
  clockOf(e: MatchEntry): { t: number; speed: [number, number]; cap: number } | null {
    const h = e.header;
    const t = e.timeline;
    if (h === null || t === null || h.clock.kind !== "realtime" || t.final) return null;
    const cap = Math.min(e.matchEnd(), t.lastT + 3600);
    const [num, den] = h.clock.speed;
    const start = h.wallStart === undefined ? Number.NaN : Date.parse(h.wallStart);
    const now = Number.isFinite(start)
      ? Math.floor(((this.deps.now() - start) / 1000) * (num / den))
      : t.lastT;
    return { t: Math.min(cap, Math.max(t.lastT, now)), speed: [num, den], cap };
  }

  // Entries -----------------------------------------------------------------------------------------

  private add(ref: RunRef): void {
    const e = new MatchEntry(
      ref,
      { costs: this.deps.config.policy.costs, reasoning: this.deps.config.policy.reasoning },
      this.deps.now(),
    );
    this.entries.set(ref.id, e);
    this.readHead(e);
    this.readSide(e, true);
    try {
      e.watcher = watch(ref.dir, () => this.pollEntry(e));
    } catch {
      e.watcher = null;
    }
    this.refresh(e);
  }

  private remove(e: MatchEntry): void {
    e.watcher?.close();
    e.fold?.close();
    e.fold = null;
    this.entries.delete(e.id);
    this.lru.delete(e.id);
    this.backfilling.delete(e);
    const i = this.waiting.indexOf(e);
    if (i >= 0) this.waiting.splice(i, 1);
    if (e.visible) this.hooks.hidden(e.id);
  }

  /** Reads the header (and, for a finished run, the end line) without folding. */
  private readHead(e: MatchEntry): void {
    let first: string | null;
    let last: string | null;
    if (e.ref.gz) {
      try {
        const lines = readGzLines(e.ref.log);
        first = lines[0] ?? null;
        last = lines.at(-1) ?? null;
      } catch {
        first = null;
        last = null;
      }
    } else {
      first = readFirstLine(e.ref.log);
      last = readLastLine(e.ref.log);
    }
    const header = parseHeader(first);
    if (header === null) {
      // A log still being created has no complete first line yet: try again later.
      e.broken = first === null ? "the log has no complete header line yet" : "invalid header line";
      return;
    }
    e.broken = null;
    e.header = header;
    e.logId = logIdOf(header);
    e.timelineId = timelineIdOf(e.logId);
    e.endLine = parseEnd(last);
    if (e.endLine !== null) {
      e.known = {
        ended: true,
        unverifiable: false,
        lastT: e.endLine.t,
        leader: e.endLine.result.standings[0]?.player ?? null,
      };
    }
  }

  /** Re-reads the side files that changed; tails `llm_calls.jsonl` and `replies.jsonl`. */
  private readSide(e: MatchEntry, first: boolean): void {
    const dir = e.ref.dir;
    const changed = (name: string): boolean => {
      const stamp = fileStamp(join(dir, name));
      if (!first && e.stamps.get(name) === stamp) return false;
      e.stamps.set(name, stamp);
      return true;
    };
    if (changed(SEATS_FILE)) {
      const r = readSeatsFile(dir);
      if (r.ok) e.seatsFile = r.value;
      else if (!r.missing) {
        e.stamps.delete(SEATS_FILE);
        this.deps.warn(`${e.id}: ${SEATS_FILE} does not parse; seats shown from the log only`);
      }
    }
    if (changed(ARENA_FILE)) {
      const r = readArenaFile(dir);
      e.arena = r.ok ? r.value : e.arena;
      if (!r.ok && !r.missing) this.deps.warn(`${e.id}: ${ARENA_FILE} does not parse`);
    }
    if (changed(SUMMARY_FILE)) {
      const r = readSummaryFile(dir);
      e.summary = r.ok ? r.value : e.summary;
    }
    for (const raw of e.calls.read().lines) {
      const parsed = safeJson(raw, (v) => LlmLogLineSchema.safeParse(v));
      if (parsed !== null) e.annotations.call(parsed);
    }
    for (const raw of e.replies.read().lines) {
      const parsed = safeJson(raw, (v) => ReplyLineSchema.safeParse(v));
      if (parsed === null) continue;
      e.annotations.reply(parsed);
      if (!first) this.hooks.reply(e, parsed);
    }
  }

  /** Recomputes visibility and status; starts loading a newly visible match. */
  private refresh(e: MatchEntry): void {
    if (e.broken !== null && e.header === null) {
      if (e.visible) {
        e.visible = false;
        this.hooks.hidden(e.id);
      }
      return;
    }
    const t = e.timeline;
    const unverifiable = t !== null ? !t.verified.ok : e.known.unverifiable;
    const endReason =
      t?.status === "ended"
        ? (t.tail()?.result?.reason ?? "time")
        : (e.endLine?.result.reason ?? null);
    const status = matchStatus({
      loading: e.loading,
      unverifiable,
      endReason,
      fatalLine: t?.status === "fatal",
      arena: e.arena,
      summary: e.summary,
      clock: e.header?.clock ?? null,
      idleMs: this.deps.now() - e.lastGrowth,
    });
    const p = this.deps.publish.entry(e.id);
    const visible =
      p !== null &&
      (this.deps.publish.open || !unverifiable) &&
      (p.visibility === "live" || e.hasEnd());
    const wasVisible = e.visible;
    const statusChanged = status.status !== e.status.status || status.reason !== e.status.reason;
    e.status = status;
    e.visible = visible;
    if (wasVisible && !visible) this.hooks.hidden(e.id);
    else if (visible && statusChanged) this.hooks.status(e);
    if (p !== null && e.timeline === null && !e.onDisk && e.fold === null) this.load(e);
  }

  /** Starts a match's timeline: from the cache, else from a fold (queued behind other backfills). */
  private load(e: MatchEntry): void {
    if (e.header === null || e.logId === null || e.timelineId === null) return;
    if (e.timeline === null && this.deps.cache !== null) {
      const cached = this.deps.cache.load(e.id, e.logId, e.timelineId);
      if (cached !== null) {
        e.timeline = cached;
        this.noteKnown(e);
        if (cached.final) {
          e.onDisk = true;
          e.loading = false;
          e.logStamp = fileStamp(e.ref.log);
          this.touch(e);
          this.refresh(e);
          this.hooks.ready(e);
          return;
        }
        // A live match's cached prefix is served at once; the refold skips what it holds.
        this.hooks.ready(e);
      }
    }
    e.timeline ??= new Timeline(e.id, e.logId, e.timelineId);
    if (!this.waiting.includes(e) && !this.backfilling.has(e) && e.fold === null) {
      this.waiting.push(e);
      this.startWaiting();
    }
  }

  private startWaiting(): void {
    while (this.backfilling.size < this.deps.config.workers && this.waiting.length > 0) {
      const e = this.waiting.shift();
      if (e === undefined) break;
      this.backfilling.add(e);
      this.openFold(e);
      this.pollEntry(e);
    }
  }

  private openFold(e: MatchEntry): void {
    e.logTail = e.ref.gz ? null : new LineTail(e.ref.log);
    e.gzRead = false;
    const handle = this.deps.pool.open(e.id, {
      batch: (b) => this.onBatch(e, handle, b),
      failed: (reason) => this.onFailed(e, handle, reason),
    });
    e.fold = handle;
  }

  private onBatch(e: MatchEntry, handle: FoldHandle, batch: FoldBatch): void {
    if (e.fold !== handle || e.timeline === null) return;
    const t = e.timeline;
    const hadMap = t.map !== null;
    const appended = t.apply(batch);
    if (appended !== null) {
      const now = this.deps.now();
      for (const s of appended.steps) {
        for (const item of s.items ?? []) {
          if (item.k === "turn" && item.llm) e.turnSeen.set(`${item.seat}:${item.turn}`, now);
        }
      }
      this.noteKnown(e);
    }
    // Published before the queued subscribers are let in: they catch up to the new tail themselves.
    if (appended !== null) this.hooks.steps(e, appended);
    if (!hadMap && t.map !== null) this.hooks.ready(e);
    // Caught up: every complete line read so far is folded (a crash can leave an incomplete last
    // line that never completes: the match then stays live, and stalls).
    const caughtUp = handle.pending() === 0 && !e.tailMore;
    if (caughtUp && e.loading) {
      e.loading = false;
      this.backfilling.delete(e);
      this.startWaiting();
    }
    this.refresh(e);
    if (caughtUp && t.final) this.finish(e);
    else if (caughtUp && this.deps.cache !== null) {
      const now = this.deps.now();
      if (now - e.lastCacheWrite >= this.deps.config.timing.liveCacheMs && t.lastSeq > 0) {
        e.lastCacheWrite = now;
        this.save(t);
      }
    }
  }

  private onFailed(e: MatchEntry, handle: FoldHandle, reason: string): void {
    if (e.fold !== handle) return;
    e.fold = null;
    e.foldFailures += 1;
    this.deps.warn(`${e.id}: fold failed (${reason}), attempt ${e.foldFailures}`);
    if (e.foldFailures >= MAX_FOLD_FAILURES) {
      if (e.timeline !== null) {
        e.timeline.verified = { ok: false, divergence: "the log could not be folded" };
        e.timeline.status = "unverifiable";
      }
      e.loading = false;
      this.backfilling.delete(e);
      this.startWaiting();
      this.refresh(e);
      return;
    }
    // Refold from the first line: the timeline skips the steps it holds.
    this.openFold(e);
    this.pollEntry(e);
  }

  /** The fold reached the end of a log that cannot grow: cache it and free the worker. */
  private finish(e: MatchEntry): void {
    const t = e.timeline;
    if (t === null) return;
    e.fold?.close();
    e.fold = null;
    e.logTail = null;
    e.logStamp = fileStamp(e.ref.log);
    if (this.deps.cache !== null) {
      this.save(t);
      e.onDisk = true;
      this.touch(e);
    }
  }

  private save(t: Timeline): void {
    const cache = this.deps.cache;
    if (cache === null) return;
    try {
      cache.save(t);
    } catch (err) {
      this.deps.warn(
        `${t.match}: cannot write the timeline cache (${err instanceof Error ? err.name : "error"})`,
      );
    }
  }

  private touch(e: MatchEntry): void {
    for (const id of this.lru.touch(e.id)) {
      const old = this.entries.get(id);
      if (old !== undefined && old.onDisk && old.fold === null) old.timeline = null;
    }
  }

  private noteKnown(e: MatchEntry): void {
    const t = e.timeline;
    if (t === null) return;
    const tail = t.tail();
    e.known = {
      ended: t.status === "ended" || e.known.ended,
      unverifiable: !t.verified.ok,
      lastT: t.lastT,
      leader: tail === null ? null : (standingsOf(tail)[0]?.player ?? null),
    };
  }

  // Polling ---------------------------------------------------------------------------------------

  private poll(): void {
    if (this.stopped) return;
    for (const e of this.entries.values()) this.pollEntry(e);
  }

  /** Reads what a match's files gained; recomputes its status. */
  private pollEntry(e: MatchEntry): void {
    if (this.stopped) return;
    e.pollTick += 1;
    if (e.header === null) {
      // The run directory appeared before its header was flushed.
      this.readHead(e);
      if (e.header === null) return;
    }
    if (e.fold !== null) this.readLog(e);
    const settled = e.fold === null && e.logStamp !== null;
    if (settled && e.pollTick % FINISHED_POLL_EVERY === 0 && this.finishedLogChanged(e)) {
      this.replaced(e);
      return;
    }
    if (!settled || e.pollTick % FINISHED_POLL_EVERY === 0) this.readSide(e, false);
    this.refresh(e);
  }

  private readLog(e: MatchEntry): void {
    const fold = e.fold;
    if (fold === null) return;
    if (e.ref.gz) {
      if (e.gzRead) return;
      e.gzRead = true;
      try {
        fold.send(readGzLines(e.ref.log));
      } catch {
        this.deps.warn(`${e.id}: cannot read ${e.ref.log}`);
      }
      return;
    }
    const tail = e.logTail;
    if (tail === null) return;
    for (let i = 0; i < 64; i += 1) {
      const r = tail.read();
      if (r.replaced) {
        this.replaced(e);
        return;
      }
      e.tailMore = r.more;
      if (r.lines.length > 0) {
        e.lastGrowth = this.deps.now();
        fold.send(r.lines);
      }
      if (!r.more) break;
    }
  }

  /** Whether a finished log's file was replaced (a new header, or other bytes than were folded). */
  private finishedLogChanged(e: MatchEntry): boolean {
    const stamp = fileStamp(e.ref.log);
    if (stamp === null || stamp === e.logStamp) return false;
    const header = parseHeader(
      e.ref.gz ? (readGzLines(e.ref.log)[0] ?? null) : readFirstLine(e.ref.log),
    );
    if (
      header !== null &&
      logIdOf(header) === e.logId &&
      stampSize(stamp) === stampSize(e.logStamp)
    ) {
      e.logStamp = stamp;
      return false;
    }
    return true;
  }

  /** The log file was replaced: drop everything derived from the old one and start over. */
  private replaced(e: MatchEntry): void {
    this.deps.warn(`${e.id}: the log was replaced; its timeline starts over`);
    e.fold?.close();
    e.fold = null;
    this.lru.delete(e.id);
    e.timeline = null;
    e.onDisk = false;
    e.loading = true;
    e.endLine = null;
    e.known = { ended: false, unverifiable: false, lastT: 0, leader: null };
    e.turnSeen.clear();
    e.calls = new LineTail(join(e.ref.dir, CALLS_FILE));
    e.replies = new LineTail(join(e.ref.dir, REPLIES_FILE));
    e.annotations = createAnnotationFold({
      costs: this.deps.config.policy.costs,
      reasoning: this.deps.config.policy.reasoning,
    });
    e.logStamp = null;
    e.logTail = null;
    this.hooks.reset(e);
    this.backfilling.delete(e);
    const i = this.waiting.indexOf(e);
    if (i >= 0) this.waiting.splice(i, 1);
    e.header = null;
    e.logId = null;
    e.timelineId = null;
    this.readHead(e);
    e.lastGrowth = this.deps.now();
    this.refresh(e);
  }
}

/** The size part of a `fileStamp`. */
function stampSize(stamp: string | null): string {
  return stamp?.split(":")[1] ?? "";
}

function safeJson<T>(
  raw: string,
  parse: (v: unknown) => { success: true; data: T } | { success: false },
): T | null {
  try {
    const r = parse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** The public reason of a status, for list items and status messages. */
export type { MatchStatus, PublicReason };
