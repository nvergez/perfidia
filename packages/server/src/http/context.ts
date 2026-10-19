import type { ServeConfig } from "../config.ts";
import type { SpectatorService } from "../service/api.ts";
import type { LiveHub } from "../service/live.ts";
import type { RateLimiter } from "./limits.ts";
import type { BodyMemo } from "./respond.ts";
import type { StaticSite } from "./static.ts";

// What an HTTP adapter gets: the service, the live hub and the shared limiter and body memo.

export interface HttpContext {
  readonly config: ServeConfig;
  readonly service: SpectatorService;
  readonly hub: LiveHub;
  readonly limiter: RateLimiter;
  readonly memo: BodyMemo;
  /** The web app's files (`--web-dist`), served outside `/api`; null: none. */
  readonly site: StaticSite | null;
  readonly now: () => number;
  readonly warn: (message: string) => void;
}

export interface RunningHttp {
  readonly port: number;
  stop(): Promise<void>;
}
