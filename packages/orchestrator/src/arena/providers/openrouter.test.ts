// OpenRouter in the arena (phase-4 design §2.5, §8.3–§8.4, Pass 2), with no network: a loopback
// `Bun.serve` stub speaks OpenRouter's protocol (its public metadata from the fixtures recorded on
// 2026-10-20; the SSE chat stream with reasoning details, tool calls split across chunks, the final
// usage chunk with `cost` and the routing metadata), and the whole CLI runs against it through
// PERFIDIA_OPENROUTER_BASE_URL.
// - Plan time: the live records are read with no key; dearer prices, a per-request price, another
//   provider name, a missing parameter, a ZDR delisting or no `tool_choice: auto` refuse the run
//   (exit 3, nothing written, no chat request); a cheaper price or a degraded status is a warning.
// - `arena estimate` and `--fake` plan on the snapshot: no request at all.
// - `arena smoke --provider openrouter`: its bound printed before any request; without a key
//   nothing is sent; against the stub it passes.
// - A 1-day lockstep match of two OpenRouter seats (bot-backed brains behind the stub) and two bots:
//   Level E, every attempt charged at its card plus the 5.5% fee (OpenRouter's reported cost plus
//   that fee), the budget block under, `effortSent: low` in `seats.json`, no `parallel_tool_calls`,
//   and every request of a turn extends the previous one byte for byte.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyLog } from "@perfidia/engine";
import { BriefingSchema, type PlayerId } from "@perfidia/protocol";
import { memoryIo, readLog, type CliIo } from "@perfidia/sim";
import { ArenaReportSchema, SeatsFileSchema } from "../../log/schema.ts";
import { ModelError, type Entry, type UserPart } from "../../model/adapter.ts";
import { HARNESS_PREFIX, type Brain, type FakeReply } from "../../model/fake.ts";
import { costOf } from "../../model/prices.ts";
import { OPENROUTER_CARDS } from "../../model/prices/openrouter.ts";
import {
  CompatRequestSchema,
  EndpointsResponseSchema,
  ZdrResponseSchema,
  type CompatMessage,
  type CompatRequest,
  type PublicEndpoint,
} from "../../model/wire/compat.ts";
import { THOUGHT_ASK } from "../../seat/prompt.ts";
import { botBrain } from "../brain.ts";
import { main } from "../cli.ts";
import { arenaEnv, type ArenaRequest } from "../plan.ts";
import { RULESET, readCalls, runDir } from "../rig.test.ts";
import {
  OPENROUTER_SMOKE_MODEL,
  fetchLiveEndpoints,
  openrouterSmokePlan,
  planLive,
  usdPerTokenToPico,
} from "./openrouter.ts";

const KEY = "sk-or-v1-planted-wire-stub-0123456789abcdef";
const LONG = 120_000;
const FIX = join(import.meta.dir, "..", "..", "model", "fixtures", "openrouter");
const PIN = "z-ai/fp8";
const SEATS = [
  "p1=openrouter:z-ai/glm-5.3@z-ai/fp8:medium:odysseus",
  "p2=openrouter:z-ai/glm-5.3-flash@z-ai/fp8:medium:achilles",
  "p3=bot:expander@2",
  "p4=bot:turtle@3",
];
/** The bot each OpenRouter seat's brain replays behind the stub. */
const BRAINS: Readonly<Record<string, string>> = { p1: "bot:opportunist@3", p2: "bot:conqueror@3" };
const RUN_ARGS = [
  "run",
  "--seed",
  "1",
  "--id-key",
  "seed",
  "--days",
  "1",
  "--ruleset",
  RULESET,
  ...SEATS.flatMap((s) => ["--seat", s]),
  "--budget-usd",
  "5",
  "--quiet",
];
const REQUEST: ArenaRequest = {
  ruleset: RULESET,
  seed: 1,
  idKey: "seed",
  days: 1,
  seats: SEATS,
  budgetUsd: "5",
};
const NOW = (): number => Date.parse("2026-10-20T12:00:00.000Z");

function recorded(name: string): unknown {
  const v: unknown = JSON.parse(readFileSync(join(FIX, name), "utf8"));
  if (typeof v !== "object" || v === null) throw new Error(`${name}: not an object`);
  expect(Reflect.get(v, "synthetic")).toBe(false);
  return Reflect.get(v, "response");
}

const utf8 = new TextEncoder();
const bytes = (v: unknown): number => utf8.encode(JSON.stringify(v)).length;

function textOf(m: CompatMessage | undefined): string {
  if (m === undefined) return "";
  if (m.role === "user") {
    return typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join("");
  }
  return m.content ?? "";
}

interface Hit {
  readonly method: string;
  readonly path: string;
  readonly auth: string | null;
  readonly metadata: string | null;
  readonly accept: string | null;
}

interface StubOptions {
  /** Edits a live endpoint record before it is served. */
  readonly edit?: (model: string, e: PublicEndpoint) => void;
  /** Leaves `model@tag` out of the ZDR list. */
  readonly unlist?: string;
  /** Every request, in order, next to what the CLI printed. */
  readonly timeline?: string[];
  /** The status of every metadata request (default 200). */
  readonly metadataStatus?: number;
}

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** A string cut in two (a delta streamed over two chunks). */
const halves = (s: string): readonly [string, string] => [
  s.slice(0, Math.ceil(s.length / 2)),
  s.slice(Math.ceil(s.length / 2)),
];

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The message of what `p` rejects with (it must reject). */
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("resolved");
}

/** One SSE body: comments, `[DONE]`, or JSON chunks. */
function sse(events: readonly unknown[]): string {
  return events
    .map((e) =>
      typeof e === "string" && e.startsWith(":")
        ? `${e}\n\n`
        : `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`,
    )
    .join("");
}

/**
 * The stub of OpenRouter: the recorded metadata, and a chat endpoint whose replies come from one
 * bot-backed brain per seat (the bot's `RoundInput` rebuilt from the messages: the briefing is the
 * first user message, the turn header the next, the results the tool messages after the last
 * assistant message). Usage is about a token per 4 bytes, the stable prefix read from the seat's
 * second request on, and `cost` the card's price of it, fee excluded.
 */
function openrouterStub(o: StubOptions = {}) {
  const hits: Hit[] = [];
  const chats: CompatRequest[] = [];
  const brains = new Map<string, Brain>();
  const warm = new Set<string>();
  let n = 0;

  const endpoints = (model: string): unknown => {
    const file = join(FIX, `endpoints-${model.replace("/", "_")}.json`);
    if (!existsSync(file)) return null;
    const doc = EndpointsResponseSchema.parse(
      recorded(`endpoints-${model.replace("/", "_")}.json`),
    );
    for (const e of doc.data.endpoints) o.edit?.(model, e);
    return doc;
  };
  const zdr = (): unknown => {
    const doc = ZdrResponseSchema.parse(recorded("zdr.json"));
    return { data: doc.data.filter((e) => `${e.model_id}@${e.tag}` !== o.unlist) };
  };

  const reply = async (body: CompatRequest, briefingText: string): Promise<FakeReply> => {
    const briefing = BriefingSchema.parse(JSON.parse(briefingText));
    const header = /^\[harness\] Turn (\d+) · .+ · round trip 1 of (\d+), up to (\d+) calls\./.exec(
      textOf(body.messages[3]),
    );
    if (header === null) throw new Error("stub: no turn header after the briefing");
    const round = body.messages.filter((m) => m.role === "assistant").length;
    const results: UserPart[] = [];
    for (let i = body.messages.length - 1; i >= 0; i -= 1) {
      const m = body.messages[i];
      if (m === undefined || m.role === "assistant") break;
      if (m.role === "tool") {
        results.unshift({
          kind: "result",
          callId: m.tool_call_id,
          content: m.content,
          isError: false,
        });
      }
    }
    const entries: Entry[] = [{ role: "user", parts: [{ kind: "text", text: briefingText }] }];
    if (round > 0) entries.push({ role: "user", parts: results });
    const seat: PlayerId = briefing.you;
    let brain = brains.get(seat);
    if (brain === undefined) {
      brain = botBrain({ label: BRAINS[seat] ?? "bot:turtle@3", seat, seed: 1 });
      brains.set(seat, brain);
    }
    const thought = textOf(body.messages.at(-1)) === `${HARNESS_PREFIX}${THOUGHT_ASK}`;
    const out = await brain(
      {
        prompt: { shared: textOf(body.messages[0]), seat: textOf(body.messages[1]) },
        tools: [],
        entries,
        meta: {
          seat,
          turn: Number(header[1]),
          round,
          maxRounds: Number(header[2]),
          maxCalls: Number(header[3]),
          kind: thought ? "thought" : "round",
        },
      },
      n,
    );
    if (out instanceof ModelError) throw out;
    return out;
  };

  const stream = (body: CompatRequest, seat: string, r: FakeReply, finishLength: boolean) => {
    n += 1;
    const id = `gen-stub-${n}`;
    const head = {
      id,
      provider: "Z.AI",
      model: body.model,
      object: "chat.completion.chunk",
      created: 1792500000,
    };
    const chunk = (delta: object, finish: string | null = null, extra: object = {}) => ({
      ...head,
      choices: [{ index: 0, delta, finish_reason: finish, native_finish_reason: finish }],
      ...extra,
    });
    const events: unknown[] = [": OPENROUTER PROCESSING"];
    const reasoning = (r.reasoning ?? []).join("\n");
    if (reasoning !== "") {
      for (const [i, text] of halves(reasoning).entries()) {
        events.push(
          chunk({
            ...(i === 0 ? { role: "assistant" } : {}),
            content: "",
            reasoning_details: [{ type: "reasoning.text", text, format: "unknown", index: 0 }],
          }),
        );
      }
    }
    const text = (r.text ?? []).join("\n");
    if (text !== "") events.push(chunk({ content: text }));
    const calls = r.calls ?? [];
    for (const [i, c] of calls.entries()) {
      const [a, b] = halves(JSON.stringify(c.args ?? {}));
      events.push(
        chunk({
          content: "",
          tool_calls: [
            {
              index: i,
              id: `call_${id}_${i}`,
              type: "function",
              function: { name: c.name, arguments: a },
            },
          ],
        }),
        chunk({ content: "", tool_calls: [{ index: i, function: { arguments: b } }] }),
      );
    }
    const finish = finishLength ? "length" : calls.length > 0 ? "tool_calls" : "stop";
    const prompt = Math.ceil(bytes([body.messages, body.tools]) / 4);
    const prefix = Math.ceil(bytes([body.messages.slice(0, 2), body.tools]) / 4);
    const key = `${body.model} ${seat}`;
    const cached = warm.has(key) ? Math.min(prefix, prompt) : 0;
    warm.add(key);
    const completion = finishLength ? body.max_tokens : 40 + Math.ceil(bytes(r) / 4);
    const tokens = {
      input: prompt - cached,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: cached,
      output: completion,
    };
    const cost = costOf([{ model: body.model, kind: "message", tokens, estimated: false }], {
      provider: "openrouter",
      endpoint: PIN,
      at: new Date().toISOString(),
    });
    events.push(
      chunk({ content: "", role: "assistant" }, finish),
      chunk({ content: "", role: "assistant" }, finish, {
        usage: {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
          prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
          completion_tokens_details: {
            reasoning_tokens: Math.min(completion, Math.ceil(reasoning.length / 4)),
          },
          cost: (cost.nanoUsd - cost.feeNanoUsd) / 1e9,
          is_byok: false,
        },
        openrouter_metadata: {
          requested: body.model,
          strategy: "direct",
          endpoints: {
            total: 1,
            available: [{ provider: "Z.AI", model: body.model, selected: true }],
          },
          attempts: [{ provider: "Z.AI", model: body.model, status: 200 }],
        },
      }),
      "[DONE]",
    );
    return new Response(sse(events), {
      headers: { "content-type": "text/event-stream", "x-generation-id": id },
    });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      hits.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("authorization"),
        metadata: req.headers.get("x-openrouter-metadata"),
        accept: req.headers.get("accept"),
      });
      o.timeline?.push(`request ${req.method} ${url.pathname}`);
      const status = o.metadataStatus ?? 200;
      if (req.method === "GET" && url.pathname === "/api/v1/endpoints/zdr") {
        return Response.json(status === 200 ? zdr() : { error: { code: status } }, { status });
      }
      const m = /^\/api\/v1\/models\/(.+)\/endpoints$/.exec(url.pathname);
      if (req.method === "GET" && m !== null) {
        const doc = endpoints(decodeURIComponent(m[1] ?? ""));
        if (doc === null)
          return Response.json({ error: { code: 404, message: "Not Found" } }, { status: 404 });
        return Response.json(status === 200 ? doc : { error: { code: status } }, { status });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/chat/completions") {
        const body = CompatRequestSchema.parse(await req.json());
        chats.push(body);
        const first = textOf(body.messages[2]);
        if (first === '{"preflight":true}') {
          return stream(body, "preflight", { text: ["ok"], reasoning: ["Checking."] }, true);
        }
        const seat = BriefingSchema.parse(JSON.parse(first)).you;
        return stream(body, seat, await reply(body, first), false);
      }
      return Response.json({ error: { code: 404, message: "Not Found" } }, { status: 404 });
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}/api/v1`, hits, chats };
}

function envOf(base: string, key: string | null = KEY): Record<string, string> {
  return {
    PERFIDIA_OPENROUTER_BASE_URL: base,
    ...(key === null ? {} : { PERFIDIA_OPENROUTER_API_KEY: key }),
  };
}

/** A `CliIo` that also writes into `timeline` (what was printed, next to the stub's requests). */
function timedIo(timeline: string[]): CliIo & { stdout(): string; stderr(): string } {
  const io = memoryIo();
  return {
    out: (t) => {
      timeline.push(`out ${t}`);
      io.out(t);
    },
    err: (t) => {
      timeline.push(`err ${t}`);
      io.err(t);
    },
    stdout: () => io.stdout(),
    stderr: () => io.stderr(),
  };
}

describe("OpenRouter's live metadata at plan time", () => {
  test("prices as the endpoints JSON writes them, in pico-dollars per token, rounded up", () => {
    expect(usdPerTokenToPico("0.0000014")).toBe(1_400_000);
    expect(usdPerTokenToPico("0.00000026")).toBe(260_000);
    expect(usdPerTokenToPico("0.00000015")).toBe(150_000);
    expect(usdPerTokenToPico("2")).toBe(2_000_000_000_000);
    expect(usdPerTokenToPico("0.0000000000001")).toBe(1);
    expect(usdPerTokenToPico("0")).toBe(0);
    expect(() => usdPerTokenToPico("-1")).toThrow("not a price");
    expect(() => usdPerTokenToPico("1e-6")).toThrow("not a price");
  });

  test("the records of the pins and the ZDR list, read with no key", async () => {
    const stub = openrouterStub();
    const live = await fetchLiveEndpoints(
      [
        { model: "z-ai/glm-5.3", endpoint: PIN },
        { model: "z-ai/glm-5.3-flash", endpoint: PIN },
        { model: "z-ai/glm-5.3", endpoint: PIN },
      ],
      { baseURL: stub.base, checked: "2026-10-20" },
    );
    // One request for the ZDR list and one per model; no key, no metadata opt-in.
    expect(stub.hits.map((h) => `${h.method} ${h.path}`)).toEqual([
      "GET /api/v1/endpoints/zdr",
      "GET /api/v1/models/z-ai/glm-5.3/endpoints",
      "GET /api/v1/models/z-ai/glm-5.3-flash/endpoints",
    ]);
    expect(stub.hits.every((h) => h.auth === null && h.metadata === null)).toBe(true);
    const e = live.endpoints.get(`z-ai/glm-5.3@${PIN}`);
    expect(e?.providerName).toBe("Z.AI");
    expect(e?.pricing).toMatchObject({ prompt: "0.0000014", completion: "0.0000044" });
    expect(e?.info).toMatchObject({
      tag: PIN,
      quantization: "fp8",
      contextTokens: 1_048_576,
      maxCompletionTokens: 131_072,
      zdr: true,
      implicitCaching: true,
      checked: "2026-10-20",
    });
    expect(e?.info.supportedParams).toContain("reasoning");
    expect(e?.info.supportedParams).not.toContain("parallel_tool_calls");
    // Together serves GLM-5.3 but is not in the trimmed ZDR list.
    expect(live.endpoints.get("z-ai/glm-5.3@together")?.info.zdr).toBe(false);
    expect(live.source("z-ai/glm-5.3-flash", PIN)?.zdr).toBe(true);
    expect(live.source("z-ai/glm-5.3", "nowhere")).toBeUndefined();
  });

  test("a metadata request that fails refuses the plan: nothing is sent to a model", async () => {
    const stub = openrouterStub({ metadataStatus: 503 });
    const run = fetchLiveEndpoints([{ model: "z-ai/glm-5.3", endpoint: PIN }], {
      baseURL: stub.base,
      checked: "2026-10-20",
    });
    expect(await failure(run)).toBe(
      `OpenRouter's metadata answered HTTP 503 (${stub.base}/endpoints/zdr); nothing was sent to a model`,
    );
  });

  test("a real run's plan reads the live records: accepted as they were recorded", async () => {
    const stub = openrouterStub();
    const plan = await planLive(REQUEST, arenaEnv(envOf(stub.base)), { now: NOW });
    expect(stub.hits.map((h) => h.method)).toEqual(["GET", "GET", "GET"]);
    expect(stub.chats).toEqual([]);
    expect(plan.warnings.filter((w) => w.includes("OpenRouter now bills"))).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("medium is sent as low"))).toBe(true);
  });

  test("a cheaper live price, a negative status or another quantization: warnings only", async () => {
    const stub = openrouterStub({
      edit: (model, e) => {
        if (model !== "z-ai/glm-5.3" || e.tag !== PIN) return;
        e.pricing.completion = "0.000004";
        e.status = -2;
        e.quantization = "fp4";
      },
    });
    const plan = await planLive(REQUEST, arenaEnv(envOf(stub.base)), { now: NOW });
    expect(plan.warnings).toContain(
      "p1: z-ai/glm-5.3@z-ai/fp8: OpenRouter now bills less than the card openrouter:z-ai/glm-5.3(z-ai/fp8)@2026-10-20 (completion $4/M < $4.4/M): the ledger over-charges, and arena reconcile shows by how much",
    );
    expect(plan.warnings.some((w) => w.includes("reports the endpoint's status -2"))).toBe(true);
    expect(plan.warnings).toContain(
      "p1: z-ai/glm-5.3@z-ai/fp8: the live quantization is fp4, the 2026-10-20 snapshot's fp8",
    );
  });

  const refusals: readonly (readonly [string, StubOptions, string])[] = [
    [
      "a dearer prompt price",
      {
        edit: (m, e) =>
          void (m === "z-ai/glm-5.3" && e.tag === PIN && (e.pricing.prompt = "0.0000015")),
      },
      "p1: z-ai/glm-5.3@z-ai/fp8: OpenRouter now bills prompt $1.5/M (the card: $1.4/M), over the card openrouter:z-ai/glm-5.3(z-ai/fp8)@2026-10-20: the ledger would charge less than the bill",
    ],
    [
      "a dearer time-of-day override",
      {
        edit: (m, e) =>
          void (
            m === "z-ai/glm-5.3-flash" &&
            e.tag === PIN &&
            (e.pricing.overrides = [{ completion: "0.0000006" }])
          ),
      },
      "p2: z-ai/glm-5.3-flash@z-ai/fp8: OpenRouter now bills completion $0.6/M (the card: $0.5/M)",
    ],
    [
      "a per-request price",
      {
        edit: (m, e) =>
          void (m === "z-ai/glm-5.3" && e.tag === PIN && (e.pricing.request = "0.001")),
      },
      "a per-request price (no card has one)",
    ],
    [
      "another provider behind the slug",
      {
        edit: (m, e) =>
          void (m === "z-ai/glm-5.3" && e.tag === PIN && (e.provider_name = "Together")),
      },
      'p1: z-ai/glm-5.3@z-ai/fp8: OpenRouter names its provider "Together", not "Z.AI"',
    ],
    [
      "a parameter the request sends, no longer listed",
      {
        edit: (m, e) =>
          void (
            m === "z-ai/glm-5.3" &&
            e.tag === PIN &&
            (e.supported_parameters = e.supported_parameters.filter((p) => p !== "reasoning"))
          ),
      },
      "p1: z-ai/glm-5.3@z-ai/fp8 does not list reasoning in its supported parameters",
    ],
    [
      "tool_choice auto not taken",
      {
        edit: (m, e) =>
          void (
            m === "z-ai/glm-5.3" &&
            e.tag === PIN &&
            (e.supports_tool_choice = { auto: false })
          ),
      },
      'p1: z-ai/glm-5.3@z-ai/fp8 does not take tool_choice "auto" (live /endpoints)',
    ],
    [
      "the pin out of the ZDR list",
      { unlist: `z-ai/glm-5.3-flash@${PIN}` },
      "p2: z-ai/glm-5.3-flash@z-ai/fp8 is not in OpenRouter's zero-data-retention list",
    ],
    [
      "an output limit under twice max_tokens",
      {
        edit: (m, e) =>
          void (m === "z-ai/glm-5.3" && e.tag === PIN && (e.max_completion_tokens = 40_000)),
      },
      "p1: z-ai/glm-5.3@z-ai/fp8 returns at most 40000 output tokens (live /endpoints), under twice maxTokens 32768 (the max_tokens retry)",
    ],
  ];
  for (const [what, o, message] of refusals) {
    test(`refused at plan time: ${what}`, async () => {
      const stub = openrouterStub(o);
      expect(await failure(planLive(REQUEST, arenaEnv(envOf(stub.base)), { now: NOW }))).toContain(
        message,
      );
      expect(stub.chats).toEqual([]);
    });
  }

  test("arena run refused at plan time: exit 3, nothing written, no chat request, no key printed", async () => {
    const stub = openrouterStub({
      edit: (m, e) =>
        void (m === "z-ai/glm-5.3" && e.tag === PIN && (e.pricing.prompt = "0.0000015")),
    });
    const dir = runDir("refused");
    const io = memoryIo();
    const code = await main([...RUN_ARGS, "--out", dir], io, envOf(stub.base));
    expect(code).toBe(3);
    expect(io.stderr()).toContain("OpenRouter now bills prompt $1.5/M");
    expect(existsSync(dir)).toBe(false);
    expect(stub.hits.every((h) => h.method === "GET")).toBe(true);
    expect(`${io.stdout()}${io.stderr()}`).not.toContain(KEY);
  });

  test("arena estimate and a --fake plan read the snapshot: no request at all", async () => {
    const stub = openrouterStub();
    const io = memoryIo();
    const estimate = await main(
      ["estimate", "--ruleset", RULESET, "--days", "1", ...SEATS.flatMap((s) => ["--seat", s])],
      io,
      envOf(stub.base),
    );
    expect(estimate).toBe(0);
    const fake = await planLive({ ...REQUEST, fake: true }, arenaEnv(envOf(stub.base)), {
      now: NOW,
    });
    expect(fake.fake).toBe(true);
    expect(stub.hits).toEqual([]);
  });
});

describe("arena smoke --provider openrouter", () => {
  test("its bound, under $0.05 on GLM-5.3 Flash, is printed before anything is sent", async () => {
    const plan = await openrouterSmokePlan({
      model: OPENROUTER_SMOKE_MODEL,
      endpoint: PIN,
      effort: "medium",
      ruleset: "perfidia-1",
      at: "2026-10-20T12:00:00.000Z",
    });
    expect(plan.boundNano).toBeGreaterThan(0);
    expect(plan.boundNano).toBeLessThan(50_000_000);
    const timeline: string[] = [];
    const stub = openrouterStub({ timeline });
    const io = timedIo(timeline);
    const code = await main(["smoke", "--provider", "openrouter"], io, envOf(stub.base), {
      nowMs: NOW,
    });
    expect(io.stderr()).toBe("");
    expect(code).toBe(0);
    expect(timeline[0]).toMatch(
      /^out smoke: openrouter z-ai\/glm-5\.3-flash@z-ai\/fp8 at medium \(sent as low, the nearest level the model lists; unverified\) on http:\/\/127\.0\.0\.1:\d+\/api\/v1, at most \$0\.\d+ \(OpenRouter's 5\.5% credit fee included\)\n$/,
    );
    expect(timeline.slice(1, 3)).toEqual([
      "request GET /api/v1/models/z-ai/glm-5.3-flash/endpoints",
      "request POST /api/v1/chat/completions",
    ]);
    expect(timeline[3]).toStartWith("out 1. preflight: ok");
    expect(io.stdout()).toContain("smoke: ok\n");
    expect(io.stdout()).toContain("served by z-ai/glm-5.3-flash on z-ai/fp8");
    // Two chat requests, both pinned, at the effort OpenRouter takes, with the key in the header only.
    expect(stub.chats.map((c) => [c.max_tokens, c.reasoning?.effort, c.provider?.only])).toEqual([
      [16, "low", [PIN]],
      [4_000, "low", [PIN]],
    ]);
    const posts = stub.hits.filter((h) => h.method === "POST");
    expect(posts.every((h) => h.auth === `Bearer ${KEY}` && h.metadata === "enabled")).toBe(true);
    expect(stub.hits.every((h) => !h.path.includes(KEY))).toBe(true);
    expect(`${io.stdout()}${io.stderr()}`).not.toContain(KEY);
  });

  test("without PERFIDIA_OPENROUTER_API_KEY: the bound, then exit 3, and nothing sent", async () => {
    const stub = openrouterStub();
    const io = memoryIo();
    const code = await main(["smoke", "--provider", "openrouter"], io, envOf(stub.base, null), {
      nowMs: NOW,
    });
    expect(code).toBe(3);
    expect(io.stdout()).toContain("smoke: openrouter z-ai/glm-5.3-flash@z-ai/fp8 at medium");
    expect(io.stderr()).toContain("makes one live API call (at most $0.");
    expect(io.stderr()).toContain("set PERFIDIA_OPENROUTER_API_KEY first. Nothing was sent.");
    expect(stub.hits).toEqual([]);
  });

  test("a model or an endpoint that is not a pin, or a bad effort: usage errors, nothing sent", async () => {
    const stub = openrouterStub();
    const cases: readonly (readonly [readonly string[], string])[] = [
      [["--model", "z-ai/glm-4"], "--model z-ai/glm-4 is not an OpenRouter seat model"],
      [
        ["--endpoint", "together"],
        "--endpoint together is not a pinnable endpoint of z-ai/glm-5.3-flash",
      ],
      [
        ["--effort", "loud"],
        '--effort must be one of none, minimal, low, medium, high, xhigh, max, got "loud"',
      ],
      [
        ["--provider", "anthropic", "--endpoint", PIN],
        "--endpoint applies to --provider openrouter only",
      ],
    ];
    for (const [flags, message] of cases) {
      const io = memoryIo();
      const argv = flags.includes("--provider")
        ? ["smoke", ...flags]
        : ["smoke", "--provider", "openrouter", ...flags];
      // oxlint-disable-next-line no-await-in-loop -- one CLI call per case
      const code = await main(argv, io, envOf(stub.base), { nowMs: NOW });
      expect(code).toBe(3);
      expect(io.stderr()).toContain(message);
    }
    expect(stub.hits).toEqual([]);
  });
});

describe("a 1-day lockstep match on the OpenRouter wire stub", () => {
  test(
    "Level E, card costs plus the fee, the reported cost logged, the budget under, effortSent, stable prefixes",
    async () => {
      const stub = openrouterStub();
      const dir = runDir("wire");
      const io = memoryIo();
      const code = await main([...RUN_ARGS, "--out", dir], io, envOf(stub.base));
      expect(io.stderr()).not.toContain("error");
      expect(code).toBe(0);
      expect(`${io.stdout()}${io.stderr()}`).not.toContain(KEY);
      expect(verifyLog(readLog(join(dir, "match.jsonl"))).ok).toBe(true);

      // Plan time: the metadata; then the start preflight (one listing and one shape check per group).
      const gets = stub.hits.filter((h) => h.method === "GET").map((h) => h.path);
      expect(gets.toSorted(byName)).toEqual([
        "/api/v1/endpoints/zdr",
        "/api/v1/models/z-ai/glm-5.3-flash/endpoints",
        "/api/v1/models/z-ai/glm-5.3-flash/endpoints",
        "/api/v1/models/z-ai/glm-5.3/endpoints",
        "/api/v1/models/z-ai/glm-5.3/endpoints",
      ]);
      for (const h of stub.hits.filter((x) => x.method === "POST")) {
        expect([h.auth, h.metadata, h.accept]).toEqual([
          `Bearer ${KEY}`,
          "enabled",
          "text/event-stream",
        ]);
      }

      // Every request: pinned to the full slug, no fallback, ZDR, only the listed parameters.
      expect(stub.chats.length).toBeGreaterThan(10);
      for (const c of stub.chats) {
        expect(c.provider).toEqual({
          only: [PIN],
          allow_fallbacks: false,
          require_parameters: true,
          data_collection: "deny",
          zdr: true,
        });
        expect(c.reasoning).toEqual({ effort: "low" });
        expect(Object.keys(c)).not.toContain("parallel_tool_calls");
        expect(c.tool_choice).toBe("auto");
      }

      // Prefix stability: within a turn, every request extends the previous one unchanged (the
      // assistant messages echoed as they came, reasoning details included); the two system blocks
      // and the tools never change for a seat.
      const bySeat = new Map<string, CompatRequest[]>();
      for (const c of stub.chats) {
        const first = textOf(c.messages[2]);
        if (first === '{"preflight":true}') continue;
        const seat = BriefingSchema.parse(JSON.parse(first)).you;
        bySeat.set(seat, [...(bySeat.get(seat) ?? []), c]);
      }
      expect([...bySeat.keys()].toSorted(byName)).toEqual(["p1", "p2"]);
      let extended = 0;
      let echoedDetails = 0;
      for (const list of bySeat.values()) {
        const stable = JSON.stringify([list[0]?.messages.slice(0, 2), list[0]?.tools]);
        for (const [i, c] of list.entries()) {
          expect(JSON.stringify([c.messages.slice(0, 2), c.tools])).toBe(stable);
          const prev = list[i - 1];
          if (prev === undefined || textOf(prev.messages[2]) !== textOf(c.messages[2])) continue;
          expect(JSON.stringify(c.messages.slice(0, prev.messages.length))).toBe(
            JSON.stringify(prev.messages),
          );
          extended += 1;
          for (const m of c.messages) {
            if (m.role === "assistant" && (m.reasoning_details?.length ?? 0) > 0)
              echoedDetails += 1;
          }
        }
      }
      expect(extended).toBeGreaterThan(0);
      expect(echoedDetails).toBeGreaterThan(0);

      // Money: every attempt at its card plus the 5.5% fee, which is OpenRouter's reported cost plus
      // that fee; the totals are sums of logged lines; the budget block is under.
      const calls = readCalls(dir);
      const priced = calls.flatMap((l) => (l.k === "llm_call" || l.k === "preflight" ? [l] : []));
      const llm = calls.flatMap((l) => (l.k === "llm_call" ? [l] : []));
      expect(llm.length).toBeGreaterThan(0);
      const cardOf = (model: string) =>
        OPENROUTER_CARDS.find((c) => c.model === model && c.endpoint === PIN)?.id;
      for (const l of llm) {
        expect(l.provider).toBe("openrouter");
        expect(l.endpoint).toBe(PIN);
        expect(l.error).toBeNull();
        expect(l.priceCard).toBe(cardOf(l.model));
        expect(l.reasoningKind).toBe("raw");
        expect(l.reportedCostNanoUsd).toBeGreaterThan(0);
        expect(l.feeNanoUsd).toBe(Math.ceil(((l.reportedCostNanoUsd ?? 0) * 55) / 1000));
        expect(l.costNanoUsd).toBe((l.reportedCostNanoUsd ?? 0) + (l.feeNanoUsd ?? 0));
        expect(l.unpriced).toEqual([]);
      }
      const report = ArenaReportSchema.parse(
        JSON.parse(readFileSync(join(dir, "arena.json"), "utf8")),
      );
      expect(report.totals.costNanoUsd).toBe(priced.reduce((n, l) => n + l.costNanoUsd, 0));
      expect(report.budget.under).toBe(true);
      expect(report.budget.killSwitch).toBeNull();

      // seats.json records the effort OpenRouter takes (C9): medium is sent as low.
      const seats = SeatsFileSchema.parse(
        JSON.parse(readFileSync(join(dir, "seats.json"), "utf8")),
      );
      const llmSeats = seats.seats.flatMap((s) => (s.kind === "llm" ? [s] : []));
      expect(llmSeats.map((s) => [s.seat, s.provider, s.endpoint, s.effort, s.effortSent])).toEqual(
        [
          ["p1", "openrouter", PIN, "medium", "low"],
          ["p2", "openrouter", PIN, "medium", "low"],
        ],
      );
    },
    LONG,
  );
});
