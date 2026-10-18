// A public, read-only site (phase-3 design §2.6, §6.1, §6.4):
// - nothing served (every REST route, every WebSocket message, the OpenAPI document, error bodies)
//   and nothing in the cache files holds the run's id key or seed, a request id, an error message,
//   a refusal explanation, a planted API key, the prompts or a transcript path;
// - only GET/HEAD; encoded traversal, symbolic links and unknown ids get 404/422; `transcripts/`
//   and `prompts/` are unreachable; the security headers are on every response; a burst gets 429
//   with `Retry-After`; a WebSocket from a foreign origin is refused; per-IP socket caps, the
//   message rate and the payload size are enforced;
// - the configuration binds 127.0.0.1 by default and refuses a public host without `publish.json`.

// oxlint-disable no-await-in-loop -- the requests, pages and chunks follow each other on purpose (one cursor, one writer)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { idKeyFromSeed } from "@perfidia/engine/core";
import { LlmLogLineSchema } from "@perfidia/protocol";
import {
  ApiErrorSchema,
  FeedPageSchema,
  MatchListItemSchema,
  ServerMsgSchema,
  StepsPageSchema,
  type MatchMeta,
} from "@perfidia/protocol/spectator";
import { z } from "zod";
import { ConfigError, DEFAULT_LIMITS, parseServeArgs, readEnv } from "./config.ts";
import {
  Follower,
  PLANTED,
  expectNoSecrets,
  fakeRun,
  metaOf,
  rows,
  serve,
  tempDir,
  testConfig,
  type FakeRun,
  type TestServer,
  stopServers,
} from "./testkit.test.ts";

afterAll(stopServers);

const LONG = 180_000;
const API_KEY = "sk-ant-PLANTED-KEY-0123456789";

let run: FakeRun;
let root = "";
let cache = "";
let s: TestServer;
let meta: MatchMeta;
const saved = process.env["PERFIDIA_ANTHROPIC_API_KEY"];

beforeAll(async () => {
  process.env["PERFIDIA_ANTHROPIC_API_KEY"] = API_KEY;
  run = await fakeRun({ days: 1, seed: 4, secrets: true });
  root = tempDir("sec");
  cache = tempDir("sec-cache");
  cpSync(run.dir, join(root, "secret"), { recursive: true });
  // A linked run directory and a run whose log is a link are never served.
  symlinkSync(join(root, "secret"), join(root, "linked"));
  mkdirSync(join(root, "loglink"));
  symlinkSync(join(root, "secret", "match.jsonl"), join(root, "loglink", "match.jsonl"));
  s = serve(testConfig({ runs: root, cache }));
  meta = await metaOf(s, "secret", { settled: true });
}, LONG);

afterAll(() => {
  if (saved === undefined) delete process.env["PERFIDIA_ANTHROPIC_API_KEY"];
  else process.env["PERFIDIA_ANTHROPIC_API_KEY"] = saved;
});

describe("nothing served holds a secret", () => {
  test(
    "every route, every WebSocket message, the OpenAPI document, error bodies and the cache files",
    async () => {
      const header = run.header;
      expect(header.setup.idKey).toBe(idKeyFromSeed(header.setup.seed));
      const shared = readFileSync(join(run.dir, "prompts", "shared.txt"), "utf8");
      const excerpt = shared.slice(
        Math.floor(shared.length / 2),
        Math.floor(shared.length / 2) + 80,
      );
      const secrets = {
        idKey: header.setup.idKey,
        seed: header.setup.seed,
        planted: [...Object.values(PLANTED), API_KEY, excerpt],
      };
      const raw = readFileSync(join(run.dir, "llm_calls.jsonl"), "utf8");
      for (const p of Object.values(PLANTED)) expect([p, raw.includes(p)]).toEqual([p, true]);

      const served: string[] = [];
      const get = async (path: string): Promise<string> => {
        const text = await (await fetch(`${s.url}${path}`)).text();
        served.push(text);
        return text;
      };
      const base = `/api/matches/secret`;
      const t = `${base}/t/${meta.timeline}`;
      await get("/api/health");
      await get("/api/matches");
      await get(base);
      await get(`${base}/latest`);
      await get("/api/openapi/json");
      for (const seq of meta.keyframes) await get(`${t}/keyframes/${seq}`);
      let after = -1;
      for (;;) {
        const page = StepsPageSchema.parse(
          JSON.parse(await get(`${t}/steps?after=${after}&limit=2000`)),
        );
        after = page.to;
        if (!page.more) break;
      }
      await get(`${t}/moments`);
      let feedAfter = -1;
      for (;;) {
        const page = FeedPageSchema.parse(
          JSON.parse(await get(`${base}/feed?after=${feedAfter}&limit=200`)),
        );
        const last = page.items.at(-1);
        if (!page.more || last === undefined) break;
        feedAfter = last.seq;
      }
      for (const seat of meta.seats) await get(`${base}/players/${seat.seat}`);
      const turns = new Set<string>();
      for (const line of rows(raw)) {
        const l = LlmLogLineSchema.parse(JSON.parse(line));
        if (l.k === "llm_call") turns.add(`${l.seat}/${l.turn}`);
      }
      expect(turns.size).toBeGreaterThan(10);
      for (const k of turns) await get(`${base}/annotations/${k}`);
      for (const path of [
        "/api/matches/nope",
        `${t}/keyframes/3`,
        `${base}/feed?kinds=x`,
        "/api/matches/secret/t/0123456789abcdef/steps",
      ]) {
        const text = await get(path);
        expect([path, ApiErrorSchema.parse(JSON.parse(text)).ok]).toEqual([path, false]);
      }
      // Paths naming the side directories are not routes (their 404 body echoes the path only).
      for (const path of [`${base}/transcripts`, `${base}/prompts/shared.txt`]) {
        const res = await fetch(`${s.url}${path}`);
        expect([path, res.status, ApiErrorSchema.parse(await res.json()).code]).toEqual([
          path,
          404,
          "NO_ROUTE",
        ]);
      }
      // A follower's every message.
      const f = await Follower.start(s, "secret");
      await f.until(meta.lastSeq);
      served.push(JSON.stringify(f.messages));
      await f.disconnect();
      for (const text of served) expectNoSecrets(text, secrets);
      // The cache files.
      const files = readdirSync(cache).filter((n) => n.endsWith(".json.gz"));
      expect(files.length).toBeGreaterThan(0);
      for (const name of files) {
        const text = new TextDecoder().decode(
          Bun.gunzipSync(new Uint8Array(readFileSync(join(cache, name)))),
        );
        expectNoSecrets(text, secrets);
      }
      // The refusal category and error kind are kept.
      const all = served.join("\n");
      expect(all.includes('"refusal":"cyber"')).toBe(true);
      expect(all.includes('"overloaded"')).toBe(true);
    },
    LONG,
  );
});

describe("a read-only site", () => {
  test("GET and HEAD only; traversal, links and unknown ids give 404 or 422 errors", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await fetch(`${s.url}/api/matches/secret`, { method });
      expect([method, res.status, res.headers.get("allow")]).toEqual([method, 405, "GET, HEAD"]);
    }
    for (const path of [
      "/api/matches/..%2f..%2fetc%2fpasswd",
      "/api/matches/%2Fetc%2Fpasswd",
      "/api/matches/secret%2f..%2f..%2fsecret/latest",
      "/api/matches/.hidden",
      "/api/matches/linked",
      "/api/matches/loglink",
      "/api/matches/secret/transcripts",
      "/api/matches/secret/prompts",
      "/api/matches/secret/match.jsonl",
      "/runs/secret/match.jsonl",
      "/api/../../etc/passwd",
    ]) {
      const res = await fetch(`${s.url}${path}`);
      const text = await res.text();
      expect([path, res.status === 404 || res.status === 422]).toEqual([path, true]);
      expect(ApiErrorSchema.parse(JSON.parse(text)).ok).toBe(false);
    }
    const list = z
      .array(MatchListItemSchema)
      .parse(await (await fetch(`${s.url}/api/matches`)).json());
    expect(list.map((m) => m.id)).toEqual(["secret"]);
  });

  test("security headers on every response; no CORS", async () => {
    for (const [path, init] of [
      ["/api/health", {}],
      ["/api/matches/secret", {}],
      ["/api/nope", {}],
      ["/api/matches/secret", { method: "POST" }],
      ["/api/openapi/json", {}],
    ] as const) {
      const res = await fetch(`${s.url}${path}`, init);
      for (const h of [
        "content-security-policy",
        "x-content-type-options",
        "referrer-policy",
        "permissions-policy",
        "cross-origin-opener-policy",
        "cross-origin-resource-policy",
      ]) {
        expect([path, h, res.headers.get(h) !== null]).toEqual([path, h, true]);
      }
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  test("a WebSocket from a foreign origin is refused; the server's own origin is accepted", async () => {
    const url = `${s.url.replace("http", "ws")}/api/live`;
    const open = (origin: string): Promise<boolean> =>
      new Promise((resolve) => {
        const ws = new WebSocket(url, { headers: { origin } });
        ws.addEventListener("open", () => {
          ws.close();
          resolve(true);
        });
        ws.addEventListener("error", () => resolve(false));
      });
    expect(await open("https://evil.example")).toBe(false);
    expect(await open(s.url)).toBe(true);
  });
});

describe("limits", () => {
  test(
    "a burst gets 429 with Retry-After; sockets per IP, messages per socket and payload size are capped",
    async () => {
      const burst = serve(
        testConfig({ runs: root, limits: { ...DEFAULT_LIMITS, httpPerMinute: 60, httpBurst: 5 } }),
      );
      const statuses: number[] = [];
      let retry: string | null = null;
      for (let i = 0; i < 8; i += 1) {
        const res = await fetch(`${burst.url}/api/health`);
        statuses.push(res.status);
        if (res.status === 429) retry = res.headers.get("retry-after");
      }
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses.slice(5)).toEqual([429, 429, 429]);
      expect(Number(retry)).toBeGreaterThanOrEqual(1);

      const limited = serve(
        testConfig({
          runs: root,
          limits: {
            ...DEFAULT_LIMITS,
            httpPerMinute: 6_000,
            httpBurst: 100,
            socketsPerIp: 2,
            socketMessages: 5,
            subscribesPerMinute: 3,
          },
        }),
      );
      const url = `${limited.url.replace("http", "ws")}/api/live`;
      const connect = (): Promise<WebSocket | null> =>
        new Promise((resolve) => {
          const ws = new WebSocket(url);
          ws.addEventListener("open", () => resolve(ws));
          ws.addEventListener("error", () => resolve(null));
        });
      const a = await connect();
      const b = await connect();
      const c = await connect();
      expect([a !== null, b !== null, c === null]).toEqual([true, true, true]);
      if (a === null || b === null) throw new Error("no socket");
      // Too many messages close the socket (1008); a bad message gets an error.
      const errors: string[] = [];
      const closed = new Promise<number>((resolve) => {
        a.addEventListener("close", (ev) => resolve(ev.code));
      });
      a.addEventListener("message", (ev) => {
        const msg = ServerMsgSchema.parse(JSON.parse(String(ev.data)));
        if (msg.type === "error") errors.push(msg.code);
      });
      a.send("not json");
      for (let i = 0; i < 10; i += 1) a.send(JSON.stringify({ type: "ping", n: i }));
      expect(await closed).toBe(1008);
      expect(errors[0]).toBe("BAD_MESSAGE");
      // An oversized message closes the socket.
      const bigClosed = new Promise<number>((resolve) => {
        b.addEventListener("close", (ev) => resolve(ev.code));
      });
      b.send("x".repeat(DEFAULT_LIMITS.maxPayloadBytes * 4));
      // Bun drops the connection (1006 at the client) or sends 1009.
      expect([1006, 1009]).toContain(await bigClosed);
    },
    LONG,
  );
});

describe("configuration", () => {
  test("binds 127.0.0.1 by default; a public host needs publish.json; two environment variables only", () => {
    const env = { port: null, trustProxy: null } as const;
    const c = parseServeArgs(["--runs", "r"], env);
    expect([c.host, c.port, c.publish, c.adapter, c.policy]).toEqual([
      "127.0.0.1",
      8080,
      null,
      "elysia",
      { costs: true, reasoning: true },
    ]);
    expect(() => parseServeArgs(["--runs", "r", "--host", "0.0.0.0"], env)).toThrow(ConfigError);
    expect(
      parseServeArgs(["--runs", "r", "--host", "0.0.0.0", "--publish", "p.json"], env).host,
    ).toBe("0.0.0.0");
    expect(() => parseServeArgs(["--runs", "r", "--bogus"], env)).toThrow(ConfigError);
    expect(() => parseServeArgs([], env)).toThrow(ConfigError);
    expect(() => parseServeArgs(["--runs", "r", "--origin", "evil"], env)).toThrow(ConfigError);
    const hidden = parseServeArgs(
      ["--runs", "r", "--no-costs", "--no-reasoning", "--adapter", "raw"],
      env,
    );
    expect([hidden.policy, hidden.adapter]).toEqual([{ costs: false, reasoning: false }, "raw"]);
    expect(
      readEnv({ PORT: "9000", PERFIDIA_SERVE_TRUST_PROXY: "fly", PERFIDIA_ANTHROPIC_API_KEY: "x" }),
    ).toEqual({ port: 9000, trustProxy: "fly" });
    expect(readEnv({ PORT: "x" })).toEqual({ port: null, trustProxy: null });
  });
});
