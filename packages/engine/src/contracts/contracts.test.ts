// Type-level tests of the engine contracts (docs/architecture.md §3.2, §5.2): a ruleset typed with
// its own config and ext is assignable to `AnyRuleset`, and handlers typed for one action fit the
// generic slots. Most checks are compile-time; the runtime assertions only keep the values used.

import { expect, test } from "bun:test";
import {
  z,
  type ActionOf,
  type CompiledRules,
  type DeepReadonly,
  type JsonObject,
  type MatchResult,
  type PlayerId,
  type Violation,
} from "@perfidia/protocol";
import type {
  ActionHandler,
  AnyRuleset,
  Ctx,
  DomainModule,
  EventHook,
  ExtraTool,
  ReadCtx,
  Ruleset,
  RulesetHooks,
} from "./index.ts";

const ConfigSchema = z.strictObject({
  pace: z.int().positive(),
  time: z.strictObject({ matchEnd: z.int().positive() }),
  bonus: z.array(z.int()),
});
type Config = z.infer<typeof ConfigSchema>;
const ExtSchema = z.strictObject({ open: z.boolean(), marks: z.record(z.string(), z.int()) });
type Ext = z.infer<typeof ExtSchema>;

const notCalled = (): never => {
  throw new Error("not called in this test");
};

interface RenamePlan {
  readonly name: string;
}

/** An `ext` action handler typed for its own plan. */
const rename: ActionHandler<ActionOf<"ext">, RenamePlan> = {
  validate: (_r, _seat, a) =>
    typeof a.args === "string"
      ? { ok: true, plan: { name: a.args } }
      : { ok: false, violation: { code: "INVALID_ARGS", details: {} } },
  apply: (_ctx, _seat, plan): JsonObject => ({ name: plan.name }),
};

/** Hooks that read the typed config and ext, as a real ruleset does. */
const onTick: EventHook<Config, Ext> = (ctx: Ctx<Config, Ext>) => {
  ctx.ext().marks["tick"] = ctx.config.pace + ctx.now;
};

const hillStatus: ExtraTool = {
  name: "hill_status",
  family: "observe",
  description: "Hill status.",
  args: z.strictObject({}),
  kind: "read",
  read: (r: ReadCtx) => ({ now: r.now }),
};

const typed: Ruleset<Config, Ext> = {
  id: "fixture-1",
  version: "1.0.0",
  ref: "fixture-1@1.0.0",
  status: "test",
  title: "Fixture",
  configSchema: ConfigSchema,
  defaults: { pace: 60, time: { matchEnd: 86400 }, bonus: [1, 2] },
  extSchema: ExtSchema,
  players: (config: DeepReadonly<Config>) => ({ min: 2, max: 2 + config.bonus.length }),
  compile: notCalled,
  check: (config: DeepReadonly<Config>) =>
    config.pace > 0 ? [] : [{ path: "pace", message: "must be positive" }],
  cheatSheet: (config: DeepReadonly<Config>, rules: DeepReadonly<CompiledRules>) =>
    `PACE ${config.pace}, ${rules.players} players`,
  hooks: {
    createWorld: (w) => ({
      islands: [],
      cities: [],
      ext: { open: w.config.pace > 0, marks: {} },
      timers: [{ kind: "tick", at: 3600, ref: "" }],
    }),
    travelTime: (r: ReadCtx<Config, Ext>) => r.config.pace * (r.ext().open ? 1 : 2),
    departure: (r: ReadCtx<Config, Ext>, d) => ({ ok: true, party: r.ext().open ? d.owner : null }),
    arrive: {
      attack: (ctx: Ctx<Config, Ext>) => {
        ctx.ext().open = ctx.config.pace > 1;
      },
      spy: notCalled,
    },
    on: { tick: onTick },
    guard: (r: ReadCtx<Config, Ext>, seat: PlayerId): Violation | null =>
      r.ext().marks[seat] === undefined ? null : { code: "CITY_BESIEGED", details: { seat } },
    afterStep: (ctx: Ctx<Config, Ext>, step) => {
      if (step.cause.kind === "event") ctx.ext().marks[step.cause.ev.kind] = step.events.length;
    },
    relations: () => [],
    standings: () => [],
    finish: (ctx: Ctx<Config, Ext>): MatchResult => ({
      endedAt: ctx.now,
      reason: ctx.ext().open ? "hill" : "time",
      winners: [],
      standings: [],
    }),
    visibility: {
      publicCity: (r: ReadCtx<Config, Ext>) => ({ open: r.ext().open }),
      briefing: (r: ReadCtx<Config, Ext>, viewer: PlayerId) => ({ viewer, pace: r.config.pace }),
    },
    actions: { ext: rename },
    invariants: [{ name: "marks are integers", level: "checkpoint", check: () => [] }],
  },
  errors: {
    CITY_BESIEGED: (v, f) => ({
      message: `besieged until ${f.time(Number(v.details["until"]))}`,
      hint: "",
    }),
  },
  errorSamples: [{ code: "CITY_BESIEGED", details: { until: 7200 } }],
  tools: [hillStatus],
  eventSchemas: { hill_opened: z.looseObject({}) },
  intelEvents: [],
};

test("a ruleset typed with its config and ext is assignable to AnyRuleset", () => {
  const registry: readonly AnyRuleset[] = [typed];
  const any: AnyRuleset = typed;
  expect(registry[0]).toBe(any);
  expect(any.configSchema.parse(any.defaults)).toEqual(typed.defaults);
  expect(any.players(any.defaults)).toEqual({ min: 2, max: 4 });
});

test("an incomplete ruleset is not a Ruleset", () => {
  const hooks: Omit<RulesetHooks<Config, Ext>, "standings"> = typed.hooks;
  // @ts-expect-error standings is mandatory
  const missing: Ruleset<Config, Ext> = { ...typed, hooks };
  const attackOnly = { ...typed.hooks, arrive: { attack: notCalled } };
  // @ts-expect-error the arrive hooks attack and spy are mandatory
  const noSpy: Ruleset<Config, Ext> = { ...typed, hooks: attackOnly };
  expect([missing.id, noSpy.id]).toEqual(["fixture-1", "fixture-1"]);
});

test("handlers typed for one action fit the domain module's slots", () => {
  const build: ActionHandler<ActionOf<"build">, { cost: number }> = {
    validate: () => ({ ok: true, plan: { cost: 1 } }),
    apply: (_ctx, _seat, plan) => ({ cost: plan.cost }),
  };
  const handler: ActionHandler = build;
  const domain: Pick<DomainModule, "events" | "invariants"> = {
    events: { build_done: notCalled },
    invariants: [],
  };
  expect([handler, domain.invariants]).toEqual([build, []]);
});
