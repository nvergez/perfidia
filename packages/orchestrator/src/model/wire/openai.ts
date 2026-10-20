import { z, type JsonObject } from "@perfidia/protocol";

// The OpenAI Responses API on the wire (phase-4 design §2.3, Pass 2): what `model/openai.ts` sends
// and what it reads, as Zod schemas. Read from the API reference and guides on 2026-10-20:
// - https://developers.openai.com/api/reference/resources/responses/methods/create.md (the body,
//   the Response object, `usage`, `incomplete_details`, `error`);
// - https://developers.openai.com/api/reference/resources/responses/streaming-events.md (SSE events);
// - https://developers.openai.com/api/reference/resources/responses.md ("Get input token counts",
//   `POST /responses/input_tokens`);
// - https://developers.openai.com/api/reference/resources/models/methods/retrieve.md;
// - https://developers.openai.com/api/docs/guides/prompt-caching.md (breakpoints, `usage` arithmetic:
//   `input_tokens − cached_tokens − cache_write_tokens` is the uncached input);
// - https://developers.openai.com/api/docs/guides/error-codes.md (error codes before statuses).
// Every payload read is parsed: the fields the adapter uses are strict, the rest pass through
// (`looseObject`), so a provider addition never breaks a run and a changed field never goes unseen.

const Count = z.int().nonnegative();

// Requests -----------------------------------------------------------------------------------------

/** A text content block of an input message; the seat block carries the explicit breakpoint. */
export interface InputText {
  readonly type: "input_text";
  readonly text: string;
  readonly prompt_cache_breakpoint?: { readonly mode: "explicit" };
}

/** A message we send: the two stable blocks and operator notes (`developer`), the briefing (`user`). */
export interface InputMessage {
  readonly type: "message";
  readonly role: "developer" | "user";
  readonly content: readonly InputText[];
}

/** A tool result: the gateway's result JSON as the output string (it carries `ok`, code and hint). */
export interface FunctionCallOutput {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string;
}

/** An input item: ours, or an output item of an earlier reply echoed verbatim. */
export type InputItem = InputMessage | FunctionCallOutput | Readonly<Record<string, unknown>>;

export interface FunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  /** Explicit: an omitted `strict` lets Responses normalise the schema to strict mode. */
  readonly strict: false;
}

export type ReasoningContext = "auto" | "current_turn" | "all_turns";

/** The OpenAI efforts (`reasoning.effort`); each model accepts a subset (the catalog's). */
export type OpenAIEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The streamed body `chat` sends to `POST /responses`. */
export interface ResponsesRequest {
  readonly model: string;
  readonly stream: true;
  readonly store: false;
  readonly include: readonly ["reasoning.encrypted_content"];
  readonly service_tier: "default";
  readonly truncation: "disabled";
  readonly max_output_tokens: number;
  readonly reasoning: {
    readonly effort: OpenAIEffort;
    readonly summary: "auto";
    readonly context?: ReasoningContext;
  };
  readonly tools: readonly FunctionTool[];
  readonly tool_choice: "auto";
  readonly parallel_tool_calls: true;
  readonly prompt_cache_options: { readonly mode: "implicit"; readonly ttl: "30m" };
  readonly input: readonly InputItem[];
}

const InputTextSchema = z.strictObject({
  type: z.literal("input_text"),
  text: z.string(),
  prompt_cache_breakpoint: z.strictObject({ mode: z.literal("explicit") }).optional(),
});

/** The request as `build()` makes it, checked in the tests (every field we send, nothing else). */
export const ResponsesRequestSchema = z.strictObject({
  model: z.string().min(1),
  stream: z.literal(true),
  store: z.literal(false),
  include: z.tuple([z.literal("reasoning.encrypted_content")]),
  service_tier: z.literal("default"),
  truncation: z.literal("disabled"),
  max_output_tokens: z.int().positive(),
  reasoning: z.strictObject({
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
    summary: z.literal("auto"),
    context: z.enum(["auto", "current_turn", "all_turns"]).optional(),
  }),
  tools: z.array(
    z.strictObject({
      type: z.literal("function"),
      name: z.string().min(1),
      description: z.string(),
      parameters: z.record(z.string(), z.unknown()),
      strict: z.literal(false),
    }),
  ),
  tool_choice: z.literal("auto"),
  parallel_tool_calls: z.literal(true),
  prompt_cache_options: z.strictObject({ mode: z.literal("implicit"), ttl: z.literal("30m") }),
  input: z.array(
    z.union([
      z.strictObject({
        type: z.literal("message"),
        role: z.enum(["developer", "user"]),
        content: z.array(InputTextSchema).min(1),
      }),
      z.strictObject({
        type: z.literal("function_call_output"),
        call_id: z.string().min(1),
        output: z.string(),
      }),
      z.looseObject({ type: z.enum(["reasoning", "message", "function_call"]) }),
    ]),
  ),
});

/** The body of `POST /responses/input_tokens` (no streaming, storage or output fields). */
export interface InputTokensRequest {
  readonly model: string;
  readonly input: readonly InputItem[];
  readonly tools: readonly FunctionTool[];
  readonly tool_choice: "auto";
  readonly parallel_tool_calls: true;
  readonly reasoning: ResponsesRequest["reasoning"];
  readonly truncation: "disabled";
}

// Responses ----------------------------------------------------------------------------------------

/**
 * `usage` (Response object): `input_tokens` counts the whole prompt, cache reads and writes
 * included (the prompt-caching guide prices `input_tokens − cached_tokens − cache_write_tokens` at
 * the uncached rate); `output_tokens` counts the reasoning tokens (`output_tokens_details`). Every
 * field we price is required: a usage without the split cannot be priced from below.
 */
export const UsageSchema = z.looseObject({
  input_tokens: Count,
  input_tokens_details: z.looseObject({ cached_tokens: Count, cache_write_tokens: Count }),
  output_tokens: Count,
  output_tokens_details: z.looseObject({ reasoning_tokens: Count }),
});
export type WireUsage = z.infer<typeof UsageSchema>;

/** A reasoning output item: its summaries are what spectators read (`reasoningKind: summary`). */
export const ReasoningItemSchema = z.looseObject({
  type: z.literal("reasoning"),
  id: z.string(),
  summary: z.array(z.looseObject({ type: z.string(), text: z.string() })),
});

/** An assistant message: `output_text` parts and, on a refusal, a `refusal` part. */
export const MessageItemSchema = z.looseObject({
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.union([
      z.looseObject({ type: z.literal("output_text"), text: z.string() }),
      z.looseObject({ type: z.literal("refusal"), refusal: z.string() }),
      z.looseObject({ type: z.string() }),
    ]),
  ),
});

/** A function call: `arguments` is a JSON string (passed raw to the gateway when it does not parse). */
export const FunctionCallItemSchema = z.looseObject({
  type: z.literal("function_call"),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

/** `error` of a failed Response (`status: "failed"`). */
export const ResponseErrorSchema = z.looseObject({
  code: z.string().nullish(),
  message: z.string().nullish(),
  type: z.string().nullish(),
  param: z.string().nullish(),
});

/**
 * The Response object of a terminal event. `usage` stays `unknown` here: it is parsed on its own,
 * so a reply whose usage cannot be priced is still known for what it was (and charged its bound).
 */
export const ResponseObjectSchema = z.looseObject({
  id: z.string().optional(),
  status: z.enum(["completed", "failed", "in_progress", "cancelled", "queued", "incomplete"]),
  model: z.string().min(1),
  output: z.array(z.looseObject({ type: z.string() })),
  usage: z.unknown().optional(),
  incomplete_details: z.looseObject({ reason: z.string().nullish() }).nullish(),
  error: ResponseErrorSchema.nullish(),
  service_tier: z.string().nullish(),
  reasoning: z.looseObject({ context: z.string().nullish() }).nullish(),
});
export type ResponseObject = z.infer<typeof ResponseObjectSchema>;

/** The SSE events that end a stream: the three terminal Response events and `error`. */
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "error",
]);

/** A terminal Response event (`response.completed`, `.incomplete`, `.failed`). */
export const TerminalResponseEventSchema = z.looseObject({
  type: z.enum(["response.completed", "response.incomplete", "response.failed"]),
  response: ResponseObjectSchema,
});

/** The in-stream `error` event (an error while consuming the stream, even after output). */
export const StreamErrorEventSchema = z.looseObject({
  type: z.literal("error"),
  code: z.string().nullish(),
  message: z.string().nullish(),
  param: z.string().nullish(),
});

/** Any stream event: its `type` (`response.created`, `response.output_text.delta`, …). */
export const StreamEventSchema = z.looseObject({ type: z.string().min(1) });

/** An HTTP error body: `{ error: { message, type, param, code } }`. */
export const ErrorBodySchema = z.looseObject({
  error: z.looseObject({
    message: z.string().nullish(),
    type: z.string().nullish(),
    param: z.string().nullish(),
    code: z.string().nullish(),
  }),
});

/** `GET /models/{model}`. */
export const ModelObjectSchema = z.looseObject({
  id: z.string().min(1),
  object: z.literal("model"),
});

/** `POST /responses/input_tokens`. */
export const InputTokensSchema = z.looseObject({
  object: z.literal("response.input_tokens"),
  input_tokens: Count,
});
