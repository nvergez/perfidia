// The spectator package's own layer rules (phase-3 design §2.1, §6.1), on top of the purity scan of
// `packages/sim/src/architecture.test.ts` (which covers this package's non-test sources): the
// `reduce` sub-path (the web's part) imports `@perfidia/protocol/spectator` and its own files only,
// and its browser bundle holds nothing else; the schemas of `@perfidia/protocol/spectator` bundle for
// the browser without the engine; and a ruleset's own event types and city tags are named in
// `fold/rulesets.ts` only.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = import.meta.dir;
const PROTOCOL_SPECTATOR = join(SRC, "..", "..", "protocol", "src", "spectator.ts");

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Non-test TypeScript sources under `dir`, relative to `src`, sorted. */
function sources(dir: string): string[] {
  return [...new Bun.Glob("**/*.ts").scanSync({ cwd: join(SRC, dir) })]
    .map((f) => (dir === "" ? f : `${dir}/${f}`))
    .filter((f) => !f.endsWith(".test.ts"))
    .toSorted(byText);
}

/** Every module specifier of a source: static, type-only, re-export, side-effect and dynamic. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) out.push(m[1] ?? "");
  return out;
}

const read = (file: string): string => readFileSync(join(SRC, file), "utf8");

describe("reduce: the web's part of the package", () => {
  test("imports @perfidia/protocol/spectator and its own files only", () => {
    const files = sources("reduce");
    expect(files).toContain("reduce/index.ts");
    for (const file of files) {
      for (const spec of specifiers(read(file))) {
        const ok = spec === "@perfidia/protocol/spectator" || /^\.\/[a-z]+\.ts$/.test(spec);
        expect([file, spec, ok]).toEqual([file, spec, true]);
      }
    }
  });

  test("the specifier scan sees every form of import", () => {
    const source = [
      'import { a } from "x1";',
      'import type { B } from "x2";',
      'export { c } from "x3";',
      'export type { D } from "x4";',
      'import "x5";',
      'const e = await import("x6");',
      "import {\n  f,\n} from 'x7';",
    ].join("\n");
    expect(specifiers(source)).toEqual(["x1", "x2", "x3", "x4", "x5", "x6", "x7"]);
  });

  test("its browser bundle holds the reduce files only", async () => {
    const built = await Bun.build({
      entrypoints: [join(SRC, "reduce", "index.ts")],
      target: "browser",
      minify: true,
      metafile: true,
    });
    expect(built.success).toBe(true);
    // Metafile paths are relative to the working directory.
    const inputs = Object.keys(built.metafile?.inputs ?? {})
      .map((p) => relative(SRC, resolve(p)))
      .toSorted(byText);
    expect(inputs).toEqual(sources("reduce"));
    const text = (await built.outputs[0]?.text()) ?? "";
    console.log(
      `reduce bundle: ${text.length} bytes minified, ${Bun.gzipSync(text).length} gzipped`,
    );
  });
});

describe("@perfidia/protocol/spectator", () => {
  test("bundles for the browser with protocol files and zod only", async () => {
    const built = await Bun.build({
      entrypoints: [PROTOCOL_SPECTATOR],
      target: "browser",
      minify: true,
      metafile: true,
    });
    expect(built.success).toBe(true);
    const inputs = Object.keys(built.metafile?.inputs ?? {});
    expect(inputs.length).toBeGreaterThan(1);
    for (const p of inputs) {
      const ok = /(^|\/)protocol\/src\/[a-z]+\.ts$/.test(p) || p.includes("node_modules/zod/");
      expect([p, ok]).toEqual([p, true]);
    }
    const text = (await built.outputs[0]?.text()) ?? "";
    console.log(
      `@perfidia/protocol/spectator bundle: ${text.length} bytes minified, ${Bun.gzipSync(text).length} gzipped`,
    );
  });
});

const quoted = (name: string): RegExp => new RegExp(`["'\`]${name}["'\`]`);

describe("ruleset knowledge stays in fold/rulesets.ts", () => {
  // perfidia-1's own event types and prize tags (docs/rulesets/perfidia-1.md §9, §13).
  const NAMES = [
    "siege_started",
    "siege_broken",
    "domination_started",
    "domination_cancelled",
    "queues_refunded",
    "crown",
    "olympus",
  ];

  test("rulesets.ts names each of them", () => {
    const own = read("fold/rulesets.ts");
    for (const name of NAMES) expect([name, quoted(name).test(own)]).toEqual([name, true]);
  });

  test("no other source names one", () => {
    const files = sources("").filter((f) => f !== "fold/rulesets.ts");
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = read(file);
      for (const name of NAMES) {
        expect([file, name, quoted(name).test(source)]).toEqual([file, name, false]);
      }
    }
  });
});
