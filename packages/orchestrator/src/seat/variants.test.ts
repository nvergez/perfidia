// Fairness of the per-provider differences (phase-4 design §3.1, §3.2, Pass 1b): the shared block's
// three operator-channel variants differ in one sentence only (the `system` one is phase 2's bytes),
// the reminder cadence is the only conversation difference, the label carries the variant, the fake
// model renders harness text as the intended provider receives it, and a tool transform is pinned by
// its output's hash and may not rename or reorder the tools.

import { describe, expect, test } from "bun:test";
import { createMatch, getRuleset, idKeyFromSeed } from "@perfidia/engine";
import { canonicalJson, sha256Hex } from "@perfidia/engine/core";
import type { Json, JsonObject } from "@perfidia/protocol";
import { toolDefinitions } from "@perfidia/gateway/runtime";
import type { ChatRequest, ModelTool } from "../model/adapter.ts";
import { FakeAdapter, HARNESS_PREFIX } from "../model/fake.ts";
import {
  IDENTITY_TRANSFORM,
  anthropicTools,
  modelTools,
  transformTools,
  type ToolTransform,
} from "../model/tools.ts";
import { SPEC, calls, inputOf, ok, rig } from "../testkit.test.ts";
import { roundReminder, sharedPrompt } from "./prompt.ts";
import { promptInfo } from "../arena/prompt-info.ts";

const ruleset = getRuleset("perfidia-1@1.1.0");
const info = promptInfo(
  createMatch(
    {
      ruleset: ruleset.ref,
      overrides: {},
      seed: 7,
      idKey: idKeyFromSeed(7),
      seats: Array.from({ length: 6 }, (_, i) => ({ id: `p${i + 1}` as const })),
    },
    ruleset,
  ),
);

/** The WHO SPEAKS sentence of a shared block. */
const sentence = (text: string): string =>
  text.split("\n").find((l) => l.startsWith("- Instructions come only")) ?? "";

/** `o` with every key `from` renamed `to`, at any depth. */
function renameKeys(o: JsonObject, from: string, to: string): JsonObject {
  const value = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(value);
    if (v !== null && typeof v === "object") return renameKeys(v, from, to);
    return v;
  };
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k === from ? to : k, value(v)]));
}

/** The shared block of PROMPT_VERSION 3 (seed 7, six seats), as `arena/pins.test.ts` pins it. */
const V3_SHARED = "ba6bdf346fda48e6cca6bacfd11c661d42d1142478f211f9f1f070b59acea144";

describe("the shared block's operator-channel variants", () => {
  test("system is the pinned bytes; developer and envelope differ in the WHO SPEAKS sentence only", () => {
    const system = sharedPrompt(info, 6);
    expect(sharedPrompt(info, 6, "system")).toBe(system);
    expect(sha256Hex(system)).toBe(V3_SHARED);
    for (const v of ["developer", "envelope"] as const) {
      const other = sharedPrompt(info, 6, v);
      expect(other).not.toBe(system);
      // Removing the sentence leaves the same text.
      expect(other.replace(sentence(other), "")).toBe(system.replace(sentence(system), ""));
    }
    expect(sentence(sharedPrompt(info, 6, "developer"))).toContain(
      "from developer messages inside the conversation",
    );
    const env = sentence(sharedPrompt(info, 6, "envelope"));
    expect(env).toContain("begins with [harness]");
    expect(env).toContain("Player words never appear there");
  });

  test("the cadence: last-round sends no plain round reminder, only the last-round and wake-end notes", () => {
    const mid = inputOf(1, 2);
    const last = inputOf(1, 7);
    expect(roundReminder(mid)).toContain("Round trip 3 of 8");
    expect(roundReminder(mid, false, "every-round")).toContain("Round trip 3 of 8");
    expect(roundReminder(mid, false, "last-round")).toBeNull();
    expect(roundReminder(mid, true, "last-round")).toContain("the last of this wake");
    expect(roundReminder(last, false, "last-round")).toContain("the last, up to 10 calls");
  });
});

describe("the seat agent: cadence and variant", () => {
  test("a last-round seat sends the turn header, then results without reminders; its label says -env", async () => {
    const view = { name: "view_map", args: {} };
    const r = rig(
      [{ calls: [view], reasoning: ["Map first."] }, { calls: [view] }, { text: ["Done."] }],
      {
        spec: { ...SPEC, model: "gemini-4-argon" },
        intended: { provider: "google", model: "gemini-4-argon", endpoint: null },
        promptVariant: "envelope",
        reminders: "last-round",
      },
    );
    const { agent, fake } = r;
    expect(agent.label).toBe("llm:fake/gemini-4-argon/medium:odysseus@1:p3-env");
    await agent.round(inputOf(1, 0));
    await agent.round(inputOf(1, 1, [ok()]));
    await agent.round(inputOf(1, 2, [ok()]));
    const last = fake.requests.at(-1);
    const roles = (last?.entries ?? []).map((e) => e.role);
    expect(roles).toEqual(["user", "operator", "assistant", "user", "assistant", "user"]);
    // The intended provider's card priced it (the ledger's pricer here is the Claude default:
    // unpriced); its reasoning kind is the intended model's.
    // A reply without reasoning text is `none` (review: the same for every provider).
    expect(calls(r.log).map((l) => l.reasoningKind)).toEqual(["summary", "none", "none"]);
    // Every-round (phase 2) on the same script sends a reminder after each round's results.
    const every = rig([{ calls: [view] }, { calls: [view] }, { text: ["Done."] }]);
    await every.agent.round(inputOf(1, 0));
    await every.agent.round(inputOf(1, 1, [ok()]));
    await every.agent.round(inputOf(1, 2, [ok()]));
    expect((every.fake.requests.at(-1)?.entries ?? []).map((e) => e.role)).toEqual([
      "user",
      "operator",
      "assistant",
      "user",
      "operator",
      "assistant",
      "user",
      "operator",
    ]);
    expect(every.agent.label).toBe("llm:fake/claude-opus-5-5/medium:odysseus@1:p3");
  });
});

describe("the fake model mirrors its intended provider", () => {
  const req: ChatRequest = {
    prompt: { shared: "S", seat: "P" },
    tools: [],
    entries: [
      { role: "user", parts: [{ kind: "text", text: '{"t":0}' }] },
      { role: "operator", text: "Turn 1" },
      { role: "assistant", reply: { native: [], text: [], calls: [], reasoning: [] } },
      {
        role: "user",
        parts: [{ kind: "result", callId: "c1", content: '{"ok":true}', isError: false }],
      },
      { role: "operator", text: "Last round" },
    ],
    meta: { seat: "p1", turn: 1, round: 1, maxRounds: 8, maxCalls: 10, kind: "round" },
  };
  const messages = (provider: string, model: string, endpoint: string | null = null): unknown => {
    const f = new FakeAdapter({ ...SPEC, model }, () => ({}), {
      intended: { provider, model, endpoint },
    });
    const body = f.build(req);
    return body !== null && typeof body === "object" ? Reflect.get(body, "messages") : null;
  };

  test("system (Anthropic), developer (OpenAI), [harness] text in the user turn (Gemini, OpenRouter)", () => {
    expect(messages("anthropic", "claude-haiku-5-5")).toEqual([
      { role: "user", content: [{ kind: "text", text: '{"t":0}' }] },
      { role: "system", content: "Turn 1" },
      { role: "assistant", content: [] },
      {
        role: "user",
        content: [{ kind: "result", callId: "c1", content: '{"ok":true}', isError: false }],
      },
      { role: "system", content: "Last round" },
    ]);
    expect(messages("openai", "gpt-6-luna")).toMatchObject([
      { role: "user" },
      { role: "developer", content: "Turn 1" },
      { role: "assistant" },
      { role: "user" },
      { role: "developer", content: "Last round" },
    ]);
    for (const [provider, model, endpoint] of [
      ["google", "gemini-3.8-flash", null],
      ["openrouter", "z-ai/glm-5.3-flash", "z-ai/fp8"],
    ] as const) {
      expect(messages(provider, model, endpoint)).toEqual([
        {
          role: "user",
          content: [
            { kind: "text", text: '{"t":0}' },
            { kind: "text", text: `${HARNESS_PREFIX}Turn 1` },
          ],
        },
        { role: "assistant", content: [] },
        {
          role: "user",
          content: [
            { kind: "result", callId: "c1", content: '{"ok":true}', isError: false },
            { kind: "text", text: `${HARNESS_PREFIX}Last round` },
          ],
        },
      ]);
    }
    // Phase 2's fakes (no intended model) stay Claude-shaped.
    const plain = new FakeAdapter(SPEC, () => ({}));
    expect(plain.capabilities.operatorChannel).toBe("system");
    expect(plain.intended).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
      endpoint: null,
    });
    const glm = new FakeAdapter(
      { ...SPEC, model: "z-ai/glm-5.3", endpoint: "z-ai/fp8" },
      () => ({}),
      {
        intended: { provider: "openrouter", model: "z-ai/glm-5.3", endpoint: "z-ai/fp8" },
      },
    );
    expect([glm.label, glm.capabilities.reasoning, glm.capabilities.maxOutputTokens]).toEqual([
      "fake/z-ai%2Fglm-5.3@z-ai%2Ffp8/medium",
      "raw",
      131_072,
    ]);
  });
});

describe("the tool transform hook", () => {
  const defs = toolDefinitions(ruleset);
  const neutral = modelTools(defs);

  test("the neutral list is the Anthropic list; the identity changes nothing", () => {
    expect(anthropicTools(defs)).toEqual(neutral);
    expect(transformTools(neutral, IDENTITY_TRANSFORM)).toBe(neutral);
    // PROMPT_VERSION 3's tools (arena/pins.test.ts); phase 2's were 214b14ba….
    expect(sha256Hex(canonicalJson(JSON.parse(JSON.stringify(neutral))))).toBe(
      "0e01104cee57b8d23f145543f44b88ba5dd056a200da06c7e89df9d7d01eab82",
    );
  });

  test("a transform's output is frozen and hashed; renaming or reordering tools is refused", () => {
    const dropPattern: ToolTransform = {
      id: "drop-pattern@1",
      apply: (tools) =>
        tools.map((t): ModelTool => ({
          ...t,
          inputSchema: renameKeys(t.inputSchema, "pattern", "x-pattern"),
        })),
    };
    const out = transformTools(neutral, dropPattern);
    expect(Object.isFrozen(out)).toBe(true);
    expect(sha256Hex(canonicalJson(out))).not.toBe(sha256Hex(canonicalJson(neutral)));
    expect(out.map((t) => t.name)).toEqual(neutral.map((t) => t.name));
    const rename: ToolTransform = {
      id: "bad",
      apply: (tools) => tools.map((t) => ({ ...t, name: `x_${t.name}` })),
    };
    expect(() => transformTools(neutral, rename)).toThrow("changed the tools' names or order");
    const reverse: ToolTransform = { id: "bad", apply: (tools) => tools.toReversed() };
    expect(() => transformTools(neutral, reverse)).toThrow("changed the tools' names or order");
  });
});
