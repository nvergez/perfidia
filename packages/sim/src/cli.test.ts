// The `sim` command line (docs/architecture.md §12.1): dispatch, help texts, the `--` that
// `bun run sim -- …` may pass through, and the exit code of an unknown command.

import { describe, expect, test } from "bun:test";
import { EXIT, memoryIo } from "./args.ts";
import { USAGE, main } from "./cli.ts";
import * as sim from "./index.ts";
import { RUN_USAGE } from "./run/index.ts";

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo();
  const code = await main(argv, io);
  return { code, out: io.stdout(), err: io.stderr() };
}

describe("main", () => {
  test("help, usage and unknown commands", async () => {
    expect(await cli()).toEqual({ code: EXIT.usage, out: "", err: USAGE });
    expect(await cli("help")).toEqual({ code: EXIT.ok, out: USAGE, err: "" });
    expect(await cli("--", "--help")).toEqual({ code: EXIT.ok, out: USAGE, err: "" });
    expect(await cli("run", "--help")).toEqual({ code: EXIT.ok, out: RUN_USAGE, err: "" });
    const unknown = await cli("frobnicate");
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.err).toContain('sim frobnicate: unknown command "frobnicate"');
    for (const name of ["run", "verify", "batch", "summary", "golden"])
      expect(USAGE).toContain(`  ${name} `);
  });

  test("a leading -- is dropped", async () => {
    const r = await cli("--", "summary");
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain("sim summary: expected 1 run argument(s), got 0");
  });

  test("the package barrel exposes the commands, and the harness as a namespace", () => {
    expect(sim.main).toBe(main);
    expect(typeof sim.summarize).toBe("function");
    expect(typeof sim.harness.runBots).toBe("function");
    expect(Object.keys(sim)).not.toContain("SIM_PACKAGE");
  });
});
