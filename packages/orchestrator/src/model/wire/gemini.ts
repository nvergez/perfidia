import { z } from "@perfidia/protocol";

// The Gemini API's wire formats as the adapter reads and writes them (phase-4 design §2.4, Pass 2):
// `v1beta` `models.generateContent`, `models.streamGenerateContent?alt=sse`, `models.get`,
// `models.countTokens`, and the error body. Read from the API reference on 2026-10-20
// (https://ai.google.dev/api/generate-content.md.txt, https://ai.google.dev/api/models.md.txt,
// https://ai.google.dev/api/tokens.md.txt, https://ai.google.dev/gemini-api/docs/generate-content/api-errors.md.txt).
//
// The fields the adapter uses are typed; everything else passes through (`looseObject`), so a part
// is echoed back exactly as it arrived (thought signatures included). Usage metadata is parsed apart
// (`GeminiUsageSchema`): a usage that fails it never fails a reply, it is charged conservatively.
// The request schema is strict: it pins what the adapter sends (tests and the wire stub check every
// body against it).

/** A token count: a non-negative safe integer (the API's `integer`, int32). */
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// Responses ----------------------------------------------------------------------------------------

export const GeminiFunctionCallSchema = z.looseObject({
  /** Optional: when present, the response must carry the same `id`. */
  id: z.string().optional(),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const GeminiPartSchema = z.looseObject({
  text: z.string().optional(),
  /** A thought summary (with `includeThoughts`). */
  thought: z.boolean().optional(),
  /** Opaque, base64: echoed back on the very part it came on. */
  thoughtSignature: z.string().optional(),
  functionCall: GeminiFunctionCallSchema.optional(),
});
export type GeminiPart = z.infer<typeof GeminiPartSchema>;

export const GeminiContentSchema = z.looseObject({
  role: z.string().optional(),
  parts: z.array(GeminiPartSchema).optional(),
});

export const GeminiCandidateSchema = z.looseObject({
  content: GeminiContentSchema.optional(),
  /** Empty while the model is still generating; an enum the adapter reads as a string. */
  finishReason: z.string().optional(),
  finishMessage: z.string().optional(),
  index: z.number().int().optional(),
});

/** `GenerateContentResponse`: a whole response, or one event of a stream. */
export const GeminiResponseSchema = z.looseObject({
  candidates: z.array(GeminiCandidateSchema).optional(),
  promptFeedback: z.looseObject({ blockReason: z.string().optional() }).optional(),
  /** Parsed apart with `GeminiUsageSchema`. */
  usageMetadata: z.unknown().optional(),
  modelVersion: z.string().optional(),
  responseId: z.string().optional(),
  /** An error delivered inside a stream (a status error object). */
  error: z.unknown().optional(),
});
export type GeminiResponse = z.infer<typeof GeminiResponseSchema>;

/**
 * `UsageMetadata`. `promptTokenCount` includes `cachedContentTokenCount`; `thoughtsTokenCount` is
 * billed as output; `totalTokenCount` is prompt + tool-use prompt + thoughts + candidates.
 */
export const GeminiUsageSchema = z.looseObject({
  promptTokenCount: count.optional(),
  cachedContentTokenCount: count.optional(),
  candidatesTokenCount: count.optional(),
  toolUsePromptTokenCount: count.optional(),
  thoughtsTokenCount: count.optional(),
  totalTokenCount: count.optional(),
  serviceTier: z.string().optional(),
});
export type GeminiUsage = z.infer<typeof GeminiUsageSchema>;

/** `models.get`. */
export const GeminiModelInfoSchema = z.looseObject({
  name: z.string(),
  inputTokenLimit: count.optional(),
  outputTokenLimit: count.optional(),
  supportedGenerationMethods: z.array(z.string()).optional(),
  thinking: z.boolean().optional(),
});

/** `models.countTokens`. */
export const GeminiCountTokensSchema = z.looseObject({ totalTokens: count });

/** The error body: `{error: {code, message, status, details}}` (gRPC status in JSON). */
export const GeminiErrorBodySchema = z.looseObject({
  error: z.looseObject({
    code: z.number().int().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    details: z.array(z.unknown()).optional(),
  }),
});

/** `google.rpc.ErrorInfo` (e.g. `reason: "API_KEY_INVALID"`). */
export const GeminiErrorInfoSchema = z.looseObject({
  "@type": z.literal("type.googleapis.com/google.rpc.ErrorInfo"),
  reason: z.string().optional(),
});

/** `google.rpc.RetryInfo`: `retryDelay` is a protobuf Duration in JSON (`"41s"`, `"1.5s"`). */
export const GeminiRetryInfoSchema = z.looseObject({
  "@type": z.literal("type.googleapis.com/google.rpc.RetryInfo"),
  retryDelay: z.string(),
});

// Requests -----------------------------------------------------------------------------------------

export const GEMINI_THINKING_LEVELS = ["MINIMAL", "LOW", "MEDIUM", "HIGH"] as const;
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];

const TextPartSchema = z.strictObject({ text: z.string() });
const FunctionResponsePartSchema = z.strictObject({
  functionResponse: z.strictObject({
    id: z.string().optional(),
    name: z.string().min(1),
    response: z.record(z.string(), z.unknown()),
  }),
});

const UserContentSchema = z.strictObject({
  role: z.literal("user"),
  parts: z.array(z.union([FunctionResponsePartSchema, TextPartSchema])).min(1),
});
/** The model's own parts, echoed verbatim. */
const ModelContentSchema = z.strictObject({
  role: z.literal("model"),
  parts: z.array(GeminiPartSchema).min(1),
});

export const GeminiFunctionDeclarationSchema = z.strictObject({
  name: z.string().min(1).max(128),
  description: z.string(),
  /** JSON Schema; mutually exclusive with `parameters`. */
  parametersJsonSchema: z.record(z.string(), z.unknown()),
});

/** What the adapter sends to `generateContent` and `streamGenerateContent` (pinned). */
export const GeminiRequestSchema = z.strictObject({
  systemInstruction: z.strictObject({ parts: z.array(TextPartSchema).min(1) }),
  contents: z.array(z.union([UserContentSchema, ModelContentSchema])).min(1),
  tools: z.array(
    z.strictObject({ functionDeclarations: z.array(GeminiFunctionDeclarationSchema) }),
  ),
  toolConfig: z.strictObject({
    functionCallingConfig: z.strictObject({ mode: z.literal("AUTO") }),
  }),
  generationConfig: z.strictObject({
    maxOutputTokens: count.min(1),
    thinkingConfig: z.strictObject({
      thinkingLevel: z.enum(GEMINI_THINKING_LEVELS),
      includeThoughts: z.literal(true),
    }),
  }),
  /** Per-request logging off: it takes precedence over the project's logging setting. */
  store: z.literal(false),
});
export type GeminiRequest = z.infer<typeof GeminiRequestSchema>;
export type GeminiUserPart = z.infer<typeof UserContentSchema>["parts"][number];

/** `models.countTokens`'s body: the request it counts, with its model. */
export const GeminiCountTokensRequestSchema = z.strictObject({
  generateContentRequest: z.strictObject({
    model: z.string().regex(/^models\//),
    systemInstruction: GeminiRequestSchema.shape.systemInstruction,
    contents: GeminiRequestSchema.shape.contents,
    tools: GeminiRequestSchema.shape.tools,
    toolConfig: GeminiRequestSchema.shape.toolConfig,
  }),
});
