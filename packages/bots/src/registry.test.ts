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

/** The registered versions of each strategy (the latest last). */
const VERSIONS: Readonly<Record<string, readonly number[]>> = {
  expander: [1, 2],
  rusher: [1, 2, 3],
  turtle: [1, 2],
  opportunist: [1, 2],
  conqueror: [1, 2, 3],
};
/** Previews (`StrategyDef.preview`): registered, but not the default yet. */
const PREVIEWS: Readonly<Record<string, readonly number[]>> = { conqueror: [3] };
const versionsOf = (s: string): readonly number[] => VERSIONS[s] ?? [];
const latest = (s: string): number =>
  versionsOf(s).findLast((v) => !(PREVIEWS[s] ?? []).includes(v)) ?? 0;

describe("the registry of this build", () => {
  test("the five strategies at their latest version, every published version kept", () => {
    expect([...BOT_STRATEGIES]).toEqual([
      "expander",
      "rusher",
      "turtle",
      "opportunist",
      "conqueror",
    ]);
    for (const s of BOT_STRATEGIES) {
      expect(botLabel(s)).toBe(`bot:${s}@${latest(s)}`);
      expect(botVersions(s)).toEqual(versionsOf(s));
      expect(createBot(s, P1).label).toBe(`bot:${s}@${latest(s)}`);
      expect(createBotVersion(s, 1, P1).label).toBe(`bot:${s}@1`);
    }
    expect(botLabels()).toEqual([
      "bot:expander@1",
      "bot:expander@2",
      "bot:rusher@1",
      "bot:rusher@2",
      "bot:rusher@3",
      "bot:turtle@1",
      "bot:turtle@2",
      "bot:opportunist@1",
      "bot:opportunist@2",
      "bot:conqueror@1",
      "bot:conqueror@2",
      "bot:conqueror@3",
    ]);
    expect(botFromLabel("bot:rusher@1", P1)?.label).toBe("bot:rusher@1");
    expect(botFromLabel("bot:rusher@2", P1)?.label).toBe("bot:rusher@2");
    expect(botFromLabel("bot:rusher@3", P1)?.label).toBe("bot:rusher@3");
    expect(botFromLabel("bot:conqueror@2", P1)?.label).toBe("bot:conqueror@2");
    // A preview builds by its label, never as the default.
    expect(botFromLabel("bot:conqueror@3", P1)?.label).toBe("bot:conqueror@3");
    expect(createBotVersion("conqueror", 3, P1).label).toBe("bot:conqueror@3");
    expect(botLabel("conqueror")).toBe("bot:conqueror@2");
  });

  test("labels parse back to their strategy; malformed or unregistered labels do not", () => {
    expect(parseBotLabel("bot:rusher@1")).toEqual({ strategy: "rusher", version: 1 });
    expect(parseBotLabel("bot:rusher@2")).toEqual({ strategy: "rusher", version: 2 });
    for (const bad of [
      "bot:rusher@9",
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
    expect(() => botLabel("rusher", 9)).toThrow("no bot:rusher@9; rusher has @1, @2, @3");
    expect(() => createBotVersion("rusher", 9, P1)).toThrow("no bot:rusher@9");
    expect(() => botLabel("turtle", 3)).toThrow("no bot:turtle@3; turtle has @1, @2");
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

  test("a preview is registered but not the default until a release drops the flag", () => {
    const preview: StrategyDef = Object.freeze<StrategyDef>({
      ...rusher,
      version: 3,
      preview: true,
    });
    const withPreview = createBotRegistry([
      expander,
      rusher2,
      rusher,
      preview,
      turtle,
      opportunist,
      conqueror,
    ]);
    expect(withPreview.versions("rusher")).toEqual([1, 2, 3]);
    expect(withPreview.latest("rusher")).toBe(2);
    expect(withPreview.label("rusher")).toBe("bot:rusher@2");
    expect(withPreview.create("rusher", P1).label).toBe("bot:rusher@2");
    expect(withPreview.create("rusher", P1, 3).label).toBe("bot:rusher@3");
    expect(withPreview.parse("bot:rusher@3")).toEqual({ strategy: "rusher", version: 3 });
    expect(withPreview.labels()).toContain("bot:rusher@3");
    // Only previews: the highest of them is the default.
    const onlyPreview = createBotRegistry([
      expander,
      { ...rusher, preview: true },
      turtle,
      opportunist,
      conqueror,
    ]);
    expect(onlyPreview.latest("rusher")).toBe(1);
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
