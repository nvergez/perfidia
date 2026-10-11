// The child process of the two-process determinism test (docs/architecture.md §13.4): runs the
// 1-game-day bot matches named on the command line (`<ref>:<clock>:<seed>`, clock `lockstep` or
// `virtual`) through the harness and prints, as one JSON object, the normalised log hash and the
// final state hash of each, and whether its log passes Level E (§13.4: every log a test produces
// does, the children's included).

import { normalisedHash, runBots } from "../harness/index.ts";
import { LOCKSTEP, VIRTUAL, daySpec, levelE } from "./kit.ts";

/** What the parent compares for one case. */
export interface CaseHashes {
  readonly log: string;
  readonly state: string;
  readonly levelE: boolean;
}

/** Parses `<ref>:<clock>:<seed>`. */
export function parseCase(arg: string): {
  ref: string;
  clock: "lockstep" | "virtual";
  seed: number;
} {
  const [ref, clock, seed] = arg.split(":");
  const n = Number(seed);
  if (
    ref === undefined ||
    (clock !== "lockstep" && clock !== "virtual") ||
    !Number.isSafeInteger(n)
  ) {
    throw new Error(`expected <ref>:<lockstep|virtual>:<seed>, got ${arg}`);
  }
  return { ref, clock, seed: n };
}

/** The hashes of one case and its Level E verdict, as the parent compares them. */
export async function caseHashes(arg: string): Promise<CaseHashes> {
  const c = parseCase(arg);
  const out = await runBots(daySpec(c.ref, c.clock === "lockstep" ? LOCKSTEP : VIRTUAL, c.seed));
  return {
    log: normalisedHash(out.lines),
    state: out.run.finalHash,
    levelE: levelE(out.lines).ok,
  };
}

if (import.meta.main) {
  const results: Record<string, CaseHashes> = {};
  for (const arg of process.argv.slice(2)) {
    // oxlint-disable-next-line no-await-in-loop -- one match at a time, as a fresh process would
    results[arg] = await caseHashes(arg);
  }
  process.stdout.write(`${JSON.stringify(results)}\n`);
}
