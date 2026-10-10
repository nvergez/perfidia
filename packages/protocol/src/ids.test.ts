import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  AuthoredNameSchema,
  CityIdSchema,
  compareIds,
  MessageIdSchema,
  MovementIdSchema,
  OPAQUE_ID_ALPHABET,
  OPAQUE_ID_LENGTH,
  PlayerIdSchema,
  ProposalIdSchema,
  ReportIdSchema,
  RulesetRefSchema,
  z,
  type CityId,
  type MovementId,
  type PlayerId,
  type RulesetRef,
} from "./index.ts";

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** Id-like strings: public ids (canonical or not), opaque ids, and arbitrary strings. */
const idLike = fc.oneof(
  fc
    .tuple(fc.constantFrom("p", "i", "c", "a"), fc.nat({ max: 100_000 }))
    .map(([k, n]) => `${k}${n}`),
  fc
    .tuple(fc.constantFrom("p", "c"), fc.stringMatching(/^[0-9]{1,4}$/))
    .map(([k, s]) => `${k}${s}`),
  fc
    .tuple(
      fc.constantFrom("m", "r", "q", "g"),
      fc.array(fc.constantFrom(...OPAQUE_ID_ALPHABET.split("")), {
        minLength: OPAQUE_ID_LENGTH,
        maxLength: OPAQUE_ID_LENGTH,
      }),
    )
    .map(([k, cs]) => `${k}${cs.join("")}`),
  fc.constantFrom("neutral", "", "p", "pfoo", "p1|p4"),
  fc.string({ maxLength: 6 }),
);

describe("compareIds", () => {
  test("orders public ids by number within a kind", () => {
    expect(compareIds("p2", "p10")).toBeLessThan(0);
    expect(compareIds("p10", "p2")).toBeGreaterThan(0);
    expect(compareIds("c9", "c107")).toBeLessThan(0);
    expect(compareIds("i3", "i3")).toBe(0);
    expect(["p10", "p2", "p1", "p12"].toSorted(compareIds)).toEqual(["p1", "p2", "p10", "p12"]);
  });

  test("groups ids by prefix", () => {
    const sorted = ["p1", "c20", "i3", "a2", "c3", "p10", "m0k4qz", "a10"].toSorted(compareIds);
    expect(sorted).toEqual(["a2", "a10", "c3", "c20", "i3", "m0k4qz", "p1", "p10"]);
  });

  test("orders opaque ids by code unit", () => {
    expect(compareIds("m0k4qz", "m0k4r0")).toBeLessThan(0);
    expect(compareIds("m9zzzz", "ma0000")).toBeLessThan(0);
    expect(compareIds("mz0000", "ma0000")).toBeGreaterThan(0);
    const ids = ["mzzzzz", "m00000", "mb1234", "m9aaaa"];
    expect(ids.toSorted(compareIds)).toEqual(ids.toSorted((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
  });

  test("sorts malformed public ids after the numbered ones", () => {
    expect(compareIds("p99", "pfoo")).toBeLessThan(0);
    expect(compareIds("p1|p4", "p7")).toBeGreaterThan(0);
    expect(compareIds("neutral", "p1")).toBeLessThan(0);
  });

  test("is a total order (property)", () => {
    fc.assert(
      fc.property(idLike, idLike, idLike, (a, b, c) => {
        expect(compareIds(a, a)).toBe(0);
        expect(compareIds(a, b) === 0).toBe(a === b);
        expect(sign(compareIds(a, b)) + sign(compareIds(b, a))).toBe(0);
        if (compareIds(a, b) <= 0 && compareIds(b, c) <= 0) {
          expect(compareIds(a, c)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 2000 },
    );
  });

  test("sorting is independent of the input order (property)", () => {
    fc.assert(
      fc.property(fc.array(idLike, { maxLength: 30 }), (ids) => {
        const once = ids.toSorted(compareIds);
        const reversed = ids.toReversed().toSorted(compareIds);
        expect(reversed).toEqual(once);
        for (let i = 1; i < once.length; i++) {
          expect(compareIds(once[i - 1] ?? "", once[i] ?? "")).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  test("agrees with the numeric order of canonical public ids (property)", () => {
    fc.assert(
      fc.property(fc.nat({ max: 2 ** 40 }), fc.nat({ max: 2 ** 40 }), (x, y) => {
        expect(sign(compareIds(`c${x + 1}`, `c${y + 1}`))).toBe(sign(x - y));
      }),
    );
  });
});

describe("opaque ids", () => {
  test("accept the alphabet and the length of §4.1 only", () => {
    expect(MovementIdSchema.safeParse("m0k4qz").success).toBe(true);
    expect(MovementIdSchema.safeParse("m41").success).toBe(false);
    expect(MovementIdSchema.safeParse("m0k4qi").success).toBe(false);
    for (const letter of ["i", "l", "o", "u"]) {
      expect(MovementIdSchema.safeParse(`m0k4q${letter}`).success).toBe(false);
    }
    expect(OPAQUE_ID_ALPHABET).toHaveLength(32);
    expect(new Set(OPAQUE_ID_ALPHABET.split("")).size).toBe(32);
  });

  test("every alphabet string of the right length parses, for every private kind (property)", () => {
    const schemas = {
      m: MovementIdSchema,
      r: ReportIdSchema,
      q: ProposalIdSchema,
      g: MessageIdSchema,
    };
    fc.assert(
      fc.property(
        fc.constantFrom("m", "r", "q", "g"),
        fc.array(fc.constantFrom(...OPAQUE_ID_ALPHABET.split("")), {
          minLength: OPAQUE_ID_LENGTH,
          maxLength: OPAQUE_ID_LENGTH,
        }),
        (prefix, chars) => {
          expect(schemas[prefix].safeParse(`${prefix}${chars.join("")}`).success).toBe(true);
        },
      ),
    );
  });

  test("templates give precise types", () => {
    const m: MovementId = MovementIdSchema.parse("m0k4qz");
    const c: CityId = CityIdSchema.parse("c12");
    const p: PlayerId = PlayerIdSchema.parse("p3");
    const ref: RulesetRef = RulesetRefSchema.parse("perfidia-1@1.0.0");
    // @ts-expect-error a city id is not a player id
    const wrong: PlayerId = c;
    expect([m, c, p, ref, wrong]).toEqual(["m0k4qz", "c12", "p3", "perfidia-1@1.0.0", "c12"]);
  });

  test("JSON Schema patterns are the exact ones", () => {
    const json = z.toJSONSchema(
      z.strictObject({ m: MovementIdSchema, p: PlayerIdSchema, r: RulesetRefSchema }),
    );
    expect(json.properties).toEqual({
      m: { type: "string", pattern: "^m[0-9a-hjkmnp-tv-z]{5}$" },
      p: { type: "string", pattern: "^p[1-9][0-9]*$" },
      r: {
        type: "string",
        pattern: "^[a-z][a-z0-9-]*@(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
      },
    });
  });
});

describe("player-authored names", () => {
  test("reject control characters and non-ASCII letters", () => {
    for (let code = 0; code < 32; code++) {
      expect(AuthoredNameSchema.safeParse(`a${String.fromCharCode(code)}b`).success).toBe(false);
    }
    expect(AuthoredNameSchema.safeParse("a\u007fb").success).toBe(false);
    for (const name of ["é", "café", "Ωmega", "名前", "a b", "x​y"]) {
      expect(AuthoredNameSchema.safeParse(name).success).toBe(false);
    }
  });

  test("accept ASCII letters, digits, space, '-', '_' and '.'", () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(..."abcXYZ019 -_.".split("")),
          minLength: 1,
          maxLength: 24,
        }),
        (name) => {
          expect(AuthoredNameSchema.safeParse(name).success).toBe(true);
        },
      ),
    );
  });
});
