import { describe, expect, test } from "bun:test";
import { deliver } from "./deliver.ts";
import { addressedTo, briefed, createGatewayState, seatOf, unreadNews } from "./state.ts";
import {
  event,
  incomingAttack,
  message,
  P1,
  P2,
  P3,
  publicMessage,
  queueEmpty,
  RULES,
} from "./testkit.test.ts";
import { createWakeScheduler } from "./wake.ts";

function fresh() {
  const gw = createGatewayState([P1, P2, P3]);
  return { gw, wake: createWakeScheduler(gw, RULES) };
}

const es = (list: readonly { e: number }[]): number[] => list.map((d) => d.e);

describe("deliver", () => {
  test("fills archives, inboxes and the feed with running delivery numbers", () => {
    const { gw, wake } = fresh();
    deliver(gw, [message(100, P2, [P1], 1), publicMessage(100, P3, 2), queueEmpty(200, P1)], wake);
    expect(gw.delivered).toBe(3);
    expect(es(seatOf(gw, P1).archive)).toEqual([1, 3]);
    expect(es(seatOf(gw, P1).inbox)).toEqual([1, 3]);
    expect(es(seatOf(gw, P2).archive)).toEqual([1]);
    expect(es(seatOf(gw, P3).archive)).toEqual([2]);
    expect(es(gw.feed)).toEqual([2]);
    // one entry object shared by every list it reaches
    expect(seatOf(gw, P1).archive[0]).toBe(seatOf(gw, P2).archive[0]);
  });

  test("an event both public and addressed is archived and in the feed; news skips it for its recipients", () => {
    const { gw, wake } = fresh();
    const conquered = event(
      500,
      "city_conquered",
      [[P1, "target"]],
      { city: "c3", from: P1, to: P2 },
      true,
    );
    deliver(gw, [conquered], wake);
    expect(es(seatOf(gw, P1).archive)).toEqual([1]);
    expect(es(gw.feed)).toEqual([1]);
    expect(addressedTo(gw.feed[0]!, P1)).toBe(true);
    expect(unreadNews(gw, P1)).toEqual([]);
    expect(es(unreadNews(gw, P2))).toEqual([1]);
  });

  test("stores copies: later changes to the source or the stored event do not leak across", () => {
    const { gw, wake } = fresh();
    const source = message(100, P2, [P1], 1, "original");
    deliver(gw, [source], wake);
    source.data.text = "changed";
    source.to.push({ p: P3, as: "target" });
    const stored = seatOf(gw, P1).archive[0]!.event;
    expect(stored.data.text).toBe("original");
    expect(stored.to.map((r) => r.p)).toEqual([P2, P1]);
    stored.data.text = "tampered";
    expect(source.data.text).toBe("changed");
  });

  test("an unknown recipient throws before anything changes", () => {
    const { gw, wake } = fresh();
    deliver(gw, [message(100, P2, [P1], 1)], wake);
    const before = JSON.stringify(gw);
    expect(() => deliver(gw, [message(200, P2, [P1, "p9"], 2)], wake)).toThrow(/unknown seat p9/);
    expect(JSON.stringify(gw)).toBe(before);
  });

  test("player_eliminated eliminates its player's seat", () => {
    const { gw, wake } = fresh();
    deliver(gw, [event(900, "player_eliminated", [[P2, "self"]], { player: P2 }, true)], wake);
    expect(seatOf(gw, P2).alive).toBe(false);
    expect(seatOf(gw, P1).alive).toBe(true);
    expect(es(seatOf(gw, P2).archive)).toEqual([1]);
    deliver(gw, [incomingAttack(1000, P2, P1, 1)], wake);
    expect(seatOf(gw, P2).wake.urgentAt).toBeNull();
    expect(es(seatOf(gw, P2).archive)).toEqual([1, 2]);
  });

  test("triggers are ingested per recipient role", () => {
    const { gw, wake } = fresh();
    for (const p of [P1, P2, P3]) {
      wake.begin(p, 0);
      wake.end(p, 0);
    }
    deliver(gw, [message(100, P2, [P1, P3], 1)], wake);
    expect(seatOf(gw, P1).wake.socialFirst).toBe(100);
    expect(seatOf(gw, P3).wake.socialFirst).toBe(100);
    expect(seatOf(gw, P2).wake.socialFirst).toBeNull(); // the sender, as self: no wake entry
    deliver(gw, [incomingAttack(200, P1, P2, 1)], wake);
    expect(seatOf(gw, P1).wake.urgentAt).toBe(200);
    expect(seatOf(gw, P1).wake.urgentReasons).toEqual(["incoming_attack m00001"]);
  });
});

describe("briefing cursor", () => {
  test("briefed empties the inbox; news is the feed after the last briefing, same-second events included", () => {
    const { gw, wake } = fresh();
    deliver(gw, [publicMessage(100, P3, 1), message(150, P2, [P1], 2)], wake);
    expect(es(unreadNews(gw, P1))).toEqual([1]);
    briefed(gw, P1, 5000);
    expect(seatOf(gw, P1).inbox).toEqual([]);
    expect(seatOf(gw, P1).lastBriefingAt).toBe(5000);
    expect(seatOf(gw, P1).lastBriefingE).toBe(2);
    expect(unreadNews(gw, P1)).toEqual([]);
    // another seat acts in the same second, after the briefing: still news for P1
    deliver(gw, [publicMessage(5000, P2, 3)], wake);
    expect(es(unreadNews(gw, P1))).toEqual([3]);
    expect(es(unreadNews(gw, P2))).toEqual([1]);
  });
});
