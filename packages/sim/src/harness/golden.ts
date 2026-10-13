import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyLog, type AnyRuleset } from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import {
  Hash64Schema,
  Sha256Schema,
  z,
  type Hash64,
  type LogLine,
  type Sha256,
} from "@perfidia/protocol";
import { ViewHasher, rulesetFingerprint } from "./fingerprint.ts";
import { jsonlText, writeJsonl } from "./jsonl.ts";
import { readLog } from "./reader.ts";
import { resimProblem, resimulate } from "./match.ts";
import { normalisedText } from "./normalise.ts";

// The freeze guard's files (docs/architecture.md §13.5, §13.6): golden logs under
// `<fixtures>/golden/<ref>/<name>.jsonl` (gzip as `.jsonl.gz` above 1 MB) and `fingerprints.json`,
// mapping each ref to its artefact fingerprint, and for each of its goldens the final hash and the
// fingerprint of what the ruleset's hooks showed every seat at every checkpoint (`views`). The
// check replays every golden at Level E (and Level G when its controllers are bots of this build)
// and recomputes the fingerprints; the writers only ever add files and entries. Both take the fixtures
// directory and the ruleset list as arguments, so a test can run them on a tampered copy or a
// modified descriptor.

export const GOLDEN_DIR = "golden";
export const FINGERPRINTS_FILE = "fingerprints.json";
/** Goldens larger than this are written gzip-compressed (§13.5). */
export const GZIP_ABOVE_BYTES = 1_000_000;

const GOLDEN_NAME = /^[a-z0-9][a-z0-9-]*$/;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const FingerprintEntrySchema = z.strictObject({
  artefacts: Sha256Schema,
  /** Golden name → final hash at Level E. */
  goldens: z.record(z.string(), Hash64Schema),
  /** Golden name → fingerprint of the hooks' views at its checkpoints (`ViewHasher`). */
  views: z.record(z.string(), Sha256Schema),
});
export type FingerprintEntry = z.infer<typeof FingerprintEntrySchema>;
export const FingerprintsSchema = z.record(z.string(), FingerprintEntrySchema);
export type Fingerprints = z.infer<typeof FingerprintsSchema>;

export interface GoldenFile {
  readonly ref: string;
  readonly name: string;
  readonly path: string;
}

/** A golden, or a fingerprint entry, that already exists: the writers never rewrite one. */
export class GoldenExists extends Error {
  constructor(what: string) {
    super(`${what} already exists; goldens and fingerprints are append-only (§13.5, §13.6)`);
    this.name = "GoldenExists";
  }
}

/** Every golden under `<fixtures>/golden`, sorted by ref then name. */
export function listGoldens(fixturesDir: string): GoldenFile[] {
  const root = join(fixturesDir, GOLDEN_DIR);
  if (!existsSync(root)) return [];
  const out: GoldenFile[] = [];
  for (const ref of readdirSync(root).toSorted(byCodeUnit)) {
    const dir = join(root, ref);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).toSorted(byCodeUnit)) {
      const m = /^(.+)\.jsonl(\.gz)?$/.exec(file);
      if (m?.[1] !== undefined) out.push({ ref, name: m[1], path: join(dir, file) });
    }
  }
  return out;
}

/** The fingerprints file, or `{}` when there is none yet. */
export function readFingerprints(fixturesDir: string): Fingerprints {
  const path = join(fixturesDir, FINGERPRINTS_FILE);
  if (!existsSync(path)) return {};
  return FingerprintsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function writeFingerprints(fixturesDir: string, fp: Fingerprints): void {
  mkdirSync(fixturesDir, { recursive: true });
  const sorted: unknown = JSON.parse(canonicalJson(fp));
  writeFileSync(join(fixturesDir, FINGERPRINTS_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** The path a new golden is written to: `.jsonl`, or `.jsonl.gz` above 1 MB. */
export function goldenPath(fixturesDir: string, ref: string, name: string, bytes: number): string {
  const ext = bytes > GZIP_ABOVE_BYTES ? ".jsonl.gz" : ".jsonl";
  return join(fixturesDir, GOLDEN_DIR, ref, `${name}${ext}`);
}

/**
 * Adds golden `name` of `ref`; refuses (`GoldenExists`) when one exists under that name, plain or
 * gzipped, whatever its content. Returns the path written.
 */
export function addGolden(
  fixturesDir: string,
  ref: string,
  name: string,
  lines: readonly LogLine[],
): string {
  if (!GOLDEN_NAME.test(name))
    throw new Error(`golden name ${name}: lowercase letters, digits and '-'`);
  const header = lines[0];
  if (header?.k !== "header" || header.setup.ruleset !== ref) {
    throw new Error(`golden ${ref}/${name}: the log's header must name ${ref}`);
  }
  for (const ext of [".jsonl", ".jsonl.gz"]) {
    if (existsSync(join(fixturesDir, GOLDEN_DIR, ref, `${name}${ext}`))) {
      throw new GoldenExists(`golden ${ref}/${name}`);
    }
  }
  const path = goldenPath(fixturesDir, ref, name, Buffer.byteLength(jsonlText(lines)));
  writeJsonl(path, lines);
  return path;
}

/**
 * Final hash of a golden at Level E and the fingerprint of the hooks' views at its checkpoints, or
 * the divergence that stopped it.
 */
function levelE(
  lines: readonly LogLine[],
  rulesets: readonly AnyRuleset[],
): {
  readonly hash: Hash64 | null;
  readonly views: Sha256 | null;
  readonly problem: string | null;
} {
  const hasher = new ViewHasher();
  const report = verifyLog(lines, (ref) => rulesets.find((rs) => rs.ref === ref), {
    onCheckpoint: (_hour, r) => hasher.add(r),
  });
  if (report.ok) return { hash: report.finalHash, views: hasher.digest(), problem: null };
  const d = report.divergence;
  return {
    hash: null,
    views: null,
    problem:
      d === undefined
        ? "Level E failed"
        : `Level E: ${d.kind} divergence at t = ${d.t}${d.n === undefined ? "" : ` (n ${d.n})`}${d.hour === undefined ? "" : ` (hour ${d.hour})`}: expected ${d.expected.slice(0, 200)}, got ${d.actual.slice(0, 200)}`,
  };
}

/**
 * Adds a fingerprint entry for every ref of `rulesets` that has none (its artefacts and the final
 * hash of each of its goldens), and the final hash of every golden an existing entry lacks. Never
 * changes a value already there. Returns what it added (`ref` or `ref/name`).
 */
export function addFingerprints(fixturesDir: string, rulesets: readonly AnyRuleset[]): string[] {
  const fp = readFingerprints(fixturesDir);
  const added: string[] = [];
  const goldens = listGoldens(fixturesDir);
  for (const rs of rulesets) {
    let entry = fp[rs.ref];
    if (entry === undefined) {
      entry = { artefacts: rulesetFingerprint(rs), goldens: {}, views: {} };
      fp[rs.ref] = entry;
      added.push(rs.ref);
    }
    for (const g of goldens.filter((x) => x.ref === rs.ref)) {
      if (Object.hasOwn(entry.goldens, g.name)) continue;
      const { hash, views, problem } = levelE(readLog(g.path), rulesets);
      if (hash === null || views === null)
        throw new Error(`golden ${g.ref}/${g.name} does not replay: ${problem ?? ""}`);
      entry.goldens[g.name] = hash;
      entry.views[g.name] = views;
      added.push(`${g.ref}/${g.name}`);
    }
  }
  if (added.length > 0) writeFingerprints(fixturesDir, fp);
  return added;
}

export interface GoldenCheck {
  readonly ref: string;
  readonly name: string;
  readonly finalHash: Hash64 | null;
  readonly levelG: "pass" | "fail" | "skipped";
}

export interface GoldenReport {
  readonly ok: boolean;
  readonly problems: string[];
  readonly goldens: GoldenCheck[];
  /** Recomputed artefact fingerprints, by ref. */
  readonly fingerprints: Record<string, Sha256>;
}

/** The first line where two texts differ, 1-based, or null when they are equal. */
function firstDifference(a: string, b: string): number | null {
  if (a === b) return null;
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) if (la[i] !== lb[i]) return i + 1;
  return null;
}

/**
 * The freeze guard (§13.5, §13.6): every golden replays at Level E with the final hash its
 * fingerprint entry records, and re-simulates byte for byte (normalised) at Level G when it
 * replays, its ruleset is one of `rulesets`, its controllers are bots of this build and its clock
 * is reproducible (`levelG: false` skips it; a re-simulation that throws is a problem of that
 * golden); every fingerprint entry of a ref of `rulesets` matches the recomputed artefacts, and
 * every golden it records is still on disk; every published ref of `rulesets` has at least one
 * golden and an entry. `ok` when there is no problem; the check itself never throws on a golden.
 * `only` restricts the goldens replayed, and those whose presence is checked, to the ones it
 * accepts (a test that tampers with one golden need not replay them all); the artefact
 * fingerprints are always checked.
 */
export async function checkGoldens(
  fixturesDir: string,
  rulesets: readonly AnyRuleset[],
  o: { readonly levelG?: boolean; readonly only?: (ref: string, name: string) => boolean } = {},
): Promise<GoldenReport> {
  const problems: string[] = [];
  const checks: GoldenCheck[] = [];
  const fp = readFingerprints(fixturesDir);
  const fingerprints: Record<string, Sha256> = {};
  for (const rs of rulesets) fingerprints[rs.ref] = rulesetFingerprint(rs);

  const only = o.only ?? ((): boolean => true);
  const files = listGoldens(fixturesDir);
  for (const g of files.filter((x) => only(x.ref, x.name))) {
    const where = `golden ${g.ref}/${g.name}`;
    let lines: LogLine[];
    try {
      lines = readLog(g.path);
    } catch (error) {
      problems.push(`${where}: ${errorText(error)}`);
      checks.push({ ref: g.ref, name: g.name, finalHash: null, levelG: "skipped" });
      continue;
    }
    const header = lines[0];
    if (header?.k !== "header" || header.setup.ruleset !== g.ref) {
      problems.push(`${where}: its header does not name ${g.ref}`);
    }
    const e = levelE(lines, rulesets);
    if (e.problem !== null) problems.push(`${where}: ${e.problem}`);
    const recorded = fp[g.ref]?.goldens[g.name];
    if (recorded === undefined) problems.push(`${where}: no final hash in ${FINGERPRINTS_FILE}`);
    else if (e.hash !== null && e.hash !== recorded) {
      problems.push(`${where}: final hash ${e.hash}, ${FINGERPRINTS_FILE} records ${recorded}`);
    }
    const views = fp[g.ref]?.views[g.name];
    if (views === undefined) {
      if (recorded !== undefined) {
        problems.push(`${where}: no views fingerprint in ${FINGERPRINTS_FILE}`);
      }
    } else if (e.views !== null && e.views !== views) {
      problems.push(
        `${where}: what the ruleset's hooks show at its checkpoints changed (${views} recorded, ${e.views} now): a published version must not change (§3.5)`,
      );
    }
    // Level G re-runs a golden that replays (a failed Level E is already a problem) of a ruleset of
    // `rulesets`; a re-simulation that cannot run is a problem of this golden, not of the check.
    let levelG: GoldenCheck["levelG"] = "skipped";
    if (
      (o.levelG ?? true) &&
      header?.k === "header" &&
      e.problem === null &&
      rulesets.some((rs) => rs.ref === header.setup.ruleset) &&
      resimProblem(header, lines) === null
    ) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one re-simulation at a time keeps memory bounded
        const again = await resimulate(lines, { rulesets });
        const diff = firstDifference(normalisedText(lines), normalisedText(again.lines));
        levelG = diff === null ? "pass" : "fail";
        if (diff !== null) problems.push(`${where}: Level G re-simulation differs at line ${diff}`);
      } catch (error) {
        levelG = "fail";
        problems.push(`${where}: Level G re-simulation failed: ${errorText(error)}`);
      }
    }
    checks.push({ ref: g.ref, name: g.name, finalHash: e.hash, levelG });
  }

  for (const [ref, entry] of Object.entries(fp)) {
    const now = fingerprints[ref];
    if (now === undefined) {
      problems.push(`${FINGERPRINTS_FILE}: ${ref} is not a ruleset of this build`);
    } else if (now !== entry.artefacts) {
      problems.push(
        `${FINGERPRINTS_FILE}: ${ref}'s artefacts changed (${entry.artefacts} recorded, ${now} now): a published version must not change (§3.5)`,
      );
    }
    // Goldens are append-only (§13.5): a recorded golden must still be on disk.
    for (const name of Object.keys(entry.goldens).toSorted(byCodeUnit)) {
      if (!only(ref, name)) continue;
      if (!files.some((g) => g.ref === ref && g.name === name)) {
        problems.push(`golden ${ref}/${name} is recorded in ${FINGERPRINTS_FILE} but missing`);
      }
    }
  }
  for (const rs of rulesets.filter((x) => x.status === "published")) {
    if (!files.some((g) => g.ref === rs.ref)) problems.push(`${rs.ref} has no golden`);
    if (fp[rs.ref] === undefined) problems.push(`${rs.ref} has no entry in ${FINGERPRINTS_FILE}`);
  }
  return { ok: problems.length === 0, problems, goldens: checks, fingerprints };
}

/** A string-valued record of an older fingerprints file, read leniently (any older format). */
function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * The append-only rule of §13.5 and §13.6 between an older fingerprints file (`base`, e.g. the
 * base branch's) and the current one: every ref, artefact fingerprint, golden final hash and views
 * fingerprint of `base` is still there, unchanged. New refs and new golden entries are allowed.
 * Returns the problems, each naming the entry; `base` is read leniently, whatever its format.
 */
export function appendOnlyProblems(base: unknown, head: Fingerprints): string[] {
  const problems: string[] = [];
  if (base === null || typeof base !== "object" || Array.isArray(base)) {
    return [`the older ${FINGERPRINTS_FILE} is not a JSON object`];
  }
  for (const [ref, old] of Object.entries(base).toSorted(([a], [b]) => byCodeUnit(a, b))) {
    const now = head[ref];
    if (now === undefined) {
      problems.push(`${FINGERPRINTS_FILE}: the entry of ${ref} was removed`);
      continue;
    }
    if (old === null || typeof old !== "object" || Array.isArray(old)) continue;
    const artefacts: unknown = Reflect.get(old, "artefacts");
    if (typeof artefacts === "string" && artefacts !== now.artefacts) {
      problems.push(
        `${FINGERPRINTS_FILE}: ${ref}'s artefacts were rewritten (${artefacts} → ${now.artefacts})`,
      );
    }
    for (const key of ["goldens", "views"] as const) {
      const recorded = stringRecord(Reflect.get(old, key));
      for (const name of Object.keys(recorded).toSorted(byCodeUnit)) {
        const value = Object.hasOwn(now[key], name) ? now[key][name] : undefined;
        if (value === undefined) {
          problems.push(`${FINGERPRINTS_FILE}: ${ref}'s ${key} entry ${name} was removed`);
        } else if (value !== recorded[name]) {
          problems.push(
            `${FINGERPRINTS_FILE}: ${ref}'s ${key} entry ${name} was rewritten (${recorded[name]} → ${value})`,
          );
        }
      }
    }
  }
  return problems;
}
