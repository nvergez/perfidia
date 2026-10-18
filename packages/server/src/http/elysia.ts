import { openapi } from "@elysia/openapi";
import { Elysia, NotFound } from "elysia";
import { websocket } from "elysia/websocket";
import { HealthSchema } from "@perfidia/protocol/spectator";
import { INTERNAL } from "../service/api.ts";
import type { HttpContext, RunningHttp } from "./context.ts";
import {
  HEALTH_PATH,
  allowedHosts,
  clientIp,
  gate,
  notFoundRoute,
  upgradeRefusal,
  upgradeRequired,
} from "./gate.ts";
import { openApiDocument } from "./openapi.ts";
import { respond, securityHeaders, type RespondOptions } from "./respond.ts";
import { LIVE_PATH, OPENAPI_JSON_PATH, OPENAPI_PATH, ROUTES, type Route } from "./routes.ts";
import { isApiPath, serveStatic } from "./static.ts";

// The Elysia 2 (beta) adapter (phase-3 design §1.3, §5.4): a thin layer over the framework-free
// route table and live hub. Elysia routes the requests (exact paths only: `strictPath`, so
// `/api/live/` is not `/api/live`), holds the WebSocket and, in development, serves the OpenAPI UI
// page through `@elysia/openapi`. The OpenAPI document comes from the route table, so the raw
// adapter serves the same one. Every request first goes through the same gate as the raw adapter
// (read-only methods, canonical paths, the Host, the rate limit), the WebSocket route checks the
// origin and the socket caps itself (whatever path reached it), and every response carries the same
// security headers. With `--web-dist`, paths outside `/api` are the web app's (`static.ts`), served
// from the same hook as the gate, before routing.

/** The Elysia app (not listening yet); its type types an Eden client (the health route only). */
export function buildElysiaApp(ctx: HttpContext) {
  const { config, service, hub, limiter, memo, now } = ctx;
  const o: RespondOptions = { memo, hsts: config.trustProxy !== null };
  const headers = securityHeaders(o.hsts);
  const hostsByPort = new Map<number, ReadonlySet<string>>();
  const hostsFor = (port: number): ReadonlySet<string> => {
    let hosts = hostsByPort.get(port);
    if (hosts === undefined) {
      hosts = allowedHosts(config, port);
      hostsByPort.set(port, hosts);
    }
    return hosts;
  };
  const app = new Elysia({ strictPath: true }).use(
    websocket({
      maxPayloadLength: config.limits.maxPayloadBytes,
      backpressureLimit: config.limits.backpressureBytes,
      closeOnBackpressureLimit: true,
      idleTimeout: config.limits.idleTimeoutS,
      sendPings: true,
      perMessageDeflate: false,
    }),
  );
  if (config.dev) {
    // The UI page loads a third-party script: development only. The plugin serves the JSON too.
    app.use(
      openapi({
        path: OPENAPI_PATH,
        specPath: OPENAPI_JSON_PATH,
        documentation: openApiDocument(),
        exclude: { paths: [...ROUTES.map((r) => r.path), LIVE_PATH] },
      }),
    );
  } else {
    app.get(OPENAPI_JSON_PATH, { detail: { hide: true } }, ({ request }) =>
      respond(
        request,
        {
          status: 200,
          body: openApiDocument(),
          cache: { kind: "max-age", seconds: 3600 },
          memo: "openapi",
        },
        o,
      ),
    );
  }
  app
    .request(({ request, server, set }) => {
      Object.assign(set.headers, headers);
      const url = new URL(request.url);
      const ip = clientIp(request, server?.requestIP(request)?.address ?? null, config);
      const hosts = hostsFor(server?.port ?? config.port);
      const refused = gate(request, url.pathname, ip, hosts, limiter, now());
      if (refused !== null) return respond(request, refused, o);
      if (ctx.site !== null && !isApiPath(url.pathname)) {
        const page = serveStatic(request, url.pathname, ctx.site, o.hsts);
        if (page !== null) return page;
      }
      if (
        url.pathname === LIVE_PATH &&
        request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      ) {
        return respond(request, upgradeRequired(), o);
      }
      return undefined;
    })
    .error(({ error, request }) => {
      if (error instanceof NotFound) {
        return respond(request, notFoundRoute(new URL(request.url).pathname), o);
      }
      ctx.warn(`request failed: ${error instanceof Error ? error.name : "error"}`);
      return respond(request, INTERNAL, o);
    });
  const handlerOf =
    (r: Route) =>
    ({
      request,
      params,
    }: {
      readonly request: Request;
      // Elysia gives no `params` object to a route without path parameters.
      readonly params?: Readonly<Record<string, string>> | undefined;
    }): Response =>
      respond(request, r.run(service, params ?? {}, new URL(request.url).searchParams), o);
  let health: Route | undefined;
  for (const r of ROUTES) {
    if (r.path === HEALTH_PATH) {
      health = r;
      continue;
    }
    app.get(r.path, { detail: { hide: true } }, handlerOf(r));
    app.head(r.path, { detail: { hide: true } }, handlerOf(r));
  }
  if (health === undefined) throw new Error("the route table has no health route");
  const healthRoute = health;
  app.head(HEALTH_PATH, { detail: { hide: true } }, handlerOf(healthRoute));
  app.ws(LIVE_PATH, {
    detail: { hide: true },
    // The origin and the socket caps are checked on the route itself, whatever path reached it.
    beforeHandle({ request, server }) {
      const ip = clientIp(request, server?.requestIP(request)?.address ?? null, config);
      const no = upgradeRefusal(request, ip, config, hostsFor(server?.port ?? config.port), hub);
      return no === null ? undefined : respond(request, no, o);
    },
    // A connection is keyed by Elysia's id for it (stable across its events).
    open(ws) {
      hub.open(ws.id, {
        ip: clientIp(ws.request, ws.remoteAddress, config),
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
        subscribe: (topic) => ws.subscribe(topic),
        unsubscribe: (topic) => ws.unsubscribe(topic),
      });
    },
    message(ws, message) {
      hub.message(ws.id, typeof message === "string" ? message : JSON.stringify(message));
    },
    drain(ws) {
      hub.drain(ws.id);
    },
    close(ws) {
      hub.close(ws.id);
    },
  });
  // The health route declared with its response type, for the Eden smoke test; it runs the route
  // table's handler, so its input is validated like every other route's.
  return app.get(
    HEALTH_PATH,
    { response: { 200: HealthSchema }, detail: { hide: true } },
    ({ request }) => handlerOf(healthRoute)({ request }),
  );
}

export type SpectatorApp = ReturnType<typeof buildElysiaApp>;

export function serveElysia(ctx: HttpContext): RunningHttp {
  const { config, hub } = ctx;
  const app = buildElysiaApp(ctx);
  app.listen({ hostname: config.host, port: config.port });
  const server = app.server;
  if (server === null || server === undefined) throw new Error("the HTTP server did not start");
  hub.setPublisher((topic, text) => {
    server.publish(topic, text);
  });
  return {
    port: server.port ?? config.port,
    stop: async () => {
      await app.stop(true);
    },
  };
}
