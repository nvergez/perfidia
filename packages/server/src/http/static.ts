import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  watch,
  type FSWatcher,
  constants,
} from "node:fs";
import { join } from "node:path";
import { SECURITY_HEADERS, HSTS, cacheControl } from "./headers.ts";

// The web app's static files (`--web-dist`, phase-3 design §5.4, §6.4): an index of the built
// directory made at startup (and again on changes with `--dev`), so a request path is only ever a
// key of that index: no path is built from a request, and nothing outside the index is read.
// Symbolic links and special files are skipped (`lstat`, then `O_NOFOLLOW` and `fstat` on the open
// descriptor). Hashed assets (Bun's `name-<hash>.ext`) are cached for a year (`private`, as every
// response of this server: a takedown is not undone by a shared cache), `index.html` and unhashed
// files are revalidated (`no-cache`). Every path outside `/api` that is not a file gets `index.html`
// (the app routes it), for GET and HEAD only; `/api` paths never do. The page's CSP allows the
// same-origin WebSocket explicitly (`wss:` of the request's host, which the gate checked, and `ws:`
// too without TLS) and requires Trusted Types.

const MAX_FILES = 2_000;
const MAX_BYTES = 64 * 1024 * 1024;
const GZIP_ABOVE = 1024;

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  map: "application/json; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
});

const COMPRESSIBLE = /^(text\/|application\/json|image\/svg\+xml)/;

/** Bun's hashed output names: `chunk-7nfh6a9j.js`, `favicon-a9xj95p3.svg`, `….js.map`. */
const HASHED = /-[a-z0-9]{8,}\.[a-z0-9]+(\.map)?$/;

export interface StaticFile {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly gzip: Uint8Array<ArrayBuffer> | null;
  readonly type: string;
  readonly etag: string;
  readonly immutable: boolean;
}

/** Whether a path belongs to the API (never served from the static index). */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function readRegular(path: string): Uint8Array<ArrayBuffer> | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const out = new Uint8Array(st.size);
    let at = 0;
    while (at < out.length) {
      const n = readSync(fd, out, at, out.length - at, at);
      if (n <= 0) break;
      at += n;
    }
    return at === out.length ? out : out.slice(0, at);
  } finally {
    closeSync(fd);
  }
}

/** Every regular file under `root`, keyed by URL path (`/chunk-x.js`); links and dotfiles skipped. */
export function indexDirectory(root: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  let bytes = 0;
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || !/^[A-Za-z0-9._@-]+$/.test(name)) continue;
      const path = join(dir, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(path, `${prefix}${name}/`);
        continue;
      }
      if (!st.isFile()) continue;
      if (files.size >= MAX_FILES) throw new Error(`--web-dist: more than ${MAX_FILES} files`);
      const body = readRegular(path);
      if (body === null) continue;
      bytes += body.length;
      if (bytes > MAX_BYTES) throw new Error(`--web-dist: more than ${MAX_BYTES} bytes`);
      const ext = name.includes(".") ? (name.split(".").at(-1) ?? "").toLowerCase() : "";
      const type = TYPES[ext] ?? "application/octet-stream";
      const gzip = COMPRESSIBLE.test(type) && body.length > GZIP_ABOVE ? Bun.gzipSync(body) : null;
      files.set(`${prefix}${name}`, {
        body,
        gzip,
        type,
        etag: `"${Bun.hash(body).toString(16)}"`,
        immutable: HASHED.test(name),
      });
    }
  };
  walk(root, "/");
  return files;
}

export class StaticSite {
  readonly dir: string;
  private files: Map<string, StaticFile>;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Indexes `dir` (which must hold `index.html`); with `watch`, re-indexes on changes. */
  constructor(
    dir: string,
    o: { readonly watch?: boolean; readonly warn?: (m: string) => void } = {},
  ) {
    this.dir = dir;
    this.files = indexDirectory(dir);
    if (!this.files.has("/index.html")) {
      throw new Error(`--web-dist ${dir}: no index.html (build the app: bun run web:build)`);
    }
    if (o.watch === true) {
      try {
        this.watcher = watch(dir, { recursive: true }, () => this.schedule(o.warn));
      } catch {
        o.warn?.(`--web-dist ${dir}: cannot watch for changes`);
      }
    }
  }

  private schedule(warn?: (m: string) => void): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        const next = indexDirectory(this.dir);
        if (next.has("/index.html")) this.files = next;
      } catch (e) {
        warn?.(`--web-dist: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, 100);
  }

  get size(): number {
    return this.files.size;
  }

  /** The file at a URL path; `/` is `index.html`. */
  file(pathname: string): StaticFile | null {
    return this.files.get(pathname === "/" ? "/index.html" : pathname) ?? null;
  }

  /** The file at a path, else `index.html` (the app's route): the response for any non-API path. */
  resolve(pathname: string): StaticFile | null {
    return this.file(pathname) ?? this.files.get("/index.html") ?? null;
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * The page's CSP: the API's, with the same-origin WebSocket of `host` named in `connect-src`
 * (`wss:` only behind TLS, `ws:` and `wss:` otherwise), and Trusted Types required with no policy
 * allowed, so no HTML or script sink accepts a string even if a future change reached for one.
 */
export function pageCsp(host: string | null, tls = false): string {
  const base = `${SECURITY_HEADERS["content-security-policy"] ?? ""}; ${TRUSTED_TYPES}`;
  if (host === null || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) return base;
  const sockets = tls ? `wss://${host}` : `ws://${host} wss://${host}`;
  return base.replace("connect-src 'self'", `connect-src 'self' ${sockets}`);
}

const TRUSTED_TYPES = "require-trusted-types-for 'script'; trusted-types 'none'";

/** The response for a non-API path: a file of the index, or `index.html`. */
export function serveStatic(
  req: Request,
  pathname: string,
  site: StaticSite,
  hsts: boolean,
): Response | null {
  const f = site.resolve(pathname);
  if (f === null) return null;
  // Each encoding is its own representation, with its own ETag (a shared one would let a strict
  // cache answer a gzip request with the identity body's validator, or the other way round).
  const gzip = f.gzip !== null && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
  const body = gzip && f.gzip !== null ? f.gzip : f.body;
  const etag = gzip ? `${f.etag.slice(0, -1)}-gz"` : f.etag;
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    ...(hsts ? { "strict-transport-security": HSTS } : {}),
    "content-type": f.type,
    "cache-control": f.immutable ? cacheControl({ kind: "immutable" }) : "no-cache",
    etag,
  };
  if (f.type.startsWith("text/html")) {
    headers["content-security-policy"] = pageCsp(req.headers.get("host"), hsts);
  }
  if (f.gzip !== null) headers["vary"] = "accept-encoding";
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (gzip) headers["content-encoding"] = "gzip";
  // HEAD: the length GET would send.
  if (req.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: { ...headers, "content-length": String(body.length) },
    });
  }
  return new Response(body, { status: 200, headers });
}
