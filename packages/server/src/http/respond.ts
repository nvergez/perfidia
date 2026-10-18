import { INTERNAL, type ApiResult } from "../service/api.ts";
import { HSTS, SECURITY_HEADERS, cacheControl } from "./headers.ts";

// From a service result to an HTTP response (phase-3 design §3.1): JSON, gzipped above 8 KB when
// the client accepts it, `Cache-Control` from the route's policy, an ETag on cacheable bodies (304
// when it matches), and the security headers. Bodies of immutable resources are kept serialised and
// compressed in a small memo, so a finished match's pages are not serialised again per request.

const GZIP_ABOVE = 8 * 1024;
const MEMO_ENTRIES = 256;

interface Memo {
  readonly text: string;
  gz: Uint8Array | null;
  readonly etag: string;
}

export class BodyMemo {
  private readonly entries = new Map<string, Memo>();

  get(key: string): Memo | undefined {
    const m = this.entries.get(key);
    if (m !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, m);
    }
    return m;
  }

  set(key: string, m: Memo): void {
    this.entries.set(key, m);
    while (this.entries.size > MEMO_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}

export interface RespondOptions {
  readonly memo: BodyMemo;
  /** Behind a TLS proxy: send HSTS. */
  readonly hsts: boolean;
}

function etagOf(text: string): string {
  return `"${Bun.hash(text).toString(16)}"`;
}

export function securityHeaders(hsts: boolean): Record<string, string> {
  return hsts
    ? { ...SECURITY_HEADERS, "strict-transport-security": HSTS }
    : { ...SECURITY_HEADERS };
}

export function respond(req: Request, r: ApiResult, o: RespondOptions): Response {
  let memo = r.memo === undefined ? undefined : o.memo.get(r.memo);
  if (memo === undefined) {
    let text: string;
    try {
      text = JSON.stringify(r.body);
    } catch {
      return respond(req, INTERNAL, o);
    }
    memo = { text, gz: null, etag: etagOf(text) };
    if (r.memo !== undefined) o.memo.set(r.memo, memo);
  }
  const headers: Record<string, string> = {
    ...securityHeaders(o.hsts),
    "content-type": "application/json; charset=utf-8",
    "cache-control": cacheControl(r.cache),
    ...r.headers,
  };
  const cacheable = r.cache.kind !== "no-store" && r.status === 200;
  if (cacheable) {
    headers["etag"] = memo.etag;
    if (req.headers.get("if-none-match") === memo.etag) {
      return new Response(null, { status: 304, headers });
    }
  }
  let body: string | Uint8Array = memo.text;
  if (memo.text.length > GZIP_ABOVE) {
    headers["vary"] = "accept-encoding";
    if (/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) {
      memo.gz ??= Bun.gzipSync(memo.text);
      body = memo.gz;
      headers["content-encoding"] = "gzip";
    }
  }
  if (req.method === "HEAD") return new Response(null, { status: r.status, headers });
  return new Response(body, { status: r.status, headers });
}
