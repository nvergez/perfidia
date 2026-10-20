import { PlayerIdSchema, ReportIdSchema, type PlayerId } from "@perfidia/protocol";
import {
  FeedKindSchema,
  FeedPageSchema,
  FrameSchema,
  HealthSchema,
  MatchIdSchema,
  MatchListItemSchema,
  MatchMetaSchema,
  MatchStatsSchema,
  ModelDetailSchema,
  ModelIdSchema,
  ModelsResponseSchema,
  MomentSchema,
  PlayerDossierSchema,
  ReportDetailSchema,
  StepsPageSchema,
  TimelineIdSchema,
  TurnAnnotationSchema,
  type FeedKind,
} from "@perfidia/protocol/spectator";
import { z } from "zod";
import { apiError, type ApiResult, type SpectatorService } from "../service/api.ts";
import { STEPS_PAGE } from "../timeline/timeline.ts";

// The REST routes (phase-3 design §3.1): GET (and HEAD) only, each with its path parameters,
// query and response declared as Zod schemas. The table is framework-free: both HTTP adapters
// register it as is, and the OpenAPI document is generated from it. Input is validated here, so a
// bad request gets the same 422 body from either adapter; immutable resources live under
// `/t/:timeline/`, so a replaced log or a new fold version gets new URLs.

/** Steps per page, at most (§3.1); pages are aligned on multiples of it (`Timeline.pageOf`). */
export const MAX_STEPS_LIMIT = STEPS_PAGE;
export const MAX_FEED_LIMIT = 200;
const MAX_KINDS = 20;
const MAX_PLAYERS = 12;

const SeqParam = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const CursorParam = z.coerce.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);

export interface Route {
  readonly operationId: string;
  /** Elysia-style path (`:name` parameters). */
  readonly path: string;
  readonly summary: string;
  /** Path parameters and query (`{}` when none: an unknown query parameter is a 422). */
  readonly params: AnyObject;
  readonly query: AnyObject;
  readonly response: z.ZodType;
  /** Error statuses the route may answer (bodies are `ApiError`). */
  readonly errors: readonly number[];
  run(
    svc: SpectatorService,
    params: Readonly<Record<string, string>>,
    query: URLSearchParams,
  ): ApiResult;
}

type AnyObject = z.ZodObject<Record<string, z.core.$ZodType>, z.core.$ZodObjectConfig>;

const NONE = z.strictObject({});

function bad(message: string, hint: string): ApiResult {
  return apiError(422, "BAD_REQUEST", message, hint);
}

/** The first issue of a failed parse, as a sentence. */
function issueText(where: string, error: z.ZodError): string {
  const i = error.issues[0];
  if (i === undefined) return `invalid ${where}`;
  const at = i.path.length > 0 ? `${where} ${i.path.join(".")}` : where;
  if (i.code === "unrecognized_keys") return `unknown ${where} ${i.keys.join(", ")}`;
  return `${at}: ${i.message}`;
}

function route<P extends AnyObject, Q extends AnyObject>(def: {
  readonly operationId: string;
  readonly path: string;
  readonly summary: string;
  readonly params: P;
  readonly query: Q;
  readonly response: z.ZodType;
  readonly errors: readonly number[];
  readonly hint: string;
  readonly handle: (svc: SpectatorService, params: z.infer<P>, query: z.infer<Q>) => ApiResult;
}): Route {
  return {
    operationId: def.operationId,
    path: def.path,
    summary: def.summary,
    params: def.params,
    query: def.query,
    response: def.response,
    errors: def.errors,
    run(svc, rawParams, rawQuery) {
      const q: Record<string, string> = {};
      for (const [k, v] of rawQuery) {
        if (Object.hasOwn(q, k)) return bad(`query parameter ${k} is repeated`, def.hint);
        q[k] = v;
      }
      const params = def.params.safeParse(rawParams);
      if (!params.success) return bad(issueText("path parameter", params.error), def.hint);
      const query = def.query.safeParse(q);
      if (!query.success) return bad(issueText("query parameter", query.error), def.hint);
      return def.handle(svc, params.data, query.data);
    },
  };
}

const IdParams = z.strictObject({ id: MatchIdSchema });
const TimelineParams = z.strictObject({ id: MatchIdSchema, timeline: TimelineIdSchema });

const FeedQuerySchema = z.strictObject({
  after: CursorParam.optional(),
  before: SeqParam.optional(),
  kinds: z.string().max(400).optional(),
  players: z.string().max(200).optional(),
  pair: z.string().max(40).optional(),
  private: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_FEED_LIMIT).optional(),
});

function list<T>(text: string | undefined, max: number, item: z.ZodType<T>): T[] | string {
  if (text === undefined || text === "") return [];
  const parts = text.split(",");
  if (parts.length > max) return `at most ${max} values`;
  const out: T[] = [];
  for (const p of parts) {
    const r = item.safeParse(p);
    if (!r.success) return `${JSON.stringify(p)} is not valid`;
    out.push(r.data);
  }
  return out;
}

export const ROUTES: readonly Route[] = [
  route({
    operationId: "health",
    path: "/api/health",
    summary: "Server health: version, format, uptime and folds in progress",
    params: NONE,
    query: NONE,
    response: HealthSchema,
    errors: [],
    hint: "GET /api/health takes no parameter",
    handle: (svc) => svc.health(),
  }),
  route({
    operationId: "listMatches",
    path: "/api/matches",
    summary: "The public matches (never starts a fold)",
    params: NONE,
    query: NONE,
    response: z.array(MatchListItemSchema),
    errors: [],
    hint: "GET /api/matches takes no parameter",
    handle: (svc) => svc.list(),
  }),
  route({
    operationId: "matchMeta",
    path: "/api/matches/:id",
    summary: "A match: seats, map, config, status, cursor, timeline and keyframe cursors",
    params: IdParams,
    query: NONE,
    response: MatchMetaSchema,
    errors: [404, 422, 503],
    hint: "GET /api/matches/<id>",
    handle: (svc, p) => svc.meta(p.id),
  }),
  route({
    operationId: "latestFrame",
    path: "/api/matches/:id/latest",
    summary: "The frame at the log's tail (the base of live mode; its seq is the cursor)",
    params: IdParams,
    query: NONE,
    response: FrameSchema,
    errors: [404, 422, 503],
    hint: "GET /api/matches/<id>/latest",
    handle: (svc, p) => svc.latest(p.id),
  }),
  route({
    operationId: "keyframe",
    path: "/api/matches/:id/t/:timeline/keyframes/:seq",
    summary: "A keyframe (only the cursors listed in the match's meta)",
    params: TimelineParams.extend({ seq: SeqParam }),
    query: NONE,
    response: FrameSchema,
    errors: [404, 422, 503],
    hint: "GET /api/matches/<id>/t/<timeline>/keyframes/<seq>, seq from meta.keyframes",
    handle: (svc, p) => svc.keyframe(p.id, p.timeline, p.seq),
  }),
  route({
    operationId: "steps",
    path: "/api/matches/:id/t/:timeline/steps",
    summary:
      "Steps after a cursor: {from, to, steps, lastSeq, more}; pages end at multiples of 2,000 steps (follow `more`)",
    params: TimelineParams,
    query: z.strictObject({
      after: CursorParam.optional(),
      limit: z.coerce.number().int().min(1).max(MAX_STEPS_LIMIT).optional(),
    }),
    response: StepsPageSchema,
    errors: [404, 422, 503],
    hint: `GET /api/matches/<id>/t/<timeline>/steps?after=<seq ≥ -1>&limit=<1–${MAX_STEPS_LIMIT}>`,
    handle: (svc, p, q) => svc.steps(p.id, p.timeline, q.after ?? -1, q.limit ?? MAX_STEPS_LIMIT),
  }),
  route({
    operationId: "moments",
    path: "/api/matches/:id/t/:timeline/moments",
    summary: "Key moments (feed items of importance 2 and 3) with titles and context",
    params: TimelineParams,
    query: NONE,
    response: z.array(MomentSchema),
    errors: [404, 422, 503],
    hint: "GET /api/matches/<id>/t/<timeline>/moments",
    handle: (svc, p) => svc.moments(p.id, p.timeline),
  }),
  route({
    operationId: "feed",
    path: "/api/matches/:id/feed",
    summary: "Feed items, filtered: by kinds, players, a pair of players, private messages",
    params: IdParams,
    query: FeedQuerySchema,
    response: FeedPageSchema,
    errors: [404, 422, 503],
    hint: `GET /api/matches/<id>/feed?after=<seq>|before=<seq>&kinds=message,betrayal&players=p1,p2&pair=p2,p3&private=true&limit=<1–${MAX_FEED_LIMIT}>`,
    handle: (svc, p, q) => {
      const hint = `kinds: up to ${MAX_KINDS} of ${FeedKindSchema.options.join(", ")}; players: up to ${MAX_PLAYERS} seat ids; pair: two seat ids`;
      const kinds = list<FeedKind>(q.kinds, MAX_KINDS, FeedKindSchema);
      if (typeof kinds === "string") return bad(`query parameter kinds: ${kinds}`, hint);
      const players = list<PlayerId>(q.players, MAX_PLAYERS, PlayerIdSchema);
      if (typeof players === "string") return bad(`query parameter players: ${players}`, hint);
      const pair = list<PlayerId>(q.pair, 2, PlayerIdSchema);
      if (typeof pair === "string" || (q.pair !== undefined && pair.length !== 2)) {
        return bad("query parameter pair: expected two seat ids, e.g. pair=p2,p3", hint);
      }
      return svc.feed(p.id, {
        after: q.after,
        before: q.before,
        kinds,
        players,
        pair:
          pair.length === 2 && pair[0] !== undefined && pair[1] !== undefined
            ? [pair[0], pair[1]]
            : undefined,
        private: q.private === "true",
        limit: q.limit ?? 50,
      });
    },
  }),
  route({
    operationId: "annotation",
    path: "/api/matches/:id/annotations/:seat/:turn",
    summary: "A turn's annotation: rounds, reasoning summaries, tool names, costs (side files)",
    params: IdParams.extend({ seat: PlayerIdSchema, turn: SeqParam }),
    query: NONE,
    response: TurnAnnotationSchema,
    errors: [404, 422],
    hint: "GET /api/matches/<id>/annotations/<seat>/<turn>",
    handle: (svc, p) => svc.annotation(p.id, p.seat, p.turn),
  }),
  route({
    operationId: "dossier",
    path: "/api/matches/:id/players/:seat",
    summary: "A seat's dossier: profile, model, notebook, counts, spend, hand-off",
    params: IdParams.extend({ seat: PlayerIdSchema }),
    query: NONE,
    response: PlayerDossierSchema,
    errors: [404, 422, 503],
    hint: "GET /api/matches/<id>/players/<seat>",
    handle: (svc, p) => svc.dossier(p.id, p.seat),
  }),
  route({
    operationId: "matchStats",
    path: "/api/matches/:id/stats",
    summary:
      "A match's statistics, seat by seat: model, play, diplomacy, battles, incidents, cost (perfidia-stats/1)",
    params: IdParams,
    query: NONE,
    response: MatchStatsSchema,
    errors: [404, 422, 503],
    hint: "GET /api/matches/<id>/stats",
    handle: (svc, p) => svc.stats(p.id),
  }),
  route({
    operationId: "models",
    path: "/api/models",
    summary:
      "Per-model statistics across the public matches, the claim state and (once enough matches) the ratings",
    params: NONE,
    query: NONE,
    response: ModelsResponseSchema,
    errors: [404, 503],
    hint: "GET /api/models takes no parameter",
    handle: (svc) => svc.models(),
  }),
  route({
    operationId: "model",
    path: "/api/models/:id",
    summary: "One model's statistics, its rating when shown, and its seats match by match",
    params: z.strictObject({ id: ModelIdSchema }),
    query: NONE,
    response: ModelDetailSchema,
    errors: [404, 422, 503],
    hint: "GET /api/models/<id>, ids from GET /api/models",
    handle: (svc, p) => svc.model(p.id),
  }),
  route({
    operationId: "report",
    path: "/api/matches/:id/reports/:report",
    summary: "A report copy, with the ids of the other recipients' copies of the same battle",
    params: IdParams.extend({ report: ReportIdSchema }),
    query: NONE,
    response: ReportDetailSchema,
    errors: [404, 422, 503],
    hint: "GET /api/matches/<id>/reports/<report id>",
    handle: (svc, p) => svc.report(p.id, p.report),
  }),
];

/** `/api/matches/:id` → `/api/matches/{id}`. */
export function openApiPath(path: string): string {
  return path.replace(/:([a-z]+)/g, "{$1}");
}

export const OPENAPI_PATH = "/api/openapi";
export const OPENAPI_JSON_PATH = "/api/openapi/json";
export const LIVE_PATH = "/api/live";
