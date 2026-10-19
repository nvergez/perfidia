// Helpers for the server tests (no tests here): temporary runs roots and caches, the committed war
// golden, fake arena runs generated once per test process through the orchestrator (a dev
// dependency; `secrets` plants a refusal explanation, an error message and request ids that must
// never reach a spectator), a server started on a free port with fast loops, JSON fetches parsed
// with the protocol's schemas, a WebSocket follower that applies steps with the web's reducer and
// checks its cursor, and the no-secret check.

// oxlint-disable no-await-in-loop -- polls and pages follow each other on purpose
import { expect } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idKeyFromSeed } from "@perfidia/engine/core";
import {
  FakeAdapter,
  ModelError,
  arenaEnv,
  botBrain,
  planArena,
  runArena,
  type Brain,
} from "@perfidia/orchestrator";
import { LogLineSchema, type HeaderLine, type LogLine } from "@perfidia/protocol";
import {
  FrameSchema,
  MatchMetaSchema,
  ServerMsgSchema,
  type Frame,
  type MatchMeta,
  type MatchStatus,
  type ServerMsg,
} from "@perfidia/protocol/spectator";
import { foldLog, type SpectatorFold } from "@perfidia/spectator";
import { applySteps } from "@perfidia/spectator/reduce";
import type { z } from "zod";
import { DEFAULT_LIMITS, type Limits, type ServeConfig } from "./config.ts";
import { startServer, type RunningServer, type StartOptions } from "./server.ts";

export const GOLDEN_DIR = join(import.meta.dir, "..", "..", "sim", "fixtures", "golden");
export const WAR_GOLDEN = join(GOLDEN_DIR, "perfidia-1@1.1.0", "lockstep-6p-6d-war.jsonl.gz");
export const REPO = join(import.meta.dir, "..", "..", "..");

// Every temporary directory of the test process, removed when it exits (test files share this
// module, and the fake runs it generates, so no file's `afterAll` may remove them).
const cleanups: string[] = [];
process.on("exit", () => {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true });
});

/** A new temporary directory, removed when the test process exits. */
export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `perfidia-server-${prefix}-`));
  cleanups.push(d);
  return d;
}

export function rows(text: string): string[] {
  const out = text.split("\n");
  if (out.at(-1) === "") out.pop();
  return out;
}

export function parseLog(text: string): LogLine[] {
  return rows(text).map((r) => LogLineSchema.parse(JSON.parse(r)));
}

export function headerOf(lines: readonly LogLine[]): HeaderLine {
  const h = lines[0];
  if (h?.k !== "header") throw new Error("no header");
  return h;
}

export function warText(): string {
  return new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(readFileSync(WAR_GOLDEN))));
}

let warCache: string | null = null;

/**
 * A timeline cache shared by the test files of this process: the first server to fold the war
 * golden (as `war`) writes it, later ones read it.
 */
export function sharedWarCache(): string {
  warCache ??= tempDir("war-cache");
  return warCache;
}

/** A runs root holding the war golden as `war/match.jsonl.gz`. */
export function warRoot(): string {
  const root = tempDir("war");
  mkdirSync(join(root, "war"));
  copyFileSync(WAR_GOLDEN, join(root, "war", "match.jsonl.gz"));
  return root;
}

// Fake arena runs ---------------------------------------------------------------------------------

export interface FakeRun {
  readonly dir: string;
  readonly text: string;
  readonly lines: LogLine[];
  readonly header: HeaderLine;
}

export interface FakeRunOptions {
  readonly days: number;
  readonly seed: number;
  readonly secrets?: boolean;
}

/** The texts `secrets` plants in `llm_calls.jsonl`. */
export const PLANTED = {
  explanation: "PLANTED-REFUSAL-EXPLANATION",
  error: "PLANTED-ERROR-MESSAGE",
  requestId: "req_PLANTED",
} as const;

function planting(inner: Brain, seat: string): Brain {
  let failed = false;
  return (req, n) => {
    const m = req.meta;
    if (seat === "p1" && m.turn === 2 && m.round === 0) {
      return {
        stop: "refusal",
        refusal: { category: "cyber", explanation: PLANTED.explanation, recommendedModel: null },
      };
    }
    if (seat === "p2" && m.turn === 3 && m.round === 0 && !failed) {
      failed = true;
      return new ModelError("overloaded", PLANTED.error, {
        status: 529,
        requestId: PLANTED.requestId,
        retryAfterMs: 10,
      });
    }
    return inner(req, n);
  };
}

const runs = new Map<string, Promise<FakeRun>>();

/** A fake arena run (perfidia-1@1.1.0, default lineup, `--id-key seed`), once per process and key. */
export function fakeRun(o: FakeRunOptions): Promise<FakeRun> {
  const key = `${o.days}:${o.seed}:${o.secrets === true ? 1 : 0}`;
  let run = runs.get(key);
  if (run === undefined) {
    run = generate(o);
    runs.set(key, run);
  }
  return run;
}

async function generate(o: FakeRunOptions): Promise<FakeRun> {
  const dir = join(tempDir("fake"), "run");
  const plan = planArena(
    { ruleset: "perfidia-1@1.1.0", fake: true, seed: o.seed, idKey: "seed", days: o.days },
    arenaEnv({}),
  );
  await runArena(plan, {
    dir,
    io: { out: () => undefined, err: () => undefined },
    quiet: true,
    ...(o.secrets === true
      ? {
          adapterFor: (s, spec, ctx) =>
            new FakeAdapter(
              spec,
              planting(
                botBrain({ label: s.brain, seat: s.seat, seed: ctx.seed, model: s.model }),
                s.seat,
              ),
            ),
        }
      : {}),
  });
  const text = readFileSync(join(dir, "match.jsonl"), "utf8");
  const lines = parseLog(text);
  return { dir, text, lines, header: headerOf(lines) };
}

/** A whole log folded directly (what every served view must end equal to). */
export function foldWhole(lines: readonly LogLine[], match: string): SpectatorFold {
  return foldLog(lines, { match });
}

// The server ----------------------------------------------------------------------------------------

export const OPEN_LIMITS: Limits = {
  ...DEFAULT_LIMITS,
  httpPerMinute: 1_000_000,
  httpBurst: 1_000_000,
  socketsPerIp: 10_000,
  subscribesPerMinute: 1_000_000,
  socketMessages: 1_000_000,
};

export function testConfig(o: Partial<ServeConfig> & { readonly runs: string }): ServeConfig {
  return {
    cache: null,
    publish: null,
    host: "127.0.0.1",
    port: 0,
    hosts: [],
    dev: false,
    webDist: null,
    adapter: "elysia",
    trustProxy: null,
    origins: [],
    policy: { costs: true, reasoning: true },
    workers: 2,
    limits: OPEN_LIMITS,
    timing: { pollMs: 25, rescanMs: 100, publishMs: 50, clockMs: 200, liveCacheMs: 0 },
    ...o,
  };
}

export interface TestServer extends RunningServer {
  readonly warnings: string[];
}

const servers: RunningServer[] = [];

/** Stops the servers still running; each test file calls it in its own `afterAll`. */
export async function stopServers(): Promise<void> {
  for (const s of servers.splice(0)) await s.stop();
}

export function serve(config: ServeConfig, o: StartOptions = {}): TestServer {
  const warnings: string[] = [];
  const s = startServer(config, { warn: (m) => warnings.push(m), ...o });
  servers.push(s);
  return Object.assign(s, { warnings });
}

export async function stopServer(s: RunningServer): Promise<void> {
  const i = servers.indexOf(s);
  if (i >= 0) servers.splice(i, 1);
  await s.stop();
}

/** Polls `cond` every 20 ms until it holds; throws after `ms`. */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  ms = 20_000,
  what = "condition",
): Promise<void> {
  const end = performance.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** GET a JSON body, check its status, parse it with `schema`. */
export async function getJson<T>(url: string, schema: z.ZodType<T>, status = 200): Promise<T> {
  const res = await fetch(url);
  const text = await res.text();
  if (res.status !== status) throw new Error(`${url}: ${res.status} ${text.slice(0, 300)}`);
  return schema.parse(JSON.parse(text));
}

/** A match's meta once its timeline is available (it may still be loading). */
export async function metaOf(
  s: RunningServer,
  id: string,
  o: { readonly settled?: boolean } = {},
): Promise<MatchMeta> {
  let meta: MatchMeta | null = null;
  await waitFor(
    async () => {
      const res = await fetch(`${s.url}/api/matches/${id}`);
      if (res.status !== 200) return false;
      meta = MatchMetaSchema.parse(await res.json());
      return o.settled !== true || meta.status !== "loading";
    },
    60_000,
    `meta of ${id}`,
  );
  if (meta === null) throw new Error("no meta");
  return meta;
}

// The WebSocket follower ---------------------------------------------------------------------------

export class Follower {
  readonly match: string;
  readonly url: string;
  ws: WebSocket | null = null;
  frame: Frame;
  cursor: number;
  timeline: string;
  readonly messages: ServerMsg[] = [];
  readonly statuses: MatchStatus[] = [];
  /** Every `steps` range applied, in order. */
  readonly ranges: [number, number][] = [];
  /** Steps messages whose `from` was not the cursor (resubscribed). */
  gaps = 0;
  resyncs: string[] = [];
  closes = 0;

  constructor(server: RunningServer, match: string, base: Frame, timeline: string) {
    this.url = `${server.url.replace("http", "ws")}/api/live`;
    this.match = match;
    this.frame = base;
    this.cursor = base.seq;
    this.timeline = timeline;
  }

  /** Follows a match from its keyframe 0 (or its latest frame). */
  static async start(
    server: RunningServer,
    match: string,
    from: "start" | "latest" = "start",
  ): Promise<Follower> {
    const meta = await metaOf(server, match);
    const base =
      from === "start"
        ? await getJson(
            `${server.url}/api/matches/${match}/t/${meta.timeline}/keyframes/0`,
            FrameSchema,
          )
        : await getJson(`${server.url}/api/matches/${match}/latest`, FrameSchema);
    const f = new Follower(server, match, base, meta.timeline);
    await f.connect();
    return f;
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener("close", () => {
      this.closes += 1;
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
    });
    this.subscribe();
  }

  subscribe(): void {
    this.ws?.send(
      JSON.stringify({
        type: "subscribe",
        match: this.match,
        timeline: this.timeline,
        after: this.cursor,
      }),
    );
  }

  /** Closes the socket (the follower keeps its frame and cursor, to resume). */
  async disconnect(): Promise<void> {
    const ws = this.ws;
    if (ws === null) return;
    this.ws = null;
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
      ws.close();
    });
  }

  private onMessage(text: string): void {
    const msg = ServerMsgSchema.parse(JSON.parse(text));
    this.messages.push(msg);
    switch (msg.type) {
      case "steps":
        if (msg.timeline !== this.timeline) throw new Error("steps of another timeline");
        if (msg.from !== this.cursor) {
          this.gaps += 1;
          this.subscribe();
          return;
        }
        if (msg.steps.some((s) => s.seq <= msg.from || s.seq > msg.to)) {
          throw new Error(`a step outside (${msg.from}, ${msg.to}]`);
        }
        this.frame = applySteps(this.frame, msg.steps);
        this.ranges.push([msg.from, msg.to]);
        this.cursor = msg.to;
        return;
      case "status":
        this.statuses.push(msg.status);
        return;
      case "resync":
        this.resyncs.push(msg.reason);
        return;
      case "hello":
      case "clock":
      case "annot":
      case "error":
      case "pong":
        return;
    }
  }

  /** Waits until the follower holds every line up to `lastSeq`. */
  async until(lastSeq: number, ms = 60_000): Promise<void> {
    await waitFor(
      () => this.cursor >= lastSeq,
      ms,
      `${this.match} cursor ${lastSeq} (at ${this.cursor})`,
    );
  }

  /** The applied ranges are contiguous: no line missed, none sent twice. */
  expectContiguous(start: number): void {
    let at = start;
    for (const [from, to] of this.ranges) {
      expect([from, to >= from]).toEqual([at, true]);
      at = to;
    }
  }
}

// Secrets -------------------------------------------------------------------------------------------

export interface Secrets {
  readonly idKey: string;
  readonly seed: number;
  readonly planted?: readonly string[];
}

function keysOf(value: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

/** A served text (JSON or not) holds no secret. */
export function expectNoSecrets(text: string, s: Secrets): void {
  expect(text.includes(s.idKey)).toBe(false);
  expect(text.includes(idKeyFromSeed(s.seed))).toBe(false);
  expect(text.includes("transcripts/")).toBe(false);
  expect(text.includes("prompts/")).toBe(false);
  for (const p of s.planted ?? []) expect([p, text.includes(p)]).toEqual([p, false]);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  for (const k of keysOf(parsed, new Set())) {
    const bad =
      k === "seed" || k === "idKey" || k === "wallMs" || k === "wallEnd" || k === "requestId";
    expect([k, bad]).toEqual([k, false]);
  }
}
