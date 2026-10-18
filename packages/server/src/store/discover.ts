import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MatchIdSchema, type MatchId } from "@perfidia/protocol/spectator";

// Discovery of run directories (phase-3 design §2.4): the subdirectories of the runs root that hold
// a `match.jsonl` (or `match.jsonl.gz`). A match id is the directory's name and must be a valid
// `MatchId`; ids are keys of the index, never path segments built from request input. Symbolic
// links are never followed (`lstat`): neither a linked run directory nor a linked log.

export const LOG_FILE = "match.jsonl";
export const LOG_FILE_GZ = "match.jsonl.gz";

export interface RunRef {
  readonly id: MatchId;
  readonly dir: string;
  /** The log file: `match.jsonl`, or `match.jsonl.gz` for a finished, compressed run. */
  readonly log: string;
  readonly gz: boolean;
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** The run directories under `root`, sorted by id; an unreadable root gives none. */
export function discoverRuns(root: string): RunRef[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: RunRef[] = [];
  for (const name of names.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!MatchIdSchema.safeParse(name).success) continue;
    const dir = join(root, name);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const plain = join(dir, LOG_FILE);
    const gz = join(dir, LOG_FILE_GZ);
    if (regularFile(plain)) out.push({ id: name, dir, log: plain, gz: false });
    else if (regularFile(gz)) out.push({ id: name, dir, log: gz, gz: true });
  }
  return out;
}
