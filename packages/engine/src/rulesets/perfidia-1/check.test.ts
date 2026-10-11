import { describe, expect, test } from "bun:test";
import { checkConfig } from "./check.ts";
import { compileRules } from "./compile.ts";
import { PERFIDIA_1_DEFAULTS, type PerfidiaConfig, PerfidiaConfigSchema } from "./config.ts";

// `Ruleset.check` (perfidia-1 §16): the two ruleset-specific compile checks. The resolution path
// through overrides is covered by config.test.ts (P14).

function edited(edit: (c: PerfidiaConfig) => void): PerfidiaConfig {
  const c = PerfidiaConfigSchema.parse(structuredClone(PERFIDIA_1_DEFAULTS));
  edit(c);
  return c;
}

const check = (c: PerfidiaConfig) => checkConfig(c, compileRules(c, 8));

describe("checkConfig", () => {
  test("accepts the defaults", () => {
    expect(check(PERFIDIA_1_DEFAULTS)).toEqual([]);
  });

  test("siegeDuration must exceed recallWindow", () => {
    const issues = check(
      edited((c) => {
        c.time.siegeDuration = 600;
      }),
    );
    expect(issues).toEqual([
      {
        path: "time.siegeDuration",
        message:
          "time.siegeDuration (600) must be greater than time.recallWindow (600), so no movement can still be recalled when its home city changes hands",
      },
    ]);
  });

  test("sameIslandTravel must be ≥ minTravel: time.sameIslandTravel=1800 alone", () => {
    const issues = check(
      edited((c) => {
        c.time.sameIslandTravel = 1800;
      }),
    );
    expect(issues.map((i) => i.path)).toEqual(["time.sameIslandTravel"]);
  });

  test("time.minTravel=7200 alone is rejected naming time.sameIslandTravel", () => {
    const issues = check(
      edited((c) => {
        c.time.minTravel = 7200;
      }),
    );
    expect(issues).toEqual([
      {
        path: "time.sameIslandTravel",
        message:
          "time.sameIslandTravel (3600) must be ≥ time.minTravel (7200), so a same-island attack keeps the speed rule",
      },
    ]);
  });

  test("time.minTravel=7200 with time.sameIslandTravel=7200 passes", () => {
    const c = edited((x) => {
      x.time.minTravel = 7200;
      x.time.sameIslandTravel = 7200;
    });
    expect(check(c)).toEqual([]);
  });

  test("reports both failures at once", () => {
    const c = edited((x) => {
      x.time.recallWindow = 30000;
      x.time.sameIslandTravel = 100;
    });
    expect(check(c).map((i) => i.path)).toEqual(["time.siegeDuration", "time.sameIslandTravel"]);
  });
});
