// UTF-8 encoding, FNV-1a 64 and SHA-256 in pure TypeScript (docs/architecture.md §6.3). No BigInt,
// no host crypto: the same code runs in Bun and in a browser replay.

/**
 * UTF-8 bytes of `s`. A lone surrogate becomes U+FFFD (`EF BF BD`), as `TextEncoder` does, so every
 * string has exactly one encoding.
 */
export function utf8Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 3);
  let j = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out[j++] = c;
    } else if (c < 0x800) {
      out[j++] = 0xc0 | (c >> 6);
      out[j++] = 0x80 | (c & 0x3f);
    } else if (c < 0xd800 || c > 0xdfff) {
      out[j++] = 0xe0 | (c >> 12);
      out[j++] = 0x80 | ((c >> 6) & 0x3f);
      out[j++] = 0x80 | (c & 0x3f);
    } else {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        out[j++] = 0xf0 | (cp >> 18);
        out[j++] = 0x80 | ((cp >> 12) & 0x3f);
        out[j++] = 0x80 | ((cp >> 6) & 0x3f);
        out[j++] = 0x80 | (cp & 0x3f);
        i += 1;
      } else {
        out[j++] = 0xef;
        out[j++] = 0xbf;
        out[j++] = 0xbd;
      }
    }
  }
  return out.subarray(0, j);
}

function hex8(word: number): string {
  return (word >>> 0).toString(16).padStart(8, "0");
}

/**
 * FNV-1a 64 of the UTF-8 bytes of `s`, as 16 lowercase hex characters (offset 0xcbf29ce484222325,
 * prime 2^40 + 435). The 64-bit state is kept in two uint32 halves, as §6.3 specifies:
 *
 *   lo = (lo ^ byte) >>> 0
 *   hi = (hi · 435 + floor(lo · 435 / 2^32) + (lo << 8)) mod 2^32
 *   lo = (lo · 435) mod 2^32
 *
 * The carry `floor(lo · 435 / 2^32)` is computed from the 16-bit halves of lo and the products with
 * `Math.imul`, all in int32 arithmetic: the same values as the float form of §6.3, about four times
 * faster on a full state.
 */
export function fnv1a64(s: string): string {
  const bytes = utf8Encode(s);
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let i = 0; i < bytes.length; i += 1) {
    lo = (lo ^ (bytes[i] ?? 0)) >>> 0;
    const carry = ((lo >>> 16) * 435 + (((lo & 0xffff) * 435) >>> 16)) >>> 16;
    hi = (Math.imul(hi, 435) + carry + (lo << 8)) >>> 0;
    lo = Math.imul(lo, 435) >>> 0;
  }
  return hex8(hi) + hex8(lo);
}

const SHA256_K: readonly number[] = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** The eight uint32 words of the SHA-256 digest of `bytes` (FIPS 180-4). */
export function sha256Words(bytes: Uint8Array): number[] {
  const length = bytes.length;
  // Message, the 0x80 marker, zero padding and the 64-bit big-endian bit length, in 64-byte blocks.
  const total = Math.ceil((length + 9) / 64) * 64;
  const block = new Uint8Array(total);
  block.set(bytes);
  block[length] = 0x80;
  const view = new DataView(block.buffer);
  view.setUint32(total - 8, Math.floor(length / 0x20000000));
  view.setUint32(total - 4, (length * 8) >>> 0);

  const w = new Int32Array(64);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getInt32(offset + 4 * i);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word >>> 0);
}

/** SHA-256 of `data` (a string is hashed as its UTF-8 bytes), as 64 lowercase hex characters. */
export function sha256Hex(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? utf8Encode(data) : data;
  return sha256Words(bytes).map(hex8).join("");
}
