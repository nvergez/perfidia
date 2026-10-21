// The web app's layer rules (phase-3 design §2.1, §4.5, §6.4; task B1): its sources import only
// React, the pinned UI packages, `@perfidia/protocol/spectator` and `@perfidia/spectator/reduce`
// (never the protocol's root barrel, the engine, the gateway, the spectator root, Bun or Node);
// they use no host globals (`Bun`, `process`); ruleset ids (buildings, units, queues, event types,
// island kinds) appear in `src/skins/**` only; no file under `src` renders HTML from strings;
// `localStorage` is touched by `lib/storage.ts` only; `index.html` has no inline script; and the
// bundle (built in process, split) holds none of the banned packages and keeps its initial load
// (the entry chunk and what it imports statically; `import()` chunks are lazy) within budget, the
// model statistics page and the dossier's model block (phase 4) outside it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { RULESETS } from "@perfidia/engine/rulesets";
import { initialOutputs } from "../scripts/build.ts";
import { field, isRecord } from "./lib/json.ts";

const SRC = import.meta.dir;
const WEB = join(SRC, "..");
/**
 * The initial load's JS, gzipped: the design's budget is 200 KB (§6.3); Pass C holds it at 185 KB
 * (docs/phase3.md §16), so its features stay in chunks loaded on demand. This build splits from
 * `main.tsx` (no stylesheet needed), so its entry and shared chunks are gzipped apart: a few KB
 * more than `bun run web:build`, whose page entry holds both.
 */
const JS_BUDGET_GZ = 185 * 1024;

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
  "lucide-react",
  "@perfidia/protocol/spectator",
  "@perfidia/spectator/reduce",
]);

/** Whether a relative specifier of `file` names a source under `src` (not another package's). */
export function staysInSrc(file: string, spec: string, src = SRC): boolean {
  if (!/^\.\.?\/[A-Za-z0-9/_.-]+\.tsx?$/.test(spec)) return false;
  const target = resolve(src, dirname(file), spec);
  return target.startsWith(src + sep);
}

describe("imports", () => {
  test("web sources import React, the UI packages, the spectator sub-paths and their own files only", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      for (const spec of specifiers(read(file))) {
        const ok = ALLOWED.has(spec) || staysInSrc(file, spec);
        expect([file, spec, ok]).toEqual([file, spec, true]);
      }
    }
  });

  test("a relative import must resolve under src: another package's files are refused", () => {
    expect(staysInSrc("map/layers.tsx", "../lib/ids.ts")).toBe(true);
    expect(staysInSrc("main.tsx", "./app.tsx")).toBe(true);
    expect(staysInSrc("main.tsx", "../../engine/src/index.ts")).toBe(false);
    expect(staysInSrc("map/layers.tsx", "../../../protocol/src/log.ts")).toBe(false);
    expect(staysInSrc("map/layers.tsx", "../../scripts/build.ts")).toBe(false);
    expect(staysInSrc("main.tsx", "../src/app.tsx")).toBe(true);
    expect(staysInSrc("main.tsx", "@perfidia/engine")).toBe(false);
  });

  test("main.tsx loads zod-jitless.ts before anything else (no CSP eval probe)", () => {
    expect(specifiers(read("main.tsx"))[0]).toBe("./zod-jitless.ts");
    expect(specifiers(read("zod-jitless.ts"))).toEqual([]);
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

/** HTML sinks, code from strings and navigation to a string (none is used by the app). */
const SINKS: readonly RegExp[] = [
  /\.(?:inner|outer)HTML\b/,
  /\[\s*["'`](?:inner|outer)HTML["'`]\s*\]/,
  /insertAdjacentHTML/,
  /createContextualFragment/,
  /parseFromString/,
  /setHTMLUnsafe/,
  /\bsrc[dD]oc\b/,
  /javascript:/i,
  /document\.write/,
  /\beval\(/,
  /new Function\(/,
  /window\.open\(/,
  /\blocation\.(?:href\s*=|assign\(|replace\()/,
];

/**
 * A link target (`href=`) the app may render: a literal path of the app (not `//host`), the router's
 * `matchHref`/`modelHref`/`routeHref`, or `AppLink` passing its own (checked) prop through.
 */
function linkOk(file: string, value: string): boolean {
  if (value.startsWith('"') || value.startsWith("'")) {
    const href = value.slice(1, -1);
    return href.startsWith("/") && !href.startsWith("//");
  }
  const expr = value.slice(1, -1).trim();
  if (file === "common/link.tsx" && expr === "href") return true;
  return /^(?:matchHref|modelHref|routeHref)\(/.test(expr);
}

describe("plain text only", () => {
  const DANGER = ["dangerously", "SetInnerHTML"].join("");

  test("nothing under src renders HTML from a string or navigates to a string", () => {
    for (const file of all()) {
      const text = read(file);
      expect([file, text.includes(DANGER)]).toEqual([file, false]);
      if (file === "architecture.test.ts") continue;
      for (const re of SINKS) {
        expect([file, re.source, re.test(text)]).toEqual([file, re.source, false]);
      }
    }
  });

  test("the sink patterns catch the HTML and navigation sinks", () => {
    const probes = [
      "el.innerHTML = t",
      'el["innerHTML"] = t',
      "el[`outerHTML`] = t",
      "document.createRange().createContextualFragment(t)",
      'new DOMParser().parseFromString(t, "text/html")',
      "el.setHTMLUnsafe(t)",
      "<iframe srcDoc={t} />",
      "<a href={`javascript:${t}`}>",
      "window.open(u)",
      "window.location.href = u",
      "location.assign(u)",
      "document.location.replace(u)",
      "new Function(t)",
    ];
    for (const p of probes) expect([p, SINKS.some((re) => re.test(p))]).toEqual([p, true]);
  });

  test("every link is a literal app path or comes from matchHref/modelHref/routeHref", () => {
    for (const file of sources().filter((f) => f.endsWith(".tsx"))) {
      const text = code(read(file));
      for (const m of text.matchAll(/\bhref=(\{[^}]*\}|"[^"]*"|'[^']*')/g)) {
        expect([file, m[1], linkOk(file, m[1] ?? "")]).toEqual([file, m[1], true]);
      }
    }
    expect(linkOk("x.tsx", '"/"')).toBe(true);
    expect(linkOk("x.tsx", '"//evil.example/phish"')).toBe(false);
    expect(linkOk("x.tsx", "{matchHref(item.id)}")).toBe(true);
    expect(linkOk("x.tsx", "{modelHref(m.id)}")).toBe(true);
    expect(linkOk("x.tsx", "{t}")).toBe(false);
    expect(linkOk("x.tsx", "{`javascript:${t}`}")).toBe(false);
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
  test("keeps its initial load within budget and holds none of the banned packages", async () => {
    const built = await Bun.build({
      entrypoints: [join(SRC, "main.tsx")],
      target: "browser",
      minify: true,
      splitting: true,
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
      /node_modules\/.*\/(elysia|@elysia|@anthropic-ai|tailwind-merge)\//,
    ];
    for (const p of inputs) {
      for (const re of banned) expect([p, re.source, re.test(p)]).toEqual([p, re.source, false]);
    }
    const initial = initialOutputs(built.metafile?.outputs ?? {}, (_, m) =>
      (m.entryPoint ?? "").endsWith("main.tsx"),
    );
    const sizes = await Promise.all(
      built.outputs.map(async (out) => {
        const bytes = new Uint8Array(await out.arrayBuffer());
        const path = out.path.replace(/^\.\//, "");
        return { initial: initial.has(path), raw: bytes.length, gzip: Bun.gzipSync(bytes).length };
      }),
    );
    const sum = (init: boolean, k: "raw" | "gzip"): number =>
      sizes.filter((x) => x.initial === init).reduce((n, x) => n + x[k], 0);
    const lazyChunks = sizes.filter((x) => !x.initial).length;
    console.log(
      `web bundle: initial ${sum(true, "raw")} bytes minified, ${sum(true, "gzip")} gzipped (budget ${JS_BUDGET_GZ}); lazy ${sum(false, "gzip")} gzipped in ${lazyChunks} chunks`,
    );
    expect(initial.size).toBeGreaterThan(0);
    expect(lazyChunks).toBeGreaterThan(5);
    expect(sum(true, "gzip")).toBeLessThanOrEqual(JS_BUDGET_GZ);
    // Phase 4 Pass 3: the model statistics page and the dossier's model block load on demand.
    const lazyOnly = [
      "src/models/models-page.tsx",
      "src/models/parts.tsx",
      "src/models/format.ts",
      "src/players/model-block.tsx",
      "src/players/match-stats.ts",
    ];
    const outputs = Object.entries(built.metafile?.outputs ?? {});
    const seen = new Set<string>();
    for (const [path, meta] of outputs) {
      for (const input of Object.keys(meta.inputs)) {
        const rel = relative(WEB, resolve(input));
        if (!lazyOnly.includes(rel)) continue;
        seen.add(rel);
        expect([rel, initial.has(path.replace(/^\.\//, ""))]).toEqual([rel, false]);
      }
    }
    expect([...seen].toSorted(byText)).toEqual(lazyOnly.toSorted(byText));
  });
});
