import { join } from "node:path";
import { WEB_DIR, buildCss, buildWeb } from "./build.ts";

// `bun run dev -- --runs <dir> [server flags]` (phase-3 design §5.4): builds the app once, then
// runs three processes until Ctrl-C: the Tailwind CLI in watch mode (src/app.css →
// src/generated/app.css), `bun build --watch` of src/index.html into dist/, and the spectator server
// (restarted by `bun --watch` when its sources change) with `--web-dist dist --dev`, so the page is
// served through the same path as in production and the server re-reads dist/ after each rebuild.
// Defaults: `--cache .cache/spectator`, `--all-runs` (unless `--publish` is given), port 8080.
// Reload the page to see a change (no hot module replacement).

const REPO = join(WEB_DIR, "..", "..");
const DIST = join(WEB_DIR, "dist");

const args = process.argv.slice(2);
if (!args.includes("--runs")) {
  process.stderr.write(
    "usage: bun run dev -- --runs <dir> [--port n] [other `bun run serve` flags]\n",
  );
  process.exit(3);
}

await buildWeb({ quiet: false });

const serverArgs = [...args];
if (!serverArgs.includes("--cache")) serverArgs.push("--cache", join(REPO, ".cache", "spectator"));
if (!serverArgs.includes("--publish") && !serverArgs.includes("--all-runs"))
  serverArgs.push("--all-runs");
if (!serverArgs.includes("--web-dist")) serverArgs.push("--web-dist", DIST);
if (!serverArgs.includes("--dev")) serverArgs.push("--dev");

const children = [
  Bun.spawn(buildCss({ watch: true }), { cwd: WEB_DIR, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(
    [
      process.execPath,
      "build",
      join(WEB_DIR, "src", "index.html"),
      "--outdir",
      DIST,
      "--watch",
      "--no-clear-screen",
      "--sourcemap=linked",
      "--public-path=/",
      "--target=browser",
      "--define",
      'process.env.NODE_ENV="development"',
    ],
    { cwd: WEB_DIR, stdout: "inherit", stderr: "inherit" },
  ),
  Bun.spawn(
    [
      process.execPath,
      "--watch",
      join(REPO, "packages", "server", "src", "main.ts"),
      ...serverArgs,
    ],
    { cwd: REPO, stdout: "inherit", stderr: "inherit" },
  ),
];

const stop = (): void => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(children.map((c) => c.exited));
stop();
