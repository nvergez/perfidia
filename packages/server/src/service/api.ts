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
import type { FeedQuery, Timeline, TimelineSummary } from "../timeline/timeline.ts";
import type { MatchEntry, Registry } from "./matches.ts";

// The spectator service (phase-3 design §3.1): plain typed functions behind the HTTP routes, free of
// any framework, so the Elysia adapter and the raw `Bun.serve` fallback serve exactly the same
// thing. Inputs arrive validated by the route table; each function returns a status, a JSON body
// and a cache policy. Errors are data (`{ok: false, code, message, hint}`), with numbers and the
// next step to take. Only visible matches exist here: an unpublished or hidden match is a 404 like
// an unknown one.
//
// A finished timeline evicted from memory costs a cache read to bring back, so routes avoid it:
// immutable bodies (keyframes, aligned step pages, a finished match's moments, reports) are keyed
// by match, timeline and parameters, and a key the HTTP layer still holds is answered from there
// before the timeline is looked up; meta, `/latest` and dossiers read the timeline's summary, which
// stays in memory. Only the feed and bodies not held bring a timeline back.

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

/** Which serialised bodies the HTTP layer holds (`BodyMemo`). */
export interface MemoProbe {
  has(key: string): boolean;
}

export class SpectatorService {
  private readonly registry: Registry;
  private readonly memo: MemoProbe;

  constructor(registry: Registry, memo: MemoProbe = { has: () => false }) {
    this.registry = registry;
    this.memo = memo;
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
    const r = this.summary(id);
    if ("status" in r) return r;
    const meta = this.registry.meta(r.entry, r.summary);
    if (meta === null) return loading(id);
    return ok(meta, r.summary.final ? maxAge(3600) : maxAge(5));
  }

  keyframe(id: MatchId, timeline: TimelineId, seq: number): ApiResult {
    const key = `${id}:${timeline}:kf:${seq}`;
    const held = this.held(id, timeline, key);
    if (held !== null) return held;
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
    return ok(frame, IMMUTABLE, key);
  }

  latest(id: MatchId): ApiResult {
    const r = this.summary(id);
    if ("status" in r) return r;
    const frame = r.summary.tail();
    if (frame === null) return loading(id);
    return ok(frame, NO_STORE);
  }

  steps(id: MatchId, timeline: TimelineId, after: number, limit: number): ApiResult {
    const key = `${id}:${timeline}:steps:${after}:${limit}`;
    const held = this.held(id, timeline, key);
    if (held !== null) return held;
    const r = this.timeline(id, timeline);
    if ("status" in r) return r;
    const { page, canonical } = r.timeline.pageOf(after, limit);
    const fixed = r.timeline.final || page.more;
    return ok(page, fixed ? IMMUTABLE : NO_STORE, fixed && canonical ? key : undefined);
  }

  moments(id: MatchId, timeline: TimelineId): ApiResult {
    const key = `${id}:${timeline}:moments`;
    const held = this.held(id, timeline, key);
    if (held !== null) return held;
    const r = this.timeline(id, timeline);
    if ("status" in r) return r;
    const final = r.timeline.final;
    return ok(r.timeline.moments, final ? IMMUTABLE : maxAge(5), final ? key : undefined);
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
    const a: TurnAnnotation | null = this.registry.annotationsOf(e).turn(seat, turn, { final });
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
    const r = this.summary(id);
    if ("status" in r) return r;
    const info = r.entry.seats().find((s) => s.seat === seat);
    if (info === undefined) return noSeat(id, seat, r.entry);
    const aux = r.summary.seats.get(seat);
    const spend = this.registry.annotationsOf(r.entry).spend(seat);
    const handoff = r.summary.tail()?.seats[seat]?.handoff ?? null;
    const body: PlayerDossier = {
      seat: info,
      notes: aux?.notes ?? "",
      counts: aux?.counts ?? { turns: 0, messagesSent: 0, messagesReceived: 0 },
      spentNanoUsd: spend?.spentNanoUsd ?? null,
      capNanoUsd: spend?.capNanoUsd ?? null,
      handoff,
      hourly: [...(aux?.hourly ?? [])],
      notebook: aux?.notebook ?? { total: 0, versions: [] },
    };
    return ok(body, maxAge(10));
  }

  report(id: MatchId, report: string): ApiResult {
    const current = this.registry.get(id)?.timelineId ?? null;
    const key = current === null ? null : `${id}:${current}:report:${report}`;
    const held = current === null || key === null ? null : this.held(id, current, key);
    if (held !== null) return held;
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
    return ok(detail, IMMUTABLE, `${id}:${r.timeline.timeline}:report:${report}`);
  }

  /** The body under `key`, when the HTTP layer holds it for the match's current timeline. */
  private held(id: MatchId, timeline: TimelineId, key: string): ApiResult | null {
    const e = this.registry.get(id);
    if (e === null || e.timelineId !== timeline || !this.memo.has(key)) return null;
    return ok(null, IMMUTABLE, key);
  }

  /** A visible match's timeline summary (never read back from the cache), or the error to send. */
  private summary(id: MatchId): { entry: MatchEntry; summary: TimelineSummary } | ApiResult {
    const e = this.registry.get(id);
    if (e === null) return notFound(id);
    const t = this.registry.summaryOf(e);
    if (t === null || t.lastSeq < 0) return loading(id);
    return { entry: e, summary: t };
  }

  /** A visible match's timeline (the current one when `timeline` is given), or the error to send. */
  private timeline(
    id: MatchId,
    timeline?: TimelineId,
  ): { entry: MatchEntry; timeline: Timeline } | ApiResult {
    const e = this.registry.get(id);
    if (e === null) return notFound(id);
    if (timeline !== undefined && e.timelineId !== null && e.timelineId !== timeline) {
      return timelineGone(id, timeline, e.timelineId);
    }
    const t = this.registry.timelineOf(e);
    if (t === null || t.lastSeq < 0) return loading(id);
    if (timeline !== undefined && t.timeline !== timeline) {
      return timelineGone(id, timeline, t.timeline);
    }
    return { entry: e, timeline: t };
  }
}

function timelineGone(id: MatchId, timeline: TimelineId, now: TimelineId): ApiResult {
  return apiError(
    404,
    "TIMELINE_GONE",
    `timeline ${timeline} is not the current timeline of match ${id} (now ${now})`,
    `the log or the fold changed: fetch GET /api/matches/${id} again and use its timeline`,
  );
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
