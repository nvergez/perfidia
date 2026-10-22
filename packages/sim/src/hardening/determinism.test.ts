// Determinism across processes (docs/architecture.md §13.4): the same 1-game-day bot matches of
// both rulesets, under lockstep and real time with `VirtualTime`, give the same normalised log and
// final state hash in this process and in two separate `bun` processes, which run them in another
// order (a hidden module-level state would show as a difference). Every one of these logs, in this
// process and in the children, passes Level E. The children run `determinism-child.ts`, a plain
// script: no test runner, linter or type checker is spawned.
// Slow suite only (docs/architecture.md §13.8): skipped unless PERFIDIA_SLOW=1
// (`bun run test:slow`, which `bun run test:exit` runs).

import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "@perfidia/protocol";
import { caseHashes, type CaseHashes } from "./determinism-child.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

const CASES = [
  "perfidia-1@1.0.0:lockstep:31",
  "perfidia-1@1.0.0:virtual:31",
  "sandbox-1@1.0.0:lockstep:32",
  "sandbox-1@1.0.0:virtual:32",
];

const CHILD = join(import.meta.dir, "determinism-child.ts");

const HashesSchema = z.record(
  z.string(),
  z.strictObject({ log: z.string(), state: z.string(), levelE: z.boolean() }),
);

async function child(args: readonly string[]): Promise<Record<string, CaseHashes>> {
  const proc = Bun.spawn([process.execPath, CHILD, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`the child process exited with ${code}: ${err}`);
  return HashesSchema.parse(JSON.parse(out.trim()));
}

xtest("two separate bun processes give the same logs and hashes as this one", async () => {
  const [forward, backward] = await Promise.all([child(CASES), child(CASES.toReversed())]);
  for (const c of CASES) {
    // oxlint-disable-next-line no-await-in-loop -- the in-process reference runs, one at a time
    const here = await caseHashes(c);
    expect([c, here.levelE]).toEqual([c, true]);
    expect([c, forward[c]]).toEqual([c, here]);
    expect([c, backward[c]]).toEqual([c, here]);
  }
  // Four different matches.
  expect(new Set(CASES.map((c) => forward[c]?.log)).size).toBe(4);
}, 60000);
