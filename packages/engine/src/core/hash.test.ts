import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { fnv1a32, fnv1a64, sha256Hex, sha256Words, utf8Encode } from "./hash.ts";

/** Any UTF-16 string, lone surrogates included. */
const anyString = fc
  .array(
    fc.oneof(
      fc.string({ unit: "binary", maxLength: 4 }),
      fc.integer({ min: 0xd800, max: 0xdfff }).map((c) => String.fromCharCode(c)),
      fc.string({ maxLength: 8 }),
    ),
    { maxLength: 12 },
  )
  .map((parts) => parts.join(""));

const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64 over BigInt, the textbook definition. */
function referenceFnv1a64(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of bytes) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & MASK64;
  return h.toString(16).padStart(16, "0");
}

/** The two-halves step of §6.3, transcribed literally (float product and Math.floor carry). */
function specFnv1a64(bytes: Uint8Array): string {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (const byte of bytes) {
    lo = (lo ^ byte) >>> 0;
    const p = lo * 435;
    hi = (hi * 435 + Math.floor(p / 4294967296) + ((lo << 8) >>> 0)) >>> 0;
    lo = p >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

describe("utf8Encode", () => {
  test("agrees with TextEncoder, lone surrogates included", () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(anyString, (s) => {
        expect(Array.from(utf8Encode(s))).toEqual(Array.from(encoder.encode(s)));
      }),
      { numRuns: 5000 },
    );
  });

  test("encodes each width and replaces lone surrogates with EF BF BD", () => {
    expect(Array.from(utf8Encode("aé€\u{1f600}"))).toEqual([
      0x61, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80,
    ]);
    expect(Array.from(utf8Encode("\ud83d"))).toEqual([0xef, 0xbf, 0xbd]);
    expect(Array.from(utf8Encode("\ude00x"))).toEqual([0xef, 0xbf, 0xbd, 0x78]);
    expect(Array.from(utf8Encode("\ude00\ud83d"))).toEqual([0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd]);
    expect(Array.from(utf8Encode("߿ࠀ￿"))).toEqual([0xdf, 0xbf, 0xe0, 0xa0, 0x80, 0xef, 0xbf, 0xbf]);
    expect(utf8Encode("").length).toBe(0);
  });
});

describe("fnv1a64", () => {
  test("matches the §6.3 vectors", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64("foobar")).toBe("85944171f73967e8");
    // Computed independently (Python, arbitrary-precision integers).
    expect(fnv1a64("héllo € \u{1f600}")).toBe("c48b425cc07adfad");
    expect(fnv1a64("�")).toBe("6f6d661b9658624a");
    expect(fnv1a64("\ud800")).toBe(fnv1a64("�"));
  });

  test("agrees with a BigInt reference on any string", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const bytes = new TextEncoder().encode(s);
        expect(fnv1a64(s)).toBe(referenceFnv1a64(bytes));
        expect(specFnv1a64(bytes)).toBe(referenceFnv1a64(bytes));
      }),
      { numRuns: 5000 },
    );
  });

  test("always returns 16 lowercase hex characters", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        expect(fnv1a64(s)).toMatch(/^[0-9a-f]{16}$/);
      }),
    );
  });
});

describe("fnv1a32", () => {
  test("matches the standard vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
    expect(fnv1a32("héllo € \u{1f600}")).toBe(0x746efaad);
    expect(fnv1a32("�")).toBe(0x03479c4a);
  });

  test("agrees with a BigInt reference and returns a uint32", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        let h = 0x811c9dc5n;
        for (const byte of new TextEncoder().encode(s))
          h = ((h ^ BigInt(byte)) * 16777619n) & 0xffffffffn;
        const got = fnv1a32(s);
        expect(got).toBe(Number(h));
        expect(Number.isInteger(got) && got >= 0 && got <= 0xffffffff).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("sha256Hex", () => {
  test("matches the FIPS 180-4 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(
      sha256Hex(
        "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      ),
    ).toBe("cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
    expect(sha256Hex("a".repeat(1000000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  test("handles every padding boundary (vectors from shasum -a 256)", () => {
    const vectors: [number, string][] = [
      [55, "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"],
      [56, "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"],
      [57, "f13b2d724659eb3bf47f2dd6af1accc87b81f09f59f2b75e5c0bed6589dfe8c6"],
      [63, "7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34"],
      [64, "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"],
      [65, "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0"],
      [119, "31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb"],
      [120, "2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c"],
      [127, "c57e9278af78fa3cab38667bef4ce29d783787a2f731d4e12200270f0c32320a"],
      [128, "6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e"],
    ];
    for (const [length, digest] of vectors) expect(sha256Hex("a".repeat(length))).toBe(digest);
  });

  test("hashes strings as UTF-8, lone surrogates as U+FFFD", () => {
    expect(sha256Hex("héllo € \u{1f600}")).toBe(
      "83643b4928cf4914ee6352fed94ef1d9cacb5a843c45544627c6593db3548d74",
    );
    expect(sha256Hex("�")).toBe("83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097");
    expect(sha256Hex("\udc00")).toBe(sha256Hex("�"));
  });

  test("gives the same digest for a string and its UTF-8 bytes", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const hex = sha256Hex(s);
        expect(hex).toMatch(/^[0-9a-f]{64}$/);
        expect(sha256Hex(utf8Encode(s))).toBe(hex);
        expect(
          sha256Words(utf8Encode(s))
            .map((w) => w.toString(16).padStart(8, "0"))
            .join(""),
        ).toBe(hex);
      }),
      { numRuns: 500 },
    );
  });
});
