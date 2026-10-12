import { DEFAULT_BOTS } from "../harness/index.ts";
import {
  EXIT,
  UsageError,
  parseFlags,
  parseIntIn,
  parseSeeds,
  usageText,
  type CliIo,
  type ExitCode,
  type FlagSpecs,
} from "../args.ts";
import { parseBots } from "../run/index.ts";
import { runBatch, writeBatchJson } from "./batch.ts";
import { fightTable, matchTable, pacingTable, variantTable } from "./table.ts";
import { parseVariants } from "./variants.ts";

// `sim batch` (docs/architecture.md §12.1, §12.2).

const FLAGS: FlagSpecs = {
  variant: {
    type: "string",
    repeat: true,
    value: '"<label>: <ref> [key=value ...]"',
    help: "a ruleset and its overrides (the label is optional)",
  },
  seeds: { type: "string", value: "<1-10 | 1,5,9>", help: "the seeds every variant runs" },
  players: {
    type: "string",
    value: "<N>",
    help: "seats per match (default: the first variant's minimum)",
  },
  bots: {
    type: "string",
    value: "<a,b,…>",
    help: `bots cycled over the seats, the same for every variant, name or name@n (default ${DEFAULT_BOTS.join(",")}, each at its latest version)`,
  },
  days: { type: "string", value: "<N>", help: "match length in game days (time.matchEnd)" },
  "per-match": { type: "boolean", help: "one row per match instead of one per variant" },
  pacing: { type: "boolean", help: "replay each match and add the per-day pacing table (§13.9)" },
  json: { type: "string", value: "<out.json>", help: "write the results with their provenance" },
  out: { type: "string", value: "<dir>", help: "keep every match's run directory under <dir>" },
  "allow-test": {
    type: "boolean",
    help: "silence the note on test rulesets such as sandbox-1 (batch runs them anyway)",
  },
};
export const BATCH_USAGE = usageText(
  'sim batch --variant "<label>: <ref> [key=value ...]" … --seeds <list> [flags]',
  FLAGS,
);

export async function batchCommand(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  const f = parseFlags(argv, FLAGS, BATCH_USAGE, { min: 0, max: 0, name: "positional" });
  const seedsText = f.string("seeds");
  if (seedsText === undefined) throw new UsageError(`--seeds is required\n\n${BATCH_USAGE}`);
  const seeds = parseSeeds(seedsText);
  const daysText = f.string("days");
  const days = daysText === undefined ? undefined : parseIntIn(daysText, "--days", 1, 3650);
  const playersText = f.string("players");
  const { variants, players } = parseVariants(f.strings("variant"), {
    days,
    players: playersText === undefined ? undefined : parseIntIn(playersText, "--players", 1, 1000),
  });
  if (!f.bool("allow-test")) {
    for (const v of variants.filter((x) => x.ruleset.status === "test")) {
      io.err(
        `note: variant "${v.text}" plays ${v.ruleset.ref}, a test ruleset (status "test"), not a game\n`,
      );
    }
  }
  const bots = f.has("bots") ? parseBots(f.strings("bots")) : [...DEFAULT_BOTS];
  const total = variants.length * seeds.length;
  let done = 0;
  const result = await runBatch(
    { variants, seeds, players, bots, days: days ?? null, pacing: f.bool("pacing") },
    {
      out: f.string("out"),
      progress(v, seed, row) {
        done += 1;
        io.err(
          `[${done}/${total}] ${v.text} · seed ${seed}: ${row.status === "ended" ? (row.reason ?? "?") : `${row.status}${row.error === null ? "" : ` (${row.error})`}`}\n`,
        );
      },
    },
  );
  io.out(f.bool("per-match") ? matchTable(result) : variantTable(result));
  io.out(`\n${fightTable(result)}`);
  if (result.variants.some((v) => v.pacing !== undefined)) io.out(`\n${pacingTable(result)}`);
  const json = f.string("json");
  if (json !== undefined) {
    writeBatchJson(json, result);
    io.out(`\nresults with provenance: ${json}\n`);
  }
  const matches = result.variants.flatMap((v) => v.matches);
  if (matches.some((m) => m.status !== "ended")) return EXIT.fatal;
  if (matches.some((m) => m.replayOk === false)) return EXIT.divergence;
  return EXIT.ok;
}
