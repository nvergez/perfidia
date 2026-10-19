import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  arcPath,
  arrowHead,
  CITY_R,
  cityPoint,
  curveBetween,
  distance,
  indexIslands,
  islandRadius,
  markerAt,
  markerRadius,
  movementEnd,
  movementStart,
  pointAt,
  progress,
  routeBetween,
  slotOffset,
  starPath,
  subCurve,
  tangentAt,
} from "./geometry.ts";

const island = (id: string, x: number, y: number, slots: number) => ({ id, x, y, slots });

const islands = indexIslands([island("i1", 300, 300, 1), island("i2", 100, 300, 2)]);
const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

describe("islands and city slots", () => {
  test("an island's cosmetic radius is 8 + 4 per slot", () => {
    expect([islandRadius(1), islandRadius(2), islandRadius(3)]).toEqual([12, 16, 20]);
  });

  test("a one-slot island holds its city at the centre", () => {
    expect(slotOffset(1, 0)).toEqual({ x: 0, y: 0 });
    expect(cityPoint(islands, { island: "i1", slot: 0 })).toEqual({ x: 300, y: 300 });
  });

  test("two slots sit west and east, half the radius out", () => {
    expect(slotOffset(2, 0)).toEqual({ x: -8, y: 0 });
    expect(slotOffset(2, 1)).toEqual({ x: 8, y: 0 });
    expect(cityPoint(islands, { island: "i2", slot: 1 })).toEqual({ x: 108, y: 300 });
  });

  test("slots are distinct, inside the island and leave room between city markers", () => {
    for (let slots = 2; slots <= 6; slots += 1) {
      const pts = Array.from({ length: slots }, (_, i) => slotOffset(slots, i));
      for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeLessThan(islandRadius(slots));
      for (let i = 0; i < slots; i += 1) {
        for (let j = i + 1; j < slots; j += 1) {
          const [a, b] = [pts[i], pts[j]];
          if (a === undefined || b === undefined) throw new Error("missing slot");
          expect(distance(a, b)).toBeGreaterThanOrEqual(2 * CITY_R);
        }
      }
    }
    expect(slotOffset(2, 3)).toEqual(slotOffset(2, 1));
  });

  test("an unknown island gives no position", () => {
    expect(cityPoint(islands, { island: "i9", slot: 0 })).toBeNull();
  });
});

describe("routes and interpolation", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };

  test("a route bends to the right of the direction of travel, so two directions differ", () => {
    // Drawn with y pointing down, the right of an eastward trip is south (y > 0).
    expect(curveBetween(a, b).c.y).toBeGreaterThan(0);
    expect(curveBetween(b, a).c.y).toBeLessThan(0);
  });

  test("progress is the share of the trip, clamped", () => {
    expect(progress(100, 200, 50)).toBe(0);
    expect(progress(100, 200, 150)).toBe(0.5);
    expect(progress(100, 200, 250)).toBe(1);
    expect(progress(100, 100, 100)).toBe(1);
  });

  test("the marker starts at the origin and reaches the drawn end on arrival", () => {
    const r = routeBetween(a, b);
    expect(markerAt(r, 0, 3_600, 0)).toEqual(a);
    const end = markerAt(r, 0, 3_600, 3_600);
    expect(close(end.x, r.drawn.p1.x) && close(end.y, r.drawn.p1.y)).toBe(true);
    // It stops short of the target city, outside its marker.
    expect(distance(end, b)).toBeGreaterThan(CITY_R);
    const mid = markerAt(r, 0, 3_600, 1_800);
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(100);
  });

  test("a sub-curve follows the curve it was cut from", () => {
    fc.assert(
      fc.property(
        fc.record({
          ax: fc.integer({ min: 0, max: 600 }),
          ay: fc.integer({ min: 0, max: 600 }),
          bx: fc.integer({ min: 0, max: 600 }),
          by: fc.integer({ min: 0, max: 600 }),
          s1: fc.double({ min: 0.1, max: 1, noNaN: true }),
          u: fc.double({ min: 0, max: 1, noNaN: true }),
        }),
        ({ ax, ay, bx, by, s1, u }) => {
          const q = curveBetween({ x: ax, y: ay }, { x: bx, y: by });
          const part = subCurve(q, 0, s1);
          const p = pointAt(part, u);
          const want = pointAt(q, u * s1);
          return close(p.x, want.x, 1e-6) && close(p.y, want.y, 1e-6);
        },
      ),
    );
  });

  test("the tangent points along the trip", () => {
    const t = tangentAt(curveBetween(a, b), 0.5);
    expect(t.x).toBeGreaterThan(0);
    expect(Math.abs(t.y)).toBeLessThan(1e-9);
  });

  test("a marker grows with log2 of the units it carries, within bounds", () => {
    expect(markerRadius(1)).toBe(2.7);
    expect(markerRadius(15)).toBe(4.8);
    expect(markerRadius(1_000_000)).toBe(8);
    expect(markerRadius(0)).toBe(2.2);
    expect(markerRadius(100)).toBeGreaterThan(markerRadius(10));
  });
});

describe("where a movement starts and ends", () => {
  const cities = {
    c1: { island: "i2", slot: 0 },
    c2: { island: "i1", slot: 0 },
  };

  test("an outbound movement goes from its city to the target city", () => {
    const m = { from: "c1", fromIsland: "i2", to: "c2", toIsland: "i1", turnedAt: null };
    expect(movementStart(islands, cities, m)).toEqual({ x: 92, y: 300 });
    expect(movementEnd(islands, cities, m)).toEqual({ x: 300, y: 300 });
  });

  test("a founding (no target city) heads for the island's centre", () => {
    const m = { from: "c1", fromIsland: "i2", to: null, toIsland: "i1", turnedAt: null };
    expect(movementEnd(islands, cities, m)).toEqual({ x: 300, y: 300 });
  });

  test("a recalled movement comes home from the point where it turned back", () => {
    // Recalled at D1 01:00, halfway from i2 (100, 300) to i1 (300, 300): the fold records the
    // turn-back point; the return then travels from it home, departing at the recall.
    const m = {
      from: "c1",
      fromIsland: "i2",
      to: "c1",
      toIsland: "i2",
      turnedAt: { t: 3_600, x: 200, y: 300 },
    };
    const start = movementStart(islands, cities, m);
    expect(start).toEqual({ x: 200, y: 300 });
    const end = movementEnd(islands, cities, m);
    if (start === null || end === null) throw new Error("no route");
    const r = routeBetween(start, end);
    expect(markerAt(r, 3_600, 7_200, 3_600)).toEqual({ x: 200, y: 300 });
    expect(markerAt(r, 3_600, 7_200, 7_200).x).toBeLessThan(200);
  });

  test("a city the frame does not hold falls back to its island's centre", () => {
    const m = { from: "c9", fromIsland: "i1", to: "c8", toIsland: "i2", turnedAt: null };
    expect(movementStart(islands, cities, m)).toEqual({ x: 300, y: 300 });
    expect(movementEnd(islands, cities, m)).toEqual({ x: 100, y: 300 });
  });
});

describe("shapes", () => {
  test("a countdown arc covers its share of the circle, clockwise from the top", () => {
    expect(arcPath(0, 0, 10, 0)).toBe("");
    expect(arcPath(0, 0, 10, 0.25)).toBe("M0 -10A10 10 0 0 1 10 0");
    expect(arcPath(0, 0, 10, 0.75)).toBe("M0 -10A10 10 0 1 1 -10 0");
    expect(arcPath(0, 0, 10, 1)).toBe("M0 -10A10 10 0 1 1 0 10A10 10 0 1 1 0 -10");
  });

  test("a star has twice as many corners as points, its first point up", () => {
    const d = starPath(0, 0, 10, 4);
    expect(d.startsWith("M0 -10L")).toBe(true);
    expect(d.split("L")).toHaveLength(10);
  });

  test("an arrowhead's tip is where it is asked", () => {
    expect(arrowHead({ x: 10, y: 0 }, { x: 1, y: 0 }, 4).startsWith("M10 0L6 2.2L6 -2.2")).toBe(
      true,
    );
  });
});
