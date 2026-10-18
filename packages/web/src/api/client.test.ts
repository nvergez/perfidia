import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { frame, meta } from "../testkit.test.ts";
import { Api, ApiFailure, SchemaError } from "./client.ts";

function fakeFetch(
  routes: Record<string, { status?: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: string[] = [];
  const fn = (input: string): Promise<Response> => {
    calls.push(input);
    const r = routes[input];
    if (r === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers ?? {} }),
    );
  };
  return { fn, calls };
}

// Schema failures are reported in the console: collected here instead.
const reported: unknown[][] = [];
const consoleError = console.error;
beforeEach(() => {
  reported.length = 0;
  console.error = (...args: unknown[]) => {
    reported.push(args);
  };
});
afterEach(() => {
  console.error = consoleError;
});

describe("the REST client", () => {
  test("parses bodies with the protocol's schemas", async () => {
    const f = fakeFetch({
      "/api/matches/m1": { body: meta() },
      "/api/matches/m1/latest": { body: frame(5, 50) },
    });
    const api = new Api({ fetch: f.fn });
    expect((await api.meta("m1")).id).toBe("m1");
    expect((await api.latest("m1")).seq).toBe(5);
  });

  test("an error body becomes an ApiFailure with its code, hint and Retry-After", async () => {
    const f = fakeFetch({
      "/api/matches/m1": {
        status: 503,
        body: { ok: false, code: "LOADING", message: "folding", hint: "retry" },
        headers: { "retry-after": "2" },
      },
    });
    const err = await new Api({ fetch: f.fn }).meta("m1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err).toMatchObject({ status: 503, code: "LOADING", hint: "retry", retryAfter: 2 });
  });

  test("a body that fails its schema is dropped, reported and thrown as SchemaError", async () => {
    const f = fakeFetch({ "/api/matches/m1/latest": { body: { ...frame(), extra: 1 } } });
    const err = await new Api({ fetch: f.fn }).latest("m1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaError);
    expect(reported.length).toBeGreaterThan(0);
    const list = fakeFetch({ "/api/matches": { body: [{ id: "x" }] } });
    expect(await new Api({ fetch: list.fn }).matches().catch((e: unknown) => e)).toBeInstanceOf(
      SchemaError,
    );
  });

  test("paths and queries are encoded", async () => {
    const f = fakeFetch({});
    const api = new Api({ fetch: f.fn });
    await api
      .feed("a@b", { pair: ["p1", "p2"], kinds: ["message", "betrayal"], limit: 50 })
      .catch(() => undefined);
    await api.steps("a@b", "0123456789abcdef", -1, 2_000).catch(() => undefined);
    await api.annotation("a@b", "p3", 7).catch(() => undefined);
    expect(f.calls).toEqual([
      "/api/matches/a%40b/feed?kinds=message%2Cbetrayal&pair=p1%2Cp2&limit=50",
      "/api/matches/a%40b/t/0123456789abcdef/steps?after=-1&limit=2000",
      "/api/matches/a%40b/annotations/p3/7",
    ]);
  });
});
