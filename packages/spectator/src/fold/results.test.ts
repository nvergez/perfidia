import { describe, expect, test } from "bun:test";
import type { TurnCall } from "@perfidia/protocol";
import { TOOL_NAME_MAX_CHARS } from "../clean.ts";
import { addResult } from "./fold.ts";

// A turn's results (`TurnItem.results`, docs/phase3.md §16.4): one entry per call, a batch's later
// items joined to it, rejections counted by code once each, a long or odd tool name cleaned and cut.

describe("addResult", () => {
  test("reads, actions, rejections and notes, one entry per call", () => {
    const r: TurnCall[] = [];
    addResult(r, 0, "view_map", undefined, null);
    addResult(r, 0, "attack", 0, "NOT_ENOUGH_UNITS");
    addResult(r, 1, "send_message", 0, null);
    addResult(r, 1, "propose", undefined, "INVALID_ARGS");
    addResult(r, null, "write_note", undefined, null);
    expect(r).toEqual([
      { rt: 0, tool: "view_map", items: 1, ok: 1, codes: [] },
      { rt: 0, tool: "attack", items: 1, ok: 0, codes: ["NOT_ENOUGH_UNITS"] },
      { rt: 1, tool: "send_message", items: 1, ok: 1, codes: [] },
      { rt: 1, tool: "propose", items: 1, ok: 0, codes: ["INVALID_ARGS"] },
      { rt: null, tool: "write_note", items: 1, ok: 1, codes: [] },
    ]);
  });

  test("a batch's items join its call; a new call starts at item 0", () => {
    const r: TurnCall[] = [];
    addResult(r, 2, "batch", 0, null);
    addResult(r, 2, "batch", 1, "NOT_ENOUGH_RESOURCES");
    addResult(r, 2, "batch", 2, "NOT_ENOUGH_RESOURCES");
    addResult(r, 2, "batch", 3, null);
    addResult(r, 2, "batch", 0, "INVALID_ARGS");
    expect(r).toEqual([
      { rt: 2, tool: "batch", items: 4, ok: 2, codes: ["NOT_ENOUGH_RESOURCES"] },
      { rt: 2, tool: "batch", items: 1, ok: 0, codes: ["INVALID_ARGS"] },
    ]);
  });

  test("an agent's tool name is cleaned and cut", () => {
    const r: TurnCall[] = [];
    addResult(r, 0, `x${"y".repeat(500)}`, undefined, "UNKNOWN_TOOL");
    expect(r[0]?.tool.length).toBeLessThanOrEqual(TOOL_NAME_MAX_CHARS + 1);
  });
});
