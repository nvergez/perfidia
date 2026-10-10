// Type-level test: a ruleset's hooks receive `Ctx<C, X>` and `ReadCtx<C, X>` typed with its own
// config and ext, and must be able to hand them to std. The checks are compile-time; the runtime
// assertion only keeps the function used.

import { expect, test } from "bun:test";
import type { Ctx, ReadCtx, RulesetHooks, Visibility } from "@perfidia/engine/contracts";
import {
  defaultDeparture,
  defaultVisibility,
  launch,
  materialize,
  relationsOf,
  stdInvariants,
  stockAt,
} from "./index.ts";

interface Config {
  readonly pace: number;
}
interface Ext {
  open: boolean;
}

function typedHooks(ctx: Ctx<Config, Ext>, r: ReadCtx<Config, Ext>): void {
  materialize(ctx, "c1");
  stockAt(r, "c1");
  relationsOf(ctx.read(), "p1");
  launch(
    ctx,
    {
      kind: "spy",
      owner: "p1",
      from: "c1",
      to: "c2",
      island: "i2",
      slot: null,
      units: {},
      cargo: { wood: 0, stone: 0, gold: 0 },
      gold: 100,
    },
    null,
  );
  const departure: NonNullable<RulesetHooks<Config, Ext>["departure"]> = defaultDeparture;
  const visibility: Partial<Visibility<Config, Ext>> = defaultVisibility;
  const invariants: RulesetHooks<Config, Ext>["invariants"] = stdInvariants;
  void departure;
  void visibility;
  void invariants;
}

test("std accepts contexts typed with a ruleset's config and ext", () => {
  expect(typeof typedHooks).toBe("function");
});
