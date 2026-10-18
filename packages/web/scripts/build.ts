import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// `bun run web:build` (phase-3 design §5.4): the Tailwind CLI builds `src/app.css` into
// `src/generated/app.css` (git-ignored, linked from `index.html`), then `Bun.build` bundles
// `src/index.html` into `dist/` (minified, split, hashed asset names, linked source maps). It prints
// each file's raw and gzipped size and fails when the initial load is over budget (§6.3: JS at most
// 200 KB gzipped, CSS at most 25 KB gzipped). Usage: bun scripts/build.ts [--out <dir>]

export const WEB_DIR = join(import.meta.dir, "..");
export const JS_BUDGET_GZ = 200 * 1024;
export const CSS_BUDGET_GZ = 25 * 1024;

export interface BuiltFile {
  readonly path: string;
  readonly bytes: number;
  readonly gzip: number;
}

export interface BuildReport {
  readonly outdir: string;
  readonly files: readonly BuiltFile[];
  readonly jsGzip: number;
  readonly cssGzip: number;
  readonly ms: number;
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
    // Absolute asset URLs: the app's routes (`/m/:id`) are nested paths.
    publicPath: "/",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) {
    throw new Error(`Bun.build failed:\n${built.logs.map((l) => l.message).join("\n")}`);
  }
  const files: BuiltFile[] = await Promise.all(
    built.outputs
      .filter((out) => !out.path.endsWith(".map"))
      .map(async (out) => {
        const bytes = new Uint8Array(await out.arrayBuffer());
        return {
          path: relative(outdir, out.path),
          bytes: bytes.length,
          gzip: Bun.gzipSync(bytes).length,
        };
      }),
  );
  const sum = (ext: string): number =>
    files.filter((f) => f.path.endsWith(ext)).reduce((n, f) => n + f.gzip, 0);
  const report: BuildReport = {
    outdir,
    files: files.toSorted((a, b) => (a.path < b.path ? -1 : 1)),
    jsGzip: sum(".js"),
    cssGzip: sum(".css"),
    ms: Math.round(performance.now() - started),
  };
  if (o.quiet !== true) {
    for (const f of report.files) {
      process.stdout.write(
        `${f.path.padEnd(40)} ${kib(f.bytes).padStart(10)} raw ${kib(f.gzip).padStart(10)} gzip\n`,
      );
    }
    process.stdout.write(
      `JS ${kib(report.jsGzip)} gzip (budget ${kib(JS_BUDGET_GZ)}), CSS ${kib(report.cssGzip)} gzip (budget ${kib(CSS_BUDGET_GZ)}); ${report.ms} ms → ${relative(process.cwd(), outdir) || "."}\n`,
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
  if (report.jsGzip > JS_BUDGET_GZ) over.push(`JS ${kib(report.jsGzip)} > ${kib(JS_BUDGET_GZ)}`);
  if (report.cssGzip > CSS_BUDGET_GZ)
    over.push(`CSS ${kib(report.cssGzip)} > ${kib(CSS_BUDGET_GZ)}`);
  if (over.length > 0) {
    process.stderr.write(`over the size budget (design §6.3): ${over.join(", ")}\n`);
    process.exit(1);
  }
}
