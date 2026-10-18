import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

// Reading run files that may still grow (phase-3 design §2.4): a byte offset per file; each read
// takes what was appended since, hands out complete lines only and keeps the partial remainder (a
// line is complete at its "\n"; a crash can leave a remainder that never completes). Lines are cut
// on the byte 0x0A, which never occurs inside a UTF-8 multi-byte sequence, so a chunk boundary can
// fall anywhere. A file whose inode changes, that shrinks, or whose first line changes was replaced:
// the read says so and starts over from its first byte.
//
// Run files are opened with `O_NOFOLLOW` and checked on the open descriptor (`fstat`), never by
// path first: a symbolic link swapped in for a file is refused, not followed.

const NL = 0x0a;
const decoder = new TextDecoder("utf-8", { fatal: false });

/** Bytes hashed at the end of a folded log prefix to recognise the log later. */
export const SOURCE_TAIL_BYTES = 64 * 1024;

/** A regular file opened read-only without following a link; null when missing or not regular. */
export function openRegular(path: string): { fd: number; size: number; ino: number } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (st.isFile()) return { fd, size: st.size, ino: st.ino };
  } catch {
    // Not readable: as missing.
  }
  closeSync(fd);
  return null;
}

/** `length` bytes from `from` of an open file (fewer at its end). */
function readAt(fd: number, from: number, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, from + got);
    if (n <= 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

/** A whole regular file (never through a link), or null. */
export function readRegular(path: string, maxBytes = 256 * 1024 * 1024): Uint8Array | null {
  const f = openRegular(path);
  if (f === null) return null;
  try {
    return f.size > maxBytes ? null : readAt(f.fd, 0, f.size);
  } finally {
    closeSync(f.fd);
  }
}

/** What identifies a log's first `bytes` bytes: their count and a hash of their last bytes. */
export interface Fingerprint {
  readonly bytes: number;
  readonly tail: string;
}

/** The fingerprint of a file's first `bytes` bytes (default: all of it); null when unreadable. */
export function fingerprint(path: string, bytes?: number): Fingerprint | null {
  const f = openRegular(path);
  if (f === null) return null;
  try {
    const n = bytes ?? f.size;
    if (n > f.size) return null;
    const from = Math.max(0, n - SOURCE_TAIL_BYTES);
    const tail = readAt(f.fd, from, n - from);
    if (tail.length !== n - from) return null;
    return { bytes: n, tail: Bun.hash(tail).toString(16) };
  } finally {
    closeSync(f.fd);
  }
}

/** Whether a file still starts with the prefix a fingerprint names (`whole`: and nothing more). */
export function fingerprintMatches(path: string, fp: Fingerprint, whole: boolean): boolean {
  const f = openRegular(path);
  if (f === null) return false;
  closeSync(f.fd);
  if (f.size < fp.bytes || (whole && f.size !== fp.bytes)) return false;
  return fingerprint(path, fp.bytes)?.tail === fp.tail;
}

/** The identity of a file (inode and birth time), to tell a recreated file from the old one. */
export function fileIdentity(path: string): string | null {
  const f = openRegular(path);
  if (f === null) return null;
  try {
    const st = fstatSync(f.fd);
    return `${st.ino}:${Math.round(st.birthtimeMs)}`;
  } finally {
    closeSync(f.fd);
  }
}

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
    const f = openRegular(this.path);
    if (f === null) return { lines: [], replaced: false, missing: true, more: false };
    let chunk: Uint8Array;
    let replaced: boolean;
    const { size, ino } = f;
    try {
      replaced = this.ino !== null && (ino !== this.ino || size < this.offset);
      if (!replaced && this.head !== null && size > this.offset) {
        replaced = !sameBytes(readAt(f.fd, 0, this.head.length), this.head);
      }
      if (replaced) this.reset();
      this.ino = ino;
      if (size <= this.offset) return { lines: [], replaced, missing: false, more: false };
      chunk = readAt(f.fd, this.offset, Math.min(size - this.offset, maxBytes));
    } finally {
      closeSync(f.fd);
    }
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

/** The lines of a whole gzipped log (finished runs only are compressed); throws when unreadable. */
export function readGzLines(path: string): string[] {
  const bytes = readRegular(path);
  if (bytes === null) throw new Error(`cannot read ${path}`);
  const text = decoder.decode(Bun.gunzipSync(new Uint8Array(bytes)));
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The first complete line of a file, if it is shorter than `maxBytes`. */
export function readFirstLine(path: string, maxBytes = 1024 * 1024): string | null {
  const f = openRegular(path);
  if (f === null) return null;
  try {
    const buf = readAt(f.fd, 0, Math.min(f.size, maxBytes));
    const cut = buf.indexOf(NL);
    return cut < 0 ? null : decoder.decode(buf.subarray(0, cut));
  } finally {
    closeSync(f.fd);
  }
}

/** The last complete line of a file, if it is shorter than `maxBytes`. */
export function readLastLine(path: string, maxBytes = 512 * 1024): string | null {
  const f = openRegular(path);
  if (f === null) return null;
  try {
    const from = Math.max(0, f.size - maxBytes);
    const buf = readAt(f.fd, from, f.size - from);
    const end = buf.lastIndexOf(NL);
    if (end < 0) return null;
    const start = buf.lastIndexOf(NL, end - 1);
    if (start < 0 && from > 0) return null;
    return decoder.decode(buf.subarray(start + 1, end));
  } finally {
    closeSync(f.fd);
  }
}
