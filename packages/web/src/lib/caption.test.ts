import { describe, expect, test } from "bun:test";
import { titleParts } from "./caption.ts";

const players = new Set(["p1", "p2", "p3", "p4", "p5"]);
const names: Readonly<Record<string, string>> = { a1: "War p1", a2: "League p2", a3: "League p2" };
const parts = (t: string) =>
  titleParts(
    t,
    (id) => players.has(id),
    (id) => names[id] ?? null,
  );

describe("moment titles with names", () => {
  test("players and alliances become parts; text stays text", () => {
    expect(parts("p2 betrayed its ally p3 at c18")).toEqual([
      { k: "player", id: "p2" },
      { k: "text", text: " betrayed its ally " },
      { k: "player", id: "p3" },
      { k: "text", text: " at c18" },
    ]);
    expect(parts("Alliance a2 dissolved")).toEqual([
      { k: "text", text: "Alliance " },
      { k: "alliance", id: "a2", name: "League p2" },
      { k: "text", text: " dissolved" },
    ]);
    expect(parts("Domination countdown: a1 (p1, p4) holds 16 cities")[1]).toEqual({
      k: "alliance",
      id: "a1",
      name: "War p1",
    });
  });

  test("a quoted name is kept whole, and an alliance it follows is not named twice", () => {
    expect(parts('Alliance a3 "League p2" formed: p2, p5')).toEqual([
      { k: "text", text: "Alliance " },
      { k: "alliance", id: "a3", name: null },
      { k: "text", text: ' "League p2" formed: ' },
      { k: "player", id: "p2" },
      { k: "text", text: ", " },
      { k: "player", id: "p5" },
    ]);
  });

  test("unknown ids and look-alikes stay text", () => {
    expect(parts("p9 took c15 from pa2 at 3pm")).toEqual([
      { k: "text", text: "p9 took c15 from pa2 at 3pm" },
    ]);
    expect(parts("a9 dissolved")).toEqual([
      { k: "alliance", id: "a9", name: null },
      { k: "text", text: " dissolved" },
    ]);
  });
});
