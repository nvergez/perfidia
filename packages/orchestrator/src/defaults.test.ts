import { describe, expect, test } from "bun:test";
import { botFromLabel } from "@perfidia/bots";
import {
  DEFAULT_CAP_NANO_USD,
  DEFAULT_LINEUP,
  DEFAULT_WAKE_CAP_NANO_USD,
  cacheTtlFor,
  lockstepRoundTimeoutMs,
} from "./defaults.ts";
import { requirePrice } from "./model/prices.ts";
import { findProfile } from "./seat/personalities.ts";

describe("defaults", () => {
  test("the default lineup: four priced Opus 5.5 seats with the four profiles, two registered bots", () => {
    expect(DEFAULT_LINEUP.map((s) => s.seat)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    for (const s of DEFAULT_LINEUP) {
      if (s.kind === "llm") {
        expect([s.model, s.effort]).toEqual(["claude-opus-5-5", "medium"]);
        expect(requirePrice(s.model).input).toBe(4000);
        expect(findProfile(s.profile)).toBeDefined();
      } else {
        expect(botFromLabel(s.label, { seat: s.seat, seed: 1 })?.label).toBe(s.label);
      }
    }
    expect(DEFAULT_LINEUP.filter((s) => s.kind === "bot").map((s) => s.seat)).toEqual(["p5", "p6"]);
  });

  test("caps in integer nano-dollars; derived lockstep round timeout; TTL per clock", () => {
    expect(DEFAULT_CAP_NANO_USD).toBe(100 * 1_000_000_000);
    expect(DEFAULT_WAKE_CAP_NANO_USD).toBe(2 * 1_000_000_000);
    expect(lockstepRoundTimeoutMs()).toBe(200 * 60_000);
    expect([cacheTtlFor("lockstep"), cacheTtlFor("realtime")]).toEqual(["5m", "1h"]);
  });
});
