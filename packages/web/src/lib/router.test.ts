import { describe, expect, test } from "bun:test";
import { matchHref, parsePair, parseRoute, routeHref } from "./router.ts";

describe("the router", () => {
  test("parses the list, a match with its query, and unknown paths", () => {
    expect(parseRoute("/", "")).toEqual({ page: "list" });
    expect(parseRoute("/m/war", "?pair=p2,p3&reel=1")).toEqual({
      page: "match",
      id: "war",
      pair: ["p2", "p3"],
      reel: true,
      start: false,
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
  });
});
