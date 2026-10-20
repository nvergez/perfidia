// The shared transport (phase-4 design §2.2, Pass 1b), against stub servers on loopback only:
// origin pinning, https outside loopback, the header allowlist, the auth header, no key in a URL,
// no redirect followed (the second origin never sees the key), the attempt timeout, the SSE reader
// and the error classification by provider code before HTTP status. No test touches the network.

import { afterEach, describe, expect, test } from "bun:test";
import type { Sleep, TimeSource } from "@perfidia/protocol";
import { ModelError } from "./adapter.ts";
import {
  checkedOrigin,
  classifyHttpError,
  fetchWithTimeout,
  guardedFetch,
  httpModelError,
  readSse,
  redact,
  retryAfterMs,
  type SseEvent,
} from "./http.ts";

const KEY = "sk-test-0123456789abcdef";

interface Seen {
  readonly path: string;
  readonly headers: Record<string, string>;
}

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** A loopback server that records every request and answers with `respond`. */
function stub(respond: (req: Request) => Response | Promise<Response>): {
  readonly url: string;
  readonly seen: Seen[];
} {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      seen.push({ path: new URL(req.url).pathname + new URL(req.url).search, headers });
      return respond(req);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const auth = { header: "x-goog-api-key", value: KEY };

/** The message a promise rejects with ("resolved" when it does not). */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe("guardedFetch", () => {
  test("sends to the configured origin only, with allowlisted headers, the auth header and the fixed ones", async () => {
    const s = stub(() => json({ ok: true }));
    const f = guardedFetch({
      baseURL: `${s.url}/v1beta`,
      auth,
      allowHeaders: /^(?:accept|content-type)$/,
      fixedHeaders: { "x-openrouter-metadata": "enabled" },
    });
    const r = await f(`${s.url}/v1beta/models/x:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "a=b",
        authorization: "Bearer other",
        "x-goog-api-key": "a-planted-key",
      },
      body: "{}",
    });
    expect(r.status).toBe(200);
    const h = s.seen[0]?.headers ?? {};
    expect(h["x-goog-api-key"]).toBe(KEY);
    expect(h["x-openrouter-metadata"]).toBe("enabled");
    expect(h["content-type"]).toBe("application/json");
    expect(h["cookie"]).toBeUndefined();
    expect(h["authorization"]).toBeUndefined();
    expect(await rejection(f("https://evil.example/v1beta/models"))).toContain(
      "refusing a request to https://evil.example",
    );
  });

  test("https outside loopback; never a key in the URL", async () => {
    expect(checkedOrigin("https://api.openai.com/v1")).toBe("https://api.openai.com");
    expect(checkedOrigin("http://localhost:8000/v1")).toBe("http://localhost:8000");
    expect(checkedOrigin("http://[::1]:1")).toBe("http://[::1]:1");
    expect(() => checkedOrigin("http://proxy.example.com")).toThrow("is not https");
    expect(() => checkedOrigin("ftp:x")).toThrow("is not https");
    expect(() => checkedOrigin("not a url")).toThrow("not a URL");
    const s = stub(() => json({}));
    const f = guardedFetch({ baseURL: s.url, auth, allowHeaders: /^$/ });
    expect(await rejection(f(`${s.url}/models?key=${KEY}`))).toContain("carries the key");
    expect(s.seen).toEqual([]);
  });

  test("a redirect is never followed: the second origin receives nothing, the error carries no key", async () => {
    const second = stub(() => json({ stolen: true }));
    const first = stub(
      () => new Response(null, { status: 307, headers: { location: `${second.url}/v1/steal` } }),
    );
    const f = guardedFetch({
      baseURL: first.url,
      auth: { header: "authorization", value: `Bearer ${KEY}` },
      allowHeaders: /^content-type$/,
    });
    const time = neverTime();
    let error: unknown;
    try {
      await fetchWithTimeout(
        f,
        `${first.url}/v1/responses`,
        { method: "POST", body: "{}" },
        {
          time,
          timeoutMs: 60_000,
        },
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ModelError);
    expect(error instanceof ModelError ? error.kind : "").toBe("connection");
    expect(String(error instanceof Error ? error.message : error)).not.toContain(KEY);
    expect(first.seen).toHaveLength(1);
    expect(first.seen[0]?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(second.seen).toEqual([]);
  });

  test("the attempt timeout aborts a request that never answers", async () => {
    const s = stub(() => new Promise<Response>(() => undefined));
    const f = guardedFetch({ baseURL: s.url, auth, allowHeaders: /^$/ });
    const e = await fetchWithTimeout(
      f,
      `${s.url}/x`,
      {},
      { time: instantTime(), timeoutMs: 5 },
    ).catch((x: unknown) => x);
    expect(e instanceof ModelError ? [e.kind, e.message] : e).toEqual([
      "timeout",
      "request timed out after 5 ms",
    ]);
    // The caller's own abort is an abort, not a timeout.
    const ctl = new AbortController();
    ctl.abort();
    const a = await fetchWithTimeout(
      f,
      `${s.url}/x`,
      {},
      {
        time: neverTime(),
        timeoutMs: 60_000,
        signal: ctl.signal,
      },
    ).catch((x: unknown) => x);
    expect(a instanceof ModelError ? a.kind : a).toBe("aborted");
  });

  test("redact replaces every occurrence of a secret", () => {
    expect(redact(`key ${KEY} and ${KEY}`, [KEY])).toBe("key [redacted] and [redacted]");
    expect(redact("short ab", ["ab"])).toBe("short ab");
  });
});

/** A time source whose every sleep is already due (a timeout fires at once). */
function instantTime(): TimeSource {
  return {
    nowMs: () => 0,
    sleepUntil: (): Sleep => ({ done: Promise.resolve(), cancel: () => undefined }),
  };
}

/** A time source whose sleeps never end. */
function neverTime(): TimeSource {
  return {
    nowMs: () => 0,
    sleepUntil: (): Sleep => ({
      done: new Promise<void>(() => undefined),
      cancel: () => undefined,
    }),
  };
}

/** A body that yields `chunks` (strings) in order, then ends. */
function body(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(ctl) {
      const c = chunks[i];
      i += 1;
      if (c === undefined) ctl.close();
      else ctl.enqueue(enc.encode(c));
    },
  });
}

async function events(
  chunks: readonly string[],
  terminal: (e: SseEvent) => boolean,
): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of readSse(body(chunks), { terminal })) out.push(e);
  return out;
}

describe("readSse", () => {
  test("CRLF, lone CR split across chunks, comments, multi-line data, named events", async () => {
    const got = await events(
      [
        ': keep-alive\r\n\r\nevent: response.created\r\ndata: {"a":',
        "1}\r",
        "\n\r\ndata: line one\ndata: line two\n\n",
        "event: response.completed\ndata: {}\n\n",
        "data: never read\n\n",
      ],
      (e) => e.event === "response.completed",
    );
    expect(got).toEqual([
      { event: "response.created", data: '{"a":1}' },
      { event: "message", data: "line one\nline two" },
      { event: "response.completed", data: "{}" },
    ]);
  });

  test("a body that ends before the terminal event is a retryable connection error with its spend", async () => {
    const spent = [
      {
        model: "gpt-6-luna",
        kind: "message" as const,
        tokens: { input: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 32_768 },
        estimated: true,
      },
    ];
    const out: SseEvent[] = [];
    let error: unknown;
    try {
      for await (const e of readSse(body(['data: {"x":1}\n\n', "data: partial"]), {
        terminal: (ev) => ev.data === "[DONE]",
        spent: () => spent,
      })) {
        out.push(e);
      }
    } catch (e) {
      error = e;
    }
    // The event the body ended inside is discarded (phase-4 review: the SSE rule).
    expect(out).toEqual([{ event: "message", data: '{"x":1}' }]);
    expect(error).toBeInstanceOf(ModelError);
    const m = error instanceof ModelError ? error : null;
    expect([m?.kind, m?.retryable, m?.spent]).toEqual(["connection", true, spent]);
    // A terminal `[DONE]` ends the stream cleanly.
    expect(await events(["data: a\n\ndata: [DONE]\n\n"], (e) => e.data === "[DONE]")).toHaveLength(
      2,
    );
  });

  test("a body cut inside its terminal event is a broken stream, not a complete one (review)", async () => {
    const out: SseEvent[] = [];
    let error: unknown;
    try {
      for await (const e of readSse(
        body([
          'event: message_delta\ndata: {"a":1}\n\n',
          'event: message_stop\ndata: {"type":"mess',
        ]),
        { terminal: (ev) => ev.event === "message_stop" },
      )) {
        out.push(e);
      }
    } catch (e) {
      error = e;
    }
    expect(out).toEqual([{ event: "message_delta", data: '{"a":1}' }]);
    expect(error instanceof ModelError ? [error.kind, error.retryable] : null).toEqual([
      "connection",
      true,
    ]);
    // Complete, but without a blank line at the very end: still cut (the event never closed).
    const unclosed = await events(["event: message_stop\ndata: {}\n"], () => true).catch(
      (e: unknown) => e,
    );
    expect(unclosed).toBeInstanceOf(ModelError);
  });

  test("a CRLF split inside a multi-line data event is one line break, not an event end (review)", async () => {
    // Without the lone-CR guard, "a\r" | "\n" would end a line and the "\n" alone a blank line:
    // two events "a" and "b" instead of one "a\nb".
    expect(await events(["data: a\r", "\ndata: b\r\n\r\n"], () => true)).toEqual([
      { event: "message", data: "a\nb" },
    ]);
  });
});

/** The kind and refusal flag `classifyHttpError` gives. */
const c = (
  provider: string,
  status: number,
  b: unknown,
  phase: "plan" | "match" = "match",
  headers: Record<string, string> = {},
) => {
  const x = classifyHttpError(provider, status, new Headers(headers), b, phase);
  return [x.kind, x.refusal];
};

describe("classifyHttpError (the provider's code before the HTTP status)", () => {
  test("OpenAI: spend limits pause for the operator; rate limits retry; misalignment is a refusal", () => {
    for (const code of [
      "credit_balance_exhausted",
      "project_spend_limit_exceeded",
      "organization_spend_limit_exceeded",
      "organization_usage_limit_exceeded",
    ]) {
      expect(c("openai", 429, { error: { code, type: "insufficient_quota" } })).toEqual([
        "billing",
        null,
      ]);
    }
    expect(c("openai", 429, { error: { type: "insufficient_quota" } })).toEqual(["billing", null]);
    expect(c("openai", 429, { error: { code: "rate_limit_exceeded" } })).toEqual([
      "rate_limit",
      null,
    ]);
    expect(c("openai", 429, null)).toEqual(["rate_limit", null]);
    expect(c("openai", 403, { error: { code: "misalignment_policy_violation" } })).toEqual([
      "refusal",
      "misalignment",
    ]);
    expect(c("openai", 403, { error: { code: "forbidden" } })).toEqual(["auth", null]);
  });

  test("Gemini: an empty balance (402) and a billing cap pause; RESOURCE_EXHAUSTED retries", () => {
    expect(c("google", 402, { error: { status: "FAILED_PRECONDITION" } })).toEqual([
      "billing",
      null,
    ]);
    expect(c("google", 429, { error: { status: "RESOURCE_EXHAUSTED", details: [] } })).toEqual([
      "rate_limit",
      null,
    ]);
    expect(
      c("google", 429, {
        error: { status: "RESOURCE_EXHAUSTED", details: [{ reason: "MONTHLY_SPEND_CAP" }] },
      }),
    ).toEqual(["billing", null]);
    expect(c("google", 403, { error: { status: "PERMISSION_DENIED" } })).toEqual(["auth", null]);
  });

  test("OpenRouter: in-flight budget retries; other 402s, guardrails and key budgets pause; moderation refuses; 503 by phase", () => {
    expect(
      c("openrouter", 402, {
        error: { metadata: { limit_source: "openrouter_in_flight_budget" } },
      }),
    ).toEqual(["rate_limit", null]);
    expect(c("openrouter", 402, { error: { code: 402 } })).toEqual(["billing", null]);
    expect(c("openrouter", 403, { error: { metadata: { limit_source: "key_budget" } } })).toEqual([
      "billing",
      null,
    ]);
    expect(c("openrouter", 403, { error: { metadata: { reasons: ["violence"] } } })).toEqual([
      "refusal",
      "moderation",
    ]);
    expect(c("openrouter", 503, {}, "plan")).toEqual(["bad_request", null]);
    expect(c("openrouter", 503, {}, "match")).toEqual(["overloaded", null]);
  });

  test("other statuses keep phase 2's classes; Retry-After is read; the error is one line without the body", () => {
    expect(c("compat", 500, {})).toEqual(["server", null]);
    expect(c("compat", 529, {})).toEqual(["overloaded", null]);
    expect(c("compat", 401, {})).toEqual(["auth", null]);
    expect(c("compat", 404, {})).toEqual(["not_found", null]);
    expect(c("compat", 413, {})).toEqual(["too_large", null]);
    expect(c("compat", 400, {})).toEqual(["bad_request", null]);
    expect(retryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2000);
    expect(retryAfterMs(new Headers({ "retry-after-ms": "150" }))).toBe(150);
    const x = classifyHttpError("openai", 429, new Headers({ "retry-after": "1" }), {
      error: { code: "rate_limit_exceeded", message: `key ${KEY} is slow` },
    });
    const err = httpModelError("openai", 429, x, { requestId: "req_1" });
    expect([err.kind, err.retryable, err.retryAfterMs, err.message]).toEqual([
      "rate_limit",
      true,
      1000,
      "openai HTTP 429 rate_limit_exceeded",
    ]);
  });
});
