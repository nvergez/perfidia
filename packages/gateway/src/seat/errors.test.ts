import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  GwLineSchema,
  ToolErrorSchema,
  type GatewayRules,
  type ToolError,
} from "@perfidia/protocol";
import { checkCallCap, checkDailyCap, checkRoundTrip } from "./caps.ts";
import { seatError, seatErrorText } from "./errors.ts";
import { writeNote } from "./notes.ts";
import { createGatewayState, seatOf } from "./state.ts";
import { P1, RULES } from "./testkit.test.ts";

/** The `gw` line of a rejection, read back from JSON as the rebuild sees it. */
function viaGwLine(err: ToolError) {
  const line = GwLineSchema.parse(
    JSON.parse(
      JSON.stringify({
        k: "gw",
        n: 1,
        t: err.t,
        seat: P1,
        turn: 1,
        rt: 0,
        tool: "x",
        r: { ok: false, code: err.code, details: err.details },
      }),
    ),
  );
  return seatErrorText(line.r.code, line.r.details, line.t);
}

describe("seat errors are worded from the details a gw line keeps", () => {
  test("every cap and note error regenerates its message and hint from its logged details", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 * 86400 }),
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 6000 }),
        fc.constantFrom<"append" | "replace">("append", "replace"),
        (t, cap, perRound, used, size, mode) => {
          const rules: GatewayRules = {
            ...RULES,
            attackLaunchesPerDay: cap,
            messagesPerDay: cap,
            toolCallsPerRoundTrip: perRound,
            toolCallsPerWake: cap,
            roundTripsPerWake: cap,
          };
          const s = seatOf(createGatewayState([P1]), P1);
          s.day = {
            index: Math.floor(t / 86400),
            ownWakes: 0,
            socialWakes: 0,
            attacks: used,
            messages: used,
          };
          s.notes = "n".repeat(size % 4000);
          const errors = [
            checkDailyCap(s, rules, "attacks", t),
            checkDailyCap(s, rules, "messages", t),
            checkCallCap(rules, { round: used % (perRound + 2), wake: used }, t),
            checkRoundTrip(rules, used % (cap + 2), t),
            writeNote(s, "x".repeat(size), mode, RULES.notesMaxChars, t),
          ];
          for (const err of errors) {
            if (err === null || err.ok) continue;
            expect(ToolErrorSchema.parse(err)).toEqual(err);
            expect(viaGwLine(err)).toEqual({ message: err.message, hint: err.hint });
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  test("other codes and malformed details have no seat wording", () => {
    expect(seatErrorText("UNKNOWN_ID", { id: "c9" }, 0)).toBeNull();
    expect(seatErrorText("DAILY_CAP", undefined, 0)).toBeNull();
    expect(
      seatErrorText("DAILY_CAP", { kind: "spies", cap: 1, used: 1, availableAt: 86400 }, 0),
    ).toBeNull();
    expect(
      seatErrorText("DAILY_CAP", { kind: "attacks", cap: 1, used: 1, availableAt: 86400 }, 90000),
    ).toBeNull();
    expect(seatErrorText("CALLS_CAP", { scope: "turn", cap: 1, used: 1 }, 0)).toBeNull();
    expect(
      seatErrorText("NOTE_TOO_LONG", { chars: 5, max: 4, over: 1, notes: 0, mode: "insert" }, 0),
    ).toBeNull();
    expect(seatErrorText("ROUND_TRIP_CAP", { cap: "8", round: 9 }, 0)).toBeNull();
    expect(seatErrorText("constructor", {}, 0)).toBeNull();
    expect(() => seatError("CALLS_CAP", {}, 0)).toThrow(/malformed details/);
  });
});
