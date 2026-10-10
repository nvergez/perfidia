import { describe, expect, test } from "bun:test";
import type { Ctx, Ruleset } from "@perfidia/engine/contracts";
import {
  fakeDomain,
  fixtureRuleset,
  fixtureSetup,
  testStep,
  type FixtureConfig,
  type FixtureExt,
} from "@perfidia/engine/testing";
import type { ScheduledEvent } from "@perfidia/protocol";
import fc from "fast-check";
import { compareScheduled, createMatch } from "./index.ts";

// P1 through the kernel: under random schedule/cancel sequences the queue pops in (at, cls, seq)
// order, and exactly the events that were scheduled and not cancelled fire.

const PING_CLASSES = { ping_a: 2, ping_b: 5, ping_c: 8 } as const;
type Ping = keyof typeof PING_CLASSES;
const PINGS: readonly Ping[] = ["ping_a", "ping_b", "ping_c"];

function pingRuleset(fired: ScheduledEvent[]): Ruleset<FixtureConfig, FixtureExt> {
  const record = (_ctx: Ctx<FixtureConfig, FixtureExt>, ev: ScheduledEvent): void => {
    fired.push({ ...ev });
  };
  return {
    ...fixtureRuleset,
    compile: (config, n) => {
      const rules = fixtureRuleset.compile(config, n);
      return { ...rules, eventClasses: { ...rules.eventClasses, ...PING_CLASSES } };
    },
    hooks: {
      ...fixtureRuleset.hooks,
      on: { ...fixtureRuleset.hooks.on, ping_a: record, ping_b: record, ping_c: record },
    },
  };
}

type Op =
  | { readonly op: "schedule"; readonly kind: Ping; readonly dt: number }
  | { readonly op: "cancel"; readonly pick: number }
  | { readonly op: "advance"; readonly dt: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      op: fc.constant("schedule" as const),
      kind: fc.constantFrom(...PINGS),
      dt: fc.integer({ min: 1, max: 40 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("cancel" as const), pick: fc.nat() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant("advance" as const),
      dt: fc.integer({ min: 0, max: 30 }),
    }),
  },
);

describe("P1: the event queue", () => {
  test("pops in (at, cls, seq) order under random schedule and cancel sequences", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        const fired: ScheduledEvent[] = [];
        const m = createMatch(fixtureSetup(), pingRuleset(fired), fakeDomain, {
          invariants: "step",
        });
        const pending: ScheduledEvent[] = [];
        const expected: ScheduledEvent[] = [];
        const settle = (t: number): void => {
          const due = pending.filter((e) => e.at <= t).toSorted(compareScheduled);
          expected.push(...due);
          for (const e of due) pending.splice(pending.indexOf(e), 1);
        };
        for (const o of ops) {
          if (o.op === "schedule") {
            testStep(m, (ctx) => {
              const at = ctx.now + o.dt;
              const seq = ctx.schedule(o.kind, at, "");
              pending.push({ at, cls: PING_CLASSES[o.kind], seq, kind: o.kind, ref: "" });
            });
          } else if (o.op === "cancel") {
            const victim = pending[o.pick % Math.max(1, pending.length)];
            if (victim === undefined) continue;
            testStep(m, (ctx) => ctx.cancel(victim.seq));
            pending.splice(pending.indexOf(victim), 1);
          } else {
            const t = m.now + o.dt;
            m.advanceTo(t);
            settle(t);
          }
        }
        const end = m.now + 100;
        m.advanceTo(end);
        settle(end);
        expect(fired).toEqual(expected);
        for (let i = 1; i < fired.length; i += 1) {
          const [a, b] = [fired[i - 1], fired[i]];
          if (a !== undefined && b !== undefined) expect(compareScheduled(a, b)).toBeLessThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  test("same-second events resolve by class, then by seq (launch order)", () => {
    const fired: ScheduledEvent[] = [];
    const m = createMatch(fixtureSetup(), pingRuleset(fired), fakeDomain, { invariants: "step" });
    testStep(m, (ctx) => {
      ctx.schedule("ping_c", 10, "");
      ctx.schedule("ping_a", 10, "");
      ctx.schedule("ping_b", 10, "");
      ctx.schedule("ping_a", 10, "second");
      ctx.schedule("ping_a", 9, "");
    });
    m.advanceTo(10);
    expect(fired.map((e) => `${e.at}:${e.kind}:${e.ref}`)).toEqual([
      "9:ping_a:",
      "10:ping_a:",
      "10:ping_a:second",
      "10:ping_b:",
      "10:ping_c:",
    ]);
  });
});
