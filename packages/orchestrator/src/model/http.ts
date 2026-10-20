import type { TimeSource } from "@perfidia/protocol";
import { ModelError, type ModelErrorKind, type UsageEntry } from "./adapter.ts";
import { timeoutSignal } from "./clock.ts";

// The shared transport of every provider (phase-4 design §2.2, Pass 1b): the only module of the
// orchestrator that calls `fetch`. The Anthropic SDK's client goes through `guardedFetch` too; the
// OpenAI, Gemini and OpenAI-compatible adapters (Pass 2) build on all of it.
//
// - `guardedFetch` sends only to the configured origin, over `https:` (plain `http:` on loopback
//   only), with headers built from an allowlist plus the provider's auth header, and never follows a
//   redirect (`redirect: "error"`): under Bun 1.4.3 a cross-origin 307 forwards `x-api-key` and
//   `x-goog-api-key` to its target. A key never goes in a URL.
// - `readSse` reads a server-sent-event body (`\r\n`, comments, multi-line `data:`); a body that ends
//   without the provider's terminal event is a retryable `connection` error.
// - `classifyHttpError` reads the provider's error code before the HTTP status (an OpenAI spend
//   limit is a 429, a Gemini empty balance a 402, an OpenRouter in-flight budget a 402 to retry).
// - Errors are one line with no body and no header: a key never reaches a log.

export type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Hosts a plain `http:` origin may name: the key never crosses the network in cleartext. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface GuardOptions {
  /** The configured base URL; only its origin is allowed. */
  readonly baseURL: string;
  /** The provider's auth header and its value (`x-api-key`, `authorization: Bearer …`, …). */
  readonly auth: { readonly header: string; readonly value: string } | null;
  /** Header names let through from the caller (lower case). */
  readonly allowHeaders: RegExp;
  /** Headers always set (a pinned API version, OpenRouter's metadata opt-in). */
  readonly fixedHeaders?: Readonly<Record<string, string>>;
  /** The inner fetch (tests: a stub); default the global `fetch`. */
  readonly fetch?: HttpFetch;
}

/** The origin of a base URL, refused unless `https:` or `http:` on loopback. */
export function checkedOrigin(baseURL: string): string {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error(`not a URL: ${JSON.stringify(baseURL)}`);
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    throw new Error(
      `${url.protocol}//${url.host} is not https: a key would cross the network in cleartext (http:// is for localhost, 127.0.0.1 or [::1])`,
    );
  }
  return url.origin;
}

/**
 * A `fetch` that only reaches `o.baseURL`'s origin, with allowlisted headers and the provider's
 * auth, and never follows a redirect. A request elsewhere, or one whose URL carries the key, is
 * refused before anything is sent.
 */
export function guardedFetch(o: GuardOptions): HttpFetch {
  const origin = checkedOrigin(o.baseURL);
  const inner: HttpFetch = o.fetch ?? ((input, init) => fetch(input, init));
  // The key itself: a Bearer header's value without its scheme (a URL holding the bare key is
  // refused too, Pass 2 integration).
  const secret = (o.auth?.value ?? "").replace(/^Bearer /, "");
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin) {
      return Promise.reject(
        new Error(`refusing a request to ${url.origin}: the client is configured for ${origin}`),
      );
    }
    if (
      secret !== "" &&
      (url.href.includes(secret) || url.href.includes(encodeURIComponent(secret)))
    ) {
      return Promise.reject(new Error("refusing a request whose URL carries the key"));
    }
    const headers = new Headers();
    const given = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => given.set(name, value));
    given.forEach((value, name) => {
      if (o.allowHeaders.test(name)) headers.set(name, value);
    });
    for (const [name, value] of Object.entries(o.fixedHeaders ?? {})) headers.set(name, value);
    if (o.auth !== null) headers.set(o.auth.header, o.auth.value);
    // Never follow a redirect: the key would go to wherever it points (phase-4 design §2.2).
    return inner(url.toString(), { ...init, headers, redirect: "error" });
  };
}

/** A body read to its end as text; one that breaks keeps what came. */
async function readAll(
  body: ReadableStream<Uint8Array>,
): Promise<{ readonly text: string; readonly broken: boolean }> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const reader = body.getReader();
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    return { text: chunks.join("") + decoder.decode(), broken: false };
  } catch {
    return { text: chunks.join(""), broken: true };
  }
}

/** One request and its response as `arena smoke --record` keeps them (design §8.2). */
export interface RecordedExchange {
  readonly method: string;
  readonly url: string;
  /** The request body when it was a string (every adapter sends JSON text); else null. */
  readonly requestBody: string | null;
  readonly status: number;
  readonly contentType: string | null;
  /** The whole response body, as text; a body that broke ends where it broke. */
  readonly responseBody: string;
  readonly broken: boolean;
}

/**
 * A fetch that copies each exchange for a recording: `sink` gets, at the response, a promise of
 * the exchange that settles once its body was read to the end; the caller reads its own branch of
 * the stream, unchanged. It sits under the guard (`GuardOptions.fetch`), so the guard's checks run
 * first, and it keeps no header but the response's content type (no key, no account header). A
 * request that fails before a response records nothing.
 */
export function recordingFetch(
  sink: (exchange: Promise<RecordedExchange>) => void,
  inner?: HttpFetch,
): HttpFetch {
  const next: HttpFetch = inner ?? ((input, init) => fetch(input, init));
  return async (input, init) => {
    const res = await next(input, init);
    const base = {
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      url: input instanceof Request ? input.url : String(input),
      requestBody: typeof init?.body === "string" ? init.body : null,
      status: res.status,
      contentType: res.headers.get("content-type"),
    };
    if (res.body === null) {
      sink(Promise.resolve({ ...base, responseBody: "", broken: false }));
      return res;
    }
    const [mine, theirs] = res.body.tee();
    const read = async (): Promise<RecordedExchange> => {
      const r = await readAll(mine);
      return { ...base, responseBody: r.text, broken: r.broken };
    };
    sink(read());
    return new Response(theirs, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

/**
 * A fetch whose request is aborted after `timeoutMs` of `time` (the attempt backstop), on top of
 * the caller's own signal; the timer is dropped when the response headers arrive.
 */
export async function fetchWithTimeout(
  f: HttpFetch,
  url: string,
  init: RequestInit,
  o: { readonly time: TimeSource; readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<Response> {
  const timer = timeoutSignal(o.time, o.timeoutMs, `request timed out after ${o.timeoutMs} ms`);
  const signal = o.signal === undefined ? timer.signal : AbortSignal.any([o.signal, timer.signal]);
  try {
    return await f(url, { ...init, signal });
  } catch (e) {
    if (timer.signal.aborted && o.signal?.aborted !== true) {
      throw new ModelError("timeout", `request timed out after ${o.timeoutMs} ms`);
    }
    throw transportError(e, signal);
  } finally {
    timer.cancel();
  }
}

/**
 * A failure below HTTP (DNS, reset, a refused redirect, an abort) as a `ModelError`; `secrets`
 * (the key) are redacted from the message.
 */
export function transportError(
  e: unknown,
  signal?: AbortSignal,
  secrets: readonly string[] = [],
): ModelError {
  if (e instanceof ModelError) return e;
  if (signal?.aborted === true) return new ModelError("aborted", "request aborted");
  const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new ModelError("connection", oneLine(redact(`connection failed: ${what}`, secrets)));
}

/** One line of at most 300 characters. */
export function oneLine(s: string): string {
  const line = s.replaceAll(/\s+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** `text` with every occurrence of each secret replaced (a last guard on error messages). */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.replaceAll(s, "[redacted]");
  return out;
}

// Server-sent events ----------------------------------------------------------------------------

export interface SseEvent {
  /** The `event:` field, `message` when absent. */
  readonly event: string;
  /** The `data:` lines joined with `\n`. */
  readonly data: string;
}

/**
 * The events of a server-sent-event body, in order. Lines end with `\n`, `\r\n` or `\r`; `:` lines
 * are comments; consecutive `data:` lines join with `\n`; an event without data is skipped; an
 * event the body ends inside (no blank line after it) is discarded, as the SSE rule says. When the
 * body ends before an event for which `terminal` is true, the stream broke: a retryable
 * `connection` error (with `spent()`, what the caller says the attempt cost so far). With
 * `endOk`, the end of the body is the normal end (a protocol with no terminal event: Gemini's),
 * unless it ends inside an event; a failed read is a break either way.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  o: {
    readonly terminal: (e: SseEvent) => boolean;
    readonly spent?: () => readonly UsageEntry[];
    readonly endOk?: boolean;
  },
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let ended = false;
  const dispatch = (): SseEvent | null => {
    const out =
      data.length === 0 ? null : { event: event === "" ? "message" : event, data: data.join("\n") };
    event = "";
    data = [];
    return out;
  };
  const lines = function* (final: boolean): Generator<string> {
    for (;;) {
      const m = /\r\n|\n|\r/.exec(buffer);
      if (m === null) break;
      // A lone `\r` at the end of the buffer may be the first half of `\r\n`.
      if (!final && m[0] === "\r" && m.index === buffer.length - 1) break;
      yield buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
    }
    if (final && buffer !== "") {
      yield buffer;
      buffer = "";
    }
  };
  const reader = body.getReader();
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read chunk by chunk
      const { done, value } = await reader.read();
      if (done) buffer += decoder.decode();
      else buffer += decoder.decode(value, { stream: true });
      for (const line of lines(done)) {
        if (line === "") {
          const e = dispatch();
          if (e !== null) {
            yield e;
            if (o.terminal(e)) {
              ended = true;
              return;
            }
          }
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let text = colon < 0 ? "" : line.slice(colon + 1);
        if (text.startsWith(" ")) text = text.slice(1);
        if (field === "event") event = text;
        else if (field === "data") data.push(text);
      }
      // At the end of the body, an event not closed by a blank line was cut in transit: it is
      // discarded (the SSE rule), so a body cut inside its terminal event is a broken stream.
      if (done) {
        // A body that ends inside an event (data not closed by a blank line) was cut: a break.
        if (o.endOk === true && data.length === 0) {
          ended = true;
          return;
        }
        break;
      }
    }
  } catch (e) {
    throw new ModelError(
      "connection",
      oneLine(`the stream broke: ${e instanceof Error ? e.message : String(e)}`),
      {
        spent: o.spent?.() ?? [],
      },
    );
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  throw new ModelError("connection", "the stream ended before its final event", {
    spent: o.spent?.() ?? [],
  });
}

// Error classification ----------------------------------------------------------------------------

/** Where the error happened: OpenRouter's "no provider meets your routing requirements" is fatal at plan time. */
export type ErrorPhase = "plan" | "match";

export interface Classified {
  /** `refusal`: close the turn as a refusal of category `refusal` (not an error, never retried). */
  readonly kind: ModelErrorKind | "refusal";
  /** The refusal's category (`misalignment`, `moderation`); null otherwise. */
  readonly refusal: string | null;
  readonly retryAfterMs: number | null;
  /** The provider's error code or type, as reported (logged; never the message body). */
  readonly code: string | null;
}

export function retryAfterMs(headers: Headers | null | undefined): number | null {
  if (headers === null || headers === undefined) return null;
  const ms = Number(headers.get("retry-after-ms") ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
  const s = Number(headers.get("retry-after") ?? Number.NaN);
  if (Number.isFinite(s) && s >= 0) return Math.ceil(s * 1000);
  return null;
}

const isObject = (v: unknown): v is object =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const field = (v: unknown, key: string): unknown => (isObject(v) ? Reflect.get(v, key) : undefined);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The provider's error fields of a JSON error body: code, type, status, metadata. */
function errorFields(body: unknown): {
  code: string | null;
  type: string | null;
  status: string | null;
  limitSource: string | null;
  moderated: boolean;
  details: string;
} {
  const inner = field(body, "error");
  const err = isObject(inner) ? inner : body;
  const code = field(err, "code");
  const metadata = field(err, "metadata");
  return {
    code: str(code) ?? (typeof code === "number" ? String(code) : null),
    type: str(field(err, "type")) ?? str(field(body, "error_type")),
    status: str(field(err, "status")),
    limitSource: str(field(metadata, "limit_source")),
    moderated:
      field(metadata, "reasons") !== undefined || field(metadata, "flagged_input") !== undefined,
    details: JSON.stringify(field(err, "details") ?? null),
  };
}

const OPENAI_BILLING = new Set([
  "credit_balance_exhausted",
  "project_spend_limit_exceeded",
  "organization_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "insufficient_quota",
]);

/** The phase-2 classes of a status no provider rule matched. */
function byStatus(status: number): ModelErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 500) return "server";
  if (status === 400 || status === 409 || status === 422) return "bad_request";
  return "unknown";
}

/**
 * An HTTP error response, classified by the provider's code before its status (design §2.2's
 * table). `body` is the parsed JSON body or null; it is never echoed.
 */
export function classifyHttpError(
  provider: string,
  status: number,
  headers: Headers | null,
  body: unknown,
  phase: ErrorPhase = "match",
): Classified {
  const f = errorFields(body);
  const after = retryAfterMs(headers);
  const done = (kind: Classified["kind"], refusal: string | null = null): Classified => ({
    kind,
    refusal,
    retryAfterMs: after,
    code: f.code ?? f.type ?? f.status,
  });
  if (provider === "openai") {
    if (status === 429 && (OPENAI_BILLING.has(f.code ?? "") || f.type === "insufficient_quota")) {
      return done("billing");
    }
    if (status === 429) return done("rate_limit");
    if (status === 403 && f.code === "misalignment_policy_violation") {
      return done("refusal", "misalignment");
    }
  } else if (provider === "google") {
    if (status === 402) return done("billing");
    if (status === 429 || f.status === "RESOURCE_EXHAUSTED") {
      // The monthly tier cap's shape is unverified (design §2.2): a 429 whose details name a
      // billing or monthly limit pauses for the operator; any other is a rate limit.
      return /billing|monthly|spend.?cap|tier.?cap/i.test(f.details)
        ? done("billing")
        : done("rate_limit");
    }
    if (f.status === "PERMISSION_DENIED" || f.status === "UNAUTHENTICATED") return done("auth");
  } else if (provider === "openrouter") {
    const source = f.limitSource;
    if (status === 402 && source === "openrouter_in_flight_budget") return done("rate_limit");
    if (status === 402) return done("billing");
    if (status === 403 && source !== null && /guardrail|workspace|key|budget/i.test(source)) {
      return done("billing");
    }
    if (status === 403 && (f.moderated || /moderation|flagged/i.test(f.type ?? ""))) {
      return done("refusal", "moderation");
    }
    if (status === 503) return done(phase === "plan" ? "bad_request" : "overloaded");
  }
  return done(byStatus(status));
}

/** A classified HTTP error as the `ModelError` an adapter throws (refusals are handled apart). */
export function httpModelError(
  provider: string,
  status: number,
  c: Classified,
  o: {
    readonly requestId?: string | null;
    readonly spent?: readonly UsageEntry[];
    /** The key (raw and URL-encoded): redacted from the message (a code an upstream echoed). */
    readonly secrets?: readonly string[];
  } = {},
): ModelError {
  const code = c.code === null ? "" : ` ${c.code}`;
  // A refusal reaching here (the caller did not close the turn) is not retried.
  const kind: ModelErrorKind = c.kind === "refusal" ? "bad_request" : c.kind;
  return new ModelError(
    kind,
    oneLine(redact(`${provider} HTTP ${status}${code}`, o.secrets ?? [])),
    {
      status,
      requestId: o.requestId ?? null,
      retryAfterMs: c.retryAfterMs,
      spent: o.spent ?? [],
    },
  );
}
