// A redirecting server never receives the key (phase-4 design §2.6, §7; probe S44): two loopback
// servers in this process, the first answering every request with a 307 to the second, which is
// another origin. Under Bun 1.4.3 a plain `fetch` follows the redirect and forwards `x-api-key` to
// the second origin (the control below); the Anthropic client's guarded fetch sends
// `redirect: "error"`, so the attempt fails as a connection error, nothing reaches the second
// server, and the error message carries no key. Loopback only: no test touches the network.

import { afterEach, describe, expect, test } from "bun:test";
import type { ChatRequest, ModelSpec } from "./adapter.ts";
import { ModelError } from "./adapter.ts";
import { AnthropicAdapter, AnthropicClient } from "./anthropic.ts";

const KEY = "sk-ant-planted-redirect-0123456789";

const SPEC: ModelSpec = {
  provider: "anthropic",
  model: "claude-haiku-5-5",
  effort: "low",
  maxOutputTokens: 16_000,
  cacheTtl: "5m",
};

const REQ: ChatRequest = {
  prompt: { shared: "SHARED", seat: "SEAT" },
  tools: [],
  entries: [
    { role: "user", parts: [{ kind: "text", text: "{}" }] },
    { role: "operator", text: "Turn 1." },
  ],
  meta: { seat: "p1", turn: 1, round: 0, maxRounds: 8, maxCalls: 10, kind: "round" },
};

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** The second origin: records every request's headers. */
function target(): { url: string; seen: Headers[] } {
  const seen: Headers[] = [];
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push(req.headers);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  servers.push(s);
  return { url: `http://127.0.0.1:${s.port}`, seen };
}

/** The configured origin: a 307 to `to` for every request (path and query kept). */
function redirecting(to: string): { url: string; hits: () => number } {
  let hits = 0;
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      hits += 1;
      const u = new URL(req.url);
      return new Response(null, {
        status: 307,
        headers: { location: `${to}${u.pathname}${u.search}` },
      });
    },
  });
  servers.push(s);
  return { url: `http://127.0.0.1:${s.port}`, hits: () => hits };
}

async function failure(p: Promise<unknown>): Promise<ModelError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ModelError) return e;
    throw e;
  }
  throw new Error("expected a ModelError");
}

describe("redirects (phase 4)", () => {
  test("control: a plain fetch follows a cross-origin 307 and forwards x-api-key (Bun 1.4.3)", async () => {
    const b = target();
    const a = redirecting(b.url);
    const res = await fetch(`${a.url}/v1/models`, { headers: { "x-api-key": KEY } });
    expect(res.status).toBe(200);
    expect(b.seen.map((h) => h.get("x-api-key"))).toEqual([KEY]);
  });

  test("the guarded client never follows it: a connection error, and the second origin gets nothing", async () => {
    const b = target();
    const a = redirecting(b.url);
    const adapter = new AnthropicAdapter(
      SPEC,
      new AnthropicClient({ apiKey: KEY, baseURL: a.url }),
    );
    const chat = await failure(adapter.chat(REQ));
    expect(chat.kind).toBe("connection");
    const pre = await failure(adapter.preflight(REQ));
    expect(pre.kind).toBe("connection");
    const count = await failure(adapter.countTokens(REQ));
    expect(count.kind).toBe("connection");
    expect(a.hits()).toBe(3);
    expect(b.seen).toHaveLength(0);
    for (const e of [chat, pre, count]) expect(e.message).not.toContain(KEY);
  });
});
