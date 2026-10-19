import { describe, expect, test } from "bun:test";
import { createLoader } from "./loader.ts";

// The on-demand loader behind `common/lazy.tsx` (docs/phase3.md §16): one import at a time, a
// stable state object, a failure as a state, loading again after one (the browser may answer from
// its module map: `LazyProblem` offers a page load), and a preload whose failure stays quiet.

describe("createLoader", () => {
  test("idle, then loading, then ready; one import while it loads", async () => {
    const d = Promise.withResolvers<string>();
    let calls = 0;
    const l = createLoader(() => {
      calls += 1;
      return d.promise;
    });
    expect(l.state().status).toBe("idle");
    const seen: string[] = [];
    const off = l.subscribe(() => seen.push(l.state().status));
    const a = l.load();
    const b = l.load();
    expect(calls).toBe(1);
    expect(l.state().status).toBe("loading");
    d.resolve("chunk");
    expect(await a).toEqual({ status: "ready", value: "chunk" });
    expect(await b).toBe(l.state());
    expect(seen).toEqual(["loading", "ready"]);
    const s = l.state();
    await l.load();
    expect(calls).toBe(1);
    expect(l.state()).toBe(s);
    off();
  });

  test("a failure is a state, never a rejection; load again retries the import", async () => {
    let calls = 0;
    const l = createLoader(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("chunk gone")) : Promise.resolve(42);
    });
    const failed = await l.load();
    expect(failed.status).toBe("failed");
    expect(l.state()).toBe(failed);
    const ready = await l.load();
    expect(ready).toEqual({ status: "ready", value: 42 });
    expect(calls).toBe(2);
  });

  test("a failed preload leaves the state idle; a load then fails visibly", async () => {
    let calls = 0;
    const gone = Promise.withResolvers<number>();
    const l = createLoader(() => {
      calls += 1;
      return calls === 1 ? gone.promise : Promise.reject(new Error("chunk gone"));
    });
    l.preload();
    l.preload();
    expect([calls, l.state().status]).toEqual([1, "loading"]);
    gone.reject(new Error("offline"));
    await Bun.sleep(0);
    expect(l.state().status).toBe("idle");
    expect((await l.load()).status).toBe("failed");
    // A failure the viewer sees is not hidden by a later preload.
    l.preload();
    expect([calls, l.state().status]).toEqual([2, "failed"]);
  });

  test("a load asked for while a preload runs makes its failure visible", async () => {
    const gone = Promise.withResolvers<number>();
    const l = createLoader(() => gone.promise);
    l.preload();
    const asked = l.load();
    gone.reject(new Error("offline"));
    expect((await asked).status).toBe("failed");
  });

  test("an importer that throws synchronously fails the same way", async () => {
    const l = createLoader<number>(() => {
      throw new Error("no");
    });
    expect((await l.load()).status).toBe("failed");
  });

  test("unsubscribed listeners hear nothing more", async () => {
    const l = createLoader(() => Promise.resolve(1));
    let n = 0;
    const off = l.subscribe(() => {
      n += 1;
    });
    off();
    await l.load();
    expect(n).toBe(0);
  });
});
