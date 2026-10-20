// Phase 4, Pass 1a constraint (docs/phase4.md): the Anthropic prompt bytes and controller labels
// are phase 2's. The hashes below were computed at ec8e2ad (phase 3 merged, before any phase-4
// change) from the same inputs: perfidia-1@1.1.0, seed 7, six seats, the 22 tools, each profile's
// seat block, a round-0 conversation, `AnthropicAdapter.build`. The only request change phase 4
// makes is that a seat whose fallbacks are `off` (Claude Sonnet 5.5's default) sends neither
// `fallbacks` nor its beta: its body then equals ec8e2ad's body without those two keys.

import { describe, expect, test } from "bun:test";
import { createMatch, getRuleset, idKeyFromSeed } from "@perfidia/engine";
import { canonicalJson, sha256Hex } from "@perfidia/engine/core";
import { rulesInfo } from "@perfidia/gateway/present";
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
import { virtualTime } from "../testkit.test.ts";
import { arenaEnv, llmSeatsOf, planArena } from "./plan.ts";

/** sha256 of the canonical request body at ec8e2ad, per model and seat (profile p1..p4 in order). */
const EC8E2AD = {
  shared: "a24c94a7990c88ffafb2e85d43e4179dac9c358a7f21097182e6c51ea5e5b363",
  tools: "214b14ba67e638817bb4ca4d46d8e789fef47a95d375f4695b140587bf8d5b3b",
  body: {
    "claude-opus-5-5": [
      "c97fc7eca0d48f72baf836f8d2c65939edb5cca3c983b2ba5258ebe1595fbbf0",
      "5f881c87fcaaff8729d76cab1e63c6ed3dcfe1ae6d85163313fbd910b68bb9b0",
      "f5431d933af016d246653bb2ec3a9fd76ad0489228a1ecf39bcca809d6551c0e",
      "603fecf944c25715d6fe5f48fe544003b8477ca977f26997d3a077cfb9d3e472",
    ],
    "claude-sonnet-5-5": [
      "449f5c5444a0b4975aa1e9513a0e572ed18babfb831a0f4d8b869eaa208eed3e",
      "87c66c7eb873fa874eab7821337b22cc2e35a6fb470b82b1f6176eaf336749bc",
      "821d3f8f794ac9536238f27441a2e57b073c021efc2c5dcf071ba13a5b9382b5",
      "708b19e5797c82d9208dbafbfa3bdc19b7cda3abfeb8ffec03f324bb0361e163",
    ],
    "claude-haiku-5-5": [
      "dd717cbfa94fcdb0c2a131fb5317374ee1b6b6e7e05070fbecde0304745ebea0",
      "cf52d4072927145e6d3da546d82ae457de057a670c552a9143bd045198c37abd",
      "39106d7c54584220da0df9ded613e7bd465cec3b1d57499919d6a565f391ff14",
      "427c4dd157844e0170c1dd3259b53b2c7b69dbda3da13cb708783d4851defc3e",
    ],
  },
  /** The same bodies without `betas` and `fallbacks`. */
  bodyWithoutFallbacks: {
    "claude-sonnet-5-5": [
      "3c7e93c37714f03f00d8060227a957c821c36f51f0d10414bea5149c9ed0787b",
      "da271ecb1a72f6fe21fd4380ed274b9fac485be7d90beb7a9677e7e435039b0c",
      "c446cba1f8a2a910a3a0ed7814f346339b1072bb09002cb1d294cdd458482617",
      "93cbaf75791e8c73a16206cd26e37f1d38096300a2fedde2609c08118179708f",
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
const shared = sharedPrompt(rulesInfo(match), 6);
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

describe("Anthropic prompt bytes and controller labels are ec8e2ad's (phase 4 Pass 1a)", () => {
  test("the shared block and the tools", () => {
    expect(sha256Hex(shared)).toBe(EC8E2AD.shared);
    expect(sha256Hex(canonicalJson(JSON.parse(JSON.stringify(tools))))).toBe(EC8E2AD.tools);
  });

  test("request bodies: Opus 5.5 and Haiku 5.5 unchanged; Sonnet 5.5 unchanged but for fallbacks off", () => {
    for (let i = 0; i < 4; i += 1) {
      expect(bodyHash(spec("claude-opus-5-5"), i)).toBe(EC8E2AD.body["claude-opus-5-5"][i] ?? "");
      expect(bodyHash(spec("claude-opus-5-5", "default"), i)).toBe(
        EC8E2AD.body["claude-opus-5-5"][i] ?? "",
      );
      expect(bodyHash(spec("claude-haiku-5-5", "off"), i)).toBe(
        EC8E2AD.body["claude-haiku-5-5"][i] ?? "",
      );
      expect(bodyHash(spec("claude-sonnet-5-5", "default"), i)).toBe(
        EC8E2AD.body["claude-sonnet-5-5"][i] ?? "",
      );
      expect(bodyHash(spec("claude-sonnet-5-5", "off"), i)).toBe(
        EC8E2AD.bodyWithoutFallbacks["claude-sonnet-5-5"][i] ?? "",
      );
    }
  });

  test("the plan's seats: claude-duo and claude-family get exactly those bodies and phase 2's labels", () => {
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
            ? EC8E2AD.bodyWithoutFallbacks["claude-sonnet-5-5"][i]
            : s.model === "claude-sonnet-5-5" ||
                s.model === "claude-opus-5-5" ||
                s.model === "claude-haiku-5-5"
              ? EC8E2AD.body[s.model][i]
              : undefined;
        expect([lineup, s.seat, bodyHash(planned, i)]).toEqual([lineup, s.seat, expected ?? ""]);
        expect(labelOf(planned, i)).toBe(
          `llm:anthropic/${s.model}/${s.effort}:${s.profile.id}@${s.profile.version}:p2`,
        );
      }
    }
    // The labels exactly as ec8e2ad wrote them.
    expect(labelOf(spec("claude-sonnet-5-5", "off"), 0)).toBe(
      "llm:anthropic/claude-sonnet-5-5/medium:odysseus@1:p2",
    );
    expect(labelOf(spec("claude-haiku-5-5", "off"), 3)).toBe(
      "llm:anthropic/claude-haiku-5-5/medium:agamemnon@1:p2",
    );
    expect(labelOf(spec("claude-opus-5-5", "default"), 1)).toBe(
      "llm:anthropic/claude-opus-5-5/medium:achilles@1:p2",
    );
  });
});
