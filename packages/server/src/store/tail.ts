import { closeSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";

// Reading run files that may still grow (phase-3 design §2.4): a byte offset per file; each read
// takes what was appended since, hands out complete lines only and keeps the partial remainder (a
// line is complete at its "\n"; a crash can leave a remainder that never completes). Lines are cut
// on the byte 0x0A, which never occurs inside a UTF-8 multi-byte sequence, so a chunk boundary can
// fall anywhere. A file whose inode changes, that shrinks, or whose first line changes was replaced:
// the read says so and starts over from its first byte.

const NL = 0x0a;
const decoder = new TextDecoder("utf-8", { fatal: false });

export interface TailRead {
  /** Complete lines appended since the last read (after a replacement: from the start). */
  readonly lines: string[];
  /** The file was replaced since the last read. */
  readonly replaced: boolean;
  /** The file is missing (or is not a regular file). */
  readonly missing: boolean;
  /** Bytes are still unread (the read stopped at its size cap). */
  readonly more: boolean;
}

function readRange(path: string, from: number, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  const fd = openSync(path, "r");
  try {
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return got === length ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export class LineTail {
  readonly path: string;
  private offset = 0;
  private ino: number | null = null;
  private rest = new Uint8Array(0);
  /** The bytes of the first line (with its "\n"), once read. */
  private head: Uint8Array | null = null;
  /** Complete lines handed out since the last (re)start. */
  lines = 0;

  constructor(path: string) {
    this.path = path;
  }

  /** Bytes consumed so far (complete lines and the pending remainder). */
  get bytes(): number {
    return this.offset;
  }

  /** Bytes of an incomplete last line waiting for its "\n". */
  get pending(): number {
    return this.rest.length;
  }

  read(maxBytes = 8 * 1024 * 1024): TailRead {
    let size: number;
    let ino: number;
    try {
      const st = lstatSync(this.path);
      if (!st.isFile()) return { lines: [], replaced: false, missing: true, more: false };
      size = st.size;
      ino = st.ino;
    } catch {
      return { lines: [], replaced: false, missing: true, more: false };
    }
    let replaced = this.ino !== null && (ino !== this.ino || size < this.offset);
    if (!replaced && this.head !== null && size > this.offset) {
      replaced = !sameBytes(readRange(this.path, 0, this.head.length), this.head);
    }
    if (replaced) this.reset();
    this.ino = ino;
    if (size <= this.offset) return { lines: [], replaced, missing: false, more: false };
    const length = Math.min(size - this.offset, maxBytes);
    const chunk = readRange(this.path, this.offset, length);
    this.offset += chunk.length;
    const buf = new Uint8Array(this.rest.length + chunk.length);
    buf.set(this.rest, 0);
    buf.set(chunk, this.rest.length);
    const cut = buf.lastIndexOf(NL);
    if (cut < 0) {
      this.rest = buf;
      return { lines: [], replaced, missing: false, more: this.offset < size };
    }
    this.rest = buf.slice(cut + 1);
    if (this.head === null) {
      const first = buf.indexOf(NL);
      this.head = buf.slice(0, first + 1);
    }
    const text = decoder.decode(buf.subarray(0, cut));
    const lines = text.split("\n");
    this.lines += lines.length;
    return { lines, replaced, missing: false, more: this.offset < size };
  }

  private reset(): void {
    this.offset = 0;
    this.rest = new Uint8Array(0);
    this.head = null;
    this.lines = 0;
  }
}

/** The lines of a whole gzipped log (finished runs only are compressed). */
export function readGzLines(path: string): string[] {
  const text = decoder.decode(Bun.gunzipSync(new Uint8Array(readFileSync(path))));
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The first complete line of a file, if it is shorter than `maxBytes`. */
export function readFirstLine(path: string, maxBytes = 1024 * 1024): string | null {
  try {
    const size = lstatSync(path).size;
    const buf = readRange(path, 0, Math.min(size, maxBytes));
    const cut = buf.indexOf(NL);
    return cut < 0 ? null : decoder.decode(buf.subarray(0, cut));
  } catch {
    return null;
  }
}

/** The last complete line of a file, if it is shorter than `maxBytes`. */
export function readLastLine(path: string, maxBytes = 512 * 1024): string | null {
  try {
    const size = lstatSync(path).size;
    const from = Math.max(0, size - maxBytes);
    const buf = readRange(path, from, size - from);
    const end = buf.lastIndexOf(NL);
    if (end < 0) return null;
    const start = buf.lastIndexOf(NL, end - 1);
    if (start < 0 && from > 0) return null;
    return decoder.decode(buf.subarray(start + 1, end));
  } catch {
    return null;
  }
}
