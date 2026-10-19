import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// `bun run web:build` (phase-3 design §5.4): the Tailwind CLI builds `src/app.css` into
// `src/generated/app.css` (git-ignored, linked from `index.html`), then `Bun.build` bundles
// `src/index.html` into `dist/` (minified, split, hashed asset names, linked source maps). Parts
// loaded on demand are dynamic `import()` chunks (docs/phase3.md §16): the initial load is the
// page's entry chunk and the chunks it imports statically; every other chunk is lazy. It prints
// each file's raw and gzipped size, marked initial or lazy, and fails when the initial load is over
// budget (§6.3: JS at most 200 KB gzipped, CSS at most 25 KB gzipped). Usage:
// bun scripts/build.ts [--out <dir>]
//
// Source maps are public (served beside the chunks) and hold the sources' text, which is no secret:
// the same code ships minified. Their `sources` are rewritten relative to the repository root
// (`packages/web/src/main.tsx`, `node_modules/...`), so a build outside the repository (the e2e
// test's, a hosting build) never records the builder's absolute path.

export const WEB_DIR = join(import.meta.dir, "..");
const REPO_DIR = resolve(WEB_DIR, "..", "..");

/**
 * A source map's `sources` relative to the repository root instead of to the map's directory; a
 * source outside the repository keeps only its file name (under `external/`).
 */
export function repoRelativeSources(
  sources: readonly string[],
  mapDir: string,
  repo: string = REPO_DIR,
): string[] {
  return sources.map((s) => {
    const abs = isAbsolute(s) ? s : resolve(mapDir, s);
    const rel = relative(repo, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return `external/${basename(abs)}`;
    return rel.split(sep).join("/");
  });
}

function rewriteMap(path: string): void {
  const map: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (map === null || typeof map !== "object" || !("sources" in map)) return;
  const sources = map.sources;
  if (!Array.isArray(sources) || !sources.every((x) => typeof x === "string")) return;
  const next = { ...map, sources: repoRelativeSources(sources, dirname(path)) };
  if ("sourceRoot" in next) delete next.sourceRoot;
  writeFileSync(path, JSON.stringify(next));
}
export const JS_BUDGET_GZ = 200 * 1024;
export const CSS_BUDGET_GZ = 25 * 1024;

export interface BuiltFile {
  readonly path: string;
  readonly bytes: number;
  readonly gzip: number;
  /** Loaded with the page (the entry chunk and what it imports statically), or on demand. */
  readonly initial: boolean;
}

export interface BuildReport {
  readonly outdir: string;
  readonly files: readonly BuiltFile[];
  /** JavaScript of the initial load (the budget's), gzipped. */
  readonly jsGzip: number;
  /** JavaScript loaded on demand, gzipped (every lazy chunk). */
  readonly lazyJsGzip: number;
  readonly cssGzip: number;
  readonly ms: number;
}

/** A metafile output's static and dynamic imports, by output path (`./chunk-x.js` → `chunk-x.js`). */
interface OutputMeta {
  readonly entryPoint?: string;
  readonly imports?: readonly { readonly path: string; readonly kind: string }[];
}

const norm = (p: string): string => p.replace(/^\.\//, "");

/**
 * The outputs of the initial load: each page entry chunk (an output whose entry point is an HTML
 * file, or `entries`) and, transitively, the chunks it imports with an `import` statement; a
 * dynamic `import()` starts a lazy chunk. Paths are relative to the output directory.
 */
export function initialOutputs(
  outputs: Readonly<Record<string, OutputMeta>>,
  isEntry: (path: string, meta: OutputMeta) => boolean,
): Set<string> {
  const byPath = new Map(Object.entries(outputs).map(([k, v]) => [norm(k), v]));
  const seen = new Set<string>();
  const stack = [...byPath].filter(([p, m]) => isEntry(p, m)).map(([p]) => p);
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    if (seen.has(p)) continue;
    seen.add(p);
    for (const i of byPath.get(p)?.imports ?? []) {
      if (i.kind === "import-statement") stack.push(norm(i.path));
    }
  }
  return seen;
}

/** The Tailwind CLI's entry script (its `bin`), resolved from the web package. */
function tailwindCli(): string {
  const pkgPath = Bun.resolveSync("@tailwindcss/cli/package.json", WEB_DIR);
  const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
  const bins: unknown =
    pkg !== null && typeof pkg === "object" && "bin" in pkg ? pkg.bin : undefined;
  const bin: unknown =
    bins !== null && typeof bins === "object" && "tailwindcss" in bins
      ? bins.tailwindcss
      : undefined;
  if (typeof bin !== "string") throw new Error("@tailwindcss/cli has no tailwindcss bin");
  return join(dirname(pkgPath), bin);
}

/** Builds the stylesheet with the Tailwind CLI (run by Bun). */
export function buildCss(o: { readonly watch?: boolean } = {}): string[] {
  return [
    process.execPath,
    tailwindCli(),
    "-i",
    join(WEB_DIR, "src", "app.css"),
    "-o",
    join(WEB_DIR, "src", "generated", "app.css"),
    ...(o.watch === true ? ["--watch=always"] : ["--minify"]),
  ];
}

const kib = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

export async function buildWeb(
  o: { readonly outdir?: string; readonly quiet?: boolean } = {},
): Promise<BuildReport> {
  const started = performance.now();
  const outdir = o.outdir ?? join(WEB_DIR, "dist");
  mkdirSync(join(WEB_DIR, "src", "generated"), { recursive: true });
  const css = Bun.spawnSync(buildCss(), { cwd: WEB_DIR, stdout: "pipe", stderr: "pipe" });
  if (css.exitCode !== 0) {
    throw new Error(
      `tailwindcss failed (${css.exitCode}): ${css.stderr.toString().slice(0, 2000)}`,
    );
  }
  // Empty the directory rather than remove it: a server started with `--web-dist <dir> --dev`
  // watches this directory, and a new one would leave it watching the old inode.
  if (existsSync(outdir)) {
    for (const entry of readdirSync(outdir)) {
      rmSync(join(outdir, entry), { recursive: true, force: true });
    }
  }
  const built = await Bun.build({
    entrypoints: [join(WEB_DIR, "src", "index.html")],
    outdir,
    target: "browser",
    minify: true,
    splitting: true,
    sourcemap: "linked",
    metafile: true,
    // Absolute asset URLs: the app's routes (`/m/:id`) are nested paths.
    publicPath: "/",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) {
    throw new Error(`Bun.build failed:\n${built.logs.map((l) => l.message).join("\n")}`);
  }
  for (const out of built.outputs) if (out.path.endsWith(".map")) rewriteMap(out.path);
  const metaOutputs: Readonly<Record<string, OutputMeta>> = built.metafile?.outputs ?? {};
  const initial = initialOutputs(
    metaOutputs,
    (p, m) => p.endsWith(".js") && (m.entryPoint ?? "").endsWith(".html"),
  );
  const files: BuiltFile[] = await Promise.all(
    built.outputs
      .filter((out) => !out.path.endsWith(".map"))
      .map(async (out) => {
        const bytes = new Uint8Array(await out.arrayBuffer());
        const path = relative(outdir, out.path);
        return {
          path,
          bytes: bytes.length,
          gzip: Bun.gzipSync(bytes).length,
          initial: !path.endsWith(".js") || initial.has(path),
        };
      }),
  );
  const sum = (ext: string, init: boolean): number =>
    files.filter((f) => f.path.endsWith(ext) && f.initial === init).reduce((n, f) => n + f.gzip, 0);
  const report: BuildReport = {
    outdir,
    files: files.toSorted((a, b) =>
      a.initial !== b.initial ? (a.initial ? -1 : 1) : a.path < b.path ? -1 : 1,
    ),
    jsGzip: sum(".js", true),
    lazyJsGzip: sum(".js", false),
    cssGzip: sum(".css", true),
    ms: Math.round(performance.now() - started),
  };
  if (o.quiet !== true) {
    for (const f of report.files) {
      process.stdout.write(
        `${f.path.padEnd(40)} ${kib(f.bytes).padStart(10)} raw ${kib(f.gzip).padStart(10)} gzip${f.path.endsWith(".js") ? (f.initial ? "  initial" : "  lazy") : ""}\n`,
      );
    }
    process.stdout.write(
      `initial JS ${kib(report.jsGzip)} gzip (budget ${kib(JS_BUDGET_GZ)}), lazy JS ${kib(report.lazyJsGzip)} gzip, CSS ${kib(report.cssGzip)} gzip (budget ${kib(CSS_BUDGET_GZ)}); ${report.ms} ms → ${relative(process.cwd(), outdir) || "."}\n`,
    );
  }
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--out");
  const outdir = at >= 0 ? args[at + 1] : undefined;
  const report = await buildWeb(outdir === undefined ? {} : { outdir });
  const over: string[] = [];
  if (report.jsGzip > JS_BUDGET_GZ) {
    over.push(`initial JS ${kib(report.jsGzip)} > ${kib(JS_BUDGET_GZ)}`);
  }
  if (report.cssGzip > CSS_BUDGET_GZ)
    over.push(`CSS ${kib(report.cssGzip)} > ${kib(CSS_BUDGET_GZ)}`);
  if (over.length > 0) {
    process.stderr.write(`over the size budget (design §6.3): ${over.join(", ")}\n`);
    process.exit(1);
  }
}
