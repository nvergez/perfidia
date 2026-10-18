// `arena smoke` against a fetch stub with recorded bodies (no network): the preflight
// (models.retrieve, then the shape check at max_tokens 0), count_tokens on the prefix and a real
// briefing, then one streamed call. Only our key goes out, to the configured origin.

import { describe, expect, test } from "bun:test";
import { memoryIo } from "@perfidia/sim";
import type { HttpFetch } from "../model/anthropic.ts";
import { SMOKE_MAX_TOKENS, smokeBoundNano, smokeCommand } from "./smoke.ts";

const BASE = "https://api.test.invalid";

/** The roles of a request body's messages. */
const roleList = (body: Record<string, unknown> | null): unknown[] => {
  const messages: unknown = body?.["messages"];
  return Array.isArray(messages)
    ? messages.map((m: unknown): unknown =>
        m !== null && typeof m === "object" ? Reflect.get(m, "role") : null,
      )
    : [];
};

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | null;
}

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", "request-id": "req_json" },
  });

const sse = (events: readonly Record<string, unknown>[]): Response =>
  new Response(
    events.map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_sse" } },
  );

const usage = {
  input_tokens: 40,
  cache_creation_input_tokens: 1200,
  cache_read_input_tokens: 9000,
};

function stub(): { fetch: HttpFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const answers = [
    json({
      id: "claude-haiku-5-5",
      type: "model",
      display_name: "Claude Haiku 5.5",
      created_at: "2026-01-01T00:00:00Z",
      allowed_fallback_models: [],
    }),
    json({
      id: "msg_w",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [],
      stop_reason: "max_tokens",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 3, output_tokens: 0, cache_creation_input_tokens: 9000 },
    }),
    json({ input_tokens: 10_250, context_management: null }),
    sse([
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          usage: { ...usage, output_tokens: 1 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Build first." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "view_map", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null, stop_details: null },
        usage: { output_tokens: 220 },
      },
      { type: "message_stop" },
    ]),
  ];
  const fetch: HttpFetch = (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const raw = typeof init?.body === "string" ? init.body : null;
    const body: unknown = raw === null ? null : JSON.parse(raw);
    seen.push({
      url: input instanceof Request ? input.url : String(input),
      headers,
      body:
        body !== null && typeof body === "object" ? Object.fromEntries(Object.entries(body)) : null,
    });
    const a = answers.shift();
    return a === undefined ? Promise.reject(new Error("stub: no answer left")) : Promise.resolve(a);
  };
  return { fetch, seen };
}

describe("arena smoke", () => {
  test("preflight, count_tokens, one streamed call: reported, with our key only", async () => {
    const s = stub();
    const io = memoryIo();
    const code = await smokeCommand({
      env: { apiKey: "sk-smoke", baseURL: BASE, live: false },
      io,
      fetch: s.fetch,
    });
    expect(io.stderr()).toBe("");
    expect(code).toBe(0);
    const out = io.stdout();
    expect(out).toContain(
      "smoke: anthropic/claude-haiku-5-5/low on https://api.test.invalid, at most $0.005437",
    );
    expect(out).toContain("1. preflight: ok; allowed fallbacks: none");
    expect(out).toContain("2. count_tokens: 10250 input tokens");
    expect(out).toContain("3. one call: stop tool_use, served by claude-haiku-5-5");
    expect(out).toContain("cache read 9000");
    expect(out).toContain("1 tool call(s) (view_map)");
    expect(out).toContain("smoke: ok");
    expect(s.seen.map((x) => x.url)).toEqual([
      `${BASE}/v1/models/claude-haiku-5-5?beta=true`,
      `${BASE}/v1/messages?beta=true`,
      `${BASE}/v1/messages/count_tokens?beta=true`,
      `${BASE}/v1/messages?beta=true`,
    ]);
    for (const x of s.seen) {
      expect(x.headers["x-api-key"]).toBe("sk-smoke");
      expect(x.headers["authorization"]).toBeUndefined();
    }
    // The preflight's shape check carries an operator entry, as every round 0 does.
    expect(s.seen[1]?.body?.["max_tokens"]).toBe(0);
    expect(roleList(s.seen[1]?.body ?? null)).toEqual(["user", "system"]);
    // Haiku 5.5: no server-side fallback, so neither the beta nor `fallbacks`.
    const call = s.seen[3]?.body ?? {};
    expect(call["max_tokens"]).toBe(SMOKE_MAX_TOKENS);
    expect(call["fallbacks"]).toBeUndefined();
    expect(s.seen[3]?.headers["anthropic-beta"]).toBeUndefined();
    expect(call["stream"]).toBe(true);
    expect(call["output_config"]).toEqual({ effort: "low" });
    const messages: unknown = call["messages"];
    const roles = Array.isArray(messages)
      ? messages.map((m: unknown): unknown =>
          m !== null && typeof m === "object" ? Reflect.get(m, "role") : null,
        )
      : [];
    expect(roles).toEqual(["user", "system"]);
    // count_tokens counts the prefix and the briefing, with the request's thinking and effort.
    const count = s.seen[2]?.body ?? {};
    expect(Object.keys(count).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([
      "messages",
      "model",
      "output_config",
      "system",
      "thinking",
      "tools",
    ]);
  }, 60_000);

  test("the bound: about $0.22 on Opus 5.5, half a cent on Haiku 5.5; said before anything is sent", async () => {
    expect(smokeBoundNano("claude-opus-5-5")).toBe(217_500_000);
    expect(smokeBoundNano("claude-haiku-5-5")).toBe(5_437_500);
    let message = "";
    try {
      await smokeCommand({
        env: { apiKey: null, baseURL: BASE, live: false },
        io: memoryIo(),
        model: "opus-5-5",
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("at most $0.217500 on claude-opus-5-5");
    expect(message).toContain("Nothing was sent");
  });

  test("an unpriced model is refused before anything is sent", async () => {
    const s = stub();
    const io = memoryIo();
    let message = "";
    try {
      await smokeCommand({
        env: { apiKey: "sk", baseURL: BASE, live: false },
        io,
        fetch: s.fetch,
        model: "claude-x-1",
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("no price for model claude-x-1");
    expect(s.seen).toEqual([]);
  });
});
