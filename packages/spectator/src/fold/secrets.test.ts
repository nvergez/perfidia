// No secret reaches a spectator (phase-3 design §2.6, §6.1): whatever the match's seed and id key,
// nothing the fold serves (steps, keyframes, moments, frames, the map, verification, reports, notes)
// carries the header's `idKey`, the id key derived from its seed, a key named `seed` or `idKey`, a
// `wall*` key but `wallStart`, or a transcript path. Property-tested on short matches played by
// scripted agents with random seeds and id keys; `expectNoSecrets` is shared with the golden and
// fake-run tests (`testkit.test.ts`).

import { describe, expect, test } from "bun:test";
import { findRuleset } from "@perfidia/engine";
import { MemorySink, runMatch } from "@perfidia/gateway/runtime";
import type { LogLine, PlayerId, RoundInput, RoundOutput, SeatAgent } from "@perfidia/protocol";
import fc from "fast-check";
import { expectNoSecrets } from "../testkit.test.ts";
import { foldLog } from "./fold.ts";

/** Sends a message (to everyone, then to its neighbour) and builds, then ends its turn. */
class Talker implements SeatAgent {
  readonly label = "test:talker";
  private readonly seat: PlayerId;
  private readonly players: number;
  private readonly word: string;

  constructor(seat: PlayerId, players: number, word: string) {
    this.seat = seat;
    this.players = players;
    this.word = word;
  }

  round(input: RoundInput): Promise<RoundOutput> {
    if (input.round > 0) return Promise.resolve({ calls: [] });
    const me = Number(this.seat.slice(1));
    const next = `p${(me % this.players) + 1}`;
    const city = input.briefing.cities[0]?.id ?? "c1";
    return Promise.resolve({
      calls: [
        {
          tool: "send_message",
          args: {
            to: input.turn % 2 === 0 ? "all" : [next],
            text: `${this.word} turn ${input.turn}`,
          },
        },
        { tool: "build", args: { city, buildings: ["warehouse"] } },
        { tool: "end_turn", args: { nextWakeIn: 3600 } },
      ],
      thought: `${this.word} thinking about ${next}`,
    });
  }
}

const TWO: readonly PlayerId[] = ["p1", "p2"];

async function play(seed: number, idKey: string, word: string): Promise<LogLine[]> {
  const ruleset = findRuleset("perfidia-1@1.1.0");
  if (ruleset === undefined) throw new Error("no perfidia-1@1.1.0");
  const n = 6;
  const seats = Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}` as const }));
  const sink = new MemorySink();
  await runMatch({
    setup: { ruleset: ruleset.ref, overrides: { "time.matchEnd": 6 * 3600 }, seed, idKey, seats },
    ruleset,
    agents: new Map(seats.map((s) => [s.id, new Talker(s.id, n, word)])),
    clock: { kind: "lockstep" },
    sink,
    invariants: "off",
  });
  return sink.parsed();
}

describe("no secret in anything the fold serves", () => {
  test("random seeds, id keys and player text", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.stringMatching(/^[0-9a-f]{32}$/),
        fc.stringMatching(/^[a-z]{3,8}$/),
        async (seed, idKey, word) => {
          const lines = await play(seed, idKey, word);
          const fold = foldLog(lines, { match: "secret" });
          expect(fold.status).toBe("ended");
          expect(fold.verified().ok).toBe(true);
          const items = fold.steps.flatMap((s) => s.items ?? []);
          // The players' words reach the feed (so the check looks at real text).
          expect(items.some((i) => i.k === "message" && i.text.startsWith(word))).toBe(true);
          expect(items.some((i) => i.k === "turn" && i.thought?.startsWith(word) === true)).toBe(
            true,
          );
          expectNoSecrets(
            {
              steps: fold.steps,
              keyframes: fold.keyframes,
              moments: fold.moments,
              frame: fold.frame(),
              map: fold.map(),
              verified: fold.verified(),
              notes: TWO.map((p) => fold.notes(p)),
            },
            { idKey, seed },
          );
        },
      ),
      { numRuns: 4 },
    );
  }, 120_000);
});
