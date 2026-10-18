import { describe, expect, test } from "bun:test";
import { PLAYER_COLORS, PLAYER_SHAPES, playerColor, playerShape } from "./colors.ts";
import { fmtInt, fmtUsd, plural } from "./format.ts";
import { stockNow } from "./stock.ts";

describe("numbers, colours, stock", () => {
  test("integers, plurals and dollars", () => {
    expect([fmtInt(0), fmtInt(999), fmtInt(1_312), fmtInt(1_234_567), fmtInt(-4_200)]).toEqual([
      "0",
      "999",
      "1,312",
      "1,234,567",
      "−4,200",
    ]);
    expect([plural(1, "city", "cities"), plural(3, "city", "cities"), plural(2, "day")]).toEqual([
      "1 city",
      "3 cities",
      "2 days",
    ]);
    expect([fmtUsd(0), fmtUsd(420_000_000), fmtUsd(12_050_000_000)]).toEqual([
      "$0.00",
      "$0.42",
      "$12.05",
    ]);
  });

  test("12 distinct colours and shapes, wrapping past 12", () => {
    expect(new Set(PLAYER_COLORS).size).toBe(12);
    expect(new Set(PLAYER_SHAPES.map((s) => s.name)).size).toBe(12);
    expect(playerColor(12)).toBe(playerColor(0));
    expect(playerShape(13).name).toBe(playerShape(1).name);
  });

  test("stock is extrapolated at the playhead and capped, never below what is stored", () => {
    const city = {
      stock: { wood: 100, stone: 900, gold: 0 },
      stockAt: 3_600,
      perHour: { wood: 60, stone: 60, gold: 0 },
      cap: 500,
    };
    expect(stockNow(city, 3_600)).toEqual({ wood: 100, stone: 900, gold: 0 });
    expect(stockNow(city, 7_200)).toEqual({ wood: 160, stone: 900, gold: 0 });
    expect(stockNow(city, 3_600 * 100)).toEqual({ wood: 500, stone: 900, gold: 0 });
  });
});
