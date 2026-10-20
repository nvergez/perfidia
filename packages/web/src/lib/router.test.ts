import { describe, expect, test } from "bun:test";
import { matchHref, modelHref, parsePair, parseRoute, parseTurnRef, routeHref } from "./router.ts";

describe("the router", () => {
  test("parses the list, a match with its query, and unknown paths", () => {
    expect(parseRoute("/", "")).toEqual({ page: "list" });
    expect(parseRoute("/m/war", "?pair=p2,p3&reel=1")).toEqual({
      page: "match",
      id: "war",
      pair: ["p2", "p3"],
      reel: true,
      start: false,
      turn: null,
    });
    expect(parseRoute("/m/perfidia-1%401.1.0-s1", "?start=1")).toMatchObject({
      page: "match",
      id: "perfidia-1@1.1.0-s1",
      start: true,
    });
    expect(parseRoute("/m/..%2fx", "").page).toBe("not-found");
    expect(parseRoute("/nope", "").page).toBe("not-found");
    expect(parseRoute("/m/%E0%A4%A", "").page).toBe("not-found");
  });

  test("a pair is two distinct player ids", () => {
    expect(parsePair("p1,p2")).toEqual(["p1", "p2"]);
    for (const bad of ["p1", "p1,p1", "p0,p2", "x1,p2", "p1,p2,p3", ""])
      expect(parsePair(bad)).toBeNull();
    expect(parsePair(null)).toBeNull();
  });

  test("hrefs round-trip", () => {
    const href = matchHref("perfidia-1@1.1.0", { pair: ["p2", "p3"], reel: true });
    expect(href).toBe("/m/perfidia-1%401.1.0?pair=p2,p3&reel=1");
    const [path, search] = href.split("?");
    expect(routeHref(parseRoute(path ?? "", `?${search ?? ""}`))).toBe(href);
    expect(routeHref({ page: "list" })).toBe("/");
    const turn = matchHref("war", { start: true, turn: { seat: "p2", turn: 48 } });
    expect(turn).toBe("/m/war?start=1&turn=p2.48");
    expect(parseRoute("/m/war", "?start=1&turn=p2.48")).toMatchObject({
      start: true,
      turn: { seat: "p2", turn: 48 },
    });
  });

  test("a turn is a player id and a turn number", () => {
    expect(parseTurnRef("p2.48")).toEqual({ seat: "p2", turn: 48 });
    expect(parseTurnRef("p12.1")).toEqual({ seat: "p12", turn: 1 });
    expect(parseTurnRef("p12.0")).toBeNull();
    expect(parseTurnRef("p12.007")).toBeNull();
    for (const bad of ["p2", "p0.4", "p2.-1", "p2.4.5", "x2.4", "p2.12345678", "p2.4 ", ""])
      expect(parseTurnRef(bad)).toBeNull();
    expect(parseTurnRef(null)).toBeNull();
  });

  test("the model statistics and one model's: ids as the protocol's ModelIdSchema", () => {
    expect(parseRoute("/models", "")).toEqual({ page: "models" });
    expect(parseRoute("/models/", "")).toEqual({ page: "models" });
    expect(parseRoute("/models/anthropic.claude-haiku-5-5.medium", "")).toEqual({
      page: "model",
      id: "anthropic.claude-haiku-5-5.medium",
    });
    expect(parseRoute("/models/bot.conqueror.3/", "")).toEqual({
      page: "model",
      id: "bot.conqueror.3",
    });
    for (const bad of [
      "/models/Upper",
      "/models/a_b",
      "/models/..%2fx",
      "/models/a/b",
      "/models/%E0%A4%A",
    ]) {
      expect([bad, parseRoute(bad, "").page]).toEqual([bad, "not-found"]);
    }
    const id = "fake.z-ai-glm-5-3-flash.z-ai-fp8.low";
    expect(modelHref(id)).toBe(`/models/${id}`);
    expect(routeHref(parseRoute(modelHref(id), ""))).toBe(modelHref(id));
    expect(routeHref({ page: "models" })).toBe("/models");
  });
});
