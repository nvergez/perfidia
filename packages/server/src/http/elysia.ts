import { openapi } from "@elysia/openapi";
import { Elysia, NotFound } from "elysia";
import { websocket } from "elysia/websocket";
import { HealthSchema } from "@perfidia/protocol/spectator";
import { INTERNAL } from "../service/api.ts";
import type { HttpContext, RunningHttp } from "./context.ts";
import { clientIp, gate, notFoundRoute, upgradeRefusal, upgradeRequired } from "./gate.ts";
import { openApiDocument } from "./openapi.ts";
import { respond, securityHeaders } from "./respond.ts";
import { LIVE_PATH, OPENAPI_JSON_PATH, OPENAPI_PATH, ROUTES } from "./routes.ts";

// The Elysia 2 (beta) adapter (phase-3 design §1.3, §5.4): a thin layer over the framework-free
// route table and live hub. Elysia routes the requests, holds the WebSocket and serves the OpenAPI
// document through `@elysia/openapi` (the document itself comes from the route table, so the raw
// adapter serves the same one). Every request first goes through the same gate as the raw adapter
// (read-only methods, rate limit, WebSocket origin and caps), and every response carries the same
// security headers. The OpenAPI UI page is served in development only.

/** The Elysia app (not listening yet); its type types an Eden client (the health route only). */
export function buildElysiaApp(ctx: HttpContext) {
  const { config, service, hub, limiter, memo, now } = ctx;
  const o = { memo, hsts: config.trustProxy !== null };
  const headers = securityHeaders(o.hsts);
  const app = new Elysia()
    .use(
      websocket({
        maxPayloadLength: config.limits.maxPayloadBytes,
        backpressureLimit: config.limits.backpressureBytes,
        closeOnBackpressureLimit: true,
        idleTimeout: config.limits.idleTimeoutS,
        sendPings: true,
        perMessageDeflate: false,
      }),
    )
    .use(
      openapi({
        path: OPENAPI_PATH,
        specPath: OPENAPI_JSON_PATH,
        documentation: openApiDocument(),
        exclude: { paths: [...ROUTES.map((r) => r.path), LIVE_PATH] },
      }),
    )
    .request(({ request, server, set }) => {
      Object.assign(set.headers, headers);
      const url = new URL(request.url);
      const ip = clientIp(request, server?.requestIP(request)?.address ?? null, config);
      const refused = gate(request, ip, limiter, now());
      if (refused !== null) return respond(request, refused, o);
      if (url.pathname === OPENAPI_PATH && !config.dev) {
        return respond(request, notFoundRoute(url.pathname), o);
      }
      if (url.pathname === LIVE_PATH) {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return respond(request, upgradeRequired(), o);
        }
        const no = upgradeRefusal(request, ip, config, hub);
        if (no !== null) return respond(request, no, o);
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
  for (const r of ROUTES) {
    // Elysia gives no `params` object to a route without path parameters.
    const handler = ({
      request,
      params,
    }: {
      readonly request: Request;
      readonly params?: Readonly<Record<string, string>> | undefined;
    }): Response =>
      respond(request, r.run(service, params ?? {}, new URL(request.url).searchParams), o);
    if (r.operationId !== "health") app.get(r.path, { detail: { hide: true } }, handler);
    app.head(r.path, { detail: { hide: true } }, handler);
  }
  app.ws(LIVE_PATH, {
    detail: { hide: true },
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
  // The one route declared with its response type, for the Eden smoke test.
  return app.get(
    "/api/health",
    { response: { 200: HealthSchema }, detail: { hide: true } },
    ({ request }) => respond(request, service.health(), o),
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
