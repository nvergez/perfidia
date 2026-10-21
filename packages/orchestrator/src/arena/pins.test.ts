// The Anthropic prompt bytes and controller labels, pinned (docs/phase4.md, Pass 1a constraint:
// phase 4 changed no request byte of phase 2). The hashes are computed from the same inputs:
// perfidia-1@1.1.0, seed 7, six seats, the 22 tools, each profile's seat block, a round-0
// conversation, `AnthropicAdapter.build`. A seat whose fallbacks are `off` (Claude Sonnet 5.5's
// default) sends neither `fallbacks` nor its beta: its body is the body without those two keys.
//
// PROMPT_VERSION 3 (after the `arena playtest` sessions, before any real match, so no measured run
// is lost) changed them on purpose: the shared block gained READING THE INTERFACE and TIMES, and
// six gateway tool descriptions changed. Version 2's hashes, computed at ec8e2ad, were: shared
// a24c94a7…, tools 214b14ba…, Opus 5.5 bodies c97fc7ec…, 5f881c87…, f5431d93…, 603fecf9…. The
// seat blocks and operator texts did not change (seat/prompt.test.ts).

import { describe, expect, test } from "bun:test";
import { createMatch, getRuleset, idKeyFromSeed } from "@perfidia/engine";
import { canonicalJson, sha256Hex } from "@perfidia/engine/core";
import { toolDefinitions } from "@perfidia/gateway/runtime";
import type { PlayerId, SeatAgent } from "@perfidia/protocol";
import { BudgetLedger } from "../budget/ledger.ts";
import { MemoryCallLog } from "../log/calls.ts";
import type { ModelSpec } from "../model/adapter.ts";
import { AnthropicAdapter, AnthropicClient } from "../model/anthropic.ts";
import { RateGate } from "../model/rate.ts";
import { anthropicTools } from "../model/tools.ts";
import { LOCKSTEP_POLICY, LlmSeatAgent } from "../seat/agent.ts";
import { NoPauseGate } from "../seat/pause.ts";
import { PROFILES } from "../seat/personalities.ts";
import { seatPrompt, sharedPrompt } from "../seat/prompt.ts";
import { promptInfo } from "./prompt-info.ts";
import { virtualTime } from "../testkit.test.ts";
import { arenaEnv, llmSeatsOf, planArena } from "./plan.ts";

/** sha256 of the canonical request body at PROMPT_VERSION 3, per model and seat (profiles in order). */
const PINNED = {
  shared: "ba6bdf346fda48e6cca6bacfd11c661d42d1142478f211f9f1f070b59acea144",
  tools: "0e01104cee57b8d23f145543f44b88ba5dd056a200da06c7e89df9d7d01eab82",
  body: {
    "claude-opus-5-5": [
      "dae35e3249e553a68b570a40776f91cae9bce2409d1135d7bb69811b4c8f1b79",
      "4f66a3aa0337f540230d48ec51177dee1bb6bd76dec0fa22a935a970e0b4b7c7",
      "4d9edb67fb0a8f1689e03508d0974e84d075273d6f0ebec165a8a04045a476f3",
      "d35cab64763bd8a05e8ff7461590e723f3559a1b593087115e105327adaff1d2",
    ],
    "claude-sonnet-5-5": [
      "38b071c2df6efdb1a8567f5aa995f9204e26b8dcf05c3d3917e3c16e81607212",
      "965f5536d3cf8cd40e7500b25c0ee47cfb8651503d2dfc209acbeca667b029ed",
      "50d0e348e3799b2bbcd72f140b07ae0c01f37e4f715603a4a43e38d2d890bcd7",
      "e7a421e7e523e7ccddca3111aab2c2af98c152330d5bbca2bf0474c4c0bd3320",
    ],
    "claude-haiku-5-5": [
      "15299beb9fbf9feeddb0041448ffecc823e425c9713d13cf30a6a0463d10809c",
      "62a550f9feaaeaa9ac2aeeb623a9894eab7e6426f62c02be2be1597e80e1552b",
      "11ab6db3c61e552e2de79c445776a4b85da2ca6e4a69444763efa9581c3896d6",
      "85c7cc6d04e2952b5f745166c6efe07c9e0ec99a473a9a48b46194a9fbd42a6c",
    ],
  },
  /** The same bodies without `betas` and `fallbacks`. */
  bodyWithoutFallbacks: {
    "claude-sonnet-5-5": [
      "6d3dabb6e10394feaad4fb534d4ab204a2d1ffc77de353fa30797706ca9f55ac",
      "199515e658c27bf776c4e83bf1bc5871413939c740a82af049f776c1abb8e924",
      "5f16ea48ece772fa35f30f7427362315418ce7bcd32509f53f04e22300090b19",
      "be515f7cda99f32f4b1605681724d01b514e330a5e6e79bab1c19ac2b9b7431d",
    ],
  },
} as const;

const ruleset = getRuleset("perfidia-1@1.1.0");
const match = createMatch(
  {
    ruleset: ruleset.ref,
    overrides: {},
    seed: 7,
    idKey: idKeyFromSeed(7),
    seats: Array.from({ length: 6 }, (_, i) => ({ id: `p${i + 1}` as const })),
  },
  ruleset,
);
const shared = sharedPrompt(promptInfo(match), 6);
const tools = anthropicTools(toolDefinitions(ruleset));
const client = new AnthropicClient({ apiKey: "k", baseURL: "https://api.anthropic.com" });

function bodyHash(spec: ModelSpec, i: number): string {
  const profile = PROFILES[i];
  if (profile === undefined) throw new Error(`no profile ${i}`);
  const seat: PlayerId = `p${i + 1}`;
  const body = new AnthropicAdapter(spec, client).build({
    prompt: { shared, seat: seatPrompt(seat, profile) },
    tools,
    entries: [
      { role: "user", parts: [{ kind: "text", text: '{"briefing":1}' }] },
      { role: "operator", text: "Turn 1 · D1 00:00 · round trip 1 of 8, up to 10 calls." },
    ],
    meta: { seat, turn: 1, round: 0, maxRounds: 8, maxCalls: 10, kind: "round" },
  });
  return sha256Hex(canonicalJson(JSON.parse(JSON.stringify(body))));
}

const spec = (model: string, fallbacks?: "default" | "off"): ModelSpec => ({
  provider: "anthropic",
  model,
  effort: "medium",
  maxOutputTokens: 16_000,
  cacheTtl: "5m",
  ...(fallbacks === undefined ? {} : { fallbacks }),
});

const idle = (label: string): SeatAgent => ({ label, round: () => Promise.resolve({ calls: [] }) });

/** The controller label an LLM seat of `spec` and profile `i` writes. */
function labelOf(s: ModelSpec, i: number): string {
  const profile = PROFILES[i];
  if (profile === undefined) throw new Error(`no profile ${i}`);
  const time = virtualTime();
  const clock = { time, random: () => 0 };
  return new LlmSeatAgent({
    seat: "p1",
    adapter: new AnthropicAdapter(s, client),
    prompt: { shared, seat: "" },
    tools,
    profile,
    ledger: new BudgetLedger({
      caps: new Map([["p1", 1]]),
      wakeCapNanoUsd: null,
      handoffTo: () => ({ label: "bot:turtle@3", agent: idle("bot:turtle@3") }),
    }),
    log: new MemoryCallLog(),
    clock,
    gate: new NoPauseGate(),
    rate: new RateGate({ clock }),
    policy: LOCKSTEP_POLICY,
  }).label;
}

describe("Anthropic prompt bytes and controller labels are pinned (PROMPT_VERSION 3)", () => {
  test("the shared block and the tools", () => {
    expect(sha256Hex(shared)).toBe(PINNED.shared);
    expect(sha256Hex(canonicalJson(JSON.parse(JSON.stringify(tools))))).toBe(PINNED.tools);
  });

  test("request bodies: Opus 5.5 and Haiku 5.5 unchanged; Sonnet 5.5 unchanged but for fallbacks off", () => {
    for (let i = 0; i < 4; i += 1) {
      expect(bodyHash(spec("claude-opus-5-5"), i)).toBe(PINNED.body["claude-opus-5-5"][i] ?? "");
      expect(bodyHash(spec("claude-opus-5-5", "default"), i)).toBe(
        PINNED.body["claude-opus-5-5"][i] ?? "",
      );
      expect(bodyHash(spec("claude-haiku-5-5", "off"), i)).toBe(
        PINNED.body["claude-haiku-5-5"][i] ?? "",
      );
      expect(bodyHash(spec("claude-sonnet-5-5", "default"), i)).toBe(
        PINNED.body["claude-sonnet-5-5"][i] ?? "",
      );
      expect(bodyHash(spec("claude-sonnet-5-5", "off"), i)).toBe(
        PINNED.bodyWithoutFallbacks["claude-sonnet-5-5"][i] ?? "",
      );
    }
  });

  test("the plan's seats: claude-duo and claude-family get exactly those bodies and labels", () => {
    for (const lineup of ["claude-duo", "claude-family"]) {
      const plan = planArena(
        { ruleset: ruleset.ref, fake: true, seed: 7, idKey: "seed", lineup },
        arenaEnv({}),
      );
      for (const s of llmSeatsOf(plan)) {
        const i = PROFILES.findIndex((p) => p.id === s.profile.id);
        const planned = { ...spec(s.model, s.fallbacks), effort: s.effort };
        if (s.effort !== "medium") continue;
        const expected =
          s.fallbacks === "off" && s.model === "claude-sonnet-5-5"
            ? PINNED.bodyWithoutFallbacks["claude-sonnet-5-5"][i]
            : s.model === "claude-sonnet-5-5" ||
                s.model === "claude-opus-5-5" ||
                s.model === "claude-haiku-5-5"
              ? PINNED.body[s.model][i]
              : undefined;
        expect([lineup, s.seat, bodyHash(planned, i)]).toEqual([lineup, s.seat, expected ?? ""]);
        expect(labelOf(planned, i)).toBe(
          `llm:anthropic/${s.model}/${s.effort}:${s.profile.id}@${s.profile.version}:p3`,
        );
      }
    }
    // The labels: phase 2's grammar, with prompt version 3.
    expect(labelOf(spec("claude-sonnet-5-5", "off"), 0)).toBe(
      "llm:anthropic/claude-sonnet-5-5/medium:odysseus@1:p3",
    );
    expect(labelOf(spec("claude-haiku-5-5", "off"), 3)).toBe(
      "llm:anthropic/claude-haiku-5-5/medium:agamemnon@1:p3",
    );
    expect(labelOf(spec("claude-opus-5-5", "default"), 1)).toBe(
      "llm:anthropic/claude-opus-5-5/medium:achilles@1:p3",
    );
  });
});
