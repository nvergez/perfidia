// @perfidia/server: the read-only spectator server (phase-3 design §2–§3): run directories found
// under a root, folded once in worker threads (and cached), served as REST and one WebSocket.

export {
  ConfigError,
  DEFAULT_LIMITS,
  DEFAULT_TIMING,
  parseServeArgs,
  readEnv,
  type Limits,
  type ServeConfig,
  type Timing,
} from "./config.ts";
export { startServer, type RunningServer, type StartOptions } from "./server.ts";
export { SERVER_VERSION } from "./service/api.ts";
export { CATCH_UP_STEPS } from "./service/live.ts";
export { PUBLISH_FORMAT, PublishFileSchema, type PublishFile } from "./store/publish.ts";
export { MAX_FEED_LIMIT, MAX_STEPS_LIMIT, ROUTES, openApiPath } from "./http/routes.ts";
export { openApiDocument } from "./http/openapi.ts";
export type { SpectatorApp } from "./http/elysia.ts";
