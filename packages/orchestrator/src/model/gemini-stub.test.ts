// A wire stub of the Gemini API for tests (phase-4 design §2.8, §8.5): a local `Bun.serve` on
// 127.0.0.1 that speaks `v1beta` (`models.get`, `countTokens`, `generateContent`,
// `streamGenerateContent?alt=sse`), checks every request the way the API would (the key header,
// the strict request schema, thought signatures echoed on the parts they came on, function
// responses matching the calls by id or order, the model's parts sent back verbatim), and answers
// each streamed round with a bot's play: a thought summary, a text part, the bot's calls as
// `functionCall` parts (the first one signed), then the finish with a deterministic usage. It is
// driven by the same bots as `--fake` (one instance per seat), rebuilt from the request alone: the
// briefing is the first text part, the turn header the `[harness]` part after it, the round the
// number of model turns, the results the function responses. Nothing here leaves the machine.

import { afterAll, describe, expect, test } from "bun:test";
import { botFromLabel } from "@perfidia/bots";
import {
  BriefingSchema,
  ToolResultSchema,
  type PlayerId,
  type RoundInput,
  type SeatAgent,
  type ToolResult,
} from "@perfidia/protocol";
import {
  GeminiCountTokensRequestSchema,
  GeminiRequestSchema,
  type GeminiRequest,
} from "./wire/gemini.ts";

export const STUB_KEY = "stub-gemini-key-0123456789";

export interface StubCall {
  /** 1-based count of streamed requests. */
  readonly n: number;
  readonly model: string;
  readonly seat: PlayerId;
  readonly turn: number;
  readonly round: number;
  readonly maxOutputTokens: number;
  readonly body: GeminiRequest;
}

export interface StubRecord {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly streamed: boolean;
  readonly call: StubCall | null;
  readonly status: number;
}

export interface GeminiStubOptions {
  readonly key?: string;
  readonly seed: number;
  /** The bot each seat plays (`bot:<strategy>@<n>`); default `bot:turtle@3`. */
  readonly bots?: Readonly<Record<string, string>>;
  /** Models whose calls carry no `id` (responses then carry none either). */
  readonly noIds?: ReadonlySet<string>;
  /** A response to send instead of the bot's reply (errors, truncations); null: the bot plays. */
  readonly inject?: (c: StubCall) => Response | null;
}

export interface GeminiStub {
  readonly url: string;
  readonly records: StubRecord[];
  /** What the stub found wrong in a request (each also answered with a 400). */
  readonly problems: string[];
  stop(): void;
}

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The API's error body. */
export const errorBody = (code: number, status: string, message: string, details: unknown[] = []) =>
  ({ error: { code, message, status, ...(details.length === 0 ? {} : { details }) } }) as const;

/** An SSE body of these events (`data:` lines, CRLF as the API sends them). */
export function sseOf(events: readonly unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("");
}

export const sse = (events: readonly unknown[], status = 200): Response =>
  new Response(sseOf(events), { status, headers: { "content-type": "text/event-stream" } });

const HEADER = /^\[harness\] Turn (\d+) · .* · round trip 1 of (\d+), up to (\d+) calls\./;

type Part = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A deterministic base64 signature. */
const signature = (s: string): string => Buffer.from(`sig:${s}`).toString("base64");

/** The bot's round input, rebuilt from the request alone. */
function inputOf(body: GeminiRequest): RoundInput | string {
  const first = body.contents[0];
  const [brief, header] = first?.role === "user" ? first.parts : [];
  if (brief === undefined || !("text" in brief)) return "no briefing text part";
  if (header === undefined || !("text" in header)) return "no turn header part";
  const m = HEADER.exec(header.text);
  if (m === null) return `not a turn header: ${header.text.slice(0, 60)}`;
  const briefing = BriefingSchema.parse(JSON.parse(brief.text));
  const round = body.contents.filter((c) => c.role === "model").length;
  const last = body.contents.at(-1);
  const results: ToolResult[] =
    round === 0 || last?.role !== "user"
      ? []
      : last.parts.flatMap((p) =>
          "functionResponse" in p ? [ToolResultSchema.parse(p.functionResponse.response)] : [],
        );
  return {
    seat: briefing.you,
    turn: Number(m[1]),
    round,
    maxRounds: Number(m[2]),
    maxCalls: Number(m[3]),
    briefing,
    results,
  };
}

/** Starts the stub on a free loopback port. */
export function startGeminiStub(o: GeminiStubOptions): GeminiStub {
  const key = o.key ?? STUB_KEY;
  const records: StubRecord[] = [];
  const problems: string[] = [];
  const bots = new Map<string, SeatAgent>();
  /** The parts of every streamed reply, as JSON: an echo must be one of them. */
  const sent = new Set<string>();
  /** Seats whose prefix the "implicit cache" holds. */
  const warm = new Set<string>();
  let streamed = 0;

  const botOf = (seat: PlayerId): SeatAgent => {
    let bot = bots.get(seat);
    if (bot === undefined) {
      const label = o.bots?.[seat] ?? "bot:turtle@3";
      bot = botFromLabel(label, { seat, seed: o.seed }) ?? undefined;
      if (bot === undefined) throw new Error(`stub: no bot ${label}`);
      bots.set(seat, bot);
    }
    return bot;
  };

  const bad = (why: string): Response => {
    problems.push(why);
    return json(400, errorBody(400, "INVALID_ARGUMENT", why));
  };

  /**
   * The checks the API makes of a conversation; null when it passes. `raw` is the body as sent
   * (the schema's output reorders keys): the model's parts must be the bytes the stub streamed.
   */
  const checkConversation = (body: GeminiRequest, raw: unknown): string | null => {
    const contents = body.contents;
    const rawContents: unknown = isRecord(raw) ? raw["contents"] : undefined;
    for (const [i, c] of contents.entries()) {
      if (c.role !== "model") continue;
      const rawContent: unknown = Array.isArray(rawContents) ? rawContents[i] : undefined;
      const rawParts: unknown = isRecord(rawContent) ? rawContent["parts"] : undefined;
      if (!sent.has(JSON.stringify(rawParts))) {
        return `content ${i}: the model's parts are not echoed verbatim`;
      }
      const parts: unknown[] = c.parts;
      const calls = parts.flatMap((p) =>
        isRecord(p) && isRecord(p["functionCall"]) ? [{ part: p, fc: p["functionCall"] }] : [],
      );
      const first = calls[0];
      if (first !== undefined && typeof first.part["thoughtSignature"] !== "string") {
        return `Function call in the ${i}. content block is missing a thought_signature`;
      }
      const next = contents[i + 1];
      if (calls.length === 0) continue;
      if (next === undefined || next.role !== "user")
        return `content ${i}: no function responses after the calls`;
      const responses = next.parts.flatMap((p) =>
        "functionResponse" in p ? [p.functionResponse] : [],
      );
      if (responses.length !== calls.length)
        return `content ${i + 1}: ${responses.length} responses for ${calls.length} calls`;
      for (const [k, r] of responses.entries()) {
        const fc = calls[k]?.fc;
        if (fc?.["name"] !== r.name || fc["id"] !== r.id) {
          return `content ${i + 1}: response ${k} does not match its call (id and name)`;
        }
      }
      // Function responses first, then any text (harness notes), never interleaved.
      const kinds = next.parts.map((p) => ("functionResponse" in p ? "r" : "t")).join("");
      if (/t.*r/.test(kinds)) return `content ${i + 1}: a text part before a function response`;
    }
    return null;
  };

  /** A streamed round: the response, and the call it answered (null: refused before the bot). */
  const stream = async (
    model: string,
    text: string,
  ): Promise<{ readonly res: Response; readonly call: StubCall | null }> => {
    let body: GeminiRequest;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
      body = GeminiRequestSchema.parse(raw);
    } catch (e) {
      const why = e instanceof Error ? e.message.slice(0, 300) : "";
      return { res: bad(`the request fails the schema: ${why}`), call: null };
    }
    const wrong = checkConversation(body, raw);
    if (wrong !== null) return { res: bad(wrong), call: null };
    const input = inputOf(body);
    if (typeof input === "string") return { res: bad(input), call: null };
    streamed += 1;
    const call: StubCall = {
      n: streamed,
      model,
      seat: input.seat,
      turn: input.turn,
      round: input.round,
      maxOutputTokens: body.generationConfig.maxOutputTokens,
      body,
    };
    const injected = o.inject?.(call);
    if (injected !== undefined && injected !== null) return { res: injected, call };
    const out = await botOf(input.seat).round(input);
    const id = `${input.seat}-${input.turn}-${input.round}`;
    const thought: Part = {
      text: `Stub summary: ${input.seat} plays turn ${input.turn}, round ${input.round}.`,
      thought: true,
    };
    const calls: Part[] = out.calls.map((c, i) => ({
      functionCall: {
        ...(o.noIds?.has(model) === true ? {} : { id: `fc-${id}-${i}` }),
        name: c.tool,
        args: c.args,
      },
    }));
    const texts: Part[] = out.thought === undefined ? [] : [{ text: out.thought }];
    if (calls.length === 0 && texts.length === 0) texts.push({ text: "Holding." });
    const tail = calls.length > 0 ? calls : texts;
    const signed = calls.length > 0 ? 0 : tail.length - 1;
    const tailSigned = tail.map((p, i) =>
      i === signed ? Object.assign({}, p, { thoughtSignature: signature(id) }) : p,
    );
    const answer = calls.length > 0 ? [...texts, ...tailSigned] : tailSigned;
    const parts = [thought, ...answer];
    sent.add(JSON.stringify(parts));
    const prefix = bytes(JSON.stringify({ s: body.systemInstruction, t: body.tools }));
    const prompt = Math.ceil(bytes(text) / 4);
    const cached = warm.has(`${model}/${input.seat}`) ? Math.min(prompt, Math.ceil(prefix / 4)) : 0;
    warm.add(`${model}/${input.seat}`);
    const candidates = Math.ceil(bytes(JSON.stringify(answer)) / 4);
    const thoughts = 64;
    const meta = { modelVersion: model, responseId: `resp-${call.n}` };
    const res = sse([
      { candidates: [{ content: { role: "model", parts: [thought] }, index: 0 }], ...meta },
      { candidates: [{ content: { role: "model", parts: answer }, index: 0 }], ...meta },
      {
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
        usageMetadata: {
          promptTokenCount: prompt,
          ...(cached === 0 ? {} : { cachedContentTokenCount: cached }),
          candidatesTokenCount: candidates,
          thoughtsTokenCount: thoughts,
          totalTokenCount: prompt + candidates + thoughts,
        },
        ...meta,
      },
    ]);
    return { res, call };
  };

  const route = /^\/v1beta\/models\/([^/:]+)(?::([A-Za-z]+))?$/;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      let call: StubCall | null = null;
      const answer = async (): Promise<Response> => {
        if (url.href.includes(key) || url.href.includes(encodeURIComponent(key))) {
          return bad("the key is in the URL");
        }
        if (headers["x-goog-api-key"] !== key) {
          return json(
            400,
            errorBody(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [
              { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
            ]),
          );
        }
        const m = route.exec(url.pathname);
        const model = m?.[1];
        if (m === null || model === undefined)
          return json(404, errorBody(404, "NOT_FOUND", "no route"));
        const method = m[2];
        if (req.method === "GET" && method === undefined) {
          return json(200, {
            name: `models/${model}`,
            inputTokenLimit: 1_048_576,
            outputTokenLimit: 65_536,
            supportedGenerationMethods: ["generateContent", "countTokens"],
            thinking: true,
          });
        }
        const text = await req.text();
        if (method === "countTokens") {
          const r = GeminiCountTokensRequestSchema.safeParse(JSON.parse(text));
          if (!r.success) return bad("countTokens: the request fails the schema");
          return json(200, { totalTokens: Math.ceil(bytes(text) / 4) });
        }
        if (method === "generateContent") {
          const r = GeminiRequestSchema.safeParse(JSON.parse(text));
          if (!r.success) return bad("generateContent: the request fails the schema");
          const prompt = Math.ceil(bytes(text) / 4);
          const out = r.data.generationConfig.maxOutputTokens;
          return json(200, {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "", thoughtSignature: signature("pre") }],
                },
                finishReason: "MAX_TOKENS",
                index: 0,
              },
            ],
            usageMetadata: {
              promptTokenCount: prompt,
              candidatesTokenCount: 0,
              thoughtsTokenCount: out,
              totalTokenCount: prompt + out,
            },
            modelVersion: model,
            responseId: "resp-preflight",
          });
        }
        if (method === "streamGenerateContent" && url.search === "?alt=sse") {
          const r = await stream(model, text);
          call = r.call;
          return r.res;
        }
        return json(404, errorBody(404, "NOT_FOUND", `no method ${method ?? "?"}`));
      };
      const res = await answer();
      records.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        headers,
        streamed: url.pathname.endsWith(":streamGenerateContent"),
        call,
        status: res.status,
      });
      return res;
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    records,
    problems,
    stop: () => {
      void server.stop(true);
    },
  };
}

// The stub itself ----------------------------------------------------------------------------------

describe("the Gemini wire stub", () => {
  const stub = startGeminiStub({ seed: 1 });
  afterAll(() => stub.stop());

  test("refuses a wrong key and a key in the URL; answers models.get", async () => {
    const at = (path: string, init: RequestInit = {}) => fetch(`${stub.url}${path}`, init);
    expect((await at("/v1beta/models/gemini-4-argon")).status).toBe(400);
    const ok = await at("/v1beta/models/gemini-4-argon", {
      headers: { "x-goog-api-key": STUB_KEY },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ outputTokenLimit: 65_536 });
    expect(
      (await at(`/v1beta/models/x?key=${STUB_KEY}`, { headers: { "x-goog-api-key": STUB_KEY } }))
        .status,
    ).toBe(400);
    expect(stub.problems).toEqual(["the key is in the URL"]);
  });
});
