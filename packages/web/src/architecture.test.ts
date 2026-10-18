// The web app's layer rules (phase-3 design §2.1, §4.5, §6.4; task B1): its sources import only
// React, the pinned UI packages, `@perfidia/protocol/spectator` and `@perfidia/spectator/reduce`
// (never the protocol's root barrel, the engine, the gateway, the spectator root, Bun or Node);
// they use no host globals (`Bun`, `process`); ruleset ids (buildings, units, queues, event types,
// island kinds) appear in `src/skins/**` only; no file under `src` renders HTML from strings;
// `localStorage` is touched by `lib/storage.ts` only; `index.html` has no inline script; and the
// bundle (built in process) stays within the initial-load budget and holds none of the banned
// packages.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { RULESETS } from "@perfidia/engine/rulesets";
import { field, isRecord } from "./lib/json.ts";

const SRC = import.meta.dir;
const WEB = join(SRC, "..");
const JS_BUDGET_GZ = 200 * 1024;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every TypeScript source under `src`, relative to it, sorted. */
function all(): string[] {
  return [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })].toSorted(byText);
}

const isTest = (f: string): boolean => /\.test\.tsx?$/.test(f);
const sources = (): string[] => all().filter((f) => !isTest(f));
const read = (file: string): string => readFileSync(join(SRC, file), "utf8");

/** Source text without comments (good enough for these scans: no comment markers in strings). */
function code(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every module specifier of a source: static, type-only, re-export, side-effect and dynamic. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) out.push(m[1] ?? "");
  return out;
}

const ALLOWED = new Set([
  "react",
  "react-dom",
  "react-dom/client",
  "zustand",
  "radix-ui",
  "class-variance-authority",
  "clsx",
  "tailwind-merge",
  "lucide-react",
  "@perfidia/protocol/spectator",
  "@perfidia/spectator/reduce",
]);

describe("imports", () => {
  test("web sources import React, the UI packages, the spectator sub-paths and their own files only", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      for (const spec of specifiers(read(file))) {
        const ok = ALLOWED.has(spec) || /^\.\.?\/[A-Za-z0-9/_.-]+\.tsx?$/.test(spec);
        expect([file, spec, ok]).toEqual([file, spec, true]);
      }
    }
  });

  test("no host globals: Bun, process, require", () => {
    for (const file of sources()) {
      const text = code(read(file));
      for (const re of [/\bBun\./, /\bprocess\./, /\bprocess\[/, /\brequire\(/]) {
        expect([file, re.source, re.test(text)]).toEqual([file, re.source, false]);
      }
    }
  });
});

const keysOf = (v: unknown): string[] => (isRecord(v) ? Object.keys(v) : []);

/** Every id a published ruleset gives buildings, units, queues, island kinds and its own events. */
function rulesetIds(): string[] {
  const ids = new Set<string>();
  for (const r of RULESETS) {
    const d: unknown = r.defaults;
    for (const k of keysOf(field(d, "buildings"))) ids.add(k);
    const units = field(d, "units");
    for (const k of keysOf(units)) {
      ids.add(k);
      const queue = field(field(units, k), "queue");
      if (typeof queue === "string") ids.add(queue);
    }
    for (const k of keysOf(field(field(d, "map"), "kinds"))) ids.add(k);
    for (const k of Object.keys(r.eventSchemas)) ids.add(k);
  }
  // `build` is the engine's construction queue, not a ruleset's.
  ids.delete("build");
  return [...ids].toSorted(byText);
}

const quoted = (id: string): RegExp => new RegExp(`["'\`]${id}["'\`]`);

describe("ruleset knowledge stays in src/skins", () => {
  test("no other web source names a ruleset's building, unit, queue, island kind or event type", () => {
    const ids = rulesetIds();
    for (const id of ["acropolis", "hoplite", "trireme", "barracks", "olympus", "siege_started"]) {
      expect(ids).toContain(id);
    }
    for (const file of sources().filter((f) => !f.startsWith("skins/"))) {
      const text = code(read(file));
      for (const id of ids) expect([file, id, quoted(id).test(text)]).toEqual([file, id, false]);
    }
  });
});

describe("plain text only", () => {
  const DANGER = ["dangerously", "SetInnerHTML"].join("");

  test("nothing under src renders HTML from a string", () => {
    for (const file of all()) {
      const text = read(file);
      expect([file, text.includes(DANGER)]).toEqual([file, false]);
      if (file === "architecture.test.ts") continue;
      for (const re of [
        /\.innerHTML\b/,
        /\.outerHTML\b/,
        /insertAdjacentHTML/,
        /document\.write/,
        /\beval\(/,
        /new Function\(/,
      ]) {
        expect([file, re.source, re.test(text)]).toEqual([file, re.source, false]);
      }
    }
  });

  test("localStorage only through lib/storage.ts", () => {
    for (const file of sources()) {
      const uses = /\blocalStorage\b/.test(code(read(file)));
      expect([file, uses]).toEqual([file, file === "lib/storage.ts"]);
    }
  });

  test("index.html loads its script from a file (no inline script, for the CSP)", () => {
    const html = read("index.html");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    for (const s of scripts) {
      expect(s[1]).toContain("src=");
      expect((s[2] ?? "").trim()).toBe("");
    }
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
  });
});

describe("the bundle", () => {
  test("stays within 200 KB gzipped and holds none of the banned packages", async () => {
    const built = await Bun.build({
      entrypoints: [join(SRC, "main.tsx")],
      target: "browser",
      minify: true,
      metafile: true,
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    });
    expect(built.success).toBe(true);
    const inputs = Object.keys(built.metafile?.inputs ?? {}).map((p) => relative(WEB, resolve(p)));
    const banned = [
      /packages\/engine\//,
      /packages\/gateway\//,
      /packages\/server\//,
      /packages\/protocol\/src\/index\.ts$/,
      /packages\/spectator\/src\/(?!reduce\/)/,
      /node_modules\/.*\/(elysia|@elysia|@anthropic-ai)\//,
    ];
    for (const p of inputs) {
      for (const re of banned) expect([p, re.source, re.test(p)]).toEqual([p, re.source, false]);
    }
    const sizes = await Promise.all(
      built.outputs.map(async (out) => {
        const bytes = new Uint8Array(await out.arrayBuffer());
        return { raw: bytes.length, gzip: Bun.gzipSync(bytes).length };
      }),
    );
    const raw = sizes.reduce((n, s) => n + s.raw, 0);
    const gzip = sizes.reduce((n, s) => n + s.gzip, 0);
    console.log(`web bundle: ${raw} bytes minified, ${gzip} gzipped (budget ${JS_BUDGET_GZ})`);
    expect(gzip).toBeLessThanOrEqual(JS_BUDGET_GZ);
  });
});
