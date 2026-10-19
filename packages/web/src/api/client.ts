import {
  ApiErrorSchema,
  FeedPageSchema,
  FrameSchema,
  HealthSchema,
  MatchListItemSchema,
  MatchMetaSchema,
  MomentSchema,
  PlayerDossierSchema,
  ReportDetailSchema,
  StepsPageSchema,
  TurnAnnotationSchema,
  type FeedKind,
  type FeedPage,
  type Frame,
  type Health,
  type MatchListItem,
  type MatchMeta,
  type Moment,
  type PlayerDossier,
  type ReportDetail,
  type StepsPage,
  type TurnAnnotation,
} from "@perfidia/protocol/spectator";
import type { PlayerId } from "../lib/ids.ts";

// The REST client (phase-3 design §3.1, docs/phase3.md §6): same-origin `fetch`, every body parsed
// with the protocol's schemas. A body that fails its schema is dropped and reported in the console
// (`SchemaError`), and the caller re-syncs; an error body is the server's `{ok: false, code,
// message, hint}` (`ApiFailure`).

/** The server answered with an error body (or no JSON at all). */
export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string;
  /** Seconds the server asked to wait (`Retry-After`), when it did. */
  readonly retryAfter: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    hint: string,
    retryAfter: number | null,
  ) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.retryAfter = retryAfter;
  }
}

/** A payload that does not match the protocol's schema: dropped, reported, and re-synced. */
export class SchemaError extends Error {
  readonly what: string;

  constructor(what: string, detail: string) {
    super(`${what}: the payload does not match the spectator protocol (${detail})`);
    this.name = "SchemaError";
    this.what = what;
  }
}

interface Parser<T> {
  safeParse(
    v: unknown,
  ):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: { readonly message: string } };
}

/** `schema` applied to `value`; a failure is reported in the console and thrown as `SchemaError`. */
export function parseOrReport<T>(what: string, schema: Parser<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const err = new SchemaError(what, r.error.message.slice(0, 500));
  console.error(err.message);
  throw err;
}

const MatchListSchema = {
  safeParse(v: unknown) {
    if (!Array.isArray(v)) {
      return { success: false as const, error: { message: "expected an array of matches" } };
    }
    const out: MatchListItem[] = [];
    for (const [i, item] of v.entries()) {
      const r = MatchListItemSchema.safeParse(item);
      if (!r.success)
        return { success: false as const, error: { message: `[${i}] ${r.error.message}` } };
      out.push(r.data);
    }
    return { success: true as const, data: out };
  },
};

const MomentsSchema = {
  safeParse(v: unknown) {
    if (!Array.isArray(v)) {
      return { success: false as const, error: { message: "expected an array of moments" } };
    }
    const out: Moment[] = [];
    for (const [i, item] of v.entries()) {
      const r = MomentSchema.safeParse(item);
      if (!r.success)
        return { success: false as const, error: { message: `[${i}] ${r.error.message}` } };
      out.push(r.data);
    }
    return { success: true as const, data: out };
  },
};

export interface FeedQuery {
  readonly after?: number;
  readonly before?: number;
  readonly kinds?: readonly FeedKind[];
  readonly players?: readonly PlayerId[];
  readonly pair?: readonly [PlayerId, PlayerId];
  readonly private?: boolean;
  readonly limit?: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
  /** URL prefix of the API (same origin by default). */
  readonly base?: string;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}

const seg = (s: string | number): string => encodeURIComponent(String(s));

export class Api {
  private readonly base: string;
  private readonly fetchFn: FetchLike;

  constructor(o: ApiOptions = {}) {
    this.base = o.base ?? "";
    this.fetchFn = o.fetch ?? ((input, init) => fetch(input, init));
  }

  private async get<T>(
    path: string,
    what: string,
    schema: Parser<T>,
    signal?: AbortSignal,
    cache?: RequestCache,
  ): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
      ...(cache === undefined ? {} : { cache }),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const retry = res.headers.get("retry-after");
      const retryAfter = retry !== null && /^[0-9]+$/.test(retry) ? Number(retry) : null;
      const e = ApiErrorSchema.safeParse(body);
      if (e.success)
        throw new ApiFailure(res.status, e.data.code, e.data.message, e.data.hint, retryAfter);
      throw new ApiFailure(
        res.status,
        "HTTP",
        `${what}: HTTP ${res.status}`,
        "retry later",
        retryAfter,
      );
    }
    return parseOrReport(what, schema, body);
  }

  health(signal?: AbortSignal): Promise<Health> {
    return this.get("/api/health", "health", HealthSchema, signal);
  }

  matches(signal?: AbortSignal): Promise<MatchListItem[]> {
    return this.get("/api/matches", "match list", MatchListSchema, signal);
  }

  /**
   * The match's meta. It names the timeline every other route is read from, so a copy a cache kept
   * from before the log or the fold changed would mix two matches: by default the browser
   * revalidates it (`no-cache`, a cheap 304 by ETag); a re-sync asks past every cache (`reload`).
   */
  meta(id: string, signal?: AbortSignal, cache: RequestCache = "no-cache"): Promise<MatchMeta> {
    return this.get(`/api/matches/${seg(id)}`, "match meta", MatchMetaSchema, signal, cache);
  }

  latest(id: string, signal?: AbortSignal): Promise<Frame> {
    return this.get(`/api/matches/${seg(id)}/latest`, "latest frame", FrameSchema, signal);
  }

  keyframe(id: string, timeline: string, seq: number, signal?: AbortSignal): Promise<Frame> {
    return this.get(
      `/api/matches/${seg(id)}/t/${seg(timeline)}/keyframes/${seg(seq)}`,
      "keyframe",
      FrameSchema,
      signal,
    );
  }

  /** Steps with `after < seq`, one aligned page (follow `more`). */
  steps(
    id: string,
    timeline: string,
    after: number,
    limit = 2_000,
    signal?: AbortSignal,
  ): Promise<StepsPage> {
    return this.get(
      `/api/matches/${seg(id)}/t/${seg(timeline)}/steps?after=${seg(after)}&limit=${seg(limit)}`,
      "steps page",
      StepsPageSchema,
      signal,
    );
  }

  moments(id: string, timeline: string, signal?: AbortSignal): Promise<Moment[]> {
    return this.get(
      `/api/matches/${seg(id)}/t/${seg(timeline)}/moments`,
      "moments",
      MomentsSchema,
      signal,
    );
  }

  feed(id: string, q: FeedQuery = {}, signal?: AbortSignal): Promise<FeedPage> {
    const p = new URLSearchParams();
    if (q.after !== undefined) p.set("after", String(q.after));
    if (q.before !== undefined) p.set("before", String(q.before));
    if (q.kinds !== undefined && q.kinds.length > 0) p.set("kinds", q.kinds.join(","));
    if (q.players !== undefined && q.players.length > 0) p.set("players", q.players.join(","));
    if (q.pair !== undefined) p.set("pair", `${q.pair[0]},${q.pair[1]}`);
    if (q.private !== undefined) p.set("private", String(q.private));
    if (q.limit !== undefined) p.set("limit", String(q.limit));
    const query = p.toString();
    return this.get(
      `/api/matches/${seg(id)}/feed${query === "" ? "" : `?${query}`}`,
      "feed page",
      FeedPageSchema,
      signal,
    );
  }

  annotation(
    id: string,
    seat: PlayerId,
    turn: number,
    signal?: AbortSignal,
  ): Promise<TurnAnnotation> {
    return this.get(
      `/api/matches/${seg(id)}/annotations/${seg(seat)}/${seg(turn)}`,
      "annotation",
      TurnAnnotationSchema,
      signal,
    );
  }

  dossier(id: string, seat: PlayerId, signal?: AbortSignal): Promise<PlayerDossier> {
    return this.get(
      `/api/matches/${seg(id)}/players/${seg(seat)}`,
      "dossier",
      PlayerDossierSchema,
      signal,
    );
  }

  report(id: string, report: string, signal?: AbortSignal): Promise<ReportDetail> {
    return this.get(
      `/api/matches/${seg(id)}/reports/${seg(report)}`,
      "report",
      ReportDetailSchema,
      signal,
    );
  }
}

/** The app's client (same origin). */
export const api = new Api();
