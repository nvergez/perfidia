// `arena smoke --record` (phase-4 design §8.2): each provider's smoke, run against its wire stub on
// 127.0.0.1 (`model/wire-stubs.test.ts`), writes one sanitised `perfidia-recording/1` file per
// exchange: no key anywhere, every id renumbered consistently, the streams as their events. A
// recorded stream served again (`recordedResponse`) through the provider's real adapter gives the
// reply and the usage the stub sent: what an owner's recording pins, a contract test can replay.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, memoryIo } from "@perfidia/sim";
import type { ModelAdapter, ModelSpec } from "../model/adapter.ts";
import { AnthropicAdapter, AnthropicClient } from "../model/anthropic.ts";
import { modelTools } from "../model/tools.ts";
import {
  WIRE_KEYS,
  WIRE_PROVIDERS,
  startWireStub,
  wireEnv,
  type WireProvider,
  type WireReply,
  type WireStub,
} from "../model/wire-stubs.test.ts";
import { main as arenaMain } from "./cli.ts";
import { PROVIDERS } from "./providers.ts";
import { Sanitiser, readRecording, recordedResponse, startRecording } from "./record.ts";
import { runDir } from "./rig.test.ts";

/** `arena` as the CLI runs it, with no calibration profile unless a test passes `--profiles`. */
const main = (...[argv, io, env, o]: Parameters<typeof arenaMain>) =>
  arenaMain(argv, io, env, { profilesDir: "off", ...o });

const LONG = 60_000;

const REPLY: WireReply = {
  reasoning: ["I look before I leap."],
  text: ["Scouting first."],
  calls: [{ name: "view_city", args: { city: "c1" } }],
  stop: "natural",
  usage: { uncached: 120, cacheRead: 0, cacheWrite: 2_400, output: 260, reasoning: 90 },
};

/** The model each provider's smoke calls by default. */
const SMOKE_SPECS: Readonly<Record<WireProvider, ModelSpec>> = {
  anthropic: {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    effort: "low",
    maxOutputTokens: 4_000,
    cacheTtl: "5m",
    fallbacks: "off",
  },
  openai: {
    provider: "openai",
    model: "gpt-6-luna",
    effort: "low",
    maxOutputTokens: 4_000,
    cacheTtl: "5m",
    fallbacks: "off",
  },
  google: {
    provider: "google",
    model: "gemini-3.8-flash",
    effort: "low",
    maxOutputTokens: 4_000,
    cacheTtl: "5m",
    fallbacks: "off",
  },
  openrouter: {
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    endpoint: "z-ai/fp8",
    effort: "medium",
    maxOutputTokens: 4_000,
    cacheTtl: "5m",
    fallbacks: "off",
  },
};

let stubs: WireStub[] = [];
afterEach(() => {
  for (const s of stubs) s.stop();
  stubs = [];
});

/** The provider's real adapter on a fetch that serves one response. */
function replayAdapter(provider: WireProvider, url: string, res: () => Response): ModelAdapter {
  const fetch = () => Promise.resolve(res());
  const spec = SMOKE_SPECS[provider];
  const key = WIRE_KEYS[provider];
  if (provider === "anthropic") {
    return new AnthropicAdapter(spec, new AnthropicClient({ apiKey: key, baseURL: url, fetch }));
  }
  const create = PROVIDERS[provider].create;
  if (create === undefined) throw new Error("no factory");
  return create(spec, {
    apiKey: key,
    baseURL: url,
    time: new harness.SystemTime(),
    timeoutMs: 60_000,
    fetch,
  });
}

describe("the sanitiser", () => {
  test("keys out (raw and URL-encoded), ids renumbered consistently, streams as events", () => {
    const key = "sk-secret/with+chars";
    const s = new Sanitiser([key]);
    expect(s.text(`a ${key} b ${encodeURIComponent(key)}`)).toBe("a <key> b <key>");
    const v = s.value({
      id: "resp_1",
      output: [{ call_id: "call_9", id: "fc_1", note: `key ${key}` }],
      next: { previous_response_id: "resp_1", user: "u-42", role: "user" },
    });
    expect(v).toEqual({
      id: "<id-1>",
      output: [{ call_id: "<id-2>", id: "<id-3>", note: "key <key>" }],
      next: { previous_response_id: "<id-1>", user: "<id-4>", role: "user" },
    });
    expect(
      s.events(': PROCESSING\n\nevent: x\ndata: {"id":"call_9"}\n\ndata: [DONE]\r\n\r\n'),
    ).toEqual([
      { comment: "PROCESSING" },
      { event: "x", data: { id: "<id-2>" } },
      { data: "[DONE]" },
    ]);
  });

  test("a recording refuses a directory that already holds files", () => {
    const dir = runDir("rec");
    const r = startRecording(dir, { provider: "openai", secrets: [], now: () => 0 });
    expect(r.fetch).toBeInstanceOf(Function);
    // Nothing exchanged yet: no directory.
    expect(existsSync(dir)).toBe(false);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-post-responses.json"), "{}\n");
    expect(() => startRecording(dir, { provider: "openai", secrets: [], now: () => 0 })).toThrow(
      "already holds files",
    );
  });

  test("account identifiers in free text and under `consumer` are replaced (review C7)", () => {
    const s = new Sanitiser(["sk-k"]);
    const openai = s.value({
      error: {
        message:
          "Rate limit reached for gpt-6-luna in organization org-AbCdEf123456 on tokens per min. Project proj_ZyXw987654, request req_9f8e7d6c5b4a.",
        type: "tokens",
      },
    });
    const google = s.value({
      error: {
        code: 403,
        message:
          "Generative Language API has not been used in project 123456789012 before or it is disabled.",
        details: [
          {
            reason: "SERVICE_DISABLED",
            metadata: {
              consumer: "projects/123456789012",
              activationUrl:
                "https://console.developers.google.com/apis/api/generativelanguage.googleapis.com/overview?project=123456789012",
            },
          },
        ],
      },
    });
    const openrouter = s.text("generation gen-1760000000-AbCdEfGhIjKl failed");
    const text = JSON.stringify([openai, google, openrouter]);
    for (const leak of [
      "AbCdEf123456",
      "ZyXw987654",
      "9f8e7d6c5b4a",
      "123456789012",
      "AbCdEfGhIjKl",
    ]) {
      expect([leak, text.includes(leak)]).toEqual([leak, false]);
    }
    // The same project is the same id everywhere; the model id stays.
    expect(text).toContain("gpt-6-luna");
    const project = /project (<id-\d+>)/.exec(text)?.[1];
    expect(project).toBeDefined();
    expect(text).toContain(`overview?project=${project ?? ""}`);
    expect(text).toMatch(/"consumer":"<id-\d+>"/);
  });

  test("a smoke refused before it sends anything leaves no recording directory", async () => {
    const dir = runDir("rec-nokey");
    const io = memoryIo();
    expect(await main(["smoke", "--provider", "openai", "--record", dir], io, {})).toBe(3);
    expect(io.stderr()).toContain("Nothing was sent");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("arena smoke --record against each provider's wire stub", () => {
  for (const provider of WIRE_PROVIDERS) {
    test(
      `${provider}: every exchange recorded, sanitised, and the recorded stream replays through the adapter`,
      async () => {
        const stub = startWireStub(provider, () => REPLY);
        stubs.push(stub);
        const dir = runDir(`record-${provider}`);
        const io = memoryIo();
        const code = await main(
          ["smoke", "--provider", provider, "--record", dir],
          io,
          wireEnv([stub]),
        );
        expect([provider, code, io.stderr()]).toEqual([provider, 0, io.stderr()]);
        expect(code).toBe(0);
        const files = readdirSync(dir).toSorted((a, b) => (a < b ? -1 : 1));
        expect(io.stdout()).toContain(`recorded ${files.length} exchange(s), sanitised, in ${dir}`);
        // Every request the stub answered is in the recording, in its numbered file.
        expect(files.length).toBe(stub.hits.length);
        const texts = files.map((f) => readFileSync(join(dir, f), "utf8"));
        for (const text of texts) {
          for (const key of Object.values(WIRE_KEYS)) expect(text.includes(key)).toBe(false);
          // The stub's ids (`toolu_3_0`, `call_3_0`, `resp_3`, `gen-wire-3`, …) are renumbered.
          expect(
            text.match(/"((toolu|call|resp|msg|fc|rs)[_-]\d[\w-]*|gen-wire-\d+)"/g),
          ).toBeNull();
        }
        expect(texts.some((t) => t.includes('"<id-1>"'))).toBe(true);
        const recordings = files.map((f) => readRecording(join(dir, f)));
        expect([...new Set(recordings.map((r) => [r.provider, r.synthetic].join(" ")))]).toEqual([
          `${provider} false`,
        ]);
        // The smoke's call is the last streamed exchange; served again, it gives the stub's reply.
        const call = recordings.findLast(
          (r) => r.response.events !== undefined && r.response.events.length > 2,
        );
        if (call === undefined) throw new Error("no streamed call recorded");
        const adapter = replayAdapter(provider, stub.url, () => recordedResponse(call));
        const res = await adapter.chat({
          prompt: { shared: "s", seat: "t" },
          tools: modelTools([]),
          entries: [
            { role: "user", parts: [{ kind: "text", text: "{}" }] },
            { role: "operator", text: "Turn 1." },
          ],
          meta: { seat: "p1", turn: 1, round: 0, maxRounds: 8, maxCalls: 10, kind: "round" },
        });
        const usage = res.usage.reduce(
          (n, u) => ({
            prompt:
              n.prompt +
              u.tokens.input +
              u.tokens.cacheWrite5m +
              u.tokens.cacheWrite1h +
              u.tokens.cacheRead,
            output: n.output + u.tokens.output,
          }),
          { prompt: 0, output: 0 },
        );
        expect({
          stop: res.stop,
          calls: res.reply.calls.map((c) => ({ name: c.name, args: c.args })),
          text: res.reply.text.join(""),
          reasoning: res.reply.reasoning.join(""),
          usage,
        }).toEqual({
          stop: "tool_use",
          calls: [{ name: "view_city", args: { city: "c1" } }],
          text: "Scouting first.",
          reasoning: "I look before I leap.",
          usage: { prompt: 2_520, output: 260 },
        });
      },
      LONG,
    );
  }
});
