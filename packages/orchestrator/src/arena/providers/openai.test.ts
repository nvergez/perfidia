// The OpenAI provider end to end (phase-4 design §8.4–§8.5, Pass 2), with no network: a local
// `Bun.serve` stub on 127.0.0.1 speaks the Responses API (`GET /models/{id}`, streamed
// `POST /responses`, `POST /responses/input_tokens`), driven by the bot-backed brain, and the real
// adapter reaches it through the real CLI (`arena run`, `arena smoke --provider openai`) with
// `PERFIDIA_OPENAI_BASE_URL` pointing at it. Checked: Level E, costs from OpenAI's cards, the budget
// block, one fetch per attempt, the key in the header only and nowhere in the run directory, every
// request valid against the wire schema, and prefix stability (each request of a turn extends the
// previous one, byte for byte, and the stable blocks and tools never change).

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { verifyLog } from "@perfidia/engine";
import { BriefingSchema, type PlayerId } from "@perfidia/protocol";
import { memoryIo, readLog } from "@perfidia/sim";
import { ArenaReportSchema, SeatsFileSchema, type LlmLogLine } from "../../log/schema.ts";
import type { ChatRequest, Entry, ModelCall, UserPart } from "../../model/adapter.ts";
import { costOf, formatUsd } from "../../model/prices.ts";
import { ResponsesRequestSchema } from "../../model/wire/openai.ts";
import { THOUGHT_ASK } from "../../seat/prompt.ts";
import { botBrain } from "../brain.ts";
import { main } from "../cli.ts";
import { arenaEnv, planArena } from "../plan.ts";
import { readCalls, runDir } from "../rig.test.ts";
import { openaiBaseUrlProblem } from "./openai.ts";

const LONG = 180_000;
const KEY = "sk-test-wire-stub-openai-0123456789";

// The wire stub -------------------------------------------------------------------------------------

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const textsOf = (item: unknown): string[] =>
  arr(rec(item)["content"]).flatMap((c) => {
    const t = rec(c)["text"];
    return typeof t === "string" ? [t] : [];
  });

const HEADER = /^Turn (\d+) · .+ · round trip 1 of (\d+), up to (\d+) calls\./;

/** A Responses request as the seat's conversation: what the bot-backed brain reads. */
function decode(body: unknown): { readonly req: ChatRequest; readonly preflight: boolean } {
  const input = arr(rec(body)["input"]);
  const [shared, seatBlock, ...items] = input;
  const entries: Entry[] = [];
  let user: UserPart[] | null = null;
  let assistant: unknown[] | null = null;
  const flushUser = (): void => {
    if (user !== null) entries.push({ role: "user", parts: user });
    user = null;
  };
  const flushAssistant = (): void => {
    if (assistant === null) return;
    const calls: ModelCall[] = assistant.flatMap((i) => {
      const r = rec(i);
      return r["type"] === "function_call"
        ? [
            {
              callId: String(r["call_id"]),
              name: String(r["name"]),
              args: JSON.parse(String(r["arguments"])) as unknown,
            },
          ]
        : [];
    });
    entries.push({
      role: "assistant",
      reply: { native: assistant, text: [], calls, reasoning: [] },
    });
    assistant = null;
  };
  for (const item of items) {
    const r = rec(item);
    if (r["type"] === "function_call_output") {
      flushAssistant();
      (user ??= []).push({
        kind: "result",
        callId: String(r["call_id"]),
        content: String(r["output"]),
        isError: false,
      });
    } else if (r["type"] === "message" && r["role"] === "user") {
      flushAssistant();
      (user ??= []).push(...textsOf(item).map((text) => ({ kind: "text" as const, text })));
    } else if (r["type"] === "message" && r["role"] === "developer") {
      flushAssistant();
      flushUser();
      entries.push({ role: "operator", text: textsOf(item).join("") });
    } else {
      flushUser();
      (assistant ??= []).push(item);
    }
  }
  flushAssistant();
  flushUser();
  const first = entries[0];
  const briefingText =
    first?.role === "user" && first.parts[0]?.kind === "text" ? first.parts[0].text : "";
  const header = entries.find((e) => e.role === "operator");
  const m = HEADER.exec(header?.role === "operator" ? header.text : "");
  const preflight = briefingText === '{"preflight":true}';
  const last = entries.at(-1);
  const seat: PlayerId = preflight ? "p1" : BriefingSchema.parse(JSON.parse(briefingText)).you;
  return {
    preflight,
    req: {
      prompt: { shared: textsOf(shared).join(""), seat: textsOf(seatBlock).join("") },
      tools: [],
      entries,
      meta: {
        seat,
        turn: Number(m?.[1] ?? 0),
        round: entries.filter((e) => e.role === "assistant").length,
        maxRounds: Number(m?.[2] ?? 8),
        maxCalls: Number(m?.[3] ?? 10),
        kind: last?.role === "operator" && last.text === THOUGHT_ASK ? "thought" : "round",
      },
    },
  };
}

const tokens = (v: unknown): number =>
  Math.ceil(new TextEncoder().encode(JSON.stringify(v)).length / 4);

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly headerNames: readonly string[];
  readonly body: unknown;
  readonly preflight: boolean;
  readonly seat: PlayerId | null;
  readonly turn: number;
}

/** The stub: a Responses API on loopback whose replies come from one bot brain per seat. */
function wireStub(brains: Readonly<Record<string, string>>) {
  const seen: Seen[] = [];
  const invalid: string[] = [];
  const brainOf = new Map<string, ReturnType<typeof botBrain>>();
  /** Per seat, the previous request's input (the implicit cache's last write). */
  const lastInput = new Map<string, unknown[]>();
  /** The stable prefixes (tools and both blocks) written so far. */
  const stableCached = new Set<string>();
  let n = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const names: string[] = [];
      request.headers.forEach((_v, k) => names.push(k));
      const base = {
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        headerNames: names,
      };
      if (request.method === "GET" && url.pathname.startsWith("/v1/models/")) {
        seen.push({ ...base, body: null, preflight: true, seat: null, turn: 0 });
        const id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
        return Response.json({ id, object: "model", created: 0, owned_by: "openai" });
      }
      const body: unknown = await request.json();
      if (url.pathname === "/v1/responses/input_tokens") {
        seen.push({ ...base, body, preflight: true, seat: null, turn: 0 });
        return Response.json({
          object: "response.input_tokens",
          input_tokens: tokens(rec(body)["input"]),
        });
      }
      if (url.pathname !== "/v1/responses") return new Response("not found", { status: 404 });
      const check = ResponsesRequestSchema.safeParse(body);
      if (!check.success) invalid.push(check.error.message.slice(0, 300));
      const { req, preflight } = decode(body);
      seen.push({
        ...base,
        body,
        preflight,
        seat: preflight ? null : req.meta.seat,
        turn: req.meta.turn,
      });
      n += 1;
      const b = rec(body);
      const model = String(b["model"]);
      const input = arr(b["input"]);
      const total = tokens({ tools: b["tools"], input });
      // Caching as the guide describes it: the previous request's prefix is read (implicit
      // breakpoints), else the stable blocks once written (the seat block's explicit breakpoint);
      // the rest up to the end is written.
      const stable = JSON.stringify({ tools: b["tools"], input: input.slice(0, 2) });
      const prev = preflight ? undefined : lastInput.get(req.meta.seat);
      const reused =
        prev !== undefined && JSON.stringify(input.slice(0, prev.length)) === JSON.stringify(prev)
          ? tokens({ tools: b["tools"], input: prev })
          : stableCached.has(stable)
            ? tokens({ tools: b["tools"], input: input.slice(0, 2) })
            : 0;
      stableCached.add(stable);
      if (!preflight) lastInput.set(req.meta.seat, input);
      const created = {
        type: "response.created",
        sequence_number: 0,
        response: { id: `resp_${n}`, object: "response", status: "in_progress", model, output: [] },
      };
      if (preflight) {
        const usage = {
          input_tokens: total,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: total },
          output_tokens: 16,
          output_tokens_details: { reasoning_tokens: 16 },
          total_tokens: total + 16,
        };
        const done = {
          type: "response.incomplete",
          sequence_number: 1,
          response: {
            id: `resp_${n}`,
            object: "response",
            status: "incomplete",
            model,
            incomplete_details: { reason: "max_output_tokens" },
            output: [],
            service_tier: "default",
            usage,
          },
        };
        return sseResponse([created, done], n);
      }
      let brain = brainOf.get(req.meta.seat);
      if (brain === undefined) {
        brain = botBrain({
          label: brains[req.meta.seat] ?? "bot:turtle@3",
          seat: req.meta.seat,
          seed: 1,
        });
        brainOf.set(req.meta.seat, brain);
      }
      const reply = await brain(req, n);
      if (reply instanceof Error) throw reply;
      const output: unknown[] = [
        {
          id: `rs_${n}`,
          type: "reasoning",
          summary: (reply.reasoning ?? []).map((text) => ({ type: "summary_text", text })),
          encrypted_content: `enc_${n}_${"x".repeat(64)}`,
        },
        ...((reply.text ?? []).length === 0
          ? []
          : [
              {
                id: `msg_${n}`,
                type: "message",
                status: "completed",
                role: "assistant",
                phase: (reply.calls ?? []).length === 0 ? "final_answer" : "commentary",
                content: (reply.text ?? []).map((text) => ({
                  type: "output_text",
                  text,
                  annotations: [],
                  logprobs: [],
                })),
              },
            ]),
        ...(reply.calls ?? []).map((c, i) => ({
          type: "function_call",
          id: `fc_${n}_${i}`,
          call_id: `call_${n}_${i}`,
          name: c.name,
          arguments: JSON.stringify(c.args),
          status: "completed",
        })),
      ];
      const out = 200 + tokens(output);
      const usage = {
        input_tokens: total,
        input_tokens_details: { cached_tokens: reused, cache_write_tokens: total - reused },
        output_tokens: out,
        output_tokens_details: { reasoning_tokens: 150 },
        total_tokens: total + out,
      };
      const delta = {
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: `msg_${n}`,
        output_index: 1,
        content_index: 0,
        delta: "…",
      };
      const done = {
        type: "response.completed",
        sequence_number: 2,
        response: {
          id: `resp_${n}`,
          object: "response",
          status: "completed",
          model,
          output,
          service_tier: "default",
          reasoning: { effort: rec(b["reasoning"])["effort"], summary: "auto" },
          usage,
        },
      };
      return sseResponse([created, delta, done], n);
    },
  });
  return { server, seen, invalid, url: `http://127.0.0.1:${server.port}/v1` };
}

function sseResponse(events: readonly unknown[], n: number): Response {
  const text = events
    .map((e) => `event: ${String(rec(e)["type"])}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new Response(text, {
    headers: { "content-type": "text/event-stream", "x-request-id": `req_stub_${n}` },
  });
}

const stubs: { stop(force?: boolean): unknown }[] = [];
afterAll(() => {
  for (const s of stubs) void s.stop(true);
});

const filesOf = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
};

// The match -----------------------------------------------------------------------------------------

describe("arena run with OpenAI seats against a wire stub (one game day, lockstep)", () => {
  test(
    "Level E, OpenAI's cards, the budget block, one fetch per attempt, the key in the header only, stable prefixes",
    async () => {
      const stub = wireStub({ p1: "bot:opportunist@3", p2: "bot:conqueror@3" });
      stubs.push(stub.server);
      const dir = runDir("openai-wire");
      const io = memoryIo();
      const code = await main(
        [
          "run",
          "--seat",
          "p1=openai:gpt-6.1-sol:medium:achilles",
          "--seat",
          "p2=openai:gpt-6-luna:low:penelope",
          "--seat",
          "p3=bot:expander@2",
          "--seat",
          "p4=bot:turtle@3",
          "--days",
          "1",
          "--seed",
          "1",
          "--id-key",
          "seed",
          "--budget-usd",
          "20",
          "--quiet",
          "--out",
          dir,
        ],
        io,
        { PERFIDIA_OPENAI_API_KEY: KEY, PERFIDIA_OPENAI_BASE_URL: stub.url },
      );
      expect(code).toBe(0);
      expect(stub.invalid).toEqual([]);

      const report = ArenaReportSchema.parse(
        JSON.parse(readFileSync(join(dir, "arena.json"), "utf8")),
      );
      expect([report.status, report.levelE?.ok, report.fake]).toEqual(["ended", true, false]);
      expect(verifyLog(readLog(join(dir, "match.jsonl"))).ok).toBe(true);

      const seats = SeatsFileSchema.parse(
        JSON.parse(readFileSync(join(dir, "seats.json"), "utf8")),
      );
      const llm = seats.seats.flatMap((s) => (s.kind === "llm" ? [s] : []));
      expect(
        llm.map((s) => [s.seat, s.label, s.promptVariant, s.reasoningContext ?? null, s.reminders]),
      ).toEqual([
        [
          "p1",
          "llm:openai/gpt-6.1-sol/medium:achilles@1:p2-dev",
          "developer",
          "all_turns",
          "last-round",
        ],
        ["p2", "llm:openai/gpt-6-luna/low:penelope@1:p2-dev", "developer", null, "last-round"],
      ]);

      // Every attempt: an OpenAI card, recomputed from its usage; summaries; no error.
      const calls = readCalls(dir);
      const attempts = calls.flatMap((l) => (l.k === "llm_call" ? [l] : []));
      expect(attempts.length).toBeGreaterThan(10);
      for (const l of attempts) {
        const cost = costOf(
          l.usage.map((u) => ({
            model: u.model,
            kind: u.kind,
            estimated: u.estimated,
            tokens: {
              input: u.input,
              cacheWrite5m: u.cacheWrite5m,
              cacheWrite1h: u.cacheWrite1h,
              cacheRead: u.cacheRead,
              output: u.output,
            },
          })),
          { provider: "openai", endpoint: null, at: "2026-10-20T12:00:00Z" },
        );
        expect([l.seat, l.error, l.costNanoUsd, l.priceCard, l.reasoningKind]).toEqual([
          l.seat,
          null,
          cost.nanoUsd,
          `openai:${l.model}@2026-10-20`,
          "summary",
        ]);
        expect(["tool_use", "end_turn"]).toContain(l.stop);
        expect(l.usage.every((u) => !u.estimated && u.reasoning === 150)).toBe(true);
      }
      expect(new Set(attempts.map((l) => l.model))).toEqual(new Set(["gpt-6.1-sol", "gpt-6-luna"]));
      // Within a turn, every request after the first reads the cache.
      const firsts = new Set<string>();
      for (const l of attempts) {
        const key = `${l.seat}:${l.turn}`;
        if (firsts.has(key)) expect(l.usage[0]?.cacheRead ?? 0).toBeGreaterThan(0);
        firsts.add(key);
      }

      // The budget block: sums of the logged lines, under the budget, no kill.
      const logged = calls.reduce(
        (n, l: LlmLogLine) => n + (l.k === "llm_call" || l.k === "preflight" ? l.costNanoUsd : 0),
        0,
      );
      expect(report.budget.actualNanoUsd).toBe(logged);
      expect(report.budget.feesNanoUsd).toBe(0);
      expect(report.budget.under).toBe(true);
      expect(report.budget.killSwitch).toBeNull();
      const preflights = calls.flatMap((l) => (l.k === "preflight" ? [l] : []));
      expect(preflights.map((l) => [l.phase, l.provider, l.model, l.ok])).toEqual([
        ["start", "openai", "gpt-6.1-sol", true],
        ["start", "openai", "gpt-6-luna", true],
      ]);

      // One fetch per attempt; the preflight's model check and shape check per group.
      const posts = stub.seen.filter((s) => s.method === "POST" && s.path === "/v1/responses");
      expect(posts.filter((s) => !s.preflight).length).toBe(attempts.length);
      expect(posts.filter((s) => s.preflight).length).toBe(2);
      expect(stub.seen.filter((s) => s.method === "GET").map((s) => s.path)).toEqual([
        "/v1/models/gpt-6.1-sol",
        "/v1/models/gpt-6-luna",
      ]);
      // The key in the authorization header only, no other credential header, nothing else leaks.
      for (const s of stub.seen) {
        expect(s.authorization).toBe(`Bearer ${KEY}`);
        expect(s.path.includes(KEY)).toBe(false);
        expect(s.headerNames.filter((h) => /key|token|cookie|openai-/i.test(h))).toEqual([]);
      }
      for (const f of filesOf(dir)) expect(readFileSync(f, "utf8").includes(KEY)).toBe(false);
      expect(io.stdout().includes(KEY) || io.stderr().includes(KEY)).toBe(false);

      // Prefix stability: per seat, the stable blocks and every field but the input and the
      // output limit never change; within a turn, each request extends the previous one.
      const bySeat = new Map<string, Record<string, unknown>[]>();
      for (const s of posts.filter((x) => !x.preflight)) {
        bySeat.set(String(s.seat), [...(bySeat.get(String(s.seat)) ?? []), rec(s.body)]);
      }
      expect([...bySeat.keys()].toSorted((a, b) => (a < b ? -1 : 1))).toEqual(["p1", "p2"]);
      for (const bodies of bySeat.values()) {
        const fixed = (b: Record<string, unknown>) => {
          const { input: _i, max_output_tokens: _m, ...rest } = b;
          return JSON.stringify({ ...rest, stable: arr(b["input"]).slice(0, 2) });
        };
        expect(new Set(bodies.map(fixed)).size).toBe(1);
      }
      let extensions = 0;
      for (const [seat, bodies] of bySeat) {
        const turns = posts.filter((s) => !s.preflight && s.seat === seat).map((s) => s.turn);
        for (let i = 1; i < bodies.length; i += 1) {
          if (turns[i] !== turns[i - 1]) continue;
          const before = arr(bodies[i - 1]?.["input"]);
          const after = arr(bodies[i]?.["input"]);
          expect(after.length).toBeGreaterThan(before.length);
          expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
          extensions += 1;
        }
      }
      expect(extensions).toBeGreaterThan(5);
      console.log(
        `openai wire stub, 1 game day: ${attempts.length} attempts (${extensions} extended a turn's previous request), ${stub.seen.length} requests, ledger ${formatUsd(report.budget.actualNanoUsd)} at OpenAI's cards (preflight ${formatUsd(report.budget.preflightNanoUsd)}), budget $20 under: ${String(report.budget.under)}, Level E ${String(report.levelE?.ok)}`,
      );
      // Reasoning items travel back with their encrypted content (stateless, store: false).
      const echoed = posts.some((s) =>
        arr(rec(s.body)["input"]).some(
          (i) => rec(i)["type"] === "reasoning" && typeof rec(i)["encrypted_content"] === "string",
        ),
      );
      expect(echoed).toBe(true);
    },
    LONG,
  );
});

// The smoke ------------------------------------------------------------------------------------------

describe("arena smoke --provider openai", () => {
  test("without the key: exit 3, its bound printed, nothing sent", async () => {
    const io = memoryIo();
    const code = await main(["smoke", "--provider", "openai"], io, {});
    expect(code).toBe(3);
    expect(io.stderr()).toMatch(
      /arena smoke --provider openai makes one live API call \(at most \$0\.0\d{5} on gpt-6-luna\): set PERFIDIA_OPENAI_API_KEY first\. Nothing was sent\./,
    );
  });

  test("with a key and a stub: the bound first, then the three steps, under $0.05", async () => {
    const stub = wireStub({ p1: "bot:opportunist@3" });
    stubs.push(stub.server);
    const io = memoryIo();
    const code = await main(["smoke", "--provider", "openai", "--effort", "low"], io, {
      PERFIDIA_OPENAI_API_KEY: KEY,
      PERFIDIA_OPENAI_BASE_URL: stub.url,
    });
    expect([code, io.stderr()]).toEqual([0, ""]);
    const lines = io.stdout().split("\n");
    const first =
      /^smoke: openai\/gpt-6-luna\/low on http:\/\/127\.0\.0\.1:\d+\/v1, at most \$(\d+\.\d{6})$/.exec(
        lines[0] ?? "",
      );
    expect(first).not.toBeNull();
    const bound = Number(first?.[1]);
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThan(0.05);
    expect(lines[1]).toMatch(/^1\. preflight: ok/);
    expect(lines[2]).toMatch(/^2\. input tokens: \d+ /);
    expect(lines[3]).toMatch(/^3\. one call: stop completed, served by gpt-6-luna/);
    expect(io.stdout()).toContain("smoke: ok");
    const cost = /cost \$(\d+\.\d{6}) at openai:gpt-6-luna@2026-10-20/.exec(io.stdout());
    expect(Number(cost?.[1])).toBeLessThanOrEqual(bound);
    expect(stub.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /v1/models/gpt-6-luna",
      "POST /v1/responses",
      "POST /v1/responses/input_tokens",
      "POST /v1/responses",
    ]);
  });

  test("a model or effort the provider does not take is refused before anything is sent", async () => {
    const io = memoryIo();
    expect(
      await main(["smoke", "--provider", "openai", "--model", "gpt-7"], io, {
        PERFIDIA_OPENAI_API_KEY: KEY,
      }),
    ).toBe(3);
    expect(io.stderr()).toContain("gpt-7 is not a openai seat model");
    const io2 = memoryIo();
    expect(
      await main(
        ["smoke", "--provider", "openai", "--model", "gpt-6.1-sol", "--effort", "none"],
        io2,
        {
          PERFIDIA_OPENAI_API_KEY: KEY,
        },
      ),
    ).toBe(3);
    expect(io2.stderr()).toContain(
      "gpt-6.1-sol accepts effort low, medium, high, xhigh, max; got none",
    );
  });
});

/** The plan's refusal of one seat on the fake path ("planned" when it plans). */
function refused(seat: string): string {
  try {
    planArena({ seed: 1, idKey: "seed", fake: true, seats: [seat] }, arenaEnv({}));
    return "planned";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// The plan ---------------------------------------------------------------------------------------------

describe("the plan of OpenAI seats (Pass 2)", () => {
  const seats = [
    "p1=openai:gpt-6-luna:low:penelope",
    "p2=bot:expander@2",
    "p3=bot:turtle@3",
    "p4=bot:conqueror@3",
  ];
  const plan = (env: Record<string, string>) => {
    try {
      planArena({ seed: 1, idKey: "seed", seats }, arenaEnv(env));
      return "planned";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  test("a real run plans with the key, and is refused without it, naming the seats", () => {
    expect(plan({ PERFIDIA_OPENAI_API_KEY: KEY })).toBe("planned");
    expect(plan({})).toBe(
      "PERFIDIA_OPENAI_API_KEY is not set: the LLM seats (p1) need it. Export it, or pass --fake for a bot-backed fake model ($0, no API)",
    );
    // Other providers' variables are never read.
    expect(plan({ OPENAI_API_KEY: KEY })).toContain("PERFIDIA_OPENAI_API_KEY is not set");
  });

  test("base URLs: http:// off loopback and the regional hosts (no card) are refused", () => {
    expect(
      plan({ PERFIDIA_OPENAI_API_KEY: KEY, PERFIDIA_OPENAI_BASE_URL: "http://api.example.com/v1" }),
    ).toContain("PERFIDIA_OPENAI_BASE_URL is http:// on api.example.com");
    expect(
      plan({
        PERFIDIA_OPENAI_API_KEY: KEY,
        PERFIDIA_OPENAI_BASE_URL: "https://eu.api.openai.com/v1",
      }),
    ).toContain("eu.api.openai.com, a regional-processing host");
    expect(openaiBaseUrlProblem("https://api.openai.com/v1")).toBeNull();
    expect(openaiBaseUrlProblem("https://us.api.openai.com/v1")).toContain("10%");
    expect(
      plan({ PERFIDIA_OPENAI_API_KEY: KEY, PERFIDIA_OPENAI_BASE_URL: "http://127.0.0.1:9/v1" }),
    ).toBe("planned");
  });

  test("efforts the model does not take are plan errors (exit 3) naming what it takes", () => {
    expect(refused("p1=openai:gpt-6.1-sol:none:achilles")).toBe(
      '--seat p1=openai:gpt-6.1-sol:none:achilles: effort must be one of low, medium, high, xhigh, max, got "none"',
    );
    expect(refused("p1=openai:gpt-6.1-sol:minimal:achilles")).toContain('got "minimal"');
    expect(refused("p1=openai:gpt-6-astra:none:achilles")).toContain('got "none"');
    expect(refused("p1=openai:gpt-6-luna:none:achilles")).toBe("planned");
  });
});
