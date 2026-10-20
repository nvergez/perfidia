// Wire stubs of the four providers for tests (phase-4 design §8.3–§8.5, the Pass 2 integration):
// one local `Bun.serve` on 127.0.0.1 per provider, speaking its protocol as the real adapter sends
// and reads it (Anthropic Messages, OpenAI Responses, Gemini `generateContent`, OpenRouter Chat
// Completions with its routing metadata). Each stub decodes a request back to the seat's
// conversation (`WireSeen`: the stable blocks, the conversation items, the neutral entries) and
// answers with a provider-neutral `WireReply` (text, calls, reasoning, a natural or `max_tokens`
// stop, and a neutral usage) encoded in the provider's wire format, so that the adapter's mapping
// must give back exactly that reply and that usage. A `WireScript` writes the replies: a fixed
// script (the conformance suite) or the bot-backed brain (`botScript`, the four-provider match),
// whose usage follows a simple cache model (a token per 4 bytes; the previous request of the turn,
// or the stable blocks once written, is read). The preflight requests (the sample briefing
// `{"preflight":true}`, Anthropic's non-streamed shape check, Gemini's `generateContent`) get a cold
// fixed answer. Each stub checks its own key in its own header, never in the URL, and records every
// request. Nothing here leaves the machine.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BriefingSchema, type PlayerId } from "@perfidia/protocol";
import { botBrain } from "../arena/brain.ts";
import { THOUGHT_ASK } from "../seat/prompt.ts";
import type { ChatRequest, Entry, StablePrompt, UserPart } from "./adapter.ts";
import { HARNESS_PREFIX, type Brain } from "./fake.ts";
import { costOf } from "./prices.ts";

export type WireProvider = "anthropic" | "openai" | "google" | "openrouter";

export const WIRE_PROVIDERS: readonly WireProvider[] = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
];

/** Distinct planted keys: each must reach its own stub only, in its own header. */
export const WIRE_KEYS: Readonly<Record<WireProvider, string>> = Object.freeze({
  anthropic: "sk-ant-wire-stub-planted-key-0001",
  openai: "sk-wire-stub-openai-planted-key-0002",
  google: "wire-stub-google-planted-key-0003",
  openrouter: "sk-or-v1-wire-stub-planted-key-0004",
});

/** The usage a reply reports, provider-neutral: the stub encodes it in the provider's terms. */
export interface WireUsage {
  /** Prompt tokens neither read from nor written to a cache. */
  readonly uncached: number;
  readonly cacheRead: number;
  /** Written to the cache (Gemini has no writes: it reports them as plain prompt tokens). */
  readonly cacheWrite: number;
  /** Billed output, reasoning included. */
  readonly output: number;
  /** The reasoning part of `output` (Anthropic reports no split). */
  readonly reasoning: number;
}

export interface WireCall {
  readonly name: string;
  readonly args: unknown;
}

export interface WireReply {
  /** At most one text (one block, part or message content in every protocol). */
  readonly text: readonly string[];
  readonly calls: readonly WireCall[];
  /** At most one reasoning summary. */
  readonly reasoning: readonly string[];
  /** `natural`: `tool_use` with calls, else `end_turn`; `max_tokens`: cut at the output limit. */
  readonly stop: "natural" | "max_tokens";
  readonly usage: WireUsage;
  /** The stream breaks after its first two events (no terminal event, no final usage). */
  readonly cut?: boolean;
}

/** One chat request as the stub decoded it. */
export interface WireSeen {
  readonly provider: WireProvider;
  /** 1-based count of the stub's chat requests (preflight included). */
  readonly n: number;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly preflight: boolean;
  /** The tools and both stable blocks, as JSON (byte-stable across a seat's requests). */
  readonly stable: string;
  /** Each conversation item as JSON (a request of a turn extends the previous one). */
  readonly items: readonly string[];
  readonly prompt: StablePrompt;
  /** The conversation as neutral entries (assistant replies hold their native item only). */
  readonly entries: readonly Entry[];
}

export type WireScript = (seen: WireSeen) => WireReply | Promise<WireReply>;

export interface WireHit {
  readonly method: string;
  /** Path and query. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
}

export interface WireStub {
  readonly provider: WireProvider;
  /** The base URL for `PERFIDIA_<PROVIDER>_BASE_URL`. */
  readonly url: string;
  readonly key: string;
  readonly hits: WireHit[];
  readonly chats: WireSeen[];
  /** What the stub found wrong (each also answered with a 400). */
  readonly problems: string[];
  stop(): void;
}

// Helpers -------------------------------------------------------------------------------------------

const utf8 = new TextEncoder();
/** About a token per 4 UTF-8 bytes. */
export const tok = (text: string): number => Math.ceil(utf8.encode(text).length / 4);

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const textsOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : arr(content)
        .map((c) => str(rec(c)["text"]))
        .join("");

/** The sample briefing of a preflight request (`arena/preflight.ts`). */
const PREFLIGHT_BRIEFING = '{"preflight":true}';

/** A user text that is harness text (the envelope channel), or null. */
const harnessText = (text: string): string | null =>
  text.startsWith(HARNESS_PREFIX) ? text.slice(HARNESS_PREFIX.length) : null;

/** Builds neutral entries: results and texts gather into user entries, in order. */
class Entries {
  readonly out: Entry[] = [];
  private user: UserPart[] | null = null;

  result(callId: string, content: string): void {
    (this.user ??= []).push({ kind: "result", callId, content, isError: false });
  }

  text(text: string): void {
    const h = harnessText(text);
    if (h !== null) return this.operator(h);
    (this.user ??= []).push({ kind: "text", text });
  }

  operator(text: string): void {
    this.flush();
    this.out.push({ role: "operator", text });
  }

  assistant(native: unknown): void {
    this.flush();
    this.out.push({ role: "assistant", reply: { native, text: [], calls: [], reasoning: [] } });
  }

  flush(): void {
    if (this.user !== null) this.out.push({ role: "user", parts: this.user });
    this.user = null;
  }

  done(): Entry[] {
    this.flush();
    return this.out;
  }
}

const briefingText = (entries: readonly Entry[]): string => {
  const first = entries[0];
  const part = first?.role === "user" ? first.parts[0] : undefined;
  return part?.kind === "text" ? part.text : "";
};

interface Decoded {
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly prompt: StablePrompt;
  readonly stable: string;
  readonly items: readonly string[];
  readonly entries: readonly Entry[];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const sse = (text: string, headers: Record<string, string>): Response =>
  new Response(text, { headers: { "content-type": "text/event-stream", ...headers } });

const stopOf = (r: WireReply): "max_tokens" | "tool_use" | "end_turn" =>
  r.stop === "max_tokens" ? "max_tokens" : r.calls.length > 0 ? "tool_use" : "end_turn";

const promptTotal = (u: WireUsage): number => u.uncached + u.cacheRead + u.cacheWrite;

/** The cold usage of a preflight: the whole prompt written (or plain), `output` tokens out. */
function coldUsage(provider: WireProvider, d: Decoded, output: number): WireUsage {
  const p = tok(d.stable) + d.items.reduce((n, i) => n + tok(i), 0);
  const writes = provider === "anthropic" || provider === "openai";
  return {
    uncached: writes ? 0 : p,
    cacheRead: 0,
    cacheWrite: writes ? p : 0,
    output,
    reasoning: provider === "anthropic" ? 0 : output,
  };
}

// Anthropic Messages ------------------------------------------------------------------------------

function decodeAnthropic(body: unknown): Decoded {
  const b = rec(body);
  const system = arr(b["system"]);
  const messages = arr(b["messages"]);
  const e = new Entries();
  for (const m of messages) {
    const r = rec(m);
    if (r["role"] === "system") e.operator(textsOf(r["content"]));
    else if (r["role"] === "assistant") e.assistant(r["content"]);
    else {
      const content = r["content"];
      if (typeof content === "string") e.text(content);
      for (const c of arr(content)) {
        const block = rec(c);
        if (block["type"] === "tool_result") {
          e.result(str(block["tool_use_id"]), textsOf(block["content"]));
        } else if (block["type"] === "text") e.text(str(block["text"]));
      }
    }
  }
  return {
    model: str(b["model"]),
    maxOutputTokens: num(b["max_tokens"]),
    prompt: { shared: str(rec(system[0])["text"]), seat: str(rec(system[1])["text"]) },
    stable: JSON.stringify({ system: b["system"], tools: b["tools"] }),
    items: messages.map((m) => JSON.stringify(m)),
    entries: e.done(),
  };
}

const anthropicUsage = (u: WireUsage) => ({
  input_tokens: u.uncached,
  cache_creation_input_tokens: u.cacheWrite,
  cache_read_input_tokens: u.cacheRead,
  cache_creation: { ephemeral_5m_input_tokens: u.cacheWrite, ephemeral_1h_input_tokens: 0 },
});

function encodeAnthropic(r: WireReply, model: string, n: number): Response {
  const blocks: Record<string, unknown>[] = [];
  const reasoning = r.reasoning.join("");
  if (reasoning !== "")
    blocks.push({ type: "thinking", thinking: reasoning, signature: `sig-${n}` });
  for (const text of r.text) blocks.push({ type: "text", text });
  for (const [i, c] of r.calls.entries()) {
    blocks.push({ type: "tool_use", id: `toolu_${n}_${i}`, name: c.name, input: c.args });
  }
  const events: Record<string, unknown>[] = [
    {
      type: "message_start",
      message: {
        id: `msg_${n}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: { ...anthropicUsage(r.usage), output_tokens: 1 },
      },
    },
  ];
  for (const [index, b] of blocks.entries()) {
    if (b["type"] === "thinking") {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: b["thinking"] },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: b["signature"] },
        },
      );
    } else if (b["type"] === "text") {
      events.push(
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index, delta: { type: "text_delta", text: b["text"] } },
      );
    } else {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: b["id"], name: b["name"], input: {} },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(b["input"]) },
        },
      );
    }
    events.push({ type: "content_block_stop", index });
  }
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: stopOf(r), stop_sequence: null, stop_details: null },
      usage: { output_tokens: r.usage.output },
    },
    { type: "message_stop" },
  );
  const text = events
    .map((e) => `event: ${str(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return sse(text, { "request-id": `req_wire_${n}` });
}

// OpenAI Responses --------------------------------------------------------------------------------

function decodeOpenAI(body: unknown): Decoded {
  const b = rec(body);
  const input = arr(b["input"]);
  const [shared, seat, ...rest] = input;
  const e = new Entries();
  let assistant: unknown[] | null = null;
  const flushAssistant = (): void => {
    if (assistant !== null) e.assistant(assistant);
    assistant = null;
  };
  for (const item of rest) {
    const r = rec(item);
    if (r["type"] === "function_call_output") {
      flushAssistant();
      e.result(str(r["call_id"]), str(r["output"]));
    } else if (r["type"] === "message" && r["role"] === "user") {
      flushAssistant();
      e.text(textsOf(r["content"]));
    } else if (r["type"] === "message" && r["role"] === "developer") {
      flushAssistant();
      e.operator(textsOf(r["content"]));
    } else (assistant ??= []).push(item);
  }
  flushAssistant();
  return {
    model: str(b["model"]),
    maxOutputTokens: num(b["max_output_tokens"]),
    prompt: { shared: textsOf(rec(shared)["content"]), seat: textsOf(rec(seat)["content"]) },
    stable: JSON.stringify({ tools: b["tools"], blocks: input.slice(0, 2) }),
    items: rest.map((i) => JSON.stringify(i)),
    entries: e.done(),
  };
}

function encodeOpenAI(r: WireReply, model: string, n: number, effort: unknown): Response {
  const output: unknown[] = [
    {
      id: `rs_${n}`,
      type: "reasoning",
      summary: r.reasoning.map((text) => ({ type: "summary_text", text })),
      encrypted_content: `enc_${n}_${"x".repeat(48)}`,
    },
    ...r.text.map((text) => ({
      id: `msg_${n}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
    })),
    ...r.calls.map((c, i) => ({
      type: "function_call",
      id: `fc_${n}_${i}`,
      call_id: `call_${n}_${i}`,
      name: c.name,
      arguments: JSON.stringify(c.args),
      status: "completed",
    })),
  ];
  const u = r.usage;
  const usage = {
    input_tokens: promptTotal(u),
    input_tokens_details: { cached_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite },
    output_tokens: u.output,
    output_tokens_details: { reasoning_tokens: u.reasoning },
    total_tokens: promptTotal(u) + u.output,
  };
  const cut = r.stop === "max_tokens";
  const response = (status: string, done: boolean) => ({
    id: `resp_${n}`,
    object: "response",
    status,
    model,
    output: done ? output : [],
    ...(done
      ? {
          service_tier: "default",
          reasoning: { effort, summary: "auto" },
          usage,
          ...(cut ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        }
      : {}),
  });
  const events: Record<string, unknown>[] = [
    { type: "response.created", sequence_number: 0, response: response("in_progress", false) },
    ...r.text.map((text) => ({
      type: "response.output_text.delta",
      sequence_number: 1,
      item_id: `msg_${n}`,
      output_index: 1,
      content_index: 0,
      delta: text,
    })),
    {
      type: cut ? "response.incomplete" : "response.completed",
      sequence_number: 2,
      response: response(cut ? "incomplete" : "completed", true),
    },
  ];
  const text = events
    .map((e) => `event: ${str(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return sse(text, { "x-request-id": `req_wire_${n}` });
}

// Gemini generateContent --------------------------------------------------------------------------

function decodeGemini(body: unknown): Decoded {
  const b = rec(body);
  const parts = arr(rec(b["systemInstruction"])["parts"]);
  const contents = arr(b["contents"]);
  const e = new Entries();
  for (const c of contents) {
    const r = rec(c);
    if (r["role"] === "model") {
      e.assistant(r["parts"]);
      continue;
    }
    for (const p of arr(r["parts"])) {
      const part = rec(p);
      const fr = rec(part["functionResponse"]);
      if (part["functionResponse"] !== undefined) {
        e.result(str(fr["id"]) || str(fr["name"]), JSON.stringify(fr["response"]));
      } else e.text(str(part["text"]));
    }
    e.flush();
  }
  return {
    model: "",
    maxOutputTokens: num(rec(b["generationConfig"])["maxOutputTokens"]),
    prompt: { shared: str(rec(parts[0])["text"]), seat: str(rec(parts[1])["text"]) },
    stable: JSON.stringify({
      system: b["systemInstruction"],
      tools: b["tools"],
      toolConfig: b["toolConfig"],
    }),
    items: contents.map((c) => JSON.stringify(c)),
    entries: e.done(),
  };
}

const signature = (s: string): string => Buffer.from(`sig:${s}`).toString("base64");

function geminiUsage(u: WireUsage) {
  const prompt = promptTotal(u);
  return {
    promptTokenCount: prompt,
    ...(u.cacheRead === 0 ? {} : { cachedContentTokenCount: u.cacheRead }),
    candidatesTokenCount: u.output - u.reasoning,
    thoughtsTokenCount: u.reasoning,
    totalTokenCount: prompt + u.output,
  };
}

function encodeGemini(r: WireReply, model: string, n: number): Response {
  const reasoning = r.reasoning.join("");
  const thought = reasoning === "" ? [] : [{ text: reasoning, thought: true }];
  const texts: Record<string, unknown>[] = r.text.map((text) => ({ text }));
  const calls: Record<string, unknown>[] = r.calls.map((c, i) => ({
    functionCall: { id: `fc-${n}-${i}`, name: c.name, args: c.args },
  }));
  // The first call carries the step's signature; with no call, the last part does.
  if (calls[0] !== undefined) calls[0] = { ...calls[0], thoughtSignature: signature(`${n}`) };
  else if (texts.length > 0) {
    const last = texts.length - 1;
    texts[last] = { ...texts[last], thoughtSignature: signature(`${n}`) };
  }
  const answer = [...texts, ...calls];
  const meta = { modelVersion: model, responseId: `resp-${n}` };
  const chunks: unknown[] = [
    ...(thought.length === 0
      ? []
      : [{ candidates: [{ content: { role: "model", parts: thought }, index: 0 }], ...meta }]),
    ...(answer.length === 0
      ? []
      : [{ candidates: [{ content: { role: "model", parts: answer }, index: 0 }], ...meta }]),
    {
      candidates: [
        {
          content: { role: "model", parts: [] },
          finishReason: r.stop === "max_tokens" ? "MAX_TOKENS" : "STOP",
          index: 0,
        },
      ],
      usageMetadata: geminiUsage(r.usage),
      ...meta,
    },
  ];
  return sse(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""), {});
}

// OpenRouter Chat Completions ---------------------------------------------------------------------

/** The pinned endpoint of the OpenRouter seats and its provider's name (`arena/providers/compat.ts`). */
export const OPENROUTER_PIN = Object.freeze({ endpoint: "z-ai/fp8", provider: "Z.AI" });

function decodeOpenRouter(body: unknown): Decoded {
  const b = rec(body);
  const messages = arr(b["messages"]);
  const [shared, seat, ...rest] = messages;
  const e = new Entries();
  for (const m of rest) {
    const r = rec(m);
    if (r["role"] === "assistant") e.assistant(m);
    else if (r["role"] === "tool") e.result(str(r["tool_call_id"]), textsOf(r["content"]));
    else e.text(textsOf(r["content"]));
  }
  return {
    model: str(b["model"]),
    maxOutputTokens: num(b["max_tokens"]),
    prompt: { shared: textsOf(rec(shared)["content"]), seat: textsOf(rec(seat)["content"]) },
    stable: JSON.stringify({ tools: b["tools"], blocks: messages.slice(0, 2) }),
    items: rest.map((m) => JSON.stringify(m)),
    entries: e.done(),
  };
}

/** A string cut in two (a delta streamed over two chunks). */
const halves = (s: string): readonly [string, string] => [
  s.slice(0, Math.ceil(s.length / 2)),
  s.slice(Math.ceil(s.length / 2)),
];

function encodeOpenRouter(r: WireReply, model: string, n: number): Response {
  const id = `gen-wire-${n}`;
  const head = {
    id,
    provider: OPENROUTER_PIN.provider,
    model,
    object: "chat.completion.chunk",
    created: 1792500000,
  };
  const chunk = (delta: object, finish: string | null = null, extra: object = {}) => ({
    ...head,
    choices: [{ index: 0, delta, finish_reason: finish, native_finish_reason: finish }],
    ...extra,
  });
  const events: unknown[] = [": OPENROUTER PROCESSING"];
  const reasoning = r.reasoning.join("");
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
  const text = r.text.join("");
  if (text !== "") events.push(chunk({ content: text }));
  for (const [i, c] of r.calls.entries()) {
    const [a, b] = halves(JSON.stringify(c.args));
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
  const finish = r.stop === "max_tokens" ? "length" : r.calls.length > 0 ? "tool_calls" : "stop";
  const u = r.usage;
  // OpenRouter's own cost of the call: the card's price of this usage, fee excluded.
  const cost = costOf(
    [
      {
        model,
        kind: "message",
        tokens: {
          input: u.uncached,
          cacheWrite5m: u.cacheWrite,
          cacheWrite1h: 0,
          cacheRead: u.cacheRead,
          output: u.output,
          reasoning: u.reasoning,
        },
        estimated: false,
      },
    ],
    { provider: "openrouter", endpoint: OPENROUTER_PIN.endpoint, at: new Date().toISOString() },
  );
  events.push(
    chunk({ content: "", role: "assistant" }, finish),
    chunk({ content: "", role: "assistant" }, finish, {
      usage: {
        prompt_tokens: promptTotal(u),
        completion_tokens: u.output,
        total_tokens: promptTotal(u) + u.output,
        prompt_tokens_details: { cached_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite },
        completion_tokens_details: { reasoning_tokens: u.reasoning },
        cost: (cost.nanoUsd - cost.feeNanoUsd) / 1e9,
        is_byok: false,
      },
      openrouter_metadata: {
        requested: model,
        strategy: "direct",
        endpoints: {
          total: 1,
          available: [{ provider: OPENROUTER_PIN.provider, model, selected: true }],
        },
        attempts: [{ provider: OPENROUTER_PIN.provider, model, status: 200 }],
      },
    }),
    "[DONE]",
  );
  const body = events
    .map((e) =>
      typeof e === "string" && e.startsWith(":")
        ? `${e}\n\n`
        : `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`,
    )
    .join("");
  return sse(body, { "x-generation-id": id });
}

const FIXTURES = join(import.meta.dir, "fixtures", "openrouter");

/** A recorded OpenRouter metadata response (`synthetic: false`, fetched 2026-10-20). */
function recorded(name: string): unknown {
  const v: unknown = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  if (rec(v)["synthetic"] !== false) throw new Error(`${name}: not a recorded fixture`);
  return rec(v)["response"];
}

/** A stream cut after its first two events: the body ends with no terminal event and no usage. */
async function cutStream(res: Response, provider: WireProvider): Promise<Response> {
  const sep = provider === "google" ? "\r\n\r\n" : "\n\n";
  const events = (await res.text()).split(sep).filter((e) => e !== "");
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return new Response(`${events.slice(0, 2).join(sep)}${sep}`, { headers });
}

// The stub ----------------------------------------------------------------------------------------

/** Starts the stub of `provider` on a free loopback port. */
export function startWireStub(provider: WireProvider, script: WireScript): WireStub {
  const key = WIRE_KEYS[provider];
  const hits: WireHit[] = [];
  const chats: WireSeen[] = [];
  const problems: string[] = [];
  let n = 0;

  const bad = (why: string): Response => {
    problems.push(why);
    return json({ error: { code: 400, message: why } }, 400);
  };

  const seen = (d: Decoded, model: string): WireSeen => {
    n += 1;
    const s: WireSeen = {
      provider,
      n,
      model,
      maxOutputTokens: d.maxOutputTokens,
      preflight: briefingText(d.entries) === PREFLIGHT_BRIEFING,
      stable: d.stable,
      items: d.items,
      prompt: d.prompt,
      entries: d.entries,
    };
    chats.push(s);
    return s;
  };

  /** The next streamed response breaks (its reply asked for it). */
  let cutNext = false;
  const reply = async (s: WireSeen): Promise<WireReply> => {
    if (s.preflight) {
      return {
        text: [],
        calls: [],
        reasoning: [],
        stop: "max_tokens",
        usage: coldUsage(provider, s, s.maxOutputTokens),
      };
    }
    const r = await script(s);
    cutNext = r.cut === true;
    return r;
  };

  const keyOk = (headers: Readonly<Record<string, string>>): boolean =>
    provider === "anthropic"
      ? headers["x-api-key"] === key
      : provider === "google"
        ? headers["x-goog-api-key"] === key
        : headers["authorization"] === `Bearer ${key}`;

  const answer = async (
    req: Request,
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response> => {
    if (url.href.includes(key) || url.href.includes(encodeURIComponent(key))) {
      return bad("the key is in the URL");
    }
    const path = url.pathname;
    // OpenRouter's metadata is public: `planLive` sends no key for it; the adapter's preflight
    // sends its own (the pinned origin), never another.
    if (provider === "openrouter" && req.method === "GET") {
      const auth = headers["authorization"];
      if (auth !== undefined && auth !== `Bearer ${key}`) return bad("a wrong key on metadata");
      if (path === "/api/v1/endpoints/zdr") return json(recorded("zdr.json"));
      const m = /^\/api\/v1\/models\/(.+)\/endpoints$/.exec(path);
      const model = decodeURIComponent(m?.[1] ?? "");
      try {
        return json(recorded(`endpoints-${model.replace("/", "_")}.json`));
      } catch {
        return json({ error: { code: 404, message: "Not Found" } }, 404);
      }
    }
    if (!keyOk(headers)) return json({ error: { code: 401, message: "invalid key" } }, 401);
    if (provider === "anthropic") {
      const m = /^\/v1\/models\/([^/]+)$/.exec(path);
      if (req.method === "GET" && m !== null) {
        return json({
          type: "model",
          id: decodeURIComponent(m[1] ?? ""),
          display_name: "stub",
          created_at: "2026-01-01T00:00:00Z",
          allowed_fallback_models: [],
        });
      }
      const body: unknown = await req.json();
      const d = decodeAnthropic(body);
      if (path === "/v1/messages/count_tokens") {
        return json({ input_tokens: tok(d.stable) + d.items.reduce((k, i) => k + tok(i), 0) });
      }
      if (path !== "/v1/messages") return json({ error: { message: "no route" } }, 404);
      const s = seen(d, d.model);
      const r = await reply(s);
      if (rec(body)["stream"] === true) return encodeAnthropic(r, d.model, s.n);
      return json({
        id: `msg_${s.n}`,
        type: "message",
        role: "assistant",
        model: d.model,
        content: [],
        stop_reason: "max_tokens",
        stop_sequence: null,
        usage: { ...anthropicUsage(r.usage), output_tokens: 0 },
      });
    }
    if (provider === "openai") {
      const m = /^\/v1\/models\/([^/]+)$/.exec(path);
      if (req.method === "GET" && m !== null) {
        return json({
          id: decodeURIComponent(m[1] ?? ""),
          object: "model",
          created: 0,
          owned_by: "openai",
        });
      }
      const body: unknown = await req.json();
      const d = decodeOpenAI(body);
      if (path === "/v1/responses/input_tokens") {
        return json({
          object: "response.input_tokens",
          input_tokens: tok(d.stable) + d.items.reduce((k, i) => k + tok(i), 0),
        });
      }
      if (path !== "/v1/responses") return json({ error: { message: "no route" } }, 404);
      const s = seen(d, d.model);
      return encodeOpenAI(await reply(s), d.model, s.n, rec(rec(body)["reasoning"])["effort"]);
    }
    if (provider === "google") {
      const m = /^\/v1beta\/models\/([^/:]+)(?::([A-Za-z]+))?$/.exec(path);
      const model = m?.[1];
      if (m === null || model === undefined) return json({ error: { code: 404 } }, 404);
      const method = m[2];
      if (req.method === "GET" && method === undefined) {
        return json({
          name: `models/${model}`,
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
          supportedGenerationMethods: ["generateContent", "countTokens"],
          thinking: true,
        });
      }
      const body: unknown = await req.json();
      if (method === "countTokens") {
        return json({ totalTokens: tok(JSON.stringify(body)) });
      }
      const d = decodeGemini(body);
      if (method === "generateContent") {
        const s = seen(d, model);
        const r = await reply(s);
        return json({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "", thoughtSignature: signature("pre") }] },
              finishReason: "MAX_TOKENS",
              index: 0,
            },
          ],
          usageMetadata: geminiUsage(r.usage),
          modelVersion: model,
          responseId: `resp-${s.n}`,
        });
      }
      if (method === "streamGenerateContent" && url.search === "?alt=sse") {
        const s = seen(d, model);
        return encodeGemini(await reply(s), model, s.n);
      }
      return json({ error: { code: 404 } }, 404);
    }
    if (req.method === "POST" && path === "/api/v1/chat/completions") {
      if (headers["x-openrouter-metadata"] !== "enabled") return bad("no X-OpenRouter-Metadata");
      const d = decodeOpenRouter(await req.json());
      const s = seen(d, d.model);
      return encodeOpenRouter(await reply(s), d.model, s.n);
    }
    return json({ error: { code: 404, message: "Not Found" } }, 404);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      let res: Response;
      try {
        res = await answer(req, url, headers);
        if (cutNext && res.headers.get("content-type") === "text/event-stream") {
          cutNext = false;
          res = await cutStream(res, provider);
        }
      } catch (e) {
        res = bad(`stub: ${e instanceof Error ? e.message : String(e)}`);
      }
      hits.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        status: res.status,
      });
      return res;
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const url =
    provider === "openai"
      ? `${origin}/v1`
      : provider === "openrouter"
        ? `${origin}/api/v1`
        : origin;
  return {
    provider,
    url,
    key,
    hits,
    chats,
    problems,
    stop: () => {
      void server.stop(true);
    },
  };
}

/** The environment of a run whose seats of `stubs` call them (keys and base URLs). */
export function wireEnv(stubs: readonly WireStub[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const s of stubs) {
    const p = s.provider.toUpperCase();
    env[`PERFIDIA_${p}_API_KEY`] = s.key;
    env[`PERFIDIA_${p}_BASE_URL`] = s.url;
  }
  return env;
}

// The bot-backed script -------------------------------------------------------------------------------

const HEADER = /^Turn (\d+) · .+ · round trip 1 of (\d+), up to (\d+) calls\./;

/** The seat's request rebuilt from a decoded one (what the bot-backed brain reads). */
export function chatRequestOf(s: WireSeen): ChatRequest {
  const briefing = BriefingSchema.parse(JSON.parse(briefingText(s.entries)));
  const header = s.entries.find((e) => e.role === "operator");
  const m = HEADER.exec(header?.role === "operator" ? header.text : "");
  const last = s.entries.at(-1);
  return {
    prompt: s.prompt,
    tools: [],
    entries: s.entries,
    meta: {
      seat: briefing.you,
      turn: Number(m?.[1] ?? 0),
      round: s.entries.filter((e) => e.role === "assistant").length,
      maxRounds: Number(m?.[2] ?? 8),
      maxCalls: Number(m?.[3] ?? 10),
      kind: last?.role === "operator" && last.text === THOUGHT_ASK ? "thought" : "round",
    },
  };
}

export interface BotScriptOptions {
  /** The bot each seat's brain plays (`bot:<strategy>@<n>`); default `bot:turtle@3`. */
  readonly bots: Readonly<Record<string, string>>;
  readonly seed: number;
  /** Output tokens added to every reply (a budget test spends fast). */
  readonly extraOutput?: number;
}

/**
 * Replies from the bot-backed brain (one per seat, as `--fake` plays), with a usage from the
 * request's bytes: the previous request of the seat's turn is read when this one extends it, else
 * the stable blocks once a seat has sent them; the rest is written (Anthropic, OpenAI) or plain
 * (Gemini, OpenRouter: no writes reported).
 */
export function botScript(o: BotScriptOptions): WireScript {
  const brains = new Map<string, Brain>();
  const last = new Map<string, { readonly turn: number; readonly items: readonly string[] }>();
  const warm = new Set<string>();
  return async (s) => {
    const req = chatRequestOf(s);
    const seat: PlayerId = req.meta.seat;
    let brain = brains.get(seat);
    if (brain === undefined) {
      brain = botBrain({ label: o.bots[seat] ?? "bot:turtle@3", seat, seed: o.seed });
      brains.set(seat, brain);
    }
    const out = await brain(req, s.n);
    if (out instanceof Error) throw out;
    const key = `${s.provider} ${seat}`;
    const prev = last.get(key);
    const extending =
      prev !== undefined &&
      prev.turn === req.meta.turn &&
      prev.items.length <= s.items.length &&
      prev.items.every((item, i) => s.items[i] === item);
    const stable = tok(s.stable);
    const all = stable + s.items.reduce((k, i) => k + tok(i), 0);
    const read = extending
      ? stable + (prev?.items ?? []).reduce((k, i) => k + tok(i), 0)
      : warm.has(key)
        ? stable
        : 0;
    warm.add(key);
    last.set(key, { turn: req.meta.turn, items: s.items });
    const writes = s.provider === "anthropic" || s.provider === "openai";
    const text = out.text ?? [];
    const calls = out.calls ?? [];
    const reasoning = out.reasoning ?? [];
    const thinking = tok(reasoning.join(""));
    return {
      text: text.length === 0 ? [] : [text.join(" ")],
      calls,
      reasoning: reasoning.length === 0 ? [] : [reasoning.join(" ")],
      stop: "natural",
      usage: {
        uncached: writes ? 0 : all - read,
        cacheRead: read,
        cacheWrite: writes ? all - read : 0,
        output: 60 + thinking + tok(JSON.stringify({ text, calls })) + (o.extraOutput ?? 0),
        reasoning: thinking,
      },
    };
  };
}

test("the wire stubs answer on loopback only, each to its own key in its own header", async () => {
  const stubs = WIRE_PROVIDERS.map((p) =>
    startWireStub(p, () => {
      throw new Error("no chat expected");
    }),
  );
  try {
    for (const s of stubs) {
      expect(new URL(s.url).hostname).toBe("127.0.0.1");
      // oxlint-disable-next-line no-await-in-loop -- one probe per stub
      const res = await fetch(`${s.url}/models/x`, {
        headers: { authorization: "Bearer wrong", "x-api-key": "wrong", "x-goog-api-key": "wrong" },
      });
      expect([s.provider, res.status]).toEqual([
        s.provider,
        s.provider === "openrouter" ? 400 : 401,
      ]);
    }
    expect(new Set(Object.values(WIRE_KEYS)).size).toBe(4);
  } finally {
    for (const s of stubs) s.stop();
  }
});
