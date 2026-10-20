import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "@perfidia/sim";
import { z } from "@perfidia/protocol";
import { recordingFetch, type HttpFetch, type RecordedExchange } from "../model/http.ts";

// `arena smoke --record <dir>` (phase-4 design §8.2): every request of a smoke and its response,
// sanitised, one `perfidia-recording/1` file per exchange in `<dir>`, numbered in the order the
// responses arrived. These are real bodies: committed next to an adapter's synthetic fixtures
// (`model/fixtures/<provider>/`), they pin what the docs could not (the shape of a usage, of an
// error, of a stream) and `recordedResponse` replays one through a stub fetch.
//
// Sanitising: no header is kept but the response's content type (keys, request ids and account
// headers never reach the file); every occurrence of the key (raw and URL-encoded) becomes
// `<key>`; the values of id fields (`ID_KEYS`: response, message, call, generation, request,
// organisation, project and user ids) become `<id-N>`, the same N for the same value across the
// whole recording, so a call and its result still match; the provider's model ids are kept.

export const RECORDING_FORMAT = "perfidia-recording/1";

/** Fields whose string values are identifiers: replaced, consistently, by `<id-N>`. */
export const ID_KEYS: ReadonlySet<string> = new Set([
  "id",
  "call_id",
  "tool_use_id",
  "tool_call_id",
  "item_id",
  "responseId",
  "response_id",
  "previous_response_id",
  "request_id",
  "requestId",
  "generation_id",
  "organization",
  "organization_id",
  "project",
  "project_id",
  "user",
  "user_id",
  "account_id",
]);

/** One SSE event of a recorded stream. */
export const RecordedEventSchema = z.strictObject({
  event: z.string().optional(),
  data: z.unknown().optional(),
  comment: z.string().optional(),
});
export type RecordedEvent = z.infer<typeof RecordedEventSchema>;

export const RecordingFileSchema = z.strictObject({
  format: z.literal(RECORDING_FORMAT),
  synthetic: z.literal(false),
  /** The UTC day of the recording. */
  recorded: z.string(),
  source: z.string(),
  provider: z.string().min(1),
  request: z.strictObject({ method: z.string(), url: z.string(), body: z.unknown() }),
  response: z.strictObject({
    status: z.int(),
    contentType: z.string().nullable(),
    /** The stream broke before its end (what came is kept). */
    broken: z.boolean(),
    /** A JSON (or text) body; absent for a stream. */
    body: z.unknown().optional(),
    /** A stream's events, in order. */
    events: z.array(RecordedEventSchema).optional(),
  }),
});
export type RecordingFile = z.infer<typeof RecordingFileSchema>;

/** The sanitiser of one recording: keys out, ids renumbered consistently. */
export class Sanitiser {
  private readonly ids = new Map<string, string>();
  private readonly secrets: readonly string[];
  private readonly keep: ReadonlySet<string>;

  /** `keep`: values that stay as they are in an id field (the provider's model ids). */
  constructor(secrets: readonly string[], keep: readonly string[] = []) {
    this.keep = new Set(keep);
    this.secrets = [
      ...new Set(secrets.flatMap((k) => (k === "" ? [] : [k, encodeURIComponent(k)]))),
    ].toSorted((a, b) => b.length - a.length);
  }

  text(s: string): string {
    let out = s;
    for (const k of this.secrets) out = out.split(k).join("<key>");
    return out;
  }

  private id(value: string): string {
    let token = this.ids.get(value);
    if (token === undefined) {
      token = `<id-${this.ids.size + 1}>`;
      this.ids.set(value, token);
    }
    return token;
  }

  value(v: unknown, key: string | null = null): unknown {
    if (typeof v === "string") {
      return key !== null && ID_KEYS.has(key) && !this.keep.has(v) ? this.id(v) : this.text(v);
    }
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.value(x, k)]));
  }

  /** A body as JSON when it parses, else as sanitised text. */
  body(text: string | null): unknown {
    if (text === null) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      return this.value(parsed);
    } catch {
      return this.text(text);
    }
  }

  /** An SSE body as its events (data parsed when it is JSON). */
  events(text: string): RecordedEvent[] {
    const out: RecordedEvent[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      if (block.trim() === "") continue;
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(":")) out.push({ comment: this.text(line.slice(1).trim()) });
        else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (event === undefined && data.length === 0) continue;
      const raw = data.join("\n");
      out.push({
        ...(event === undefined ? {} : { event }),
        ...(data.length === 0 ? {} : { data: raw === "[DONE]" ? raw : this.body(raw) }),
      });
    }
    return out;
  }

  exchange(e: RecordedExchange, o: { provider: string; recorded: string }): RecordingFile {
    const stream = e.contentType?.includes("text/event-stream") === true;
    return {
      format: RECORDING_FORMAT,
      synthetic: false,
      recorded: o.recorded,
      source: `bun run arena -- smoke --provider ${o.provider} --record (keys, request and account ids replaced)`,
      provider: o.provider,
      request: { method: e.method, url: this.text(e.url), body: this.body(e.requestBody) },
      response: {
        status: e.status,
        contentType: e.contentType,
        broken: e.broken,
        ...(stream ? { events: this.events(e.responseBody) } : { body: this.body(e.responseBody) }),
      },
    };
  }
}

export interface Recording {
  /** The fetch to give the smoke's adapter (the guard wraps it). */
  readonly fetch: HttpFetch;
  /** Waits for every exchange to be written; returns how many were. */
  done(): Promise<number>;
}

/** The file name of the `n`-th exchange: its number, method and the URL's last path segment. */
function fileName(n: number, e: RecordedExchange): string {
  const path = new URL(e.url).pathname.split("/").filter((p) => p !== "");
  const last = (path.at(-1) ?? "root").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  return `${String(n).padStart(2, "0")}-${e.method.toLowerCase()}-${last}.json`;
}

/**
 * Starts a recording into `dir` (created; refused when it already holds files, so recordings
 * never mix). `secrets` are the keys the smoke may send.
 */
export function startRecording(
  dir: string,
  o: {
    readonly provider: string;
    readonly secrets: readonly string[];
    readonly now: () => number;
    /** Values kept in id fields (the provider's model ids: `id` of a models response). */
    readonly keep?: readonly string[];
    /** Tests: the inner fetch (a stub). */
    readonly inner?: HttpFetch;
  },
): Recording {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new UsageError(`--record: ${dir} already holds files; give an empty or new directory`);
  }
  mkdirSync(dir, { recursive: true });
  const sanitiser = new Sanitiser(o.secrets, o.keep ?? []);
  const recorded = new Date(o.now()).toISOString().slice(0, 10);
  const pending: Promise<void>[] = [];
  let n = 0;
  const sink = (exchange: Promise<RecordedExchange>): void => {
    pending.push(
      exchange.then((e) => {
        n += 1;
        const file = sanitiser.exchange(e, { provider: o.provider, recorded });
        writeFileSync(join(dir, fileName(n, e)), `${JSON.stringify(file, null, 2)}\n`);
      }),
    );
  };
  return {
    fetch: recordingFetch(sink, o.inner),
    done: async () => {
      await Promise.all(pending);
      return n;
    },
  };
}

/** Reads a recording file. */
export function readRecording(path: string): RecordingFile {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return RecordingFileSchema.parse(parsed);
}

/** A recorded response, served again (a stream as SSE text, `\n\n` between events). */
export function recordedResponse(file: RecordingFile): Response {
  const r = file.response;
  const headers = { "content-type": r.contentType ?? "application/json" };
  if (r.events === undefined) {
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null);
    return new Response(body, { status: r.status, headers });
  }
  const text = r.events
    .map((e) => {
      if (e.comment !== undefined) return `: ${e.comment}\n\n`;
      const lines = [
        ...(e.event === undefined ? [] : [`event: ${e.event}`]),
        ...(e.data === undefined
          ? []
          : [`data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}`]),
      ];
      return `${lines.join("\n")}\n\n`;
    })
    .join("");
  return new Response(text, { status: r.status, headers });
}
