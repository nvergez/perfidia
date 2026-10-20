import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DAY } from "@perfidia/engine/core";
import {
  TOKEN_PROFILE_FORMAT,
  TokenProfileSchema,
  type ArenaReportAny,
  type TokenProfile,
} from "@perfidia/protocol";
import { UsageError } from "@perfidia/sim";
import {
  ArenaReportAnySchema,
  LlmLogLineSchema,
  SeatsFileSchema,
  type HandoffLine,
  type LlmCallLine,
  type LlmLogLine,
  type SeatsFile,
} from "../log/schema.ts";
import { formatCents } from "../model/prices.ts";

// Calibration profiles (phase-4 design §5.3, Pass 2): `arena calibrate <run-dir>...` measures what
// real runs spent, wake by wake, into `perfidia-profile/1` files (`packages/orchestrator/profiles/`
// by default), one per key: (provider, model, endpoint, effort, prompt variant, reminder cadence,
// `maxTokens`, `PROMPT_VERSION`, ruleset major). `arena estimate` and `arena run` then predict from
// them (`arena/estimate.ts`): `measured-point` from 1–2 seat-days, `calibrated` (a bootstrap) from 3.
//
// - A **seat-day** is one LLM seat on one complete game day of a real lockstep run that ended (or
//   stopped at a day boundary, `--stop-after`) with Level E ok, before any hand-off of that seat.
//   Game days are numbered from 0 in the files (`day`), from 1 in what is printed.
//   Its wakes are its turns that started that day; a wake's rounds are its `llm_call` lines in
//   order (rounds, retries and thought calls: everything the ledger charged), each with its prompt,
//   output, cache-read and cache-write tokens summed over its usage entries.
// - **Fake runs never feed wake counts or tokens** (their brains are bots, their usage bot-shaped):
//   a `--fake` run that played at least 7 game days gives only the **briefing growth**, the mean
//   size of the round-0 briefing per game day, read from its transcripts (the briefing is real
//   gateway output), at `BRIEFING_BYTES_PER_TOKEN` bytes per token (an assumption).
// - Profiles accumulate: a run measured again replaces its seat-days, other runs' stay; growth
//   measured in this call replaces the growth of every profile of the same ruleset major.

/** Where the profiles live by default. */
export const PROFILES_DIR = join(import.meta.dir, "..", "..", "profiles");

/**
 * Independent seat-days a key needs for a `calibrated` prediction (percentiles); 1–2 give
 * `measured-point`. Seat-days are counted by (run, game day): the seats of one match day share its
 * map, its opponents and its events, so three seats of one model on one day count once (the Pass 2
 * review's replication: a bootstrap over one match day missed every seat's spend).
 */
export const MIN_CALIBRATED_SEAT_DAYS = 3;

/** A profile's independent seat-days: its distinct (run, game day) pairs. */
export const independentSeatDays = (p: TokenProfile): number =>
  new Set(p.seatDays.map((d) => `${d.run}\u0000${d.day}`)).size;

/** The briefing growth needs fake runs of at least a week of game days. */
export const GROWTH_DAYS = 7;

/**
 * Bytes of briefing JSON per token (an assumption): tokenizers read compact JSON at about 3 to 4
 * bytes per token; 3 counts more tokens of growth than the fake usage's 4.
 */
export const BRIEFING_BYTES_PER_TOKEN = 3;

export type ProfileKey = TokenProfile["key"];
type SeatDay = TokenProfile["seatDays"][number];
type Wake = SeatDay["wakes"][number];
type Round = Wake["rounds"][number];
type Growth = TokenProfile["briefingGrowth"];

const ARENA_FILE = "arena.json";
const SEATS_FILE = "seats.json";
const CALLS_FILE = "llm_calls.jsonl";
const TRANSCRIPTS_DIR = "transcripts";

/** `perfidia-1@1.1.0` → `perfidia-1@1`. */
export function rulesetMajorOf(ruleset: string): string {
  const m = /^([a-z][a-z0-9-]*)@([0-9]+)(?:\.|$)/.exec(ruleset);
  if (m?.[1] === undefined || m[2] === undefined) {
    throw new UsageError(`not a ruleset id with a version: ${JSON.stringify(ruleset)}`);
  }
  return `${m[1]}@${m[2]}`;
}

/** The identity of a key (profiles match seats on it exactly). */
export const profileKeyText = (k: ProfileKey): string =>
  [
    k.provider,
    k.model,
    k.endpoint ?? "",
    k.effort,
    k.promptVariant,
    k.reminders,
    String(k.maxTokens),
    `p${k.promptVersion}`,
    k.rulesetMajor,
  ].join("|");

/** A short human label of a key. */
export const profileKeyLabel = (k: ProfileKey): string =>
  `${k.provider}:${k.model}${k.endpoint === null ? "" : `@${k.endpoint}`} ${k.effort} ${k.promptVariant} ${k.reminders} max_tokens ${k.maxTokens} p${k.promptVersion} ${k.rulesetMajor}`;

/** A key part as a file-name part. */
const fileSafe = (s: string): string => s.replace(/[^A-Za-z0-9.@-]/g, "-");

/** Byte order of two strings (deterministic sorts). */
const textOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A mean with one decimal, "-" over nothing. */
const meanText = (n: number, d: number): string => (d === 0 ? "-" : (n / d).toFixed(1));

/** The file name of a key's profile. */
export function profileFileName(k: ProfileKey): string {
  const model = k.endpoint === null ? k.model : `${k.model}@${k.endpoint}`;
  return `${[
    k.provider,
    model,
    k.effort,
    k.promptVariant,
    k.reminders,
    String(k.maxTokens),
    `p${k.promptVersion}`,
    k.rulesetMajor,
  ]
    .map(fileSafe)
    .join("_")}.json`;
}

/** A profile file as written: one seat-day per line, so diffs stay readable. */
export function profileText(p: TokenProfile): string {
  const days = p.seatDays.map((d) => `    ${JSON.stringify(d)}`).join(",\n");
  return [
    "{",
    `  "format": ${JSON.stringify(p.format)},`,
    `  "key": ${JSON.stringify(p.key)},`,
    `  "runs": ${JSON.stringify(p.runs)},`,
    p.seatDays.length === 0 ? `  "seatDays": [],` : `  "seatDays": [\n${days}\n  ],`,
    `  "briefingGrowth": ${JSON.stringify(p.briefingGrowth)}`,
    "}",
    "",
  ].join("\n");
}

function readJson(path: string, what: string): unknown {
  if (!existsSync(path)) throw new UsageError(`${path}: no ${what}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UsageError(`${path}: not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** The profiles of a directory, each validated; two files of one key are an error. */
export function loadProfiles(
  dir: string,
  o: { readonly required?: boolean } = {},
): { readonly path: string; readonly profile: TokenProfile }[] {
  if (!existsSync(dir)) {
    if (o.required === true) throw new UsageError(`--profiles ${dir}: no such directory`);
    return [];
  }
  if (!statSync(dir).isDirectory()) throw new UsageError(`--profiles ${dir}: not a directory`);
  const out: { readonly path: string; readonly profile: TokenProfile }[] = [];
  const seen = new Map<string, string>();
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .toSorted(textOrder);
  for (const name of names) {
    const path = join(dir, name);
    const parsed = TokenProfileSchema.safeParse(readJson(path, "profile"));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const at = issue?.path.map(String).join(".") ?? "";
      throw new UsageError(
        `${path}: not a ${TOKEN_PROFILE_FORMAT} file: ${at === "" ? "" : `${at}: `}${issue?.message ?? "invalid"}`,
      );
    }
    const key = profileKeyText(parsed.data.key);
    const twin = seen.get(key);
    if (twin !== undefined) {
      throw new UsageError(`${path} and ${twin} hold the same key (${key}): keep one`);
    }
    seen.set(key, path);
    out.push({ path, profile: parsed.data });
  }
  return out;
}

/**
 * The profiles a plan predicts from: `--profiles <dir>` (a missing directory is an error), the
 * default directory (missing: none), or none (`off`, or no flag: programmatic plans and tests).
 */
export function profilesFor(ref: string | undefined): TokenProfile[] {
  if (ref === undefined || ref === "off") return [];
  const required = resolve(ref) !== resolve(PROFILES_DIR);
  return loadProfiles(ref, { required }).map((p) => p.profile);
}

/** One run directory, read and validated. */
interface RunDir {
  readonly dir: string;
  readonly name: string;
  readonly report: ArenaReportAny;
  readonly seats: SeatsFile;
  readonly calls: readonly LlmLogLine[];
}

function readRunDir(dir: string): RunDir {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new UsageError(`${dir}: not a run directory`);
  }
  const report = ArenaReportAnySchema.safeParse(readJson(join(dir, ARENA_FILE), ARENA_FILE));
  if (!report.success) throw new UsageError(`${join(dir, ARENA_FILE)}: not an arena report`);
  const seats = SeatsFileSchema.safeParse(readJson(join(dir, SEATS_FILE), SEATS_FILE));
  if (!seats.success) throw new UsageError(`${join(dir, SEATS_FILE)}: not a seats file`);
  const path = join(dir, CALLS_FILE);
  if (!existsSync(path)) throw new UsageError(`${path}: no ${CALLS_FILE}`);
  const calls = readFileSync(path, "utf8")
    .split("\n")
    .filter((row) => row !== "")
    .map((row, i) => {
      let raw: unknown;
      try {
        raw = JSON.parse(row);
      } catch {
        throw new UsageError(`${path}: line ${i + 1} is not JSON`);
      }
      const parsed = LlmLogLineSchema.safeParse(raw);
      if (!parsed.success) throw new UsageError(`${path}: line ${i + 1} is not an LLM log line`);
      return parsed.data;
    });
  return { dir, name: basename(resolve(dir)), report: report.data, seats: seats.data, calls };
}

/** Complete game days a run played: to its end, or to its stop at a day boundary. */
function completeDays(r: ArenaReportAny): number {
  const covered = r.status === "ended" ? (r.endedAt ?? r.lastT) : r.lastT;
  return Math.floor(covered / DAY);
}

/** Why a run cannot be measured at all, or null. */
function ineligible(r: RunDir): string | null {
  const rep = r.report;
  if (rep.clock !== "lockstep") {
    return `its clock is ${rep.clock}: profiles measure lockstep runs`;
  }
  if (rep.status !== "ended" && rep.status !== "stopped") {
    return `its status is ${rep.status}${rep.reason === null ? "" : ` (${rep.reason})`}: only runs that ended, or stopped at a day boundary (--stop-after), are measured`;
  }
  if (rep.levelE?.ok !== true) return "its match log did not pass Level E";
  if (completeDays(rep) < 1) return "it played no complete game day";
  return null;
}

/** One attempt's tokens, summed over its usage entries. */
function roundOf(l: LlmCallLine): Round {
  let prompt = 0;
  let output = 0;
  let read = 0;
  let write = 0;
  for (const u of l.usage) {
    prompt += u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;
    output += u.output;
    read += u.cacheRead;
    write += u.cacheWrite5m + u.cacheWrite1h;
  }
  return {
    promptTokens: prompt,
    outputTokens: output,
    cacheReadTokens: read,
    cacheWriteTokens: write,
  };
}

const seatNo = (s: string): number => Number(s.slice(1));

interface Measured {
  readonly key: ProfileKey;
  readonly runs: { readonly run: string; readonly seed: number }[];
  readonly seatDays: SeatDay[];
}

/** The seat-days of a real run, by key; and what the profile cannot carry, as warnings. */
function measureRun(r: RunDir): { byKey: Map<string, Measured>; warnings: string[] } {
  const byKey = new Map<string, Measured>();
  const warnings: string[] = [];
  const days = completeDays(r.report);
  const major = rulesetMajorOf(r.report.ruleset);
  const llm = r.calls.filter((l): l is LlmCallLine => l.k === "llm_call");
  for (const s of r.seats.seats) {
    if (s.kind !== "llm" || s.provider === "fake") continue;
    const key: ProfileKey = {
      provider: s.provider,
      model: s.model,
      endpoint: s.endpoint ?? null,
      effort: s.effort,
      promptVariant: s.promptVariant ?? "system",
      reminders: s.reminders ?? "every-round",
      maxTokens: s.maxTokens,
      promptVersion: r.seats.promptVersion,
      rulesetMajor: major,
    };
    const handoff = r.calls.find((l): l is HandoffLine => l.k === "handoff" && l.seat === s.seat);
    const lastDay = handoff === undefined ? days : Math.min(days, Math.floor(handoff.t / DAY));
    const turns = new Map<number, { day: number; rounds: Round[] }>();
    let unusable = 0;
    let unusableNano = 0;
    for (const l of llm) {
      if (l.seat !== s.seat) continue;
      const day = Math.floor(l.t / DAY);
      const w = turns.get(l.turn) ?? { day, rounds: [] };
      turns.set(l.turn, { day: Math.min(w.day, day), rounds: [...w.rounds, roundOf(l)] });
      const tokens = l.usage.reduce(
        (n, u) => n + u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead + u.output,
        0,
      );
      if (tokens === 0 && l.costNanoUsd > 0) {
        unusable += 1;
        unusableNano += l.costNanoUsd;
      }
    }
    if (unusable > 0) {
      warnings.push(
        `${r.name} ${s.seat}: ${unusable} attempt(s) charged ${formatCents(unusableNano)} without usable token counts (the attempt bound): the profile counts them as 0 tokens`,
      );
    }
    const seatDays: SeatDay[] = [];
    for (let d = 0; d < lastDay; d += 1) {
      const wakes = [...turns.entries()]
        .filter(([, w]) => w.day === d)
        .toSorted(([a], [b]) => a - b)
        .map(([, w]) => ({ rounds: w.rounds }));
      seatDays.push({ run: r.name, seat: s.seat, day: d, wakes });
    }
    if (seatDays.length === 0) {
      warnings.push(
        `${r.name} ${s.seat}: no complete game day before its hand-off: nothing measured`,
      );
      continue;
    }
    const text = profileKeyText(key);
    const prev = byKey.get(text) ?? {
      key,
      runs: [{ run: r.name, seed: r.report.seed }],
      seatDays: [],
    };
    byKey.set(text, { ...prev, seatDays: [...prev.seatDays, ...seatDays] });
  }
  return { byKey, warnings };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The briefing text of a transcript line when it is the round-0 request of its turn. */
function briefingTextOf(v: unknown): string | null {
  if (!isRecord(v) || v.k !== "request" || v.round !== 0 || v.attempt !== 1) return null;
  const entries = v.entries;
  if (!Array.isArray(entries)) return null;
  const first: unknown = entries[0];
  if (!isRecord(first) || first.role !== "user" || !Array.isArray(first.parts)) return null;
  const part: unknown = first.parts[0];
  if (!isRecord(part) || part.kind !== "text" || typeof part.text !== "string") return null;
  return part.text;
}

/** The first round-0 request of a transcript file, as its briefing text (null: none). */
function briefingOfFile(path: string): string | null {
  if (!existsSync(path)) return null;
  for (const row of readFileSync(path, "utf8").split("\n")) {
    if (row === "") continue;
    try {
      const text = briefingTextOf(JSON.parse(row));
      if (text !== null) return text;
    } catch {
      return null;
    }
  }
  return null;
}

const utf8 = new TextEncoder();

/** Per game day, the briefing bytes and count of a fake run's round-0 requests; or why not. */
function briefingBytes(r: RunDir): Map<number, { bytes: number; n: number }> | string {
  const days = completeDays(r.report);
  if (days < GROWTH_DAYS) {
    return `a --fake run gives only the briefing growth, from at least ${GROWTH_DAYS} complete game days; it played ${days}`;
  }
  if (!existsSync(join(r.dir, TRANSCRIPTS_DIR))) {
    return "a --fake run gives the briefing growth from its transcripts, and it has none (--transcripts off)";
  }
  const out = new Map<number, { bytes: number; n: number }>();
  for (const l of r.calls) {
    if (l.k !== "llm_call" || l.round !== 0 || l.attempt !== 1 || l.kind !== "round") continue;
    const day = Math.floor(l.t / DAY);
    if (day >= days) continue;
    const text = briefingOfFile(join(r.dir, TRANSCRIPTS_DIR, l.seat, `t${l.turn}.jsonl`));
    if (text === null) continue;
    const prev = out.get(day) ?? { bytes: 0, n: 0 };
    out.set(day, { bytes: prev.bytes + utf8.encode(text).length, n: prev.n + 1 });
  }
  if (out.size < GROWTH_DAYS) {
    return `its transcripts hold round-0 briefings on ${out.size} game day(s), fewer than ${GROWTH_DAYS}`;
  }
  return out;
}

/** The growth table of pooled briefing sizes: mean bytes per day, as tokens. */
function growthTable(sums: ReadonlyMap<number, { bytes: number; n: number }>): Growth {
  return [...sums.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([day, s]) => ({
      day,
      briefingTokens: Math.ceil(Math.round(s.bytes / s.n) / BRIEFING_BYTES_PER_TOKEN),
    }));
}

export interface CalibratedProfile {
  readonly path: string;
  readonly profile: TokenProfile;
  /** Seat-days this call measured into it (0: only its growth changed). */
  readonly measured: number;
}

export interface CalibrateResult {
  readonly profiles: readonly CalibratedProfile[];
  readonly growth: readonly {
    readonly rulesetMajor: string;
    readonly runs: readonly string[];
    readonly table: Growth;
  }[];
  readonly skipped: readonly { readonly run: string; readonly reason: string }[];
  readonly warnings: readonly string[];
}

/**
 * `arena calibrate`: measures `dirs` into the profiles of `profilesDir` (created if needed) and
 * writes every profile it changed. Nothing is written when no run can be measured (a `UsageError`).
 */
export function calibrate(
  dirs: readonly string[],
  o: { readonly profilesDir: string },
): CalibrateResult {
  if (dirs.length === 0) throw new UsageError("give at least one run directory");
  const runs = dirs.map(readRunDir);
  const names = new Map<string, string>();
  for (const r of runs) {
    const twin = names.get(r.name);
    if (twin !== undefined) {
      throw new UsageError(
        `${r.dir} and ${twin} share the name ${r.name}: profiles name runs by their directory`,
      );
    }
    names.set(r.name, r.dir);
  }
  const skipped: { run: string; reason: string }[] = [];
  const warnings: string[] = [];
  const measured = new Map<string, Measured>();
  const growthSums = new Map<string, Map<number, { bytes: number; n: number }>>();
  const growthRuns = new Map<string, string[]>();
  for (const r of runs) {
    const why = ineligible(r);
    if (why !== null) {
      skipped.push({ run: r.name, reason: why });
      continue;
    }
    if (r.report.fake) {
      const bytes = briefingBytes(r);
      if (typeof bytes === "string") {
        skipped.push({ run: r.name, reason: bytes });
        continue;
      }
      const major = rulesetMajorOf(r.report.ruleset);
      const sums = growthSums.get(major) ?? new Map<number, { bytes: number; n: number }>();
      for (const [day, s] of bytes) {
        const prev = sums.get(day) ?? { bytes: 0, n: 0 };
        sums.set(day, { bytes: prev.bytes + s.bytes, n: prev.n + s.n });
      }
      growthSums.set(major, sums);
      growthRuns.set(major, [...(growthRuns.get(major) ?? []), r.name]);
      continue;
    }
    const m = measureRun(r);
    warnings.push(...m.warnings);
    if (m.byKey.size === 0) {
      skipped.push({ run: r.name, reason: "no LLM seat played a complete game day" });
      continue;
    }
    for (const [text, v] of m.byKey) {
      const prev = measured.get(text);
      measured.set(
        text,
        prev === undefined
          ? v
          : {
              key: v.key,
              runs: [...prev.runs, ...v.runs],
              seatDays: [...prev.seatDays, ...v.seatDays],
            },
      );
    }
  }
  const growth = new Map<string, Growth>(
    [...growthSums.entries()].map(([major, sums]) => [major, growthTable(sums)]),
  );
  if (measured.size === 0 && growth.size === 0) {
    const why = skipped.map((s) => `${s.run}: ${s.reason}`).join("; ");
    throw new UsageError(`nothing to calibrate (${why})`);
  }

  const existing = loadProfiles(o.profilesDir);
  const byText = new Map(existing.map((e) => [profileKeyText(e.profile.key), e]));
  const out: CalibratedProfile[] = [];
  const keys = new Set<string>([
    ...measured.keys(),
    ...existing
      .filter((e) => growth.has(e.profile.key.rulesetMajor))
      .map((e) => profileKeyText(e.profile.key)),
  ]);
  for (const text of [...keys].toSorted(textOrder)) {
    const m = measured.get(text);
    const old = byText.get(text);
    const key = m?.key ?? old?.profile.key;
    if (key === undefined) continue;
    const mine = new Set((m?.runs ?? []).map((r) => r.run));
    const seatDays = [
      ...(old?.profile.seatDays ?? []).filter((d) => !mine.has(d.run)),
      ...(m?.seatDays ?? []),
    ].toSorted(
      (a, b) => textOrder(a.run, b.run) || seatNo(a.seat) - seatNo(b.seat) || a.day - b.day,
    );
    const runList = [
      ...(old?.profile.runs ?? []).filter((r) => !mine.has(r.run)),
      ...(m?.runs ?? []),
    ].toSorted((a, b) => textOrder(a.run, b.run));
    const profile = TokenProfileSchema.parse({
      format: TOKEN_PROFILE_FORMAT,
      key,
      runs: runList,
      seatDays,
      briefingGrowth: growth.get(key.rulesetMajor) ?? old?.profile.briefingGrowth ?? [],
    });
    const path = old?.path ?? join(o.profilesDir, profileFileName(key));
    if (old === undefined && existsSync(path)) {
      throw new UsageError(`${path} exists and holds another key: move it away first`);
    }
    if (profile.briefingGrowth.length === 0) {
      warnings.push(
        `${profileKeyLabel(key)}: no briefing growth (no ${GROWTH_DAYS}-day --fake run measured for ${key.rulesetMajor}): a calibrated prediction keeps the measured prompt sizes on the days it did not measure (biased low); calibrate again with a ${GROWTH_DAYS}-day --fake run among the run directories`,
      );
    }
    out.push({ path, profile, measured: m?.seatDays.length ?? 0 });
  }
  for (const major of growth.keys()) {
    if (!out.some((p) => p.profile.key.rulesetMajor === major)) {
      warnings.push(
        `the briefing growth of ${major} was measured, but no profile of ${major} exists yet to keep it: give the ${GROWTH_DAYS}-day --fake run together with the real runs`,
      );
    }
  }
  if (out.length > 0) mkdirSync(o.profilesDir, { recursive: true });
  for (const p of out) writeFileSync(p.path, profileText(p.profile));
  return {
    profiles: out,
    growth: [...growth.entries()].map(([major, table]) => ({
      rulesetMajor: major,
      runs: growthRuns.get(major) ?? [],
      table,
    })),
    skipped,
    warnings,
  };
}

/** What a profile predicts from: `calibrated` from 3 independent seat-days, `measured-point` below. */
export const sourceOfProfile = (p: TokenProfile): "calibrated" | "measured-point" =>
  independentSeatDays(p) >= MIN_CALIBRATED_SEAT_DAYS ? "calibrated" : "measured-point";

/** A profile in one line: what it measured and the source it gives. */
export function profileSummary(p: TokenProfile): string {
  const days = [...new Set(p.seatDays.map((d) => d.day + 1))].toSorted((a, b) => a - b);
  const wakes = p.seatDays.flatMap((d) => d.wakes);
  const rounds = wakes.flatMap((w) => w.rounds);
  const sum = (f: (r: Round) => number): number => rounds.reduce((n, r) => n + f(r), 0);
  const prompt = sum((r) => r.promptTokens);
  return [
    `${p.seatDays.length} seat-day(s), ${independentSeatDays(p)} independent (run, day) (game days ${days.join(", ")}) from ${p.runs.map((r) => r.run).join(", ")}`,
    `source ${sourceOfProfile(p)}`,
    `wakes per seat-day ${meanText(wakes.length, p.seatDays.length)}`,
    `attempts per wake ${meanText(rounds.length, wakes.length)}`,
    `output tokens per attempt ${meanText(
      sum((r) => r.outputTokens),
      rounds.length,
    )}`,
    `cache reads ${prompt === 0 ? 0 : Math.round((100 * sum((r) => r.cacheReadTokens)) / prompt)}% of prompt tokens`,
    p.briefingGrowth.length === 0
      ? "no briefing growth"
      : `briefing growth over ${p.briefingGrowth.length} game days`,
  ].join(" · ");
}

/** `arena calibrate`'s report. */
export function formatCalibrate(r: CalibrateResult): string {
  const out: string[] = [];
  for (const s of r.skipped) out.push(`skipped ${s.run}: ${s.reason}`);
  for (const g of r.growth) {
    out.push(
      `briefing growth of ${g.rulesetMajor} from ${g.runs.join(", ")} (${BRIEFING_BYTES_PER_TOKEN} bytes per token, an assumption): ${g.table.map((d) => `day ${d.day + 1} ${d.briefingTokens}`).join(" · ")} tokens`,
    );
  }
  for (const p of r.profiles) {
    out.push(`profile ${p.path}`);
    out.push(`  ${profileKeyLabel(p.profile.key)}`);
    out.push(
      `  ${p.measured > 0 ? `+${p.measured} seat-day(s) measured now; ` : "growth updated; "}${profileSummary(p.profile)}`,
    );
  }
  for (const w of r.warnings) out.push(`warning: ${w}`);
  return `${out.join("\n")}\n`;
}
