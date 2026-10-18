import type { Server, ServerWebSocket } from "bun";
import { INTERNAL } from "../service/api.ts";
import { clientIp, gate, notFoundRoute, upgradeRefusal, upgradeRequired } from "./gate.ts";
import type { HttpContext, RunningHttp } from "./context.ts";
import { openApiDocument } from "./openapi.ts";
import { respond } from "./respond.ts";
import { LIVE_PATH, OPENAPI_JSON_PATH, ROUTES, type Route } from "./routes.ts";

// The raw `Bun.serve` adapter (phase-3 design §5.4): the fallback if Elysia's betas break the thin
// HTTP layer. It serves the same route table, the same OpenAPI document and the same WebSocket hub
// as the Elysia adapter, and the contract tests run against both.

interface Compiled {
  readonly route: Route;
  readonly re: RegExp;
  readonly names: readonly string[];
}

function compile(r: Route): Compiled {
  const names: string[] = [];
  const pattern = r.path.replace(/:([a-z]+)/g, (_m, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { route: r, re: new RegExp(`^${pattern}$`), names };
}

const COMPILED = ROUTES.map(compile);

/** The route of a path and its decoded parameters; null when none matches. */
function match(path: string): { route: Route; params: Record<string, string> } | null {
  for (const c of COMPILED) {
    const m = c.re.exec(path);
    if (m === null) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < c.names.length; i += 1) {
      const name = c.names[i];
      const raw = m[i + 1];
      if (name === undefined || raw === undefined) return null;
      try {
        params[name] = decodeURIComponent(raw);
      } catch {
        return null;
      }
    }
    return { route: c.route, params };
  }
  return null;
}

interface SocketData {
  readonly ip: string;
}

export function serveRaw(ctx: HttpContext): RunningHttp {
  const { config, service, hub, limiter, memo, now } = ctx;
  const o = { memo, hsts: config.trustProxy !== null };
  const server: Server<SocketData> = Bun.serve<SocketData>({
    hostname: config.host,
    port: config.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      const ip = clientIp(req, srv.requestIP(req)?.address ?? null, config);
      const refused = gate(req, ip, limiter, now());
      if (refused !== null) return respond(req, refused, o);
      if (url.pathname === LIVE_PATH) {
        const no = upgradeRefusal(req, ip, config, hub);
        if (no !== null) return respond(req, no, o);
        if (srv.upgrade(req, { data: { ip } })) return undefined;
        return respond(req, upgradeRequired(), o);
      }
      if (url.pathname === OPENAPI_JSON_PATH) {
        return respond(
          req,
          {
            status: 200,
            body: openApiDocument(),
            cache: { kind: "max-age", seconds: 3600 },
            memo: "openapi",
          },
          o,
        );
      }
      const m = match(url.pathname);
      if (m === null) return respond(req, notFoundRoute(url.pathname), o);
      return respond(req, m.route.run(service, m.params, url.searchParams), o);
    },
    error(error) {
      ctx.warn(`request failed: ${error.name}`);
      return respond(new Request("http://localhost/"), INTERNAL, o);
    },
    websocket: {
      maxPayloadLength: config.limits.maxPayloadBytes,
      backpressureLimit: config.limits.backpressureBytes,
      closeOnBackpressureLimit: true,
      idleTimeout: config.limits.idleTimeoutS,
      sendPings: true,
      perMessageDeflate: false,
      open(ws: ServerWebSocket<SocketData>) {
        hub.open(ws, {
          ip: ws.data.ip,
          send: (text) => ws.send(text),
          close: (code, reason) => ws.close(code, reason),
          subscribe: (topic) => ws.subscribe(topic),
          unsubscribe: (topic) => ws.unsubscribe(topic),
        });
      },
      message(ws, message) {
        hub.message(ws, typeof message === "string" ? message : new TextDecoder().decode(message));
      },
      drain(ws) {
        hub.drain(ws);
      },
      close(ws) {
        hub.close(ws);
      },
    },
  });
  hub.setPublisher((topic, text) => {
    server.publish(topic, text);
  });
  return {
    port: server.port ?? config.port,
    stop: async () => {
      await server.stop(true);
    },
  };
}
