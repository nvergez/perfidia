// The war-call protocol end to end (docs/architecture.md §11.2, `bots/src/war.ts`): the caller
// (conqueror@3) and the responders (opportunist@3, turtle@3), each written on its own side, on real
// seeded perfidia-1 matches through the gateway, every seat a registered bot. The matches are cut
// on day 5, once the calls below have been served, to keep the test fast.
//
// - Seed 6: p4 (conqueror@3) calls its ally p2 (opportunist@3) to strike a capital-or-strong city
//   before its own founders land; p2 answers yes with a landing inside the window, its attack leaves
//   after the answer and lands inside the window, and the battles of both make a joint attack with
//   p4 as its caller (`teamRecords`). p1 (conqueror@3) asks p3 (turtle@3) to hold a siege, and p3
//   answers in the same tagged form.
// - Seed 14: p4 (conqueror@3) asks p3 (turtle@3) to hold the city its siege is taking (`siege`);
//   p3 answers yes, and once the city is p4's its defenders land there inside the window. The same
//   seed gives the same log.

import { describe, expect, test } from "bun:test";
import { parseWar, WAR_LIMITS, type WarAck, type WarCall } from "@perfidia/bots";
import type { ActLine, EvLine, LogLine, PlayerId } from "@perfidia/protocol";
import { teamRecords } from "./batch/index.ts";
import { normalisedHash, runBots, type BotChoice, type BotRunSpec } from "./harness/index.ts";

const DAY = 86400;
const LINEUP: readonly BotChoice[] = [
  "conqueror@3",
  "opportunist@3",
  "turtle@3",
  "conqueror@3",
  "expander@2",
  "rusher@3",
];

const spec = (seed: number, end: number): BotRunSpec => ({
  ruleset: "perfidia-1@1.0.0",
  seed,
  players: 6,
  overrides: { "time.matchEnd": end },
  bots: LINEUP,
  clock: { kind: "lockstep" },
  strict: true,
});

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const events = (lines: readonly LogLine[], type: string): EvLine[] =>
  lines.filter((l): l is EvLine => l.k === "ev" && l.e.type === type);

/** Every war message sent: its sender, recipients, time and text. */
function warMessages(lines: readonly LogLine[]): ActLine[] {
  return lines.filter(
    (l): l is ActLine =>
      l.k === "act" && l.r.ok && l.a.type === "send_message" && l.a.text.includes("WAR#"),
  );
}

const textOf = (l: ActLine): string => (l.a.type === "send_message" ? l.a.text : "");
const toOf = (l: ActLine): readonly PlayerId[] =>
  l.a.type === "send_message" && l.a.to !== "all" ? l.a.to : [];

/** The calls `seat` sent, with their recipients and time. */
function callsOf(
  lines: readonly LogLine[],
  seat: PlayerId,
): { t: number; to: readonly PlayerId[]; call: WarCall }[] {
  return warMessages(lines)
    .filter((l) => l.seat === seat)
    .flatMap((l) =>
      parseWar(textOf(l)).flatMap((i) =>
        i.kind === "call" ? [{ t: l.t, to: toOf(l), call: i.call }] : [],
      ),
    );
}

/** The answers `seat` sent to `caller` about call `id`, in order. */
function answersTo(
  lines: readonly LogLine[],
  seat: PlayerId,
  caller: PlayerId,
  id: string,
): { t: number; ack: WarAck }[] {
  return warMessages(lines)
    .filter((l) => l.seat === seat && toOf(l).includes(caller))
    .flatMap((l) =>
      parseWar(textOf(l)).flatMap((i) =>
        i.kind === "ack" && i.ack.id === id ? [{ t: l.t, ack: i.ack }] : [],
      ),
    );
}

/** Movements `by` launched to `city` (`incoming_attack` or `incoming_support`), with their times. */
function launches(
  lines: readonly LogLine[],
  kind: "incoming_attack" | "incoming_support",
  by: PlayerId,
  city: string,
): { departAt: number; arriveAt: number }[] {
  return events(lines, kind)
    .filter(
      (l) => l.e.data["by"] === by && l.e.data["to"] === city && l.e.data["homecoming"] !== true,
    )
    .map((l) => ({
      departAt: Number(l.e.data["departAt"]),
      arriveAt: Number(l.e.data["arriveAt"]),
    }));
}

function controllers(lines: readonly LogLine[]): Readonly<Record<string, string>> {
  const header = lines.find((l) => l.k === "header");
  return header?.k === "header" ? header.controllers : {};
}

describe("war calls between conqueror@3 and the responders (perfidia-1, 6 seats, real matches)", () => {
  test("seed 6: conqueror@3 calls a strike, opportunist@3 answers yes, launches and lands in the window: a joint attack", async () => {
    const { lines } = await runBots(spec(6, 4 * DAY + 12 * 3600));
    expect(lines.at(-1)?.k).toBe("end");
    expect(controllers(lines)).toMatchObject({
      p1: "bot:conqueror@3",
      p2: "bot:opportunist@3",
      p3: "bot:turtle@3",
      p4: "bot:conqueror@3",
    });
    // Every war message is short plain text that parses (a briefing never cuts it).
    for (const l of warMessages(lines)) {
      expect(textOf(l).length).toBeLessThanOrEqual(WAR_LIMITS.text);
      expect(parseWar(textOf(l)).length).toBeGreaterThan(0);
    }

    const strikes = callsOf(lines, "p4").filter(
      (c) => c.call.role === "strike" && c.to.includes("p2"),
    );
    expect(strikes.length).toBeGreaterThan(0);
    const { t: calledAt, call } = strikes[0]!;
    expect(call.vs).not.toBeNull();
    expect(call.lands).not.toBeNull();
    // The caller leaves its allies time to hear the call and to land before its own founders.
    expect(call.t1).toBeLessThanOrEqual(call.lands!);

    const answers = answersTo(lines, "p2", "p4", call.id);
    expect(answers.map((a) => a.ack.yes)).toEqual([true]);
    const promised = answers[0]!.ack.lands;
    expect(promised).not.toBeNull();
    expect(promised!).toBeGreaterThanOrEqual(call.t0);
    expect(promised!).toBeLessThanOrEqual(call.t1);

    // p2's strike leaves after its answer and lands inside the window.
    const sent = launches(lines, "incoming_attack", "p2", call.target).filter(
      (m) => m.departAt >= answers[0]!.t,
    );
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) {
      expect(m.arriveAt).toBeGreaterThanOrEqual(call.t0);
      expect(m.arriveAt).toBeLessThanOrEqual(call.t1);
    }
    // p4's own waves left after its call.
    expect(
      launches(lines, "incoming_attack", "p4", call.target).some((m) => m.departAt > calledAt),
    ).toBe(true);

    // The battles of both at the target: a joint attack after p4's call.
    const joint = teamRecords(lines, null).joint.filter((j) => j.city === call.target);
    expect(joint.map((j) => [j.players, j.caller])).toContainEqual([["p2", "p4"], "p4"]);

    // turtle@3 answers its ally's siege call in the same tagged form.
    const siege = callsOf(lines, "p1").filter(
      (c) => c.call.role === "siege" && c.to.includes("p3"),
    );
    expect(siege.length).toBeGreaterThan(0);
    expect(answersTo(lines, "p3", "p1", siege[0]!.call.id).length).toBe(1);
  }, 60_000);

  test("seed 14: conqueror@3 asks turtle@3 to hold its siege's city; turtle@3 answers yes and its defenders land there in the window; the same seed gives the same log", async () => {
    const run = spec(14, 4 * DAY + 16 * 3600);
    const { lines } = await runBots(run);
    expect(lines.at(-1)?.k).toBe("end");

    const sieges = callsOf(lines, "p4").filter(
      (c) => c.call.role === "siege" && c.to.includes("p3"),
    );
    const served = sieges.filter((c) =>
      answersTo(lines, "p3", "p4", c.call.id).some((a) => a.ack.yes),
    );
    expect(served.length).toBeGreaterThan(0);
    const { call } = served[0]!;
    // The call names a city p4 besieges, and p4 takes it before the window.
    const started = events(lines, "siege_started").filter(
      (l) => l.e.data["by"] === "p4" && l.e.data["city"] === call.target,
    );
    expect(started.length).toBeGreaterThan(0);
    const taken = events(lines, "city_conquered").filter(
      (l) => l.e.data["to"] === "p4" && str(l.e.data["city"]) === call.target,
    );
    expect(taken.length).toBe(1);
    expect(taken[0]!.t).toBeLessThan(call.t0);

    // turtle@3's supports leave once the city is p4's and land inside the window.
    const yes = answersTo(lines, "p3", "p4", call.id).find((a) => a.ack.yes)!;
    const sent = launches(lines, "incoming_support", "p3", call.target).filter(
      (m) => m.departAt >= yes.t,
    );
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) {
      expect(m.departAt).toBeGreaterThanOrEqual(taken[0]!.t);
      expect(m.arriveAt).toBeGreaterThanOrEqual(call.t0);
      expect(m.arriveAt).toBeLessThanOrEqual(call.t1);
    }
    const arrived = new Set(
      events(lines, "support_arrived")
        .filter((l) => l.e.data["by"] === "p3" && l.e.data["to"] === call.target)
        .map((l) => l.t),
    );
    for (const m of sent) expect(arrived.has(m.arriveAt)).toBe(true);

    const again = await runBots(run);
    expect(normalisedHash(again.lines)).toBe(normalisedHash(lines));
  }, 60_000);
});
