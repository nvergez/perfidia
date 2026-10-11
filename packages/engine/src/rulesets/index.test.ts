// The ruleset registry (docs/architecture.md §3.5): lookups by ref and by bare id with the
// test-version fallback, `getRuleset`'s error, and every rejection of `validateRegistry`.

import { describe, expect, test } from "bun:test";
import * as engine from "@perfidia/engine";
import type { AnyRuleset, ExtraTool } from "@perfidia/engine/contracts";
import { LogRecorder } from "@perfidia/engine/testing";
import { idKeyFromSeed } from "@perfidia/engine/core";
import { RulesetRefSchema, z, type CompiledRules } from "@perfidia/protocol";
import { perfidia1_1_0_0 } from "./perfidia-1/index.ts";
import { sandbox1_1_0_0 } from "./sandbox-1/index.ts";
import {
  RULESETS,
  RegistryError,
  UnknownRuleset,
  findRuleset,
  getRuleset,
  parseRulesetRef,
  validateRegistry,
} from "./index.ts";

const sandbox: AnyRuleset = sandbox1_1_0_0;

/**
 * `base` as another version: the ref and the compiled rules' `ruleset` follow the version, and
 * `patch` replaces any other field.
 */
function variant(
  base: AnyRuleset,
  version: string,
  patch: Partial<AnyRuleset> = {},
  rules: (r: CompiledRules) => CompiledRules = (r) => r,
): AnyRuleset {
  const ref = RulesetRefSchema.parse(`${base.id}@${version}`);
  return {
    ...base,
    version,
    ref,
    compile: (config, n) => rules({ ...base.compile(config, n), ruleset: ref }),
    ...patch,
  };
}

function rejection(list: readonly AnyRuleset[]): string {
  try {
    validateRegistry(list);
  } catch (error) {
    if (error instanceof RegistryError) return error.message;
    throw error;
  }
  return "accepted";
}

const someText = () => ({ message: "m", hint: "h" });

const readTool = (name: string, args: z.ZodType = z.strictObject({})): ExtraTool => ({
  name,
  family: "observe",
  description: "test",
  args,
  kind: "read",
  read: () => ({}),
});

describe("the registry", () => {
  test("RULESETS lists perfidia-1@1.0.0 (published) and sandbox-1@1.0.0 (test), and validates", () => {
    expect(RULESETS.map((rs) => [rs.ref, rs.status])).toEqual([
      ["perfidia-1@1.0.0", "published"],
      ["sandbox-1@1.0.0", "test"],
    ]);
    expect(() => validateRegistry()).not.toThrow();
    expect(Object.isFrozen(RULESETS)).toBe(true);
  });

  test("parseRulesetRef splits exact refs only", () => {
    expect(parseRulesetRef("perfidia-1@1.0.0")).toEqual({ id: "perfidia-1", version: "1.0.0" });
    expect(parseRulesetRef("sandbox-1@10.2.33")).toEqual({ id: "sandbox-1", version: "10.2.33" });
    for (const bad of [
      "perfidia-1",
      "perfidia-1@1.0",
      "perfidia-1@01.0.0",
      "P@1.0.0",
      "",
      "@1.0.0",
    ]) {
      expect(parseRulesetRef(bad)).toBeNull();
    }
  });

  test("findRuleset resolves exact refs and bare ids; a bare id falls back to a test version", () => {
    expect(findRuleset("perfidia-1@1.0.0")).toBe(perfidia1_1_0_0);
    expect(findRuleset("perfidia-1")).toBe(perfidia1_1_0_0);
    // sandbox-1 has no published version: the bare id resolves to its latest test version.
    expect(findRuleset("sandbox-1")).toBe(sandbox);
    expect(findRuleset("sandbox-1@1.0.0")).toBe(sandbox);
    expect(findRuleset("sandbox-1@1.0.1")).toBeUndefined();
    expect(findRuleset("nothing-1")).toBeUndefined();
    expect(findRuleset("Not An Id")).toBeUndefined();
  });

  test("a bare id prefers the latest published version, else the latest test version", () => {
    const published = variant(sandbox, "1.2.0", { status: "published" });
    const olderPublished = variant(sandbox, "1.10.0", { status: "published" });
    const newerTest = variant(sandbox, "2.0.0");
    const list = [sandbox, published, newerTest, olderPublished];
    // 1.10.0 > 1.2.0 numerically, and a newer test version never wins over a published one.
    expect(findRuleset("sandbox-1", list)).toBe(olderPublished);
    expect(findRuleset("sandbox-1", [sandbox, newerTest])).toBe(newerTest);
    expect(findRuleset("sandbox-1@2.0.0", list)).toBe(newerTest);
  });

  test("getRuleset throws UnknownRuleset listing the refs of the build", () => {
    expect(getRuleset("perfidia-1")).toBe(perfidia1_1_0_0);
    let caught: unknown;
    try {
      getRuleset("perfidia-9@1.0.0");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownRuleset);
    if (!(caught instanceof UnknownRuleset)) throw new Error("no error");
    expect(caught.known).toEqual(["perfidia-1@1.0.0", "sandbox-1@1.0.0"]);
    expect(caught.message).toContain("perfidia-1@1.0.0, sandbox-1@1.0.0");
  });

  test("getRuleset validates its list before looking it up", () => {
    const broken = [variant(sandbox, "1.0.1", { intelEvents: ["nothing"] })];
    expect(() => getRuleset("sandbox-1", broken)).toThrow(RegistryError);
  });
});

describe("validateRegistry rejects", () => {
  test("duplicate refs", () => {
    expect(rejection([sandbox, sandbox])).toBe(
      "ruleset registry: sandbox-1@1.0.0: is registered twice",
    );
    expect(rejection([sandbox, variant(sandbox, "1.0.1")])).toBe("accepted");
  });

  test("an extra tool that collides with a standard tool or another extra", () => {
    expect(rejection([variant(sandbox, "1.0.1", { tools: [readTool("view_city")] })])).toContain(
      "extra tool view_city collides with the standard tool of that name",
    );
    expect(
      rejection([variant(sandbox, "1.0.1", { tools: [readTool("peek"), readTool("peek")] })]),
    ).toContain("extra tool peek is declared twice");
    expect(rejection([variant(sandbox, "1.0.1", { tools: [readTool("Peek")] })])).toContain(
      "not a snake_case name",
    );
  });

  test("an extra tool whose args are not a root object", () => {
    const union = z.union([z.strictObject({ a: z.int() }), z.strictObject({ b: z.int() })]);
    expect(rejection([variant(sandbox, "1.0.1", { tools: [readTool("peek", union)] })])).toContain(
      "extra tool peek: its args convert to a root anyOf, not a root object",
    );
    expect(
      rejection([variant(sandbox, "1.0.1", { tools: [readTool("peek", z.string())] })]),
    ).toContain('extra tool peek: its args convert to root type "string", not "object"');
    expect(
      rejection([variant(sandbox, "1.0.1", { tools: [readTool("peek", z.strictObject({}))] })]),
    ).toBe("accepted");
  });

  test("a write extra tool without hooks.actions.ext, and a read tool without read", () => {
    const write: ExtraTool = { ...readTool("scribble"), kind: "write" };
    const hooks = { ...sandbox.hooks, actions: {} };
    expect(rejection([variant(sandbox, "1.0.1", { tools: [write], hooks })])).toContain(
      "extra tool scribble is a write tool, but hooks.actions.ext is missing to handle its actions",
    );
    const noRead: ExtraTool = {
      name: "peek",
      family: "observe",
      description: "test",
      args: z.strictObject({}),
      kind: "read",
    };
    expect(rejection([variant(sandbox, "1.0.1", { tools: [noRead] })])).toContain(
      "extra tool peek is a read tool without a read function",
    );
  });

  test("an intelEvents entry missing from eventSchemas", () => {
    expect(rejection([variant(sandbox, "1.0.1", { intelEvents: ["siege_started"] })])).toContain(
      "intelEvents names siege_started, which is not a key of eventSchemas",
    );
    expect(rejection([variant(sandbox, "1.0.1", { intelEvents: ["battle"] })])).toContain(
      "(standard intel types are listed by protocol, not by rulesets)",
    );
    expect(rejection([variant(sandbox, "1.0.1", { intelEvents: ["city_renamed"] })])).toBe(
      "accepted",
    );
  });

  test("match_end sharing its class, and an event kind without a class", () => {
    const shared = variant(sandbox, "1.0.1", {}, (r) => ({
      ...r,
      eventClasses: { ...r.eventClasses, hill_open: r.eventClasses["match_end"] ?? 0 },
    }));
    expect(rejection([shared])).toContain(
      "N = 2: eventClasses.match_end: match_end must have a class of its own; class 5 is shared with hill_open",
    );
    const missing = variant(sandbox, "1.0.1", {}, (r) => {
      const { arrive_spy: _spy, ...eventClasses } = r.eventClasses;
      return { ...r, eventClasses };
    });
    expect(rejection([missing])).toContain(
      "eventClasses.arrive_spy: event kind arrive_spy has no class",
    );
  });

  test("defaults that do not resolve, a player range beyond MAX_SEATS, a bad identity", () => {
    expect(
      rejection([variant(sandbox, "1.0.1", { players: () => ({ min: 2, max: 16 }) })]),
    ).toContain("players(config) is 2..16; it must be a range of integers within 1..15");
    expect(
      rejection([
        variant(sandbox, "1.0.1", {}, (r) => ({
          ...r,
          diplomacy: { ...r.diplomacy, proposalTtl: 0 },
        })),
      ]),
    ).toContain("diplomacy.proposalTtl: is 0");
    expect(rejection([{ ...sandbox, ref: "sandbox-1@9.9.9" }])).toContain(
      "ref is not sandbox-1@1.0.0",
    );
  });

  test("a ruleset event type that redeclares a standard one, and an errors code without a sample", () => {
    expect(
      rejection([variant(sandbox, "1.0.1", { eventSchemas: { battle: z.strictObject({}) } })]),
    ).toContain("eventSchemas redeclares the standard event type battle");
    expect(rejection([variant(sandbox, "1.0.1", { errorSamples: [] })])).toContain(
      "has no entry in errorSamples",
    );
  });

  test("a wake key or a publicOncePerDay entry that names no event type of the build", () => {
    const wake = variant(sandbox, "1.0.1", {}, (r) => ({
      ...r,
      gateway: { ...r.gateway, wake: { ...r.gateway.wake, incomming_attack: { party: "urgent" } } },
    }));
    expect(rejection([wake])).toContain(
      "N = 2: gateway.wake names incomming_attack, which is neither a standard event type nor a key of eventSchemas",
    );
    const once = variant(sandbox, "1.0.1", {}, (r) => ({
      ...r,
      gateway: { ...r.gateway, publicOncePerDay: ["hill_opened"] },
    }));
    expect(rejection([once])).toContain("gateway.publicOncePerDay names hill_opened");
    // city_renamed is a public event of sandbox-1, but its data has no key to group by.
    const keyless = variant(sandbox, "1.0.1", {}, (r) => ({
      ...r,
      gateway: { ...r.gateway, publicOncePerDay: ["city_renamed"] },
    }));
    expect(rejection([keyless])).toContain(
      "gateway.publicOncePerDay names city_renamed, whose data has no required key field to group by",
    );
    const keyed = variant(
      sandbox,
      "1.0.1",
      { eventSchemas: { ...sandbox.eventSchemas, tick: z.looseObject({ key: z.string() }) } },
      (r) => ({ ...r, gateway: { ...r.gateway, publicOncePerDay: ["tick"] } }),
    );
    expect(rejection([keyed])).toBe("accepted");
  });

  test("an errors code that reuses a domain code or a gateway warning", () => {
    for (const code of ["NOT_OWNER", "WAKE_CLAMPED"]) {
      const reused = variant(sandbox, "1.0.1", {
        errors: { ...sandbox.errors, [code]: someText },
        errorSamples: [...sandbox.errorSamples, { code, details: {} }],
      });
      expect(rejection([reused])).toContain(
        `errors.${code} reuses a domain or gateway code, which the gateway words itself`,
      );
    }
  });
});

describe("the top barrel", () => {
  test("exports the registry, and verifyLog(lines) resolves the header's ref through it", () => {
    expect(engine.RULESETS).toBe(RULESETS);
    expect(engine.getRuleset("sandbox-1")).toBe(sandbox);
    const seats = [{ id: "p1" as const }, { id: "p2" as const }];
    const setup = {
      ruleset: sandbox.ref,
      overrides: { "time.matchEnd": 7200 },
      seed: 5,
      idKey: idKeyFromSeed(5),
      seats,
    };
    const rec = new LogRecorder(engine.createMatch(setup, sandbox, { invariants: "step" }));
    rec.act("p1", { type: "build", city: "c1", building: "sawmill" });
    rec.act("p2", { type: "ext", tool: "rename_city", args: { city: "c2", name: "Fort Two" } });
    rec.end();
    const report = engine.verifyLog(rec.lines);
    expect(report.divergence).toBeUndefined();
    expect(report).toMatchObject({ ok: true, actions: 2 });
    // An unknown ref is a header divergence naming it.
    const header = rec.lines[0];
    if (header?.k !== "header") throw new Error("no header");
    const unknown = engine.verifyLog([
      { ...header, setup: { ...header.setup, ruleset: "nothing-1@1.0.0" } },
      ...rec.lines.slice(1),
    ]);
    expect(unknown.divergence).toMatchObject({
      kind: "header",
      actual: "nothing-1@1.0.0 is not in this build",
    });
  });
});
