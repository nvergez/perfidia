import { describe, expect, test } from "bun:test";
import {
  StdError,
  cancelFrom,
  clearQueues,
  completeBuild,
  completeRecruit,
  enqueueBuild,
  enqueueRecruit,
  reflowQueue,
  removeQueueItems,
  setLevel,
  stockAt,
  checkStd,
} from "./index.ts";
import { SCALE, advance, batchRules, cityOf, ctxAt, res, type TestCtx } from "./fixtures.test.ts";

const seqs = (ctx: TestCtx): number[] => ctx.state.queue.map((e) => e.seq);

describe("enqueue", () => {
  test("a build item pays its projected level, chains after the previous item and has its event", () => {
    const ctx = ctxAt(100);
    const a = enqueueBuild(ctx, "c1", "woodcut");
    const b = enqueueBuild(ctx, "c1", "woodcut");
    expect(a).toMatchObject({ id: 1, level: 3, cost: res(48, 120, 72), start: 100, end: 3100 });
    expect(b).toMatchObject({ id: 2, level: 4, cost: res(68, 170, 102), start: 3100, end: 7350 });
    expect(stockAt(ctx.read(), "c1")).toEqual(res(803 - 116, 803 - 290, 803 - 174));
    expect(ctx.state.queue).toEqual([
      { at: 3100, cls: 1, seq: a.seq, kind: "build_done", ref: "c1" },
      { at: 7350, cls: 1, seq: b.seq, kind: "build_done", ref: "c1" },
    ]);
    const batch = enqueueRecruit(ctx, "c1", "pike", 2);
    expect(batch).toMatchObject({
      id: 3,
      count: 2,
      done: 0,
      unitTime: 272,
      popEach: 1,
      start: 100,
      end: 644,
    });
    expect(checkStd(ctx.read())).toEqual([]);
  });

  test("the build speed level and the queue building level are read at enqueue", () => {
    const ctx = ctxAt();
    setLevel(ctx, "c1", "center", 9);
    expect(enqueueBuild(ctx, "c1", "woodcut").end).toBe(Math.floor((1500 * 24) / 18));
    setLevel(ctx, "c1", "camp", 10);
    expect(enqueueRecruit(ctx, "c1", "pike", 1).unitTime).toBe(157);
  });

  test("a level above the maximum is refused", () => {
    const ctx = ctxAt();
    setLevel(ctx, "c1", "woodcut", 10);
    expect(() => enqueueBuild(ctx, "c1", "woodcut")).toThrow(StdError);
  });
});

describe("delivery and completion", () => {
  test("trickle: units arrive one by one; recruit_done and queue_empty at the batch end", () => {
    const ctx = ctxAt();
    enqueueRecruit(ctx, "c1", "pike", 3);
    advance(ctx, 544);
    expect(ctx.events).toEqual([]);
    expect(cityOf(ctx, "c1").units.pike).toBe(20); // lazily delivered: nothing written yet
    advance(ctx, 816);
    expect(cityOf(ctx, "c1").units.pike).toBe(23);
    expect(cityOf(ctx, "c1").recruit["camp"]).toEqual([]);
    expect(ctx.events.map((e) => [e.type, e.data])).toEqual([
      ["recruit_done", { city: "c1", item: 1, queue: "camp", unit: "pike", count: 3 }],
      ["queue_empty", { city: "c1", queue: "camp" }],
    ]);
    expect(ctx.events[0]?.to).toEqual([{ p: "p1", as: "self" }]);
    expect(checkStd(ctx.read())).toEqual([]);
  });

  test("batch: nothing arrives before the batch end, everything at it", () => {
    const ctx = ctxAt(0, batchRules());
    enqueueRecruit(ctx, "c1", "pike", 3);
    advance(ctx, 815);
    expect(cityOf(ctx, "c1").units.pike).toBe(20);
    expect(cityOf(ctx, "c1").recruit["camp"]?.[0]?.done).toBe(0);
    advance(ctx, 816);
    expect(cityOf(ctx, "c1").units.pike).toBe(23);
    expect(ctx.state.ledger.p1?.made.pike).toBe(28);
    expect(checkStd(ctx.read())).toEqual([]);
  });

  test("queue_empty only when a completion empties its queue", () => {
    const ctx = ctxAt();
    enqueueBuild(ctx, "c1", "woodcut");
    enqueueBuild(ctx, "c1", "goldpit");
    advance(ctx, 3000);
    expect(ctx.events.map((e) => e.type)).toEqual(["build_done"]);
    advance(ctx, 6000);
    expect(ctx.events.map((e) => e.type)).toEqual(["build_done", "build_done", "queue_empty"]);
    expect(ctx.events[2]?.data).toEqual({ city: "c1", queue: "build" });
    expect(cityOf(ctx, "c1").buildings).toMatchObject({ woodcut: 3, goldpit: 3 });
  });

  test("completeBuild after a breach lands one level below the projected target", () => {
    const ctx = ctxAt();
    const item = enqueueBuild(ctx, "c1", "rampart");
    expect(item.level).toBe(2);
    ctx.setNow(1000);
    setLevel(ctx, "c1", "rampart", 0);
    advance(ctx, item.end);
    expect(cityOf(ctx, "c1").buildings["rampart"]).toBe(1);
    expect(ctx.events[0]?.data).toEqual({ city: "c1", item: 1, building: "rampart", level: 1 });
  });

  test("a completion is capped at the max level and cannot run early", () => {
    const ctx = ctxAt();
    const item = enqueueBuild(ctx, "c1", "woodcut");
    expect(() => completeBuild(ctx, "c1", item.id)).toThrow(StdError);
    const batch = enqueueRecruit(ctx, "c1", "pike", 1);
    expect(() => completeRecruit(ctx, "c1", batch.id)).toThrow(StdError);
    ctx.setNow(item.end);
    setLevel(ctx, "c1", "woodcut", 10);
    completeBuild(ctx, "c1", item.id);
    expect(cityOf(ctx, "c1").buildings["woodcut"]).toBe(10);
    expect(seqs(ctx)).toEqual([batch.seq]); // the item's event went with it
  });
});

describe("cancelFrom", () => {
  test("an active build item refunds pro rata, later items in full, and their events go", () => {
    const ctx = ctxAt();
    const a = enqueueBuild(ctx, "c1", "woodcut"); // 48/120/72 over 3000 s
    enqueueBuild(ctx, "c1", "woodcut"); // 68/170/102, queued
    const keep = enqueueRecruit(ctx, "c1", "pike", 1);
    ctx.setNow(1000);
    const before = stockAt(ctx.read(), "c1");
    const credited = cancelFrom(ctx, "c1", a.id);
    expect(credited).toEqual(res(32 + 68, 80 + 170, 48 + 102));
    expect(stockAt(ctx.read(), "c1")).toEqual(
      res(before.wood + 100, before.stone + 250, before.gold + 150),
    );
    expect(cityOf(ctx, "c1").build).toEqual([]);
    expect(seqs(ctx)).toEqual([keep.seq]);
    expect(ctx.events).toEqual([]);
  });

  test("a recruit batch cancelled mid-unit keeps its completed units and refunds the rest at 100%", () => {
    const ctx = ctxAt();
    const batch = enqueueRecruit(ctx, "c1", "pike", 5); // 272 s each
    ctx.setNow(600); // units 1 and 2 done, unit 3 in training
    const credited = cancelFrom(ctx, "c1", batch.id);
    expect(credited).toEqual(res(90, 180, 90));
    expect(cityOf(ctx, "c1").units.pike).toBe(22);
    expect(cityOf(ctx, "c1").recruit["camp"]).toEqual([]);
    expect(ctx.state.queue).toEqual([]);
    expect(checkStd(ctx.read())).toEqual([]);
  });

  test("a tail cancel leaves earlier items and their end times alone", () => {
    const ctx = ctxAt();
    const a = enqueueRecruit(ctx, "c1", "pike", 2);
    const b = enqueueRecruit(ctx, "c1", "axe", 2);
    const c = enqueueRecruit(ctx, "c1", "pike", 2);
    ctx.setNow(100);
    expect(cancelFrom(ctx, "c1", b.id)).toEqual(res(160, 160, 180));
    expect(cityOf(ctx, "c1").recruit["camp"]?.map((x) => [x.id, x.end])).toEqual([[a.id, a.end]]);
    expect(seqs(ctx)).toEqual([a.seq]);
    expect(seqs(ctx)).not.toContain(c.seq);
  });

  test("the {pm} variants refund the active item at pm and queued items at queuedPm", () => {
    const ctx = ctxAt(0, batchRules());
    const a = enqueueBuild(ctx, "c1", "woodcut");
    enqueueBuild(ctx, "c1", "woodcut");
    const r1 = enqueueRecruit(ctx, "c1", "pike", 4);
    enqueueRecruit(ctx, "c1", "axe", 2);
    ctx.setNow(1000);
    expect(cancelFrom(ctx, "c1", a.id)).toEqual(res(24 + 68, 60 + 170, 36 + 102));
    expect(cancelFrom(ctx, "c1", r1.id)).toEqual(res(60 + 100, 120 + 40, 60 + 120));
    expect(cityOf(ctx, "c1").units.pike).toBe(20); // batch delivery: nothing was delivered
    expect(ctx.state.queue).toEqual([]);
  });

  test("refunds are capped by storage and the result is what was credited", () => {
    const ctx = ctxAt();
    const c2 = cityOf(ctx, "c2");
    const item = enqueueRecruit(ctx, "c2", "pike", 5); // 150/300/150 paid
    c2.stock = res(1000 * SCALE, 990 * SCALE, 0);
    expect(cancelFrom(ctx, "c2", item.id)).toEqual(res(0, 10, 150));
    expect(stockAt(ctx.read(), "c2")).toEqual(res(1000, 1000, 150));
  });

  test("an unknown item is an error", () => {
    expect(() => cancelFrom(ctxAt(), "c1", 9)).toThrow(StdError);
  });
});

describe("queue_empty is never emitted by removals", () => {
  test("cancelFrom, removeQueueItems and clearQueues empty queues silently", () => {
    const ctx = ctxAt();
    const a = enqueueBuild(ctx, "c1", "woodcut");
    cancelFrom(ctx, "c1", a.id);
    const b = enqueueRecruit(ctx, "c1", "pike", 1);
    removeQueueItems(ctx, "c1", "camp", [b.id], [1000]);
    enqueueBuild(ctx, "c1", "goldpit");
    enqueueRecruit(ctx, "c1", "axe", 1);
    clearQueues(ctx, "c1", true);
    expect(cityOf(ctx, "c1").build).toEqual([]);
    expect(cityOf(ctx, "c1").recruit).toEqual({ camp: [], dock: [] });
    expect(ctx.state.queue).toEqual([]);
    expect(ctx.events).toEqual([]);
  });
});

describe("removeQueueItems, reflowQueue, clearQueues", () => {
  test("removing a middle item leaves a gap that reflowQueue closes, rescheduling events", () => {
    const ctx = ctxAt();
    const a = enqueueRecruit(ctx, "c1", "pike", 2); // 0..544
    const b = enqueueRecruit(ctx, "c1", "pike", 2); // 544..1088
    const oldSeq = enqueueRecruit(ctx, "c1", "pike", 2).seq; // 1088..1632
    ctx.setNow(100);
    expect(removeQueueItems(ctx, "c1", "camp", [b.id], [500])).toEqual(res(30, 60, 30));
    expect(cityOf(ctx, "c1").recruit["camp"]?.map((x) => [x.start, x.end])).toEqual([
      [0, 544],
      [1088, 1632],
    ]);
    reflowQueue(ctx, "c1", "camp");
    const batches = cityOf(ctx, "c1").recruit["camp"] ?? [];
    expect(batches.map((x) => [x.start, x.end])).toEqual([
      [0, 544],
      [544, 1088],
    ]);
    expect(batches[0]?.seq).toBe(a.seq);
    expect(batches[1]?.seq).not.toBe(oldSeq);
    expect(ctx.state.queue.map((e) => [e.at, e.seq])).toEqual([
      [544, a.seq],
      [1088, batches[1]?.seq ?? -1],
    ]);
    expect(checkStd(ctx.read())).toEqual([]);
  });

  test("reflowQueue starts a head that has not started at now", () => {
    const ctx = ctxAt();
    const a = enqueueBuild(ctx, "c1", "woodcut"); // 0..3000
    enqueueBuild(ctx, "c1", "goldpit"); // 3000..6000
    ctx.setNow(500);
    removeQueueItems(ctx, "c1", "build", [a.id], [0]);
    reflowQueue(ctx, "c1", "build");
    expect(cityOf(ctx, "c1").build.map((x) => [x.start, x.end])).toEqual([[500, 3500]]);
    expect(ctx.state.queue.map((e) => e.at)).toEqual([3500]);
  });

  test("clearQueues refunds like a tail cancel from each head, or nothing", () => {
    const refunded = ctxAt();
    enqueueBuild(refunded, "c1", "woodcut");
    enqueueRecruit(refunded, "c1", "pike", 5);
    refunded.setNow(600);
    const before = stockAt(refunded.read(), "c1");
    clearQueues(refunded, "c1", true);
    expect(stockAt(refunded.read(), "c1")).toEqual(
      res(before.wood + 38 + 90, before.stone + 96 + 180, before.gold + 57 + 90),
    );
    expect(cityOf(refunded, "c1").units.pike).toBe(22);

    const kept = ctxAt();
    enqueueBuild(kept, "c1", "woodcut");
    enqueueRecruit(kept, "c1", "pike", 5);
    kept.setNow(600);
    const before2 = stockAt(kept.read(), "c1");
    clearQueues(kept, "c1", false);
    expect(stockAt(kept.read(), "c1")).toEqual(before2);
    expect(cityOf(kept, "c1").units.pike).toBe(22);
    expect(kept.state.queue).toEqual([]);
    expect(checkStd(kept.read())).toEqual([]);
  });
});
