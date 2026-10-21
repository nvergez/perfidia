import { parseArgs } from "node:util";

// The server's configuration (phase-3 design §2.1, §3.4, §6.4): command-line flags, and the only
// two environment variables the server reads, `PORT` and `PERFIDIA_SERVE_TRUST_PROXY`. This is the
// only module that reads the environment; it never reads an API key (the server has none to read).
//
// Defaults are conservative: the server binds 127.0.0.1 and serves nothing without either a
// `--publish` file or an explicit `--all-runs` (local development: every run directory is listed).
// Binding any other host, or trusting a proxy, requires `--publish` (fail closed) and, for another
// host, the public host names it answers to (`--public-host`): a request for any other `Host` is
// refused, so a DNS-rebinding page cannot read the server, and the WebSocket `Origin`s allowed are
// derived from these names, never from the request.

/** Limits against abusive spectators (§3.4). */
export interface Limits {
  /** HTTP token bucket per client IP: refill per minute and burst. */
  readonly httpPerMinute: number;
  readonly httpBurst: number;
  readonly socketsPerIp: number;
  readonly subscribesPerMinute: number;
  /** Messages a socket may send per window. */
  readonly socketMessages: number;
  readonly socketWindowMs: number;
  readonly maxSockets: number;
  /** Bytes queued on a socket before it is closed (it resumes from its cursor). */
  readonly backpressureBytes: number;
  readonly maxPayloadBytes: number;
  readonly idleTimeoutS: number;
  /** Steps a WebSocket catches up at most; further behind, it gets `resync {behind}` (REST pages). */
  readonly catchUpSteps: number;
  /** Bytes of catch-up messages waiting in all sockets' send buffers; above, new catch-ups resync. */
  readonly catchUpBudgetBytes: number;
  /** A catch-up waiting this long for its socket to drain closes the socket (it resumes later). */
  readonly drainTimeoutMs: number;
}

export const DEFAULT_LIMITS: Limits = Object.freeze({
  httpPerMinute: 300,
  httpBurst: 120,
  socketsPerIp: 32,
  subscribesPerMinute: 60,
  socketMessages: 20,
  socketWindowMs: 10_000,
  maxSockets: 5_000,
  backpressureBytes: 1024 * 1024,
  maxPayloadBytes: 4 * 1024,
  idleTimeoutS: 120,
  catchUpSteps: 2_000,
  catchUpBudgetBytes: 32 * 1024 * 1024,
  drainTimeoutMs: 10_000,
});

/** Wall-clock periods of the server's loops, in milliseconds. */
export interface Timing {
  /** Tail poll of the run directories that may still grow (the fallback of `fs.watch`). */
  readonly pollMs: number;
  /** Rescan of the runs root for new run directories. */
  readonly rescanMs: number;
  /** Check of `publish.json` for changes (besides `fs.watch` and `SIGHUP`). */
  readonly publishMs: number;
  /** `clock` messages of real-time matches. */
  readonly clockMs: number;
  /** A live match's timeline is written to the cache at most this often. */
  readonly liveCacheMs: number;
}

export const DEFAULT_TIMING: Timing = Object.freeze({
  pollMs: 250,
  rescanMs: 10_000,
  publishMs: 2_000,
  clockMs: 5_000,
  liveCacheMs: 60_000,
});

export interface ServeConfig {
  /** The root whose subdirectories are run directories. */
  readonly runs: string;
  /** The server's own timeline cache; `null`: none (folds are redone after a restart). */
  readonly cache: string | null;
  /** The public list; `null`: every discovered run is listed (local development). */
  readonly publish: string | null;
  readonly host: string;
  readonly port: number;
  /**
   * The `Host` names (`name[:port]`, lower case) the server answers to besides, on a loopback bind,
   * `127.0.0.1`, `localhost` and `[::1]` with its port. `/api/health` answers any host.
   */
  readonly hosts: readonly string[];
  /** Development mode: the OpenAPI UI page is served; the web app's directory is re-indexed on changes. */
  readonly dev: boolean;
  /** The built web app (`packages/web/dist`) served outside `/api`; null: the API only. */
  readonly webDist: string | null;
  /** HTTP framework: Elysia (default) or the raw `Bun.serve` fallback (§5.4). */
  readonly adapter: "elysia" | "raw";
  /** Read the client IP from `Fly-Client-IP` (behind Fly's proxy only). */
  readonly trustProxy: "fly" | null;
  /** Browser origins allowed to open the WebSocket besides the server's own. */
  readonly origins: readonly string[];
  /** What the annotations serve (§9 Q2, Q4; the design serves both by default). */
  readonly policy: { readonly costs: boolean; readonly reasoning: boolean };
  /**
   * The model statistics file (`bun run stats -- aggregate --out <file>`) served at `/api/models`;
   * null or absent: none.
   */
  readonly stats?: string | null;
  /** Fold workers (§2.5: at most 2). */
  readonly workers: number;
  readonly limits: Limits;
  readonly timing: Timing;
}

export interface EnvConfig {
  readonly port: number | null;
  readonly trustProxy: "fly" | null;
}

/** The two environment variables the server reads. */
export function readEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EnvConfig {
  const port = env["PORT"];
  const trust = env["PERFIDIA_SERVE_TRUST_PROXY"];
  return {
    port: port !== undefined && /^[0-9]{1,5}$/.test(port) ? Number(port) : null,
    trustProxy: trust === "fly" ? "fly" : null,
  };
}

export const USAGE = [
  "usage: bun run serve -- --runs <dir> [flags]",
  "",
  "Serves the run directories under <dir> to spectators: read-only REST under /api and one",
  "WebSocket at /api/live (docs/phase3.md).",
  "",
  "  --runs <dir>        root of the run directories (required)",
  "  --cache <dir>       the server's timeline cache (recommended: folds survive restarts)",
  "  --publish <file>    publish.json: the public matches (required to bind a non-loopback host",
  "                      or behind a trusted proxy)",
  "  --all-runs          list every run directory instead (local development, loopback only)",
  "  --host <host>       default 127.0.0.1",
  "  --port <n>          default $PORT, else 8080",
  "  --public-host <h>   a Host name[:port] the server answers to (repeatable; required to bind a",
  "                      non-loopback host); its origins may open the WebSocket",
  "  --origin <url>      another browser origin allowed to open the WebSocket (repeatable)",
  "  --no-costs          leave costs, tokens and spend out of the annotations and statistics",
  "  --no-reasoning      leave reasoning summaries and reply text out of the annotations",
  "  --stats <file>      serve the model statistics of bun run stats -- aggregate --out <file>",
  "                      at /api/models (only while every match it aggregates is public)",
  "  --adapter <name>    elysia (default) or raw (the Bun.serve fallback)",
  "  --web-dist <dir>    serve the built web app (bun run web:build) outside /api",
  "  --dev               serve the OpenAPI UI page; re-read --web-dist when it changes",
  "environment: PORT, PERFIDIA_SERVE_TRUST_PROXY=fly; nothing else is read.",
  "",
].join("\n");

export class ConfigError extends Error {}

/** The configuration from command-line flags and the environment; throws `ConfigError`. */
export function parseServeArgs(argv: readonly string[], env: EnvConfig = readEnv()): ServeConfig {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        runs: { type: "string" },
        cache: { type: "string" },
        publish: { type: "string" },
        "all-runs": { type: "boolean" },
        host: { type: "string" },
        "public-host": { type: "string", multiple: true },
        port: { type: "string" },
        origin: { type: "string", multiple: true },
        "no-costs": { type: "boolean" },
        "no-reasoning": { type: "boolean" },
        stats: { type: "string" },
        adapter: { type: "string" },
        "web-dist": { type: "string" },
        dev: { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : String(e));
  }
  if (values.help === true) throw new ConfigError(USAGE);
  if (values.runs === undefined) throw new ConfigError("--runs <dir> is required");
  const host = values.host ?? "127.0.0.1";
  const loopback = isLoopback(host);
  const allRuns = values["all-runs"] === true;
  if (values.publish === undefined && !allRuns) {
    throw new ConfigError(
      "pass --publish <file> listing the public matches, or --all-runs to list every run directory (local development)",
    );
  }
  if (values.publish !== undefined && allRuns) {
    throw new ConfigError("--publish and --all-runs exclude each other");
  }
  if (!loopback && values.publish === undefined) {
    throw new ConfigError(
      `--host ${host} is not a loopback address: pass --publish <file> listing the public matches (--all-runs is for a loopback bind only)`,
    );
  }
  if (env.trustProxy !== null && values.publish === undefined) {
    throw new ConfigError(
      "PERFIDIA_SERVE_TRUST_PROXY is set (a public server behind a proxy): pass --publish <file> listing the public matches",
    );
  }
  const hosts: string[] = [];
  for (const h of values["public-host"] ?? []) {
    if (!HOST_RE.test(h)) {
      throw new ConfigError(
        `--public-host ${h}: expected name[:port], e.g. perfidia.example or 192.0.2.7:8080`,
      );
    }
    hosts.push(h.toLowerCase());
  }
  if (!loopback && hosts.length === 0) {
    throw new ConfigError(
      `--host ${host} is not a loopback address: pass --public-host <name[:port]> for each host name clients use (other Host headers are refused)`,
    );
  }
  const portText = values.port;
  const port =
    portText === undefined
      ? (env.port ?? 8080)
      : /^[0-9]{1,5}$/.test(portText)
        ? Number(portText)
        : -1;
  if (port < 0 || port > 65_535)
    throw new ConfigError(`--port ${portText ?? ""}: expected 0–65535`);
  const adapter = values.adapter ?? "elysia";
  if (adapter !== "elysia" && adapter !== "raw") {
    throw new ConfigError(`--adapter ${adapter}: expected elysia or raw`);
  }
  for (const o of values.origin ?? []) {
    if (!/^https?:\/\/[^/\s]+$/.test(o)) {
      throw new ConfigError(
        `--origin ${o}: expected scheme://host[:port], e.g. http://localhost:5173`,
      );
    }
  }
  return {
    runs: values.runs,
    cache: values.cache ?? null,
    publish: values.publish ?? null,
    host,
    port,
    hosts,
    dev: values.dev === true,
    webDist: values["web-dist"] ?? null,
    adapter,
    trustProxy: env.trustProxy,
    origins: values.origin ?? [],
    policy: { costs: values["no-costs"] !== true, reasoning: values["no-reasoning"] !== true },
    stats: values.stats ?? null,
    workers: 2,
    limits: DEFAULT_LIMITS,
    timing: DEFAULT_TIMING,
  };
}

const HOST_RE =
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(:[0-9]{1,5})?$/i;

/** A loopback bind address. */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
