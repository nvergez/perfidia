import { ConfigError, parseServeArgs } from "./config.ts";
import { startServer } from "./server.ts";

// `bun run serve -- --runs <dir> [--cache <dir>] [--publish <file>] …`: the spectator server
// (docs/phase3.md). Exit code 3 on a usage or configuration error; `SIGHUP` re-reads
// `publish.json`; `SIGINT`/`SIGTERM` stop it.

function main(): void {
  let config;
  try {
    config = parseServeArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(3);
    }
    throw e;
  }
  let server;
  try {
    server = startServer(config);
  } catch (e) {
    process.stderr.write(`cannot start: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(3);
  }
  const running = server;
  process.stdout.write(
    `spectator server on ${running.url} (runs ${config.runs}, cache ${config.cache ?? "none"}, publish ${config.publish ?? "every run (development)"}, ${config.adapter})\n`,
  );
  process.on("SIGHUP", () => running.reloadPublish());
  const stop = (): void => {
    void running.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
