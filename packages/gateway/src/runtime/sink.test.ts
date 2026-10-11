// Log sinks (docs/architecture.md §8.7, §10.1, §6.6): serialised at write, canonical, one per line.

import { describe, expect, test } from "bun:test";
import type { LogLine } from "@perfidia/protocol";
import { MemorySink, teeSink } from "./index.ts";

describe("MemorySink", () => {
  test("serialises at write: mutating a written line changes nothing it holds", () => {
    const sink = new MemorySink();
    const line: LogLine = { k: "defer", t: 5, seat: "p2", to: 6 };
    sink.write(line);
    line.to = 99;
    expect(sink.lines).toEqual(['{"k":"defer","seat":"p2","t":5,"to":6}']);
    expect(sink.text()).toBe('{"k":"defer","seat":"p2","t":5,"to":6}\n');
    const parsed = sink.parsed();
    expect(parsed).toEqual([{ k: "defer", t: 5, seat: "p2", to: 6 }]);
    parsed.length = 0;
    expect(sink.parsed()).toHaveLength(1);
  });

  test("rejects a line that is not canonical JSON, and parsed() validates the log schema", () => {
    const sink = new MemorySink();
    expect(() => sink.write({ k: "defer", t: 1.5, seat: "p2", to: 6 })).toThrow();
    sink.lines.push('{"k":"nothing"}');
    expect(() => sink.parsed()).toThrow();
  });

  test("teeSink writes to every sink in order", () => {
    const a = new MemorySink();
    const b = new MemorySink();
    const tee = teeSink(a, b);
    tee.write({ k: "batch", t: 0, b: 0, order: ["p1"] });
    tee.flush?.();
    expect(a.text()).toBe(b.text());
    expect(a.lines).toHaveLength(1);
  });
});
