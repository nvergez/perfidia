import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCallLog, MemoryCallLog, writePrompts } from "./calls.ts";
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
