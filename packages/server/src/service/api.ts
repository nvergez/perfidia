import { ENGINE_VERSION } from "@perfidia/engine";
import type { PlayerId } from "@perfidia/protocol";
import {
  SPECTATOR_FORMAT,
  type ApiError,
  type Health,
  type MatchId,
  type PlayerDossier,
  type TimelineId,
  type TurnAnnotation,
} from "@perfidia/protocol/spectator";
import { TIMELINE_VERSION } from "@perfidia/spectator";
import type { Timeline, FeedQuery } from "../timeline/timeline.ts";
import type { MatchEntry, Registry } from "./matches.ts";

// The spectator service (phase-3 design §3.1): plain typed functions behind the HTTP routes, free of
// any framework, so the Elysia adapter and the raw `Bun.serve` fallback serve exactly the same
// thing. Inputs arrive validated by the route table; each function returns a status, a JSON body
// and a cache policy. Errors are data (`{ok: false, code, message, hint}`), with numbers and the
// next step to take. Only visible matches exist here: an unpublished or hidden match is a 404 like
// an unknown one.

export type CachePolicy =
  | { readonly kind: "no-store" }
  | { readonly kind: "max-age"; readonly seconds: number }
  | { readonly kind: "immutable" };

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  readonly cache: CachePolicy;
  readonly headers?: Readonly<Record<string, string>>;
  /** A key under which the serialised (and compressed) body may be reused. */
  readonly memo?: string;
}

const NO_STORE: CachePolicy = { kind: "no-store" };
const IMMUTABLE: CachePolicy = { kind: "immutable" };
const maxAge = (seconds: number): CachePolicy => ({ kind: "max-age", seconds });

export const SERVER_VERSION = `${ENGINE_VERSION}+timeline.${TIMELINE_VERSION}`;

export function apiError(
  status: number,
  code: string,
  message: string,
  hint: string,
  headers?: Readonly<Record<string, string>>,
): ApiResult {
  const body: ApiError = { ok: false, code, message, hint };
  return { status, body, cache: NO_STORE, ...(headers === undefined ? {} : { headers }) };
}

export const INTERNAL: ApiResult = apiError(
  500,
  "INTERNAL",
  "the server failed to answer this request",
  "retry later; the error was logged without your request's data",
);

const ok = (body: unknown, cache: CachePolicy, memo?: string): ApiResult => ({
  status: 200,
  body,
  cache,
  ...(memo === undefined ? {} : { memo }),
});

export class SpectatorService {
  private readonly registry: Registry;

  constructor(registry: Registry) {
    this.registry = registry;
  }

  health(): ApiResult {
    const body: Health = {
      ok: true,
      version: SERVER_VERSION,
      format: SPECTATOR_FORMAT,
      uptimeS: Math.floor(this.registry.uptimeMs / 1000),
      folding: this.registry.folding(),
    };
    return ok(body, NO_STORE);
  }

  list(): ApiResult {
    return ok(
      this.registry.list().map((e) => this.registry.listItem(e)),
      maxAge(10),
    );
  }

  meta(id: MatchId): ApiResult {
    const r = this.timeline(id);
    if ("status" in r) return r;
    const meta = this.registry.meta(r.entry, r.timeline);
    if (meta === null) return loading(id);
    return ok(meta, r.timeline.final ? maxAge(3600) : maxAge(5));
  }

  keyframe(id: MatchId, timeline: TimelineId, seq: number): ApiResult {
    const r = this.timeline(id, timeline);
    if ("status" in r) return r;
    const frame = r.timeline.keyframe(seq);
    if (frame === null) {
      return apiError(
        404,
        "NO_KEYFRAME",
        `match ${id} has no keyframe at seq ${seq}`,
        `the keyframes are listed in GET /api/matches/${id} (keyframes: ${r.timeline.keyframes.length} so far)`,
      );
    }
    return ok(frame, IMMUTABLE, `kf:${timeline}:${seq}`);
  }

  latest(id: MatchId): ApiResult {
    const r = this.timeline(id);
    if ("status" in r) return r;
    const frame = r.timeline.tail();
    if (frame === null) return loading(id);
    return ok(frame, NO_STORE);
  }

  steps(id: MatchId, timeline: TimelineId, after: number, limit: number): ApiResult {
    const r = this.timeline(id, timeline);
    if ("status" in r) return r;
    const page = r.timeline.page(after, limit);
    const fixed = r.timeline.final || page.more;
    return ok(
      page,
      fixed ? IMMUTABLE : NO_STORE,
      fixed ? `steps:${timeline}:${after}:${limit}` : undefined,
    );
  }

  moments(id: MatchId, timeline: TimelineId): ApiResult {
    const r = this.timeline(id, timeline);
    if ("status" in r) return r;
    const final = r.timeline.final;
    return ok(
      r.timeline.moments,
      final ? IMMUTABLE : maxAge(5),
      final ? `moments:${timeline}` : undefined,
    );
  }

  feed(id: MatchId, q: FeedQuery): ApiResult {
    const r = this.timeline(id);
    if ("status" in r) return r;
    return ok(r.timeline.feedPage(q), r.timeline.final ? maxAge(3600) : NO_STORE);
  }

  annotation(id: MatchId, seat: PlayerId, turn: number): ApiResult {
    const e = this.registry.get(id);
    if (e === null) return notFound(id);
    if (!seatOf(e, seat)) return noSeat(id, seat, e);
    const final = this.registry.annotationFinal(e, seat, turn);
    const a: TurnAnnotation | null = e.annotations.turn(seat, turn, { final });
    if (a === null) {
      return apiError(
        404,
        "NO_ANNOTATION",
        `seat ${seat} of match ${id} has no model call logged for turn ${turn}`,
        "bot seats and turns without a model call have no annotation; turn numbers are in the feed's turn items",
      );
    }
    return ok(a, a.complete ? maxAge(3600) : NO_STORE);
  }

  dossier(id: MatchId, seat: PlayerId): ApiResult {
    const r = this.timeline(id);
    if ("status" in r) return r;
    const info = r.entry.seats().find((s) => s.seat === seat);
    if (info === undefined) return noSeat(id, seat, r.entry);
    const aux = r.timeline.seats.get(seat);
    const spend = r.entry.annotations.spend(seat);
    const handoff = r.timeline.tail()?.seats[seat]?.handoff ?? null;
    const body: PlayerDossier = {
      seat: info,
      notes: aux?.notes ?? "",
      counts: aux?.counts ?? { turns: 0, messagesSent: 0, messagesReceived: 0 },
      spentNanoUsd: spend?.spentNanoUsd ?? null,
      capNanoUsd: spend?.capNanoUsd ?? null,
      handoff,
    };
    return ok(body, maxAge(10));
  }

  report(id: MatchId, report: string): ApiResult {
    const r = this.timeline(id);
    if ("status" in r) return r;
    const detail = r.timeline.reports.get(report);
    if (detail === undefined) {
      return apiError(
        404,
        "NO_REPORT",
        `match ${id} has no report ${report}`,
        "report ids are listed in the feed's battle and spy items",
      );
    }
    return ok(detail, IMMUTABLE, `report:${r.timeline.timeline}:${report}`);
  }

  /** A visible match's timeline (the current one when `timeline` is given), or the error to send. */
  private timeline(
    id: MatchId,
    timeline?: TimelineId,
  ): { entry: MatchEntry; timeline: Timeline } | ApiResult {
    const e = this.registry.get(id);
    if (e === null) return notFound(id);
    const t = this.registry.timelineOf(e);
    if (t === null || t.lastSeq < 0) return loading(id);
    if (timeline !== undefined && t.timeline !== timeline) {
      return apiError(
        404,
        "TIMELINE_GONE",
        `timeline ${timeline} is not the current timeline of match ${id} (now ${t.timeline})`,
        `the log or the fold changed: fetch GET /api/matches/${id} again and use its timeline`,
      );
    }
    return { entry: e, timeline: t };
  }
}

function notFound(id: MatchId): ApiResult {
  return apiError(
    404,
    "NOT_FOUND",
    `no public match ${id}`,
    "GET /api/matches lists the public matches",
  );
}

function loading(id: MatchId): ApiResult {
  return apiError(
    503,
    "LOADING",
    `match ${id} is loading: its log is being folded`,
    "retry in a few seconds",
    { "retry-after": "2" },
  );
}

function seatOf(e: MatchEntry, seat: PlayerId): boolean {
  return e.header?.setup.seats.some((s) => s.id === seat) === true;
}

function noSeat(id: MatchId, seat: PlayerId, e: MatchEntry): ApiResult {
  const seats = e.header?.setup.seats.map((s) => s.id).join(", ") ?? "";
  return apiError(404, "NO_SEAT", `match ${id} has no seat ${seat}`, `its seats are ${seats}`);
}
