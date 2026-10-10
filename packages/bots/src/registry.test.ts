// The registry (docs/architecture.md §11): versioned labels and the factory sim uses for Level G.

import { expect, test } from "bun:test";
import { BOTS_PACKAGE } from "./index.ts";
import { botFromLabel, botLabel, createBot, isBotStrategy, parseBotLabel } from "./registry.ts";
import { BOT_STRATEGIES } from "./strategies/strategy.ts";

test("the four strategies, labelled bot:<strategy>@1", () => {
  expect([...BOT_STRATEGIES]).toEqual(["expander", "rusher", "turtle", "opportunist"]);
  for (const s of BOT_STRATEGIES) {
    expect(botLabel(s)).toBe(`bot:${s}@1`);
    expect(createBot(s, { seat: "p1", seed: 1 }).label).toBe(`bot:${s}@1`);
  }
});

test("labels parse back to their strategy; unknown or old labels do not", () => {
  expect(parseBotLabel("bot:rusher@1")).toEqual({ strategy: "rusher", version: 1 });
  for (const bad of [
    "bot:rusher@2",
    "bot:rusher@0",
    "bot:chaos@1",
    "rusher",
    "bot:rusher@01",
    "bot:Rusher@1",
    "",
  ]) {
    expect(parseBotLabel(bad)).toBeNull();
    expect(botFromLabel(bad, { seat: "p1", seed: 1 })).toBeNull();
  }
  expect(botFromLabel("bot:turtle@1", { seat: "p2", seed: 3 })?.label).toBe("bot:turtle@1");
  expect(isBotStrategy("opportunist")).toBe(true);
  expect(isBotStrategy("toString")).toBe(false);
});

test("each createBot call is a new instance", () => {
  const a = createBot("expander", { seat: "p1", seed: 1 });
  const b = createBot("expander", { seat: "p1", seed: 1 });
  expect(a).not.toBe(b);
});

test("the placeholder constant is kept until T17", () => {
  expect(BOTS_PACKAGE).toBe("@perfidia/bots");
});
