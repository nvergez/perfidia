// The registry (docs/architecture.md §11): versioned labels and the factory sim uses for Level G.
// Every published version stays registered (§11.1): unversioned calls use the latest, a label
// builds exactly the version it names.

import { describe, expect, test } from "bun:test";
import * as bots from "./index.ts";
import {
  botFromLabel,
  botLabel,
  botLabels,
  botVersions,
  createBot,
  createBotRegistry,
  createBotVersion,
  isBotStrategy,
  parseBotLabel,
} from "./registry.ts";
import { conqueror } from "./strategies/conqueror.ts";
import { expander } from "./strategies/expander.ts";
import { opportunist } from "./strategies/opportunist.ts";
import { rusher } from "./strategies/rusher.ts";
import { BOT_STRATEGIES, type StrategyDef } from "./strategies/strategy.ts";
import { turtle } from "./strategies/turtle.ts";

const P1 = { seat: "p1", seed: 1 } as const;

/** A later rusher for the tests: the same brain under version 2 (a real one would differ). */
const rusher2: StrategyDef = Object.freeze<StrategyDef>({ ...rusher, version: 2 });

describe("the registry of this build", () => {
  test("the strategies, labelled bot:<strategy>@1", () => {
    expect([...BOT_STRATEGIES]).toEqual([
      "expander",
      "rusher",
      "turtle",
      "opportunist",
      "conqueror",
    ]);
    for (const s of BOT_STRATEGIES) {
      expect(botLabel(s)).toBe(`bot:${s}@1`);
      expect(botVersions(s)).toEqual([1]);
      expect(createBot(s, P1).label).toBe(`bot:${s}@1`);
      expect(createBotVersion(s, 1, P1).label).toBe(`bot:${s}@1`);
    }
    expect(botLabels()).toEqual(BOT_STRATEGIES.map((s) => `bot:${s}@1`));
  });

  test("labels parse back to their strategy; malformed or unregistered labels do not", () => {
    expect(parseBotLabel("bot:rusher@1")).toEqual({ strategy: "rusher", version: 1 });
    for (const bad of [
      "bot:rusher@2",
      "bot:rusher@0",
      "bot:chaos@1",
      "rusher",
      "bot:rusher@01",
      "bot:Rusher@1",
      "bot:toString@1",
      "bot:rusher@1 ",
      "",
    ]) {
      expect(parseBotLabel(bad)).toBeNull();
      expect(botFromLabel(bad, P1)).toBeNull();
    }
    expect(botFromLabel("bot:turtle@1", { seat: "p2", seed: 3 })?.label).toBe("bot:turtle@1");
    expect(isBotStrategy("opportunist")).toBe(true);
    expect(isBotStrategy("toString")).toBe(false);
  });

  test("an unregistered version is an error when asked for by number", () => {
    expect(() => botLabel("rusher", 2)).toThrow("no bot:rusher@2; rusher has @1");
    expect(() => createBotVersion("rusher", 2, P1)).toThrow("no bot:rusher@2");
  });

  test("each createBot call is a new instance", () => {
    const a = createBot("expander", P1);
    const b = createBot("expander", P1);
    expect(a).not.toBe(b);
  });

  test("the public entry point exports the versioned API, and the placeholder constant is gone (T17)", () => {
    expect(typeof bots.createBotVersion).toBe("function");
    expect(typeof bots.botVersions).toBe("function");
    expect(typeof bots.botLabels).toBe("function");
    expect("BOTS_PACKAGE" in bots).toBe(false);
  });
});

describe("several versions of a strategy", () => {
  const reg = createBotRegistry([expander, rusher2, rusher, turtle, opportunist, conqueror]);

  test("unversioned calls use the latest version; every version stays registered", () => {
    expect(reg.versions("rusher")).toEqual([1, 2]);
    expect(reg.latest("rusher")).toBe(2);
    expect(reg.latest("turtle")).toBe(1);
    expect(reg.label("rusher")).toBe("bot:rusher@2");
    expect(reg.label("rusher", 1)).toBe("bot:rusher@1");
    expect(reg.create("rusher", P1).label).toBe("bot:rusher@2");
    expect(reg.create("rusher", P1, 1).label).toBe("bot:rusher@1");
    expect(reg.labels()).toEqual([
      "bot:expander@1",
      "bot:rusher@1",
      "bot:rusher@2",
      "bot:turtle@1",
      "bot:opportunist@1",
      "bot:conqueror@1",
    ]);
  });

  test("a label parses to, and builds, exactly the version it names", () => {
    for (const version of [1, 2]) {
      const label = `bot:rusher@${version}`;
      expect(reg.parse(label)).toEqual({ strategy: "rusher", version });
      const bot = reg.fromLabel(label, P1);
      expect(bot?.label).toBe(label);
      expect(bot).not.toBe(reg.fromLabel(label, P1));
    }
    for (const bad of ["bot:rusher@3", "bot:turtle@2", "bot:rusher@0", "bot:conqueror@2"]) {
      expect(reg.parse(bad)).toBeNull();
      expect(reg.fromLabel(bad, P1)).toBeNull();
    }
    expect(() => reg.create("turtle", P1, 2)).toThrow("no bot:turtle@2; turtle has @1");
  });

  test("the definitions are checked: duplicates, bad versions, strategies without a def", () => {
    expect(() => createBotRegistry([expander, rusher, rusher, turtle, opportunist])).toThrow(
      "bot:rusher@1 is registered twice",
    );
    expect(() =>
      createBotRegistry([expander, rusher, { ...rusher, version: 0 }, turtle, opportunist]),
    ).toThrow("rusher has version 0, not an integer ≥ 1");
    expect(() =>
      createBotRegistry([expander, rusher, { ...rusher, version: 1.5 }, turtle, opportunist]),
    ).toThrow("rusher has version 1.5");
    expect(() => createBotRegistry([expander, rusher, opportunist])).toThrow(
      "turtle has no version",
    );
    // A def of a strategy the registry does not list.
    expect(() => createBotRegistry([expander, rusher], ["expander"])).toThrow(
      "rusher is not a strategy (expander)",
    );
    expect(createBotRegistry([expander], ["expander"]).labels()).toEqual(["bot:expander@1"]);
  });
});
