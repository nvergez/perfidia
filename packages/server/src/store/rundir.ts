import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  ArenaStatusSchema,
  EndLineSchema,
  HeaderLineSchema,
  SeatsFileSchema,
  type ArenaStatus,
  type EndLine,
  type HeaderLine,
  type SeatsFile,
} from "@perfidia/protocol";
import { z } from "zod";
import { readRegular } from "./tail.ts";

// The side files of a run directory (phase-3 design §2.3, §2.4), read leniently: they carry no
// format version (`arena.json` aside) and will change after calibration, so a file that fails its
// schema is ignored with a warning and never makes a match unverifiable (that depends on
// `match.jsonl` alone). Only the fields spectators may see are kept: never `seed`, `reason` text,
// alerts, pause causes or prompts. `seats.json` is written once at start without a rename, so a
// parse failure is retried on its next change.

export const SEATS_FILE = "seats.json";
export const ARENA_FILE = "arena.json";
export const SUMMARY_FILE = "summary.json";
export const CALLS_FILE = "llm_calls.jsonl";
export const REPLIES_FILE = "replies.jsonl";

/** What the server keeps of `arena.json`: the run's status and whether its models are fake. */
export interface ArenaInfo {
  readonly status: ArenaStatus;
  readonly fake: boolean;
}

/** What the server keeps of a sim run's `summary.json`. */
export interface SummaryInfo {
  readonly status: "ended" | "fatal" | "incomplete";
}

const ArenaLenientSchema = z.looseObject({
  status: ArenaStatusSchema,
  fake: z.boolean().optional(),
});

const SummaryLenientSchema = z.looseObject({
  format: z.literal("perfidia-summary/1"),
  status: z.enum(["ended", "fatal", "incomplete"]),
});

/** A file's modification time and size, or null when it is missing or not a regular file. */
export function fileStamp(path: string): string | null {
  try {
    const st = lstatSync(path);
    return st.isFile() ? `${st.mtimeMs}:${st.size}:${st.ino}` : null;
  } catch {
    return null;
  }
}

function readJson(path: string): unknown {
  const bytes = readRegular(path, 16 * 1024 * 1024);
  if (bytes === null) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

export type Lenient<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly missing: boolean };

export function readSeatsFile(dir: string): Lenient<SeatsFile> {
  const raw = readJson(join(dir, SEATS_FILE));
  if (raw === undefined) return { ok: false, missing: fileStamp(join(dir, SEATS_FILE)) === null };
  const parsed = SeatsFileSchema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, missing: false };
}

export function readArenaFile(dir: string): Lenient<ArenaInfo> {
  const raw = readJson(join(dir, ARENA_FILE));
  if (raw === undefined) return { ok: false, missing: fileStamp(join(dir, ARENA_FILE)) === null };
  const parsed = ArenaLenientSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: { status: parsed.data.status, fake: parsed.data.fake === true } }
    : { ok: false, missing: false };
}

export function readSummaryFile(dir: string): Lenient<SummaryInfo> {
  const raw = readJson(join(dir, SUMMARY_FILE));
  if (raw === undefined) return { ok: false, missing: fileStamp(join(dir, SUMMARY_FILE)) === null };
  const parsed = SummaryLenientSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: { status: parsed.data.status } }
    : { ok: false, missing: false };
}

/** A header line's text parsed, or null. */
export function parseHeader(text: string | null): HeaderLine | null {
  if (text === null) return null;
  try {
    const parsed = HeaderLineSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A line's text parsed as an end line, or null. */
export function parseEnd(text: string | null): EndLine | null {
  if (text === null || !text.includes('"k":"end"')) return null;
  try {
    const parsed = EndLineSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
