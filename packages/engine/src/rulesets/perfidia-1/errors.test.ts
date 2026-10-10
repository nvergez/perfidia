import { describe, expect, test } from "bun:test";
import { fmt } from "@perfidia/engine/core";
import { ViolationSchema } from "@perfidia/protocol";
import fc from "fast-check";
import {
  CAPITAL_IMMUNE,
  CITY_BESIEGED,
  NOT_BESIEGER,
  PERFIDIA_1_ERROR_SAMPLES,
  PERFIDIA_1_ERRORS,
} from "./errors.ts";

// Wording of perfidia-1's own codes (docs/architecture.md §7.3).

const explain = (code: string, details: Record<string, string | number | boolean | null>) => {
  const explainer = PERFIDIA_1_ERRORS[code];
  if (explainer === undefined) throw new Error(`no explainer for ${code}`);
  return explainer({ code, details }, fmt);
};

describe("errors", () => {
  test("cover CITY_BESIEGED, NOT_BESIEGER and the warning CAPITAL_IMMUNE", () => {
    expect(new Set(Object.keys(PERFIDIA_1_ERRORS))).toEqual(
      new Set([CAPITAL_IMMUNE, CITY_BESIEGED, NOT_BESIEGER]),
    );
  });

  test("samples: valid violations, one per code at least, each with an explainer", () => {
    const codes = new Set(PERFIDIA_1_ERROR_SAMPLES.map((v) => v.code));
    expect(codes).toEqual(new Set(Object.keys(PERFIDIA_1_ERRORS)));
    for (const v of PERFIDIA_1_ERROR_SAMPLES) expect(ViolationSchema.parse(v)).toEqual(v);
  });

  test("CITY_BESIEGED names the besieger and the end time", () => {
    expect(explain(CITY_BESIEGED, { city: "c14", by: "p2", endsAt: 223200 })).toEqual({
      message:
        "c14 is besieged by p2 until D3 14:00: it cannot build, recruit or send anything, and only p2 may send it support.",
      hint: "Break the siege with an attack on c14 from another city (a relief battle against p2's garrison), or wait until D3 14:00. Units homed in c14 that are away can come home and fight a homecoming battle.",
    });
  });

  test("NOT_BESIEGER points to a relief attack", () => {
    expect(explain(NOT_BESIEGER, { city: "c14", by: "p2", endsAt: 223230 })).toEqual({
      message: "c14 is besieged by p2: only p2 may send it support until D3 14:00:30.",
      hint: "To help c14's owner, attack c14 instead: a relief battle against p2's garrison breaks the siege if it kills every settler in it.",
    });
  });

  test("CAPITAL_IMMUNE says a win will be a raid", () => {
    expect(explain(CAPITAL_IMMUNE, { city: "c3", arriveAt: 160200, immuneUntil: 172800 })).toEqual({
      message:
        "c3 is a capital that cannot be besieged before D3 00:00, and this attack lands at D2 20:30.",
      hint: "A win will be a raid: the settlers come back home. To start a siege, land at D3 00:00 or later.",
    });
  });

  test("explainers never throw on malformed details (property)", () => {
    const value = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(PERFIDIA_1_ERRORS)),
        fc.dictionary(
          fc.constantFrom("city", "by", "endsAt", "arriveAt", "immuneUntil", "x"),
          value,
        ),
        (code, details) => {
          const out = explain(code, details);
          expect(out.message.length).toBeGreaterThan(0);
          expect(out.hint.length).toBeGreaterThan(0);
        },
      ),
    );
  });
});
