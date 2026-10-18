import type { ServeConfig } from "./config.ts";
import { FoldPool } from "./fold/pool.ts";
import type { RunningHttp } from "./http/context.ts";
import { serveElysia } from "./http/elysia.ts";
import { RateLimiter } from "./http/limits.ts";
import { serveRaw } from "./http/raw.ts";
import { BodyMemo } from "./http/respond.ts";
import { StaticSite } from "./http/static.ts";
import { SpectatorService } from "./service/api.ts";
import { LiveHub } from "./service/live.ts";
import { Registry } from "./service/matches.ts";
import { PublishList } from "./store/publish.ts";
import { TimelineCache } from "./timeline/cache.ts";

// The spectator server (phase-3 design §2): the registry of run directories, the fold workers, the
// framework-free service and live hub, and one HTTP adapter (Elysia, or the raw `Bun.serve`
// fallback). Read-only: it never writes a run directory, only its own cache.

export interface RunningServer {
  readonly port: number;
  readonly url: string;
  readonly registry: Registry;
  readonly hub: LiveHub;
  /** Re-reads `publish.json` now (what `SIGHUP` does). */
  reloadPublish(): void;
  /** Rescans the runs root now. */
  rescan(): void;
  stop(): Promise<void>;
}

export interface StartOptions {
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

export function startServer(config: ServeConfig, o: StartOptions = {}): RunningServer {
  const now = o.now ?? Date.now;
  const warn = o.warn ?? ((m: string) => console.error(JSON.stringify({ level: "warn", msg: m })));
  const pool = new FoldPool(config.workers);
  const cache = config.cache === null ? null : new TimelineCache(config.cache);
  const publish = new PublishList(config.publish);
  let hub: LiveHub | null = null;
  const live = (): LiveHub => {
    if (hub === null) throw new Error("the live hub is not ready");
    return hub;
  };
  const registry = new Registry(
    { config, pool, cache, publish, now, warn },
    {
      steps: (e, a) => live().steps(e, a),
      status: (e) => live().status(e),
      reset: (e) => live().reset(e),
      reply: (e, line) => live().reply(e, line),
      ready: (e) => live().ready(e),
      hidden: (id) => live().hidden(id),
    },
  );
  hub = new LiveHub(registry, config.limits, now);
  const memo = new BodyMemo();
  const service = new SpectatorService(registry, memo);
  let site: StaticSite | null = null;
  let http: RunningHttp;
  try {
    site =
      config.webDist === null ? null : new StaticSite(config.webDist, { watch: config.dev, warn });
    const ctx = {
      config,
      service,
      hub,
      limiter: new RateLimiter(config.limits),
      memo,
      site,
      now,
      warn,
    };
    registry.start();
    http = config.adapter === "raw" ? serveRaw(ctx) : serveElysia(ctx);
  } catch (e) {
    site?.stop();
    registry.stop();
    void pool.stop();
    throw e;
  }
  const staticSite = site;
  const clock = setInterval(() => hub?.tickClock(), config.timing.clockMs);
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  return {
    port: http.port,
    url: `http://${host}:${http.port}`,
    registry,
    hub,
    reloadPublish: () => registry.reloadPublish(),
    rescan: () => registry.rescan(),
    stop: async () => {
      clearInterval(clock);
      staticSite?.stop();
      registry.stop();
      await http.stop();
      await pool.stop();
    },
  };
}
