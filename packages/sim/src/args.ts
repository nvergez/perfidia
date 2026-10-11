import { parseArgs } from "node:util";

// Command-line plumbing shared by the `sim` commands (docs/architecture.md §12.1): exit codes, the
// usage error, flag parsing with `node:util` `parseArgs`, and the parsers of numeric flag values.

/** Exit codes of the CLI (§12.1). */
export const EXIT = {
  ok: 0,
  /** A replay divergence, a snapshot that does not match, or a log that fails verification. */
  divergence: 1,
  /** An invariant, engine, driver or (strict) agent error. */
  fatal: 2,
  /** A usage or config error. */
  usage: 3,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A usage or config error (exit code 3); the message says what to change. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Where a command writes: standard output and standard error (injected so tests run in-process). */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/** A `CliIo` that keeps what a command writes (tests, programmatic use of `main`). */
export function memoryIo(): CliIo & { stdout(): string; stderr(): string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

export interface FlagSpec {
  readonly type: "string" | "boolean";
  /** The flag may be given several times. */
  readonly repeat?: boolean;
  /** Placeholder of the value in the usage text, e.g. `<uint32>`. */
  readonly value?: string;
  readonly help: string;
}
export type FlagSpecs = Readonly<Record<string, FlagSpec>>;

/** The usage text of a command: its synopsis and one line per flag. */
export function usageText(synopsis: string, specs: FlagSpecs): string {
  const rows = Object.entries(specs).map(([name, s]) => {
    const head = `--${name}${s.type === "string" ? ` ${s.value ?? "<value>"}` : ""}`;
    return [head, `${s.help}${s.repeat === true ? " (repeatable)" : ""}`] as const;
  });
  const width = Math.max(0, ...rows.map(([h]) => h.length));
  return [
    `usage: ${synopsis}`,
    ...rows.map(([h, help]) => `  ${h.padEnd(width)}  ${help}`),
    "",
  ].join("\n");
}

/** The parsed flags of one command. */
export class Flags {
  readonly positionals: readonly string[];
  private readonly values: Readonly<Record<string, unknown>>;

  constructor(values: Readonly<Record<string, unknown>>, positionals: readonly string[]) {
    this.values = values;
    this.positionals = positionals;
  }

  /** Every value of a string flag, in order. */
  strings(name: string): string[] {
    const v = this.values[name];
    if (v === undefined) return [];
    const list: unknown[] = Array.isArray(v) ? v : [v];
    return list.filter((x): x is string => typeof x === "string");
  }

  /** The value of a string flag given at most once. */
  string(name: string): string | undefined {
    const list = this.strings(name);
    if (list.length > 1)
      throw new UsageError(`--${name} is given ${list.length} times; give it once`);
    return list[0];
  }

  bool(name: string): boolean {
    const v = this.values[name];
    return Array.isArray(v) ? v.length > 0 : v === true;
  }

  has(name: string): boolean {
    const v = this.values[name];
    return Array.isArray(v) ? v.length > 0 : v !== undefined;
  }
}

/**
 * Parses `argv` against `specs` (strict: an unknown flag, a missing value or a value given to a
 * boolean flag is a `UsageError` that lists the valid flags). String flags are collected as lists,
 * so a non-repeatable flag given twice is reported rather than silently overridden.
 */
export function parseFlags(
  argv: readonly string[],
  specs: FlagSpecs,
  usage: string,
  positionals: { readonly min: number; readonly max: number; readonly name: string },
): Flags {
  const options: Record<string, { type: "string" | "boolean"; multiple: true }> = {};
  for (const [name, s] of Object.entries(specs)) options[name] = { type: s.type, multiple: true };
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
  }
  const flags = new Flags(parsed.values, parsed.positionals);
  for (const [name, s] of Object.entries(specs)) {
    if (s.type === "boolean" && s.repeat !== true) {
      const v = parsed.values[name];
      if (Array.isArray(v) && v.length > 1) throw new UsageError(`--${name} is given twice`);
    }
    if (s.type === "string" && s.repeat !== true) flags.string(name);
  }
  const n = flags.positionals.length;
  if (n < positionals.min || n > positionals.max) {
    const want =
      positionals.min === positionals.max
        ? `${positionals.min}`
        : `${positionals.min} to ${positionals.max === Infinity ? "any number of" : positionals.max}`;
    throw new UsageError(
      `expected ${want} ${positionals.name} argument(s), got ${n}${n > 0 ? ` (${flags.positionals.join(" ")})` : ""}\n\n${usage}`,
    );
  }
  return flags;
}

const UINT = /^(0|[1-9][0-9]*)$/;

/** A decimal integer within `[min, max]`; `what` names the flag in the error. */
export function parseIntIn(text: string, what: string, min: number, max: number): number {
  if (!UINT.test(text))
    throw new UsageError(`${what} must be an integer in ${min}..${max}, got "${text}"`);
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new UsageError(`${what} must be an integer in ${min}..${max}, got ${text}`);
  }
  return n;
}

export const UINT32_MAX = 4294967295;

/** At most this many seeds in one batch. */
export const MAX_SEEDS = 10000;

/** `1-10`, `1,5,9` or a mix (`1-3,7`): distinct uint32 seeds, in the order given. */
export function parseSeeds(text: string): number[] {
  const out: number[] = [];
  for (const part of text.split(",")) {
    const m = /^([0-9]+)-([0-9]+)$/.exec(part);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      const a = parseIntIn(m[1], "--seeds", 0, UINT32_MAX);
      const b = parseIntIn(m[2], "--seeds", 0, UINT32_MAX);
      if (a > b) throw new UsageError(`--seeds: the range ${part} is empty (write low-high)`);
      if (b - a + 1 + out.length > MAX_SEEDS) {
        throw new UsageError(`--seeds: at most ${MAX_SEEDS} seeds`);
      }
      for (let s = a; s <= b; s += 1) out.push(s);
    } else {
      out.push(parseIntIn(part, "--seeds", 0, UINT32_MAX));
    }
  }
  const seen = new Set<number>();
  for (const s of out) {
    if (seen.has(s)) throw new UsageError(`--seeds: seed ${s} is listed twice`);
    seen.add(s);
  }
  if (out.length > MAX_SEEDS) throw new UsageError(`--seeds: at most ${MAX_SEEDS} seeds`);
  return out;
}

/** `3` or `5/2`: game-seconds per wall-second, as a positive fraction. */
export function parseSpeed(text: string): { num: number; den: number } {
  const m = /^([0-9]+)(?:\/([0-9]+))?$/.exec(text);
  if (m?.[1] === undefined) {
    throw new UsageError(
      `--speed must be a positive integer or fraction such as 3 or 5/2, got "${text}"`,
    );
  }
  const num = parseIntIn(m[1], "--speed", 1, Number.MAX_SAFE_INTEGER);
  const den = m[2] === undefined ? 1 : parseIntIn(m[2], "--speed denominator", 1, 1_000_000);
  return { num, den };
}

/** `2000-60000`: a think-time range in wall milliseconds, low ≤ high. */
export function parseLatency(text: string): [number, number] {
  const m = /^([0-9]+)-([0-9]+)$/.exec(text);
  if (m?.[1] === undefined || m[2] === undefined) {
    throw new UsageError(
      `--latency must be a range of milliseconds such as 2000-60000, got "${text}"`,
    );
  }
  const lo = parseIntIn(m[1], "--latency", 0, 86_400_000);
  const hi = parseIntIn(m[2], "--latency", 0, 86_400_000);
  if (lo > hi) throw new UsageError(`--latency: ${lo} is above ${hi} (write low-high)`);
  return [lo, hi];
}

/** The message of any thrown value. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
