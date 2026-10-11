import { readFileSync } from "node:fs";
import {
  EXIT,
  UsageError,
  parseFlags,
  usageText,
  type CliIo,
  type ExitCode,
  type FlagSpecs,
} from "../args.ts";
import { appendOnlyProblems, readFingerprints, type GoldenReport } from "../harness/index.ts";
import { FIXTURES_DIR, checkFixtures, updateGoldens } from "./golden.ts";

// `sim golden --check | --update [<ref>/<name> …]` (docs/architecture.md §12.1, §13.5, §13.6).
// `--check --base <fingerprints.json>` also enforces the append-only rule against an older
// fingerprints file (CI passes the base branch's): no entry of it may change or disappear.

const FLAGS: FlagSpecs = {
  check: {
    type: "boolean",
    help: "verify every golden (Level E, and Level G when its bots exist) and the fingerprints",
  },
  update: {
    type: "boolean",
    help: "add the missing goldens and fingerprint entries; never rewrites one",
  },
  fixtures: {
    type: "string",
    value: "<dir>",
    help: "fixtures directory (default packages/sim/fixtures)",
  },
  "no-resim": { type: "boolean", help: "with --check: skip the Level G re-simulations" },
  base: {
    type: "string",
    value: "<fingerprints.json>",
    help: "with --check: also fail when an entry of this older fingerprints file changed or is gone",
  },
};
export const GOLDEN_USAGE = usageText(
  "sim golden --check | --update [<ref>/<name> …] [flags]",
  FLAGS,
);

export async function goldenCommand(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  const f = parseFlags(argv, FLAGS, GOLDEN_USAGE, {
    min: 0,
    max: Infinity,
    name: "golden name",
  });
  const check = f.bool("check");
  const update = f.bool("update");
  if (check === update)
    throw new UsageError(`give exactly one of --check and --update\n\n${GOLDEN_USAGE}`);
  const dir = f.string("fixtures") ?? FIXTURES_DIR;

  if (check) {
    if (f.positionals.length > 0)
      throw new UsageError("--check takes no golden name: it checks them all");
    const report = await checkFixtures(dir, { levelG: !f.bool("no-resim") });
    const base = f.string("base");
    if (base !== undefined) {
      let older: unknown;
      try {
        older = JSON.parse(readFileSync(base, "utf8"));
      } catch (error) {
        throw new UsageError(
          `--base ${base}: not a readable JSON file (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      const appendOnly = appendOnlyProblems(older, readFingerprints(dir));
      report.problems.push(...appendOnly);
      if (appendOnly.length > 0) return printCheck(io, { ...report, ok: false });
    }
    return printCheck(io, report);
  }

  if (f.bool("no-resim")) throw new UsageError("--no-resim applies to --check only");
  if (f.string("base") !== undefined) throw new UsageError("--base applies to --check only");
  const result = await updateGoldens(dir, {
    only: f.positionals,
    progress: (text) => io.err(`${text}\n`),
  });
  for (const id of result.added) io.out(`added golden ${id}\n`);
  for (const id of result.kept) io.out(`kept golden ${id} (it exists; goldens are append-only)\n`);
  for (const id of result.fingerprints) io.out(`added fingerprint entry ${id}\n`);
  for (const msg of result.failed) io.err(`golden not written, its match failed: ${msg}\n`);
  if (result.refused.length > 0) {
    io.err(
      `refusing to overwrite ${result.refused.join(", ")}: goldens are append-only (§13.5); a new bot version gets a new golden\n`,
    );
    return EXIT.usage;
  }
  return result.failed.length > 0 ? EXIT.fatal : EXIT.ok;
}

function printCheck(io: CliIo, report: GoldenReport): ExitCode {
  for (const g of report.goldens) {
    io.out(`${g.ref}/${g.name}: Level E ${g.finalHash ?? "FAILED"} · Level G ${g.levelG}\n`);
  }
  for (const [ref, fp] of Object.entries(report.fingerprints))
    io.out(`fingerprint ${ref}: ${fp}\n`);
  if (report.ok) {
    io.out(`golden check: ok (${report.goldens.length} golden(s))\n`);
    return EXIT.ok;
  }
  for (const p of report.problems) io.out(`problem: ${p}\n`);
  io.out(`golden check: FAILED (${report.problems.length} problem(s))\n`);
  return EXIT.divergence;
}
