// The web app's static files (`--web-dist`, phase-3 design §5.4, §6.4), on both adapters: `index.html`
// and the SPA fallback for every non-API path (GET and HEAD), hashed assets cached a year and the
// page revalidated, gzip and ETags, the security headers with a CSP whose `connect-src` names the
// same-origin WebSocket; traversal, symbolic links and dotfiles never reach a file outside the
// index; `/api` paths keep their JSON 404; the Host check, read-only methods; a directory without
// `index.html` refuses to start; with `--dev` the index follows a rebuild.

// oxlint-disable no-await-in-loop -- the requests follow each other on purpose
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiErrorSchema } from "@perfidia/protocol/spectator";
import { parseServeArgs } from "./config.ts";
import { indexDirectory, pageCsp } from "./http/static.ts";
import {
  serve,
  stopServers,
  tempDir,
  testConfig,
  waitFor,
  type TestServer,
} from "./testkit.test.ts";

afterAll(stopServers);

const INDEX =
  '<!doctype html><html><head><script type="module" src="/chunk-abc12345.js"></script></head><body><div id="root"></div></body></html>';
const SCRIPT = `console.log(${JSON.stringify("x".repeat(4_000))});`;
const SECRET = "TOP-SECRET-OUTSIDE-THE-DIST";

/** A built-app directory, a secret file beside it and a link to it inside. */
function makeDist(): { readonly dist: string; readonly secret: string } {
  const root = tempDir("web");
  const dist = join(root, "dist");
  mkdirSync(join(dist, "sub", "dir"), { recursive: true });
  writeFileSync(join(dist, "index.html"), INDEX);
  writeFileSync(join(dist, "chunk-abc12345.js"), SCRIPT);
  writeFileSync(join(dist, "chunk-abc12345.js.map"), "{}");
  writeFileSync(join(dist, "chunk-def67890.css"), "body{color:red}");
  writeFileSync(join(dist, "favicon.svg"), "<svg/>");
  writeFileSync(join(dist, "sub", "dir", "deep-aaaabbbb.js"), "export {};");
  writeFileSync(join(dist, ".secret"), SECRET);
  const secret = join(root, "secret.txt");
  writeFileSync(secret, SECRET);
  symlinkSync(secret, join(dist, "link.js"));
  symlinkSync(root, join(dist, "up"));
  return { dist, secret };
}

describe("the static index", () => {
  test("holds regular files only: no links, no dotfiles", () => {
    const { dist } = makeDist();
    const files = indexDirectory(dist);
    expect([...files.keys()].toSorted((a, b) => (a < b ? -1 : 1))).toEqual([
      "/chunk-abc12345.js",
      "/chunk-abc12345.js.map",
      "/chunk-def67890.css",
      "/favicon.svg",
      "/index.html",
      "/sub/dir/deep-aaaabbbb.js",
    ]);
    expect(files.get("/chunk-abc12345.js")?.immutable).toBe(true);
    expect(files.get("/chunk-abc12345.js.map")?.immutable).toBe(true);
    expect(files.get("/favicon.svg")?.immutable).toBe(false);
    expect(files.get("/index.html")?.immutable).toBe(false);
  });

  test("the page's CSP names the same-origin WebSocket; odd hosts get the plain policy", () => {
    expect(pageCsp("127.0.0.1:8080")).toContain(
      "connect-src 'self' ws://127.0.0.1:8080 wss://127.0.0.1:8080;",
    );
    expect(pageCsp("evil.example; script-src *")).toContain("connect-src 'self';");
    expect(pageCsp(null)).toContain("connect-src 'self';");
  });

  test("--web-dist is a flag; a directory without index.html refuses to start", () => {
    expect(parseServeArgs(["--runs", "r", "--all-runs", "--web-dist", "d"]).webDist).toBe("d");
    expect(parseServeArgs(["--runs", "r", "--all-runs"]).webDist).toBeNull();
    const empty = tempDir("web-empty");
    expect(() => serve(testConfig({ runs: tempDir("runs"), webDist: empty }))).toThrow(
      /no index\.html/,
    );
  });
});

for (const adapter of ["elysia", "raw"] as const) {
  describe(`--web-dist on the ${adapter} adapter`, () => {
    let s: TestServer;
    let host = "";

    beforeAll(() => {
      const { dist } = makeDist();
      s = serve(testConfig({ runs: tempDir("runs"), webDist: dist, adapter }));
      host = `127.0.0.1:${s.port}`;
    });

    test("/ and every non-API path answer index.html, revalidated, with the page's CSP", async () => {
      for (const path of [
        "/",
        "/index.html",
        "/m/war",
        "/m/war/",
        "/m/perfidia-1@1.1.0?pair=p1,p2",
        "/x//y",
        "/apix",
      ]) {
        const res = await fetch(`${s.url}${path}`);
        expect([path, res.status, await res.text()]).toEqual([path, 200, INDEX]);
        expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(res.headers.get("cache-control")).toBe("no-cache");
        const csp = res.headers.get("content-security-policy") ?? "";
        expect(csp).toContain(`connect-src 'self' ws://${host} wss://${host};`);
        expect(csp).toContain("script-src 'self';");
        expect(csp).toContain("frame-ancestors 'none'");
        for (const h of [
          "x-content-type-options",
          "referrer-policy",
          "permissions-policy",
          "cross-origin-opener-policy",
          "cross-origin-resource-policy",
        ]) {
          expect([path, h, res.headers.get(h) !== null]).toEqual([path, h, true]);
        }
      }
    });

    test("hashed assets are immutable for a year; gzip, ETag and HEAD", async () => {
      const res = await fetch(`${s.url}/chunk-abc12345.js`, {
        headers: { "accept-encoding": "identity" },
      });
      expect(await res.text()).toBe(SCRIPT);
      expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
      const gz = await fetch(`${s.url}/chunk-abc12345.js`, {
        headers: { "accept-encoding": "gzip" },
        decompress: false,
      } as RequestInit);
      expect(gz.headers.get("content-encoding")).toBe("gzip");
      expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toBe(
        SCRIPT,
      );
      const etag = res.headers.get("etag") ?? "";
      expect(etag).not.toBe("");
      expect(
        (await fetch(`${s.url}/chunk-abc12345.js`, { headers: { "if-none-match": etag } })).status,
      ).toBe(304);
      const head = await fetch(`${s.url}/`, { method: "HEAD" });
      expect([head.status, (await head.text()).length, head.headers.get("content-type")]).toEqual([
        200,
        0,
        "text/html; charset=utf-8",
      ]);
      expect((await fetch(`${s.url}/favicon.svg`)).headers.get("cache-control")).toBe("no-cache");
      expect(await (await fetch(`${s.url}/sub/dir/deep-aaaabbbb.js`)).text()).toBe("export {};");
      expect((await fetch(`${s.url}/chunk-def67890.css`)).headers.get("content-type")).toBe(
        "text/css; charset=utf-8",
      );
    });

    test("traversal, links and dotfiles never reach a file outside the index", async () => {
      for (const path of [
        "/..%2fsecret.txt",
        "/%2e%2e/secret.txt",
        "/sub/..%2f..%2fsecret.txt",
        "/link.js",
        "/up/secret.txt",
        "/.secret",
        "/%2esecret",
        "/sub/dir/..%2F..%2F..%2Fsecret.txt",
      ]) {
        const res = await fetch(`${s.url}${path}`);
        const text = await res.text();
        expect([path, text.includes(SECRET)]).toEqual([path, false]);
        expect([path, res.status, text]).toEqual([path, 200, INDEX]);
      }
    });

    test("/api paths keep their JSON 404; read-only; the Host is checked", async () => {
      for (const path of ["/api", "/api/", "/api/nope", "/api/matches/", "/api//matches"]) {
        const res = await fetch(`${s.url}${path}`);
        expect([path, res.status]).toEqual([path, 404]);
        expect(ApiErrorSchema.parse(await res.json()).code).toBe("NO_ROUTE");
      }
      expect((await fetch(`${s.url}/api/health`)).status).toBe(200);
      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = await fetch(`${s.url}/`, { method });
        expect([method, res.status]).toEqual([method, 405]);
        expect(ApiErrorSchema.parse(await res.json()).code).toBe("METHOD_NOT_ALLOWED");
      }
      const res = await fetch(`${s.url}/`, {
        headers: { host: `rebind.attacker.example:${s.port}` },
      });
      expect(res.status).toBe(421);
    });
  });
}

describe("--web-dist with --dev", () => {
  test("a rebuild is served without a restart", async () => {
    const { dist } = makeDist();
    const s = serve(testConfig({ runs: tempDir("runs"), webDist: dist, dev: true }));
    writeFileSync(join(dist, "chunk-new00000.js"), "export const fresh = 1;");
    writeFileSync(join(dist, "index.html"), INDEX.replace("abc12345", "new00000"));
    await waitFor(
      async () =>
        (await (await fetch(`${s.url}/chunk-new00000.js`)).text()) === "export const fresh = 1;",
      10_000,
      "the re-index",
    );
    expect(await (await fetch(`${s.url}/`)).text()).toContain("new00000");
  });
});
