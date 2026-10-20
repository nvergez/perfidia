import {
  ApiErrorSchema,
  ClientMsgSchema,
  FeedPageSchema,
  FrameSchema,
  HealthSchema,
  MatchListItemSchema,
  MatchMetaSchema,
  MatchStatsSchema,
  ModelDetailSchema,
  ModelsResponseSchema,
  MomentSchema,
  PlayerDossierSchema,
  ReportDetailSchema,
  ServerMsgSchema,
  StepsPageSchema,
  TurnAnnotationSchema,
} from "@perfidia/protocol/spectator";
import { z } from "zod";
import { SERVER_VERSION } from "../service/api.ts";
import { LIVE_PATH, ROUTES, openApiPath, type Route } from "./routes.ts";

// The OpenAPI 3.1 document (phase-3 design §3.1, §3.3), generated from the route table's Zod
// schemas with `z.toJSONSchema`: the same document whichever adapter serves it. Named schemas go to
// `components.schemas` and are referenced; the WebSocket's messages are documented there too.

type Json = Record<string, unknown>;

const NAMED = new Map<z.core.$ZodType, string>([
  [HealthSchema, "Health"],
  [MatchListItemSchema, "MatchListItem"],
  [MatchMetaSchema, "MatchMeta"],
  [FrameSchema, "Frame"],
  [StepsPageSchema, "StepsPage"],
  [MomentSchema, "Moment"],
  [FeedPageSchema, "FeedPage"],
  [TurnAnnotationSchema, "TurnAnnotation"],
  [PlayerDossierSchema, "PlayerDossier"],
  [ReportDetailSchema, "ReportDetail"],
  [MatchStatsSchema, "MatchStats"],
  [ModelsResponseSchema, "Models"],
  [ModelDetailSchema, "ModelDetail"],
  [ApiErrorSchema, "ApiError"],
  [ClientMsgSchema, "ClientMsg"],
  [ServerMsgSchema, "ServerMsg"],
]);

function jsonSchema(schema: z.core.$ZodType): Json {
  const out: Json = { ...z.toJSONSchema(schema, { io: "input" }) };
  delete out["$schema"];
  return out;
}

function ref(schema: z.ZodType): Json {
  const name = NAMED.get(schema);
  if (name !== undefined) return { $ref: `#/components/schemas/${name}` };
  if (schema instanceof z.ZodArray) {
    const item = NAMED.get(schema.element);
    if (item !== undefined)
      return { type: "array", items: { $ref: `#/components/schemas/${item}` } };
  }
  return jsonSchema(schema);
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  404: "Not found: an unknown or unpublished match, a timeline that is no longer current, or no statistics",
  422: "Invalid path or query parameter",
  503: "The match (or a match the statistics aggregate) is loading: its log is being folded",
};

function parameters(r: Route): Json[] {
  const out: Json[] = [];
  for (const [where, obj] of [
    ["path", r.params],
    ["query", r.query],
  ] as const) {
    for (const [name, schema] of Object.entries(obj.shape)) {
      const required = where === "path" || !z.safeParse(schema, undefined).success;
      out.push({ name, in: where, required, schema: jsonSchema(schema) });
    }
  }
  return out;
}

function operation(r: Route): Json {
  const responses: Json = {
    "200": { description: "OK", content: { "application/json": { schema: ref(r.response) } } },
  };
  for (const status of [...r.errors, 429]) {
    responses[String(status)] = {
      description: STATUS_TEXT[status] ?? "Too many requests (see Retry-After)",
      content: { "application/json": { schema: ref(ApiErrorSchema) } },
    };
  }
  return { operationId: r.operationId, summary: r.summary, parameters: parameters(r), responses };
}

let cached: Json | null = null;

export function openApiDocument(): Json {
  if (cached !== null) return cached;
  const paths: Json = {};
  for (const r of ROUTES) paths[openApiPath(r.path)] = { get: operation(r) };
  paths[LIVE_PATH] = {
    get: {
      operationId: "live",
      summary:
        "WebSocket (one match per socket): send ClientMsg, receive ServerMsg (see components.schemas)",
      responses: {
        "101": { description: "Switching protocols" },
        "403": { description: "Foreign Origin" },
        "429": { description: "Too many sockets from this address" },
      },
    },
  };
  const schemas: Json = {};
  for (const [schema, name] of NAMED) schemas[name] = jsonSchema(schema);
  cached = {
    openapi: "3.1.0",
    info: {
      title: "Perfidia spectator API",
      version: SERVER_VERSION,
      description:
        "Read-only. Spectators see everything the agents hide from each other; never seeds, id keys, prompts or API keys.",
    },
    paths,
    components: { schemas },
  };
  return cached;
}
