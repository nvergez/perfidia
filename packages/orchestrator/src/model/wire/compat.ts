import { EffortSchema, z } from "@perfidia/protocol";

// The wire of the OpenAI-compatible Chat Completions adapter (`model/compat.ts`, phase-4 design
// §2.5, Pass 2): Zod schemas for what it sends (checked by the tests) and for every payload it reads
// (stream chunks, usage, errors, OpenRouter's routing metadata, its `/models/{id}/endpoints` and
// `/endpoints/zdr` JSON). Fields the adapter uses are typed strictly; the rest pass through
// (`looseObject`). A payload that fails its schema is an `unknown` error, never echoed.
//
// Sources, read 2026-10-20 (raw pages):
// - https://openrouter.ai/docs/api_reference/overview.md (request and response shapes, usage)
// - https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion.md (OpenAPI schemas)
// - https://openrouter.ai/docs/api_reference/streaming.md (final usage chunk, mid-stream errors)
// - https://openrouter.ai/docs/api_reference/errors-and-debugging.md (typed `error_type`)
// - https://openrouter.ai/docs/guides/features/router-metadata.md (`openrouter_metadata`)
// - https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md (`reasoning_details`)
// - https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model.md

// Requests -------------------------------------------------------------------------------------

const TextPartSchema = z.strictObject({ type: z.literal("text"), text: z.string() });

export const CompatToolSchema = z.strictObject({
  type: z.literal("function"),
  function: z.strictObject({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }),
});
export type CompatTool = z.infer<typeof CompatToolSchema>;

export const CompatToolCallSchema = z.strictObject({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.strictObject({ name: z.string(), arguments: z.string() }),
});
export type CompatToolCall = z.infer<typeof CompatToolCallSchema>;

/** A reasoning detail as OpenRouter returns it and wants it back unmodified. */
export const ReasoningDetailSchema = z.looseObject({
  type: z.string().min(1),
  index: z.int().nonnegative().optional(),
  id: z.string().nullable().optional(),
  format: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  data: z.string().nullable().optional(),
  signature: z.string().nullable().optional(),
});
export type ReasoningDetail = z.infer<typeof ReasoningDetailSchema>;

/** The assistant message the adapter echoes back (its `native` reply). */
export const CompatAssistantSchema = z.strictObject({
  role: z.literal("assistant"),
  content: z.string().nullable(),
  tool_calls: z.array(CompatToolCallSchema).optional(),
  reasoning_details: z.array(ReasoningDetailSchema).optional(),
  reasoning: z.string().optional(),
});
export type CompatAssistant = z.infer<typeof CompatAssistantSchema>;

export const CompatMessageSchema = z.union([
  z.strictObject({ role: z.literal("system"), content: z.string() }),
  z.strictObject({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(TextPartSchema)]),
  }),
  z.strictObject({ role: z.literal("tool"), tool_call_id: z.string().min(1), content: z.string() }),
  CompatAssistantSchema,
]);
export type CompatMessage = z.infer<typeof CompatMessageSchema>;

/** OpenRouter's `provider` object (provider routing): the pin, never a fallback. */
export const ProviderPinSchema = z.strictObject({
  only: z.array(z.string().min(1)).length(1),
  allow_fallbacks: z.literal(false),
  require_parameters: z.literal(true),
  data_collection: z.literal("deny"),
  zdr: z.literal(true).optional(),
});
export type ProviderPin = z.infer<typeof ProviderPinSchema>;

export const CompatRequestSchema = z.strictObject({
  model: z.string().min(1),
  messages: z.array(CompatMessageSchema).min(1),
  tools: z.array(CompatToolSchema),
  tool_choice: z.literal("auto"),
  max_tokens: z.int().positive(),
  reasoning: z.strictObject({ effort: EffortSchema }).optional(),
  parallel_tool_calls: z.literal(true).optional(),
  stream: z.literal(true),
  stream_options: z.strictObject({ include_usage: z.literal(true) }).optional(),
  provider: ProviderPinSchema.optional(),
});
export type CompatRequest = z.infer<typeof CompatRequestSchema>;

// Responses ------------------------------------------------------------------------------------

/** An error object: OpenRouter's `{code, message, metadata}` (code a status, or a string mid-stream). */
export const WireErrorSchema = z.looseObject({
  code: z.union([z.int(), z.string()]).nullable().optional(),
  message: z.string().optional(),
  type: z.string().nullable().optional(),
  metadata: z
    .looseObject({
      error_type: z.string().optional(),
      provider_code: z.string().optional(),
      limit_source: z.string().optional(),
    })
    .nullable()
    .optional(),
});
export type WireError = z.infer<typeof WireErrorSchema>;

/** A JSON error body (any status). */
export const ErrorBodySchema = z.looseObject({ error: WireErrorSchema });

const ToolCallDeltaSchema = z.looseObject({
  index: z.int().nonnegative(),
  id: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  function: z
    .looseObject({
      name: z.string().nullable().optional(),
      arguments: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type ToolCallDelta = z.infer<typeof ToolCallDeltaSchema>;

const DeltaSchema = z.looseObject({
  role: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional(),
  /** vLLM's and DeepSeek's name for the reasoning text (compat endpoints). */
  reasoning_content: z.string().nullable().optional(),
  reasoning_details: z.array(ReasoningDetailSchema).nullable().optional(),
  refusal: z.string().nullable().optional(),
  tool_calls: z.array(ToolCallDeltaSchema).nullable().optional(),
});

const StreamChoiceSchema = z.looseObject({
  index: z.int().nonnegative().optional(),
  delta: DeltaSchema.nullable().optional(),
  finish_reason: z.string().nullable().optional(),
  native_finish_reason: z.string().nullable().optional(),
  error: WireErrorSchema.nullable().optional(),
});

/**
 * One `data:` event of a Chat Completions stream. `usage` and `openrouter_metadata` are parsed apart
 * (their own schemas), so an unexpected usage shape is charged the attempt bound rather than lost.
 */
export const StreamChunkSchema = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  /** The serving provider's name (OpenRouter shows it on mid-stream error chunks). */
  provider: z.string().nullable().optional(),
  choices: z.array(StreamChoiceSchema).nullable().optional(),
  usage: z.unknown().optional(),
  error: WireErrorSchema.nullable().optional(),
  openrouter_metadata: z.unknown().optional(),
});
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

const Count = z.int().nonnegative();

/**
 * `usage` (overview: "prompt_tokens: including images, input audio, and tools"; `cached_tokens` and
 * `cache_write_tokens` break the prompt down, `reasoning_tokens` the completion; `cost` is in
 * credits, one credit one US dollar).
 */
export const UsageSchema = z.looseObject({
  prompt_tokens: Count,
  completion_tokens: Count,
  total_tokens: Count.nullable().optional(),
  prompt_tokens_details: z
    .looseObject({
      cached_tokens: Count.nullable().optional(),
      cache_write_tokens: Count.nullable().optional(),
    })
    .nullable()
    .optional(),
  completion_tokens_details: z
    .looseObject({ reasoning_tokens: Count.nullable().optional() })
    .nullable()
    .optional(),
  cost: z.number().nonnegative().nullable().optional(),
  is_byok: z.boolean().nullable().optional(),
});
export type WireUsage = z.infer<typeof UsageSchema>;

/** `openrouter_metadata` (`X-OpenRouter-Metadata: enabled`), on the final chunk of a stream. */
export const RouterMetadataSchema = z.looseObject({
  requested: z.string().optional(),
  attempt: z.int().optional(),
  endpoints: z.looseObject({
    total: z.int().optional(),
    available: z.array(
      z.looseObject({ provider: z.string(), model: z.string(), selected: z.boolean() }),
    ),
  }),
  attempts: z
    .array(z.looseObject({ provider: z.string(), model: z.string(), status: z.int() }))
    .optional(),
});
export type RouterMetadata = z.infer<typeof RouterMetadataSchema>;

// OpenRouter's public metadata -----------------------------------------------------------------

/** A price as the endpoints JSON writes it: USD per token, a decimal string ("0.0000014"). */
const PriceText = z.string().regex(/^\d{1,9}(?:\.\d{1,18})?$/);

const PricingOverrideSchema = z.looseObject({
  prompt: PriceText.optional(),
  completion: PriceText.optional(),
  input_cache_read: PriceText.optional(),
  input_cache_write: PriceText.optional(),
  input_cache_write_1h: PriceText.optional(),
});

export const EndpointPricingSchema = z.looseObject({
  prompt: PriceText,
  completion: PriceText,
  input_cache_read: PriceText.optional(),
  input_cache_write: PriceText.optional(),
  input_cache_write_1h: PriceText.optional(),
  /** "Price in USD per internal reasoning token" (endpoints list, read 2026-10-20). */
  internal_reasoning: PriceText.optional(),
  request: PriceText.optional(),
  discount: z.number().optional(),
  overrides: z.array(PricingOverrideSchema).optional(),
});
export type EndpointPricing = z.infer<typeof EndpointPricingSchema>;

export const PublicEndpointSchema = z.looseObject({
  name: z.string().optional(),
  model_id: z.string().optional(),
  provider_name: z.string().min(1),
  tag: z.string().min(1),
  quantization: z.string().nullable().optional(),
  context_length: z.int().positive(),
  max_completion_tokens: z.int().positive().nullable().optional(),
  pricing: EndpointPricingSchema,
  supported_parameters: z.array(z.string()),
  supports_tool_choice: z.looseObject({ auto: z.boolean().optional() }).nullable().optional(),
  supports_implicit_caching: z.boolean().nullable().optional(),
  status: z.number().nullable().optional(),
  uptime_last_30m: z.number().nullable().optional(),
});
export type PublicEndpoint = z.infer<typeof PublicEndpointSchema>;

/** `GET /api/v1/models/{author}/{slug}/endpoints`. */
export const EndpointsResponseSchema = z.looseObject({
  data: z.looseObject({ id: z.string().min(1), endpoints: z.array(PublicEndpointSchema) }),
});

/** `GET /api/v1/endpoints/zdr`: every zero-data-retention endpoint, by model and tag. */
export const ZdrResponseSchema = z.looseObject({
  data: z.array(z.looseObject({ model_id: z.string().min(1), tag: z.string().min(1) })),
});
