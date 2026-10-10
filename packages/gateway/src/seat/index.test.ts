import { describe, expect, test } from "bun:test";
import * as seat from "@perfidia/gateway/seat";
import * as archive from "./archive.ts";
import * as caps from "./caps.ts";
import * as deliver from "./deliver.ts";
import * as errors from "./errors.ts";
import * as notes from "./notes.ts";
import * as state from "./state.ts";
import { P1, RULES } from "./testkit.test.ts";
import * as turn from "./turn.ts";
import * as wake from "./wake.ts";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The runtime exports of each seat module; `text.ts` stays internal. */
const SEAT_LAYOUT: readonly [object, readonly string[]][] = [
  [
    archive,
    ["entryId", "involves", "openArchive", "searchArchive", "searchArchivePage", "summarizeEvent"],
  ],
  [
    caps,
    [
      "checkCallCap",
      "checkDailyCap",
      "checkRoundTrip",
      "dailyCap",
      "dailyUsed",
      "roundCallCap",
      "seatBudget",
    ],
  ],
  [deliver, ["deliver"]],
  [errors, ["SEAT_ERROR_CODES", "seatError", "seatErrorText"]],
  [notes, ["appendedNotes", "writeNote"]],
  [
    state,
    [
      "addressedTo",
      "briefed",
      "createGatewayState",
      "dayOf",
      "initialSeatWake",
      "isSeat",
      "rollDay",
      "seatOf",
      "sortedSeats",
      "todayCounters",
      "unreadNews",
    ],
  ],
  [turn, ["closeTurn", "recordAct", "recordGw"]],
  [wake, ["createWakeScheduler", "isPublicMessage", "wakeClassOf", "wakeReasonOf"]],
];

describe("@perfidia/gateway/seat", () => {
  test("each seat module exports exactly its share of the seat API", () => {
    for (const [mod, names] of SEAT_LAYOUT) {
      expect(Object.keys(mod).toSorted(byCodeUnit)).toEqual(names.toSorted(byCodeUnit));
    }
  });

  test("the public path exposes the whole seat API, each name bound to its module's value", () => {
    const all = SEAT_LAYOUT.flatMap(([, names]) => names);
    expect(Object.keys(seat).toSorted(byCodeUnit)).toEqual(all.toSorted(byCodeUnit));
    for (const [mod, names] of SEAT_LAYOUT) {
      for (const name of names) expect(Reflect.get(seat, name)).toBe(Reflect.get(mod, name));
    }
  });

  // The deviations listed in the header of `index.ts`, as the public API shows them.

  test("the scheduler has the eight methods of §8.5, plus `rules` and `peek`", () => {
    const scheduler = seat.createWakeScheduler(seat.createGatewayState([P1]), RULES);
    expect(Object.keys(scheduler).toSorted(byCodeUnit)).toEqual(
      [
        "begin",
        "defer",
        "due",
        "eliminate",
        "end",
        "ingest",
        "nextWakeTime",
        "peek",
        "requestSelfWake",
        "rules",
      ].toSorted(byCodeUnit),
    );
    expect(scheduler.rules).toBe(RULES);
    expect(Object.isFrozen(scheduler)).toBe(true);
  });

  test("requestSelfWake and writeNote take the call time; searchArchive keeps §8.4's arity", () => {
    const scheduler = seat.createWakeScheduler(seat.createGatewayState([P1]), RULES);
    expect(scheduler.requestSelfWake.length).toBe(3); // (seat, at, now)
    expect(seat.writeNote.length).toBe(5); // (s, text, mode, max, t)
    expect(seat.searchArchive.length).toBe(3); // (gw, seat, q) -> ArchiveHit[]
    expect(seat.searchArchivePage.length).toBe(3); // (gw, seat, q) -> {hits, more}
  });

  test("the folds of §10.5 are functions of the public path", () => {
    for (const name of ["deliver", "briefed", "recordAct", "recordGw", "writeNote", "closeTurn"]) {
      expect(typeof Reflect.get(seat, name)).toBe("function");
    }
  });
});
