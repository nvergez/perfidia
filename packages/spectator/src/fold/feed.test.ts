import { describe, expect, test } from "bun:test";
import { FeedState } from "./feed.ts";
import { rulesetEvents } from "./rulesets.ts";

// The feed names a seat in thoughts by its id or by the profile its LLM label names: phase 2's
// labels and phase 4's (escaped model and endpoint ids, a channel-variant suffix) alike.

describe("profiles from controller labels", () => {
  test("phase 2, OpenRouter (escaped ids, endpoint, -env) and -dev labels name the profile; bots none", () => {
    const feed = new FeedState(rulesetEvents("perfidia-1@1.1.0"));
    feed.controller("p2", "llm:fake/claude-opus-5-5/medium:odysseus@1:p2");
    feed.controller("p3", "llm:openrouter/z-ai%2Fglm-5.3@z-ai%2Ffp8/medium:agamemnon@1:p2-env");
    feed.controller("p4", "llm:openai/gpt-6.1-sol/none:achilles@1:p2-dev");
    feed.controller("p5", "bot:turtle@3");
    feed.noteThought("p1", 1, 10, "Odysseus smiles too much.");
    feed.noteThought("p1", 1, 11, "Agamemnon wants the strait.");
    feed.noteThought("p1", 1, 12, "Achilles is restless.");
    feed.noteThought("p1", 1, 13, "The turtle digs in.");
    const thoughts = (seat: "p2" | "p3" | "p4" | "p5") =>
      feed.context("p1", seat, "ally", 20).thoughts.map((x) => x.text);
    expect(thoughts("p2")).toEqual(["Odysseus smiles too much."]);
    expect(thoughts("p3")).toEqual(["Agamemnon wants the strait."]);
    expect(thoughts("p4")).toEqual(["Achilles is restless."]);
    expect(thoughts("p5")).toEqual([]);
  });
});
