import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatResult } from "../model/adapter.ts";
import { FileCallLog, MemoryCallLog, cutParts, replyLine, writePrompts } from "./calls.ts";
import type { LlmCallLine } from "./schema.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "perfidia-orch-"));
  dirs.push(d);
  return d;
};

const line: LlmCallLine = {
  k: "llm_call",
  seat: "p3",
  turn: 12,
  round: 2,
  attempt: 1,
  kind: "round",
  t: 223320,
  wallStart: "2026-10-20T14:02:11.120Z",
  latencyMs: 23140,
  ttftMs: 4210,
  provider: "anthropic",
  model: "claude-opus-5-5",
  servedBy: "claude-opus-5-5",
  effort: "medium",
  maxTokens: 16000,
  stop: "tool_use",
  rawStop: "tool_use",
  refusal: null,
  fallback: false,
  cacheMiss: false,
  usage: [
    {
      model: "claude-opus-5-5",
      kind: "message",
      input: 412,
      cacheWrite5m: 2930,
      cacheWrite1h: 0,
      cacheRead: 14820,
      output: 1510,
      estimated: false,
    },
  ],
  costNanoUsd: 49462000,
  seatSpentNanoUsd: 3120000000,
  capNanoUsd: 100000000000,
  wakeSpentNanoUsd: 131000000,
  unpriced: [],
  calls: 3,
  textChars: 96,
  reasoningChars: 840,
  requestId: "req_1",
  error: null,
};

/** A reply that arrived with this stop reason. */
const res = (stop: ChatResult["stop"]): ChatResult => ({
  reply: {
    native: [],
    text: ["Hold the line."],
    calls: [{ callId: "c1", name: "build", args: { city: "c1", buildings: ["wall"] } }],
    reasoning: ["Thinking about walls.", "x".repeat(25_000)],
  },
  stop,
  rawStop: stop,
  refusal: null,
  servedBy: "claude-opus-5-5",
  fallback: false,
  usage: [],
  requestId: "req_secret",
  latencyMs: 1,
  ttftMs: null,
  raw: null,
});

describe("call logs", () => {
  test("the file log appends validated lines and per-turn transcripts", () => {
    const dir = tmp();
    const log = new FileCallLog(dir, { transcripts: true });
    log.write(line);
    log.write({
      k: "handoff",
      seat: "p3",
      t: 389100,
      reason: "cap",
      label: "bot:turtle@3",
      spentNanoUsd: 100012000000,
      capNanoUsd: 100000000000,
    });
    log.transcript({
      k: "response",
      seat: "p3",
      turn: 12,
      round: 2,
      attempt: 1,
      raw: { id: "msg" },
    });
    const lines = readFileSync(join(dir, "llm_calls.jsonl"), "utf8").trim().split("\n");
    const kinds = lines.map((l): unknown => {
      const v: unknown = JSON.parse(l);
      if (v === null || typeof v !== "object") return null;
      const k: unknown = Reflect.get(v, "k");
      return k;
    });
    expect(kinds).toEqual(["llm_call", "handoff"]);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual(line);
    expect(readdirSync(join(dir, "transcripts", "p3"))).toEqual(["t12.jsonl"]);
    // --transcripts off
    const quiet = new FileCallLog(tmp(), { transcripts: false });
    quiet.transcript({ k: "response", seat: "p1", turn: 1, round: 0, attempt: 1, raw: null });
  });

  test("a line that breaks its schema is refused before it is written", () => {
    const log = new MemoryCallLog();
    expect(() => log.write({ ...line, costNanoUsd: -1 })).toThrow(
      "invalid llm_call line: costNanoUsd",
    );
    expect(() => log.write({ ...line, attempt: 0 })).toThrow("invalid llm_call line: attempt");
    expect(log.lines).toHaveLength(0);
  });

  test("replies.jsonl: one validated line per kept reply, transcripts off or on", () => {
    const dir = tmp();
    const log = new FileCallLog(dir, { transcripts: false });
    const where = { seat: "p3", turn: 12, round: 2, attempt: 1, kind: "round", t: 223320 } as const;
    const kept = replyLine(where, res("tool_use"));
    if (kept === null) throw new Error("no line");
    log.reply(kept);
    for (const stop of ["refusal", "max_tokens", "pause", "other"] as const) {
      expect(replyLine(where, res(stop))).toBeNull();
    }
    const rows = readFileSync(join(dir, "replies.jsonl"), "utf8").trim().split("\n");
    expect(rows).toHaveLength(1);
    const parsed: unknown = JSON.parse(rows[0] ?? "{}");
    expect(parsed).toMatchObject({
      k: "reply",
      seat: "p3",
      turn: 12,
      round: 2,
      attempt: 1,
      stop: "tool_use",
      text: ["Hold the line."],
      calls: [{ name: "build", args: { city: "c1", buildings: ["wall"] } }],
    });
    expect(rows[0]).not.toContain("req_secret");
    expect(kept.reasoning[0]).toBe("Thinking about walls.");
    expect(kept.reasoning.join("").length).toBe(20_000);
    expect(kept.reasoning[1]?.endsWith("…")).toBe(true);
    expect(() => new MemoryCallLog().reply({ ...kept, attempt: 0 })).toThrow(
      "invalid reply line: attempt",
    );
  });

  test("cutParts keeps whole parts while they fit, cuts the next with an ellipsis, never inside a pair", () => {
    expect(cutParts(["ab", "cd"], 10)).toEqual(["ab", "cd"]);
    expect(cutParts(["abcd", "efgh"], 6)).toEqual(["abcd", "e…"]);
    expect(cutParts(["abcd", "efgh"], 4)).toEqual(["abcd"]);
    expect(cutParts(["abcd"], 3)).toEqual(["ab…"]);
    expect(cutParts(["a😀b"], 3)).toEqual(["a…"]);
    expect(cutParts([], 3)).toEqual([]);
  });

  test("prompts/ holds the exact texts", () => {
    const dir = tmp();
    writePrompts(dir, {
      shared: "SHARED",
      seats: { p1: "SEAT 1", p2: "SEAT 2" },
      operator: { turnHeader: "Turn {turn}" },
      tools: [{ name: "view_map" }],
    });
    expect(
      readdirSync(join(dir, "prompts")).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual(["operator.json", "p1.txt", "p2.txt", "shared.txt", "tools.json"]);
    expect(readFileSync(join(dir, "prompts", "p2.txt"), "utf8")).toBe("SEAT 2");
  });
});
