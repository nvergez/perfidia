// The agent-declared presentation (`SeatAgent.presentation`, docs/phase2.md §12): the host builds
// each seat's briefing and answers its read calls in the presentation of the agent that opens the
// turn; the log lines are the same but for the size of `obs` results.

import { describe, expect, test } from "bun:test";
import { createMatch } from "@perfidia/engine";
import type { PlayerId, Presentation, RoundOutput, SeatAgent } from "@perfidia/protocol";
import { HostTurn, MatchHost, MemorySink } from "./index.ts";
import { PERFIDIA, call, idle, linesOf, setupOf } from "./testkit.test.ts";

const agent = (presentation?: Presentation): SeatAgent => ({
  label: "test:presented",
  ...(presentation === undefined ? {} : { presentation }),
  round: (): Promise<RoundOutput> => Promise.resolve({ calls: [] }),
});

/** p1's first turn on a fresh perfidia-1 match: its briefing and the result of a read_notes search. */
function firstTurn(presentation?: Presentation) {
  const setup = setupOf(PERFIDIA, 6);
  const match = createMatch(setup, PERFIDIA, { invariants: "step" });
  const sink = new MemorySink();
  const agents = new Map<PlayerId, SeatAgent>(
    setup.seats.map((s) => [s.id, s.id === "p1" ? agent(presentation) : idle()]),
  );
  const host = new MatchHost({
    match,
    sink,
    agents,
    clock: { kind: "lockstep", maxTurnsPerSecond: 3 },
  });
  host.start();
  const turn = host.openTurn("p1");
  if (!(turn instanceof HostTurn)) throw new Error("the host opens HostTurns");
  const briefing = turn.input().briefing;
  turn.execute({ calls: [call("read_notes", { search: {} }), call("end_turn")] });
  const results = turn.input().results;
  turn.close();
  return { briefing, results, presentation: turn.presentation, obs: linesOf(sink.parsed(), "obs") };
}

describe("the presentation an agent declares", () => {
  test("absent: presentation 1, the bots' (no building levels, the notebook in every read_notes)", () => {
    const r = firstTurn();
    expect(r.presentation).toBe(1);
    expect(r.briefing.cities[0]).not.toHaveProperty("lvl");
    expect(r.results[0]).toMatchObject({ ok: true, data: { notes: "" } });
  });

  test("2: building levels in the briefing, no notebook in a search result, a smaller obs line", () => {
    const one = firstTurn(1);
    const two = firstTurn(2);
    expect(two.presentation).toBe(2);
    const lvl = two.briefing.cities[0]?.lvl ?? {};
    expect(Object.keys(lvl).length).toBeGreaterThan(0);
    expect(Object.values(lvl).every((l) => l >= 1)).toBe(true);
    const result = two.results[0];
    if (result === undefined || !result.ok) throw new Error("read_notes failed");
    expect(result.data).not.toHaveProperty("notes");
    expect(two.obs.map((l) => [l.tool, l.args])).toEqual(one.obs.map((l) => [l.tool, l.args]));
    expect(two.obs[0]?.bytes).toBeLessThan(one.obs[0]?.bytes ?? 0);
  });
});
