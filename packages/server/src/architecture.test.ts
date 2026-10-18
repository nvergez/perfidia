// The server's source rules (phase-3 design §2.1, §6.1), checked on every non-test source:
// - only `config.ts` reads the environment (`process.env`, `Bun.env`), and no source names an
//   `ANTHROPIC_*` variable or imports `@anthropic-ai/sdk` or the orchestrator;
// - the fold runs in the worker only: `fold/worker.ts` alone imports the spectator fold
//   (`createSpectatorFold`, `foldLog`), so no request ever folds on the main thread;
// - the service layer is framework-free: `elysia` and `@elysia/*` are imported by
//   `http/elysia.ts` alone, and `service/`, `store/`, `timeline/` import no HTTP adapter.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;

const sources: readonly string[] = [...new Bun.Glob("**/*.ts").scanSync(DIR)]
  .filter((f) => !f.endsWith(".test.ts"))
  .map((f) => f.split("\\").join("/"))
  .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const text = (f: string): string => readFileSync(join(DIR, f), "utf8");

/** The module specifiers a source imports or re-exports (type-only ones included). */
function imports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^"';]*?from\s+"([^"]+)"/g)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  for (const m of src.matchAll(/\bimport\s+"([^"]+)"/g)) if (m[1] !== undefined) out.push(m[1]);
  return out;
}

describe("server sources", () => {
  test("the sources are found", () => {
    expect(sources).toContain("config.ts");
    expect(sources).toContain("fold/worker.ts");
    expect(sources).toContain("http/elysia.ts");
    expect(sources).toContain("http/raw.ts");
  });

  test("only config.ts reads the environment; no Anthropic SDK, key or orchestrator", () => {
    for (const f of sources) {
      const src = text(f);
      const env = /\bprocess\.env\b|\bBun\.env\b/.test(src);
      expect([f, env]).toEqual([f, f === "config.ts"]);
      expect([f, /ANTHROPIC_/.test(src)]).toEqual([f, false]);
      for (const spec of imports(src)) {
        const banned =
          spec.startsWith("@anthropic-ai/") ||
          spec.startsWith("@perfidia/orchestrator") ||
          spec.startsWith("@perfidia/sim") ||
          spec.startsWith("@perfidia/bots");
        expect([f, spec, banned]).toEqual([f, spec, false]);
      }
    }
  });

  test("the spectator fold is imported by the worker alone", () => {
    for (const f of sources) {
      const folds =
        /\b(?:createSpectatorFold|foldLog|createReplay|verifyLog|createGatewayFold)\b/.test(
          text(f),
        );
      expect([f, folds]).toEqual([f, f === "fold/worker.ts"]);
    }
  });

  test("the service layer is framework-free", () => {
    for (const f of sources) {
      for (const spec of imports(text(f))) {
        const framework =
          spec === "elysia" || spec.startsWith("elysia/") || spec.startsWith("@elysia/");
        expect([f, spec, framework]).toEqual([f, spec, framework && f === "http/elysia.ts"]);
        if (f.startsWith("service/") || f.startsWith("store/") || f.startsWith("timeline/")) {
          expect([f, spec, spec.includes("/http/") || spec.startsWith("../http")]).toEqual([
            f,
            spec,
            false,
          ]);
        }
      }
    }
  });
});
