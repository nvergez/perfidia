// oxlint-disable no-await-in-loop -- steps pages and retries follow each other on purpose (one cursor)
import type { Frame, MatchMeta, MatchStatus, Moment, Step } from "@perfidia/protocol/spectator";
import { Api, ApiFailure, SchemaError, api as defaultApi } from "../api/client.ts";
import { LiveConnection, liveUrl, type LiveEvent } from "../api/live.ts";
import type { PlayerId } from "../lib/ids.ts";
import { Playback } from "../playback/playback.ts";
import { skinFor } from "../skins/index.ts";
import { INITIAL_MATCH_STATE, turnKey, useMatchStore, type MatchState } from "./match.ts";

// The match session (phase-3 design §4.4): loads a match and keeps the match store in step with the
// playback engine. Replay of a finished match: the meta, `/latest` (the end, shown at once), the
// moments, then keyframe 0 and every steps page in the background, so any time can be sought.
// Live: the meta, `/latest` as the base, the WebSocket from its cursor, and the same background
// fill from keyframe 0. An animation-frame loop advances the playhead; the store's `playhead` is
// updated at most ~10 times a second between frame changes, while `onTick` listeners (the map's
// moving markers) get every animation frame. Payloads failing the protocol's schemas are dropped,
// reported and re-synced (the match reloads).

/** Statuses of a match whose log may still grow. */
const RUNNING: ReadonlySet<MatchStatus> = new Set(["live", "paused", "stalled", "loading"]);

export function isRunningStatus(s: MatchStatus | null): boolean {
  return s !== null && RUNNING.has(s);
}

const PLAYHEAD_EVERY_MS = 100;
const MOMENTS_REFRESH_MS = 3_000;
const RELOAD_MIN_MS = 1_000;
const RELOAD_MAX_MS = 30_000;

type TickListener = (playhead: number) => void;

export interface OpenOptions {
  /** Open at the start (`?start=1`) instead of the latest frame. */
  readonly start?: boolean;
}

const now = (): number => performance.now();

class Session {
  readonly id: string;
  private readonly api: Api;
  private readonly abort = new AbortController();
  private playback: Playback | null = null;
  private live: LiveConnection | null = null;
  private meta: MatchMeta | null = null;
  private raf: number | null = null;
  private lastPlayheadPush = 0;
  private feedKey = "";
  private momentsTimer: number | null = null;
  private reloadTimer: number | null = null;
  private reloads = 0;
  private closed = false;
  private readonly listeners: Set<TickListener>;
  private readonly options: OpenOptions;

  constructor(id: string, apiClient: Api, listeners: Set<TickListener>, options: OpenOptions) {
    this.id = id;
    this.api = apiClient;
    this.listeners = listeners;
    this.options = options;
  }

  private set(patch: Partial<MatchState>): void {
    if (this.closed) return;
    useMatchStore.setState(patch);
  }

  get pb(): Playback | null {
    return this.playback;
  }

  async open(): Promise<void> {
    this.set({ ...INITIAL_MATCH_STATE, id: this.id, phase: "loading" });
    try {
      await this.load();
    } catch (e) {
      if (this.closed) return;
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    if (e instanceof ApiFailure && e.code === "NOT_FOUND") {
      this.set({
        phase: "error",
        error: {
          code: e.code,
          message: `there is no match called “${this.id}”`,
          hint: "check the link, or pick a match from the list",
        },
      });
    } else if (e instanceof ApiFailure) {
      this.set({ phase: "error", error: { code: e.code, message: e.message, hint: e.hint } });
    } else if (e instanceof SchemaError) {
      this.set({
        phase: "error",
        error: {
          code: "SCHEMA",
          message: e.message,
          hint: "reload the page; the server may be newer",
        },
      });
    } else if (e instanceof DOMException && e.name === "AbortError") {
      return;
    } else {
      this.set({
        phase: "error",
        error: {
          code: "NETWORK",
          message: "the server could not be reached",
          hint: "check that the spectator server is running, then reload",
        },
      });
    }
  }

  /** A request retried while the match's header is still being folded (503 LOADING). */
  private async whileLoading<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof ApiFailure) || e.code !== "LOADING" || attempt > 30) throw e;
        await this.sleep((e.retryAfter ?? 1) * 1000);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const h = window.setTimeout(resolve, ms);
      this.abort.signal.addEventListener("abort", () => {
        window.clearTimeout(h);
        resolve();
      });
    });
  }

  private async load(): Promise<void> {
    const meta = await this.whileLoading(() => this.api.meta(this.id, this.abort.signal));
    if (this.closed) return;
    this.meta = meta;
    const running = isRunningStatus(meta.status);
    const pb = new Playback({ realtime: meta.clock.kind === "realtime", running });
    this.playback = pb;
    const skin = skinFor(meta.ruleset);
    this.set({ meta, skin, status: meta.status, reason: meta.reason });
    const [latest, moments] = await Promise.all([
      this.whileLoading(() => this.api.latest(this.id, this.abort.signal)),
      this.api.moments(this.id, meta.timeline, this.abort.signal).catch((e: unknown) => {
        if (e instanceof SchemaError) throw e;
        return [] as Moment[];
      }),
    ]);
    if (this.closed) return;
    pb.addFrame(latest);
    if (!running) pb.setEnd(latest.t);
    this.set({ moments, phase: "ready" });
    if (running) {
      pb.goLive(now());
      this.startLive(meta, latest.seq);
    }
    if (this.options.start === true) pb.seek(0);
    this.push(true);
    this.startLoop();
    try {
      await this.backfill(meta, latest);
    } catch (e) {
      if (this.closed || (e instanceof DOMException && e.name === "AbortError")) return;
      // The view already shows the base frame: re-sync rather than replace it with an error.
      console.error(
        `loading the match history failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.scheduleReload();
    }
  }

  /** Keyframe 0 and the steps pages up to the base frame (or the end), in the background. */
  private async backfill(meta: MatchMeta, base: Frame): Promise<void> {
    const pb = this.playback;
    if (pb === null || base.seq === 0) {
      this.pushLoaded();
      return;
    }
    const k0 = await this.api.keyframe(this.id, meta.timeline, 0, this.abort.signal);
    if (this.closed) return;
    pb.addFrame(k0);
    this.push(true);
    let after = 0;
    for (;;) {
      const page = await this.api.steps(this.id, meta.timeline, after, 2_000, this.abort.signal);
      if (this.closed) return;
      if (!pb.addSteps(page.from, page.to, page.steps)) {
        console.error(`steps page (${page.from}, ${page.to}] does not join the timeline`);
        this.scheduleReload();
        return;
      }
      this.push(true);
      this.pushLoaded();
      after = page.to;
      if (!page.more || pb.timeline.segmentCount === 1) break;
    }
    this.pushLoaded();
  }

  private pushLoaded(): void {
    const pb = this.playback;
    if (pb === null) return;
    const t = pb.timeline;
    this.set({
      loaded: { fromT: t.startT, toT: t.headT, complete: t.segmentCount === 1 && t.startSeq === 0 },
    });
  }

  // Live -------------------------------------------------------------------------------------------

  private startLive(meta: MatchMeta, cursor: number): void {
    this.live?.stop();
    const live = new LiveConnection({
      url: liveUrl(window.location),
      match: this.id,
      timeline: meta.timeline,
      cursor,
      onEvent: (e) => this.onLive(e),
    });
    this.live = live;
    live.start();
  }

  private onLive(e: LiveEvent): void {
    const pb = this.playback;
    if (pb === null || this.closed) return;
    switch (e.type) {
      case "steps":
        this.onLiveSteps(pb, e.from, e.to, e.steps);
        return;
      case "status":
        this.onStatus(pb, e.status, e.reason);
        return;
      case "clock":
        if (e.speed !== null) pb.setClock({ t: e.t, speed: e.speed, cap: e.cap, at: e.at });
        return;
      case "annot": {
        const key = turnKey(e.msg.seat, e.msg.turn);
        const cur = useMatchStore.getState().liveAnnots;
        this.set({ liveAnnots: { ...cur, [key]: [...(cur[key] ?? []), e.msg] } });
        return;
      }
      case "resync":
        if (e.reason === "behind") void this.catchUp(pb);
        else this.scheduleReload();
        return;
      case "error":
        console.error(`live: ${e.code}: ${e.message}`);
        return;
      case "connection":
        this.set({ connection: e.state });
        return;
    }
  }

  private onLiveSteps(pb: Playback, from: number, to: number, steps: readonly Step[]): void {
    if (!pb.addSteps(from, to, steps)) {
      this.scheduleReload();
      return;
    }
    this.set({ lastLiveAt: now() });
    if (steps.some((s) => (s.items ?? []).some((i) => i.importance >= 2))) this.refreshMoments();
    this.push(true);
    this.pushLoaded();
  }

  private onStatus(pb: Playback, status: MatchStatus, reason: MatchState["reason"]): void {
    this.set({ status, reason });
    if (status === "unpublished") {
      this.live?.stop();
      this.live = null;
      this.set({
        phase: "error",
        error: {
          code: "UNPUBLISHED",
          message: "this match was taken down",
          hint: "it may come back later; go back to the match list",
        },
      });
      return;
    }
    if (!isRunningStatus(status)) {
      pb.setRunning(false);
      this.refreshMoments();
      this.push(true);
    }
  }

  /** `resync {behind}`: the steps pages from the cursor, then subscribe again. */
  private async catchUp(pb: Playback): Promise<void> {
    const meta = this.meta;
    const live = this.live;
    if (meta === null || live === null) return;
    try {
      let after = live.cursor;
      for (;;) {
        const page = await this.api.steps(this.id, meta.timeline, after, 2_000, this.abort.signal);
        if (this.closed) return;
        if (!pb.addSteps(page.from, page.to, page.steps)) break;
        after = page.to;
        if (!page.more) break;
      }
      this.push(true);
      live.resubscribe(after);
    } catch {
      this.scheduleReload();
    }
  }

  private refreshMoments(): void {
    if (this.momentsTimer !== null) return;
    this.momentsTimer = window.setTimeout(() => {
      this.momentsTimer = null;
      const meta = this.meta;
      if (meta === null || this.closed) return;
      this.api
        .moments(this.id, meta.timeline, this.abort.signal)
        .then((moments) => this.set({ moments }))
        .catch(() => undefined);
    }, MOMENTS_REFRESH_MS);
  }

  /** Re-sync: reload the match (meta, base, socket) after a backoff. */
  private scheduleReload(): void {
    if (this.reloadTimer !== null || this.closed) return;
    const ms = Math.min(RELOAD_MAX_MS, RELOAD_MIN_MS * 2 ** this.reloads);
    this.reloads += 1;
    this.live?.stop();
    this.live = null;
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      reopen(this.id, this.options);
    }, ms);
  }

  // The loop -----------------------------------------------------------------------------------------

  private startLoop(): void {
    const frame = (): void => {
      if (this.closed) return;
      this.raf = window.requestAnimationFrame(frame);
      this.tick();
    };
    this.raf = window.requestAnimationFrame(frame);
  }

  private tick(): void {
    const pb = this.playback;
    if (pb === null) return;
    const t = now();
    const changed = pb.tick(t);
    if (pb.playing || pb.mode === "live") for (const l of this.listeners) l(pb.playhead);
    this.push(changed, t);
  }

  /**
   * Writes the playback's view into the store: at once when the frame changed (or `force`), else the
   * playhead at most every 100 ms.
   */
  push(force: boolean, t: number = now()): void {
    const pb = this.playback;
    if (pb === null) return;
    const s = useMatchStore.getState();
    const v = pb.view(t);
    const frameChanged = v.frame !== s.frame;
    const due = t - this.lastPlayheadPush >= PLAYHEAD_EVERY_MS;
    if (
      !force &&
      !frameChanged &&
      v.mode === s.mode &&
      v.playing === s.playing &&
      v.speed === s.speed &&
      v.known === s.known &&
      v.waiting === s.waiting &&
      (!due || v.playhead === s.playhead)
    ) {
      return;
    }
    this.lastPlayheadPush = t;
    const patch: { -readonly [K in keyof MatchState]?: MatchState[K] } = {
      frame: v.frame,
      playhead: v.playhead,
      mode: v.mode,
      playing: v.playing,
      speed: v.speed,
      known: v.known,
      waiting: v.waiting,
    };
    if (v.frame !== null) {
      const key = `${pb.timeline.version}:${pb.timeline.feedCount(v.frame.seq)}`;
      if (key !== this.feedKey) {
        this.feedKey = key;
        patch.feed = pb.feed();
      }
    }
    this.set(patch);
  }

  // Caches ------------------------------------------------------------------------------------------

  loadAnnotation(seat: PlayerId, turn: number, force: boolean): void {
    const key = turnKey(seat, turn);
    const cur = useMatchStore.getState().annotations[key];
    if (
      !force &&
      cur !== undefined &&
      (cur.status === "loading" || (cur.status === "ok" && cur.value.complete))
    ) {
      return;
    }
    this.set({
      annotations: { ...useMatchStore.getState().annotations, [key]: { status: "loading" } },
    });
    this.api
      .annotation(this.id, seat, turn, this.abort.signal)
      .then((value) => {
        this.set({
          annotations: { ...useMatchStore.getState().annotations, [key]: { status: "ok", value } },
        });
      })
      .catch((e: unknown) => {
        const message =
          e instanceof ApiFailure && e.code === "NO_ANNOTATION"
            ? "no model call was logged for this turn"
            : e instanceof Error
              ? e.message
              : "the annotation could not be loaded";
        this.set({
          annotations: {
            ...useMatchStore.getState().annotations,
            [key]: { status: "error", message },
          },
        });
      });
  }

  loadDossier(seat: PlayerId): void {
    const cur = useMatchStore.getState().dossiers[seat];
    if (cur?.status === "loading") return;
    if (cur === undefined) {
      this.set({
        dossiers: { ...useMatchStore.getState().dossiers, [seat]: { status: "loading" } },
      });
    }
    this.api
      .dossier(this.id, seat, this.abort.signal)
      .then((value) => {
        this.set({
          dossiers: { ...useMatchStore.getState().dossiers, [seat]: { status: "ok", value } },
        });
      })
      .catch((e: unknown) => {
        this.set({
          dossiers: {
            ...useMatchStore.getState().dossiers,
            [seat]: { status: "error", message: e instanceof Error ? e.message : "not loaded" },
          },
        });
      });
  }

  loadReport(report: string): void {
    const cur = useMatchStore.getState().reports[report];
    if (cur !== undefined && cur.status !== "error") return;
    this.set({ reports: { ...useMatchStore.getState().reports, [report]: { status: "loading" } } });
    this.api
      .report(this.id, report, this.abort.signal)
      .then((value) => {
        this.set({
          reports: { ...useMatchStore.getState().reports, [report]: { status: "ok", value } },
        });
      })
      .catch((e: unknown) => {
        this.set({
          reports: {
            ...useMatchStore.getState().reports,
            [report]: { status: "error", message: e instanceof Error ? e.message : "not loaded" },
          },
        });
      });
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
    this.live?.stop();
    this.live = null;
    if (this.raf !== null) window.cancelAnimationFrame(this.raf);
    if (this.momentsTimer !== null) window.clearTimeout(this.momentsTimer);
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
  }
}

// The one open session -------------------------------------------------------------------------------

let current: Session | null = null;
const tickListeners = new Set<TickListener>();

function reopen(id: string, options: OpenOptions): void {
  if (current?.id !== id) return;
  const keep = useMatchStore.getState();
  current.close();
  current = new Session(id, defaultApi, tickListeners, options);
  void current.open().then(() => {
    // A reload keeps the viewer's caches.
    useMatchStore.setState({
      annotations: keep.annotations,
      dossiers: keep.dossiers,
      reports: keep.reports,
    });
  });
}

/** Opens match `id` in the store (closing any other). */
export function openMatch(
  id: string,
  options: OpenOptions = {},
  apiClient: Api = defaultApi,
): void {
  if (current?.id === id) return;
  current?.close();
  current = new Session(id, apiClient, tickListeners, options);
  void current.open();
}

/** Closes the open match and empties the store. */
export function closeMatch(): void {
  current?.close();
  current = null;
  useMatchStore.setState(INITIAL_MATCH_STATE);
}

function withPlayback(fn: (pb: Playback) => void): void {
  const s = current;
  const pb = s?.pb ?? null;
  if (s === null || pb === null) return;
  fn(pb);
  s.push(true);
}

/** Playback controls (stable functions, usable outside React). */
export const controls = {
  play: (): void => withPlayback((pb) => pb.play(now())),
  pause: (): void => withPlayback((pb) => pb.pause()),
  toggle: (): void => withPlayback((pb) => pb.toggle(now())),
  /** Moves the playhead to game time `t` (live becomes replay). */
  seek: (t: number): void => withPlayback((pb) => pb.seek(t)),
  /** Moves just after log line `seq` (a feed item's or moment's cursor); falls back to `t`. */
  seekSeq: (seq: number, t?: number): void =>
    withPlayback((pb) => {
      if (!pb.seekSeq(seq) && t !== undefined) pb.seek(t);
    }),
  setSpeed: (gameSecondsPerSecond: number): void =>
    withPlayback((pb) => pb.setSpeed(gameSecondsPerSecond)),
  faster: (): void => withPlayback((pb) => pb.stepSpeed(1)),
  slower: (): void => withPlayback((pb) => pb.stepSpeed(-1)),
  goLive: (): void => withPlayback((pb) => pb.goLive(now())),
  /** The next moment after the frame shown (none: nothing happens). */
  nextMoment(): void {
    const { moments, frame } = useMatchStore.getState();
    const seq = frame?.seq ?? -1;
    const m = moments.find((x) => x.seq > seq);
    if (m !== undefined) controls.seekSeq(m.seq, m.t);
  },
  /** The previous moment before the frame shown. */
  prevMoment(): void {
    const { moments, frame } = useMatchStore.getState();
    const seq = frame?.seq ?? Number.MAX_SAFE_INTEGER;
    const m = moments.findLast((x) => x.seq < seq);
    if (m !== undefined) controls.seekSeq(m.seq, m.t);
  },
};

/** On-demand loads into the store's caches. */
export const loaders = {
  /** A turn's annotation (reasoning, text, costs); refetched while not `complete` when `force`. */
  annotation: (seat: PlayerId, turn: number, force = false): void =>
    current?.loadAnnotation(seat, turn, force),
  dossier: (seat: PlayerId): void => current?.loadDossier(seat),
  report: (report: string): void => current?.loadReport(report),
};

/** Calls `listener` with the playhead on every animation frame while playing or live. */
export function onTick(listener: TickListener): () => void {
  tickListeners.add(listener);
  return () => {
    tickListeners.delete(listener);
  };
}

/** The exact playhead now (between store updates). */
export function playheadNow(): number {
  return current?.pb?.playhead ?? useMatchStore.getState().playhead;
}
