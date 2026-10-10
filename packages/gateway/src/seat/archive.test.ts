import { describe, expect, test } from "bun:test";
import { ArchiveEntrySchema, ArchiveHitSchema, type ArchiveHit } from "@perfidia/protocol";
import { entryId, involves, openArchive, searchArchive, summarizeEvent } from "./archive.ts";
import { deliver } from "./deliver.ts";
import { briefed, createGatewayState, seatOf, unreadNews } from "./state.ts";
import {
  event,
  message,
  oid,
  P1,
  P2,
  P3,
  publicMessage,
  queueEmpty,
  RULES,
  viaJson,
} from "./testkit.test.ts";
import type { GatewayState } from "./types.ts";
import { createWakeScheduler } from "./wake.ts";

const R1 = oid("r", 1);

/**
 * e1 t=100 message p2 → p1         e4 t=200 city_conquered (public, p1 target)
 * e2 t=100 public message by p3    e5 t=300 message p3 → p2 (hidden from p1)
 * e3 t=200 battle_report to p1     e6 t=300 queue_empty p1
 */
function world(): GatewayState {
  const gw = createGatewayState([P1, P2, P3]);
  const wake = createWakeScheduler(gw, RULES);
  deliver(
    gw,
    [
      message(100, P2, [P1], 1, "Hello there, shall we talk?"),
      publicMessage(100, P3, 2, "Big NEWS from the east"),
      event(200, "battle_report", [[P1, "self"]], {
        report: R1,
        city: "c7",
        attacker: P1,
        defender: P3,
        kind: "city",
        winner: "attacker",
        units: { raider: 12, guard: 3 },
      }),
      event(200, "city_conquered", [[P1, "target"]], { city: "c3", from: P1, to: P2 }, true),
      message(300, P3, [P2], 3, "a secret plan"),
      queueEmpty(300, P1),
    ],
    wake,
  );
  return gw;
}

const es = (hits: readonly ArchiveHit[]): number[] => hits.map((h) => h.e);

describe("searchArchive", () => {
  test("scopes: mine (archive), public (feed), all (both, each event once), newest first by (t, e)", () => {
    const gw = world();
    expect(es(searchArchive(gw, P1, { scope: "mine" }).hits)).toEqual([6, 4, 3, 1]);
    expect(es(searchArchive(gw, P1, { scope: "public" }).hits)).toEqual([4, 2]);
    expect(es(searchArchive(gw, P1, { scope: "all" }).hits)).toEqual([6, 4, 3, 2, 1]);
    expect(es(searchArchive(gw, P1, {}).hits)).toEqual([6, 4, 3, 2, 1]);
    expect(es(searchArchive(gw, P2, {}).hits)).toEqual([5, 4, 2, 1]);
  });

  test("hits are protocol archive hits with time pairs, ids and summaries", () => {
    const gw = world();
    const hits = searchArchive(gw, P1, {}).hits;
    for (const h of hits) expect(ArchiveHitSchema.parse(h)).toEqual(h);
    expect(hits.find((h) => h.e === 3)).toEqual({
      e: 3,
      t: [200, "D1 00:03:20"],
      type: "battle_report",
      public: false,
      id: R1,
      summary: `battle_report attacker=p1 city=c7 defender=p3 kind=city report=${R1} units={guard:3,raider:12} winner=attacker`,
    });
    expect(hits.find((h) => h.e === 1)?.id).toBe(oid("g", 1));
    expect(hits.find((h) => h.e === 6)?.id).toBeNull();
  });

  test("filters: kinds, counterpart, time range", () => {
    const gw = world();
    expect(es(searchArchive(gw, P1, { kinds: ["message"] }).hits)).toEqual([2, 1]);
    expect(es(searchArchive(gw, P1, { kinds: [] }).hits)).toEqual([6, 4, 3, 2, 1]);
    expect(es(searchArchive(gw, P1, { with: P3 }).hits)).toEqual([3, 2]);
    expect(es(searchArchive(gw, P1, { with: P2 }).hits)).toEqual([4, 1]);
    expect(es(searchArchive(gw, P1, { since: 150, until: 250 }).hits)).toEqual([4, 3]);
    expect(es(searchArchive(gw, P1, { since: 300 }).hits)).toEqual([6]);
    expect(
      es(searchArchive(gw, P1, { scope: "mine", kinds: ["message"], since: 100 }).hits),
    ).toEqual([1]);
  });

  test("text: ASCII case-insensitive over the message text and the summary, nothing hidden", () => {
    const gw = world();
    expect(es(searchArchive(gw, P1, { text: "HELLO" }).hits)).toEqual([1]);
    expect(es(searchArchive(gw, P1, { text: "big news" }).hits)).toEqual([2]);
    expect(es(searchArchive(gw, P1, { text: "City_Conquered" }).hits)).toEqual([4]);
    expect(es(searchArchive(gw, P1, { text: "raider:12" }).hits)).toEqual([3]);
    expect(es(searchArchive(gw, P1, { text: "secret" }).hits)).toEqual([]);
    expect(es(searchArchive(gw, P2, { text: "SECRET" }).hits)).toEqual([5]);
    // the full text is searched, not only the part the summary quotes
    const long = createGatewayState([P1, P2]);
    deliver(
      long,
      [message(10, P2, [P1], 1, `${"x".repeat(200)} needle`)],
      createWakeScheduler(long, RULES),
    );
    expect(searchArchive(long, P1, { text: "NEEDLE" }).hits).toHaveLength(1);
    // only A-Z fold: no Unicode case mapping
    const accents = createGatewayState([P1, P2]);
    deliver(accents, [message(10, P2, [P1], 1, "ÉTÉ")], createWakeScheduler(accents, RULES));
    expect(searchArchive(accents, P1, { text: "été" }).hits).toEqual([]);
    expect(searchArchive(accents, P1, { text: "ÉTÉ" }).hits).toHaveLength(1);
  });

  test("limit (default and maximum 20) and `more`", () => {
    const gw = createGatewayState([P1, P2]);
    const wake = createWakeScheduler(gw, RULES);
    for (let i = 1; i <= 25; i += 1) deliver(gw, [publicMessage(i * 10, P2, i)], wake);
    const all = searchArchive(gw, P1, { scope: "public" });
    expect(all.hits).toHaveLength(20);
    expect(all.more).toBe(true);
    expect(all.hits[0]!.e).toBe(25);
    const five = searchArchive(gw, P1, { scope: "public", limit: 5 });
    expect(es(five.hits)).toEqual([25, 24, 23, 22, 21]);
    expect(five.more).toBe(true);
    const old = searchArchive(gw, P1, { scope: "public", until: 50 });
    expect(es(old.hits)).toEqual([5, 4, 3, 2, 1]);
    expect(old.more).toBe(false);
  });

  test("deterministic, unchanged by a JSON round trip, and never aliasing the state", () => {
    const gw = world();
    const q = { text: "c", since: 0 };
    const first = searchArchive(gw, P1, q);
    expect(searchArchive(gw, P1, q)).toEqual(first);
    const copy = viaJson(gw);
    expect(searchArchive(copy, P1, q)).toEqual(first);
    first.hits[0]!.t[0] = 999999;
    first.hits[0]!.summary = "x";
    expect(searchArchive(gw, P1, q).hits[0]).toEqual(searchArchive(copy, P1, q).hits[0]);
  });

  test("a public event truncated from the news is found by read_notes scope public", () => {
    const gw = createGatewayState([P1, P2]);
    const wake = createWakeScheduler(gw, RULES);
    briefed(gw, P1, 0);
    for (let i = 1; i <= 30; i += 1) deliver(gw, [publicMessage(1000 + i, P2, i)], wake);
    const news = unreadNews(gw, P1);
    expect(news).toHaveLength(30);
    const shown = news.slice(-8); // a briefing that keeps only the latest items
    const dropped = news[0]!;
    expect(shown.some((d) => d.e === dropped.e)).toBe(false);
    const since = seatOf(gw, P1).lastBriefingAt;
    const found = searchArchive(gw, P1, { scope: "public", since, until: dropped.event.t });
    expect(es(found.hits)).toEqual([dropped.e]);
    expect(es(searchArchive(gw, P1, { scope: "public", text: "news 1" }).hits)).toContain(
      dropped.e,
    );
  });
});

describe("openArchive", () => {
  test("opens a message or report of the seat's archive, or a public entry, in full", () => {
    const gw = world();
    const entry = openArchive(gw, P1, oid("g", 1));
    expect(entry).toEqual({
      e: 1,
      t: [100, "D1 00:01:40"],
      type: "message",
      public: false,
      id: oid("g", 1),
      data: { message: oid("g", 1), from: P2, to: [P1], text: "Hello there, shall we talk?" },
      to: [
        { p: P2, as: "self" },
        { p: P1, as: "target" },
      ],
    });
    expect(ArchiveEntrySchema.parse(entry)).toEqual(entry!);
    expect(openArchive(gw, P1, R1)?.e).toBe(3);
    expect(openArchive(gw, P1, oid("g", 2))?.e).toBe(2);
  });

  test("a hidden id reads exactly like a missing one", () => {
    const gw = world();
    expect(openArchive(gw, P1, oid("g", 3))).toBeNull();
    expect(openArchive(gw, P1, oid("g", 99))).toBeNull();
    expect(openArchive(gw, P2, oid("g", 3))?.e).toBe(5);
  });

  test("the entry is a copy", () => {
    const gw = world();
    const entry = openArchive(gw, P1, oid("g", 1))!;
    entry.data.text = "changed";
    entry.to.push({ p: P3, as: "ally" });
    expect(openArchive(gw, P1, oid("g", 1))?.data.text).toBe("Hello there, shall we talk?");
    expect(seatOf(gw, P1).archive[0]!.event.to).toHaveLength(2);
  });
});

describe("summaries and counterparts", () => {
  test("a summary is one deterministic line: keys in code-unit order, control characters removed, text cut", () => {
    const ev = event(5, "message", [[P1, "target"]], {
      text: `line one\nline two\t${"y".repeat(100)}`,
      message: oid("g", 4),
      to: [P1],
      from: P2,
    });
    const summary = summarizeEvent(ev);
    expect(summary).toBe(
      `message from=p2 message=${oid("g", 4)} to=[p1] text="line one line two ${"y".repeat(59)}..."`,
    );
    expect(summary.includes("\n")).toBe(false);
    expect(summarizeEvent({ ...ev, public: true }).startsWith("message (public) ")).toBe(true);
    const huge = event(5, "custom", [], { list: Array.from({ length: 200 }, (_, i) => i) });
    expect(summarizeEvent(huge).length).toBeLessThanOrEqual(240);
  });

  test("entryId and involves", () => {
    expect(entryId(message(0, P2, [P1], 1))).toBe(oid("g", 1));
    expect(entryId(queueEmpty(0, P1))).toBeNull();
    const ev = event(
      0,
      "alliance_formed",
      [],
      { alliance: "a1", name: "p3", members: [P1, P2] },
      true,
    );
    expect(involves(ev, P2)).toBe(true);
    expect(involves(ev, P3)).toBe(false); // a name is authored text, never a counterpart
    expect(involves(message(0, P2, [P1], 1, "p3"), P3)).toBe(false);
  });
});
