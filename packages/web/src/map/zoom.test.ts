import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  centreOn,
  clampView,
  IDENTITY,
  isIdentity,
  MAX_ZOOM,
  panBy,
  toMap,
  wheelFactor,
  zoomAt,
} from "./zoom.ts";

const W = 600;
const H = 600;

describe("zoom and pan", () => {
  test("zooming keeps the point under the pointer still", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 4, noNaN: true }),
        fc.double({ min: 0, max: 600, noNaN: true }),
        fc.double({ min: 0, max: 600, noNaN: true }),
        (factor, x, y) => {
          const at = { x, y };
          const before = toMap(IDENTITY, at);
          const v = zoomAt(IDENTITY, factor, at, W, H);
          const after = toMap(v, at);
          return Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6;
        },
      ),
    );
  });

  test("the map always covers the view box, between 1× and the maximum zoom", () => {
    expect(clampView({ k: 0.5, x: 30, y: 30 }, W, H)).toEqual(IDENTITY);
    expect(clampView({ k: 20, x: 0, y: 0 }, W, H).k).toBe(MAX_ZOOM);
    const v = panBy(zoomAt(IDENTITY, 2, { x: 300, y: 300 }, W, H), 10_000, -10_000, W, H);
    expect(v).toEqual({ k: 2, x: 0, y: -600 });
  });

  test("zooming back out to 1× returns to the whole map", () => {
    const v = zoomAt(zoomAt(IDENTITY, 3, { x: 100, y: 500 }, W, H), 1 / 3, { x: 50, y: 50 }, W, H);
    expect(isIdentity(v)).toBe(true);
  });

  test("centring on a point puts it in the middle when the map allows", () => {
    const v = centreOn({ x: 300, y: 300 }, 2, W, H);
    expect(toMap(v, { x: 300, y: 300 })).toEqual({ x: 300, y: 300 });
  });

  test("a wheel notch zooms in by about a fifth, the other way out", () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1.15);
    expect(wheelFactor(-100)).toBeLessThan(1.25);
    expect(wheelFactor(100)).toBeCloseTo(1 / wheelFactor(-100), 9);
  });
});
