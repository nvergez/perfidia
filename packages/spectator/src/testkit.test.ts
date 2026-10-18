// I/O helpers for the spectator tests (the only test files allowed to read files, with
// `architecture.test.ts`): the committed goldens of the sim package, and fake arena runs generated
// once per test process through the orchestrator (a dev dependency) into temporary run directories,
// with their side files. A fake run's LLM seats are bot-backed fake models; `secrets` plants a
// refusal explanation, an error message and request ids that must never reach a spectator, and
// `expectNoSecrets` checks a served value for them. No tests here.

import { afterAll, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeAdapter,
  ModelError,
  arenaEnv,
  botBrain,
  planArena,
  runArena,
  type Brain,
} from "@perfidia/orchestrator";
import { idKeyFromSeed } from "@perfidia/engine/core";
import {
  LlmLogLineSchema,
  LogLineSchema,
  ReplyLineSchema,
  type LlmLogLine,
  type LogLine,
  type ReplyLine,
} from "@perfidia/protocol";

export const GOLDEN_DIR = join(import.meta.dir, "..", "..", "sim", "fixtures", "golden");
export const WAR_GOLDEN = "perfidia-1@1.1.0/lockstep-6p-6d-war.jsonl.gz";

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The rows of a JSONL text (a trailing newline ends the last row). */
export function rows(text: string): string[] {
  const out = text.split("\n");
  if (out.at(-1) === "") out.pop();
  return out;
}

/** A log file's text, gunzipped for `.gz`. */
export function logText(path: string): string {
  const bytes = readFileSync(path);
  return path.endsWith(".gz")
    ? new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(bytes)))
    : new TextDecoder().decode(bytes);
}

export function parseLog(text: string): LogLine[] {
  return rows(text).map((row) => LogLineSchema.parse(JSON.parse(row)));
}

/** Every committed golden, `ruleset/file`, sorted. */
export function goldenNames(): string[] {
  return readdirSync(GOLDEN_DIR)
    .toSorted(byText)
    .flatMap((d) =>
      readdirSync(join(GOLDEN_DIR, d))
        .toSorted(byText)
        .map((f) => `${d}/${f}`),
    );
}

const goldens = new Map<string, LogLine[]>();

/** A golden's lines, read once per test file. */
export function golden(name: string): LogLine[] {
  let lines = goldens.get(name);
  if (lines === undefined) {
    lines = parseLog(logText(join(GOLDEN_DIR, name)));
    goldens.set(name, lines);
  }
  return lines;
}

export interface FakeRun {
  readonly dir: string;
  /** `match.jsonl` as written. */
  readonly text: string;
  readonly lines: LogLine[];
  readonly calls: LlmLogLine[];
  readonly replies: ReplyLine[];
  readonly seats: unknown;
  readonly arena: unknown;
}

export interface FakeRunOptions {
  readonly days: number;
  readonly seed: number;
  /** Plants a refusal (with an explanation), a failed attempt (with a message) and request ids. */
  readonly secrets?: boolean;
}

/** The texts `secrets` plants in `llm_calls.jsonl`. */
export const PLANTED = {
  explanation: "PLANTED-REFUSAL-EXPLANATION",
  error: "PLANTED-ERROR-MESSAGE",
  requestId: "req_PLANTED",
} as const;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A brain that refuses p1's turn 2 and fails p2's turn 3 once (a retryable 529), else the bot. */
function planting(inner: Brain, seat: string): Brain {
  let failed = false;
  return (req, n) => {
    const m = req.meta;
    if (seat === "p1" && m.turn === 2 && m.round === 0) {
      return {
        stop: "refusal",
        refusal: { category: "cyber", explanation: PLANTED.explanation, recommendedModel: null },
      };
    }
    if (seat === "p2" && m.turn === 3 && m.round === 0 && !failed) {
      failed = true;
      return new ModelError("overloaded", PLANTED.error, {
        status: 529,
        requestId: PLANTED.requestId,
        retryAfterMs: 10,
      });
    }
    return inner(req, n);
  };
}

const runs = new Map<string, Promise<FakeRun>>();

/** A fake arena run (perfidia-1@1.1.0, the default lineup), generated once per process and key. */
export function fakeRun(o: FakeRunOptions): Promise<FakeRun> {
  const key = `${o.days}:${o.seed}:${o.secrets === true ? 1 : 0}`;
  let run = runs.get(key);
  if (run === undefined) {
    run = generate(o);
    runs.set(key, run);
  }
  return run;
}

async function generate(o: FakeRunOptions): Promise<FakeRun> {
  const base = mkdtempSync(join(tmpdir(), "perfidia-spectator-"));
  dirs.push(base);
  const dir = join(base, "run");
  const plan = planArena(
    { ruleset: "perfidia-1@1.1.0", fake: true, seed: o.seed, idKey: "seed", days: o.days },
    arenaEnv({}),
  );
  const io = { out: (): void => undefined, err: (): void => undefined };
  await runArena(plan, {
    dir,
    io,
    quiet: true,
    ...(o.secrets === true
      ? {
          adapterFor: (s, spec, ctx) =>
            new FakeAdapter(
              spec,
              planting(
                botBrain({ label: s.brain, seat: s.seat, seed: ctx.seed, model: s.model }),
                s.seat,
              ),
            ),
        }
      : {}),
  });
  const text = logText(join(dir, "match.jsonl"));
  const read = (name: string): string => readFileSync(join(dir, name), "utf8");
  return {
    dir,
    text,
    lines: parseLog(text),
    calls: rows(read("llm_calls.jsonl")).map((r) => LlmLogLineSchema.parse(JSON.parse(r))),
    replies: rows(read("replies.jsonl")).map((r) => ReplyLineSchema.parse(JSON.parse(r))),
    seats: JSON.parse(read("seats.json")) as unknown,
    arena: JSON.parse(read("arena.json")) as unknown,
  };
}

export interface Secrets {
  readonly idKey: string;
  readonly seed: number;
  /** Other texts that must not appear (planted request ids, error messages, …). */
  readonly planted?: readonly string[];
}

/** Every object key of a JSON value, at any depth. */
function keysOf(value: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

export function expectNoSecrets(served: unknown, s: Secrets): void {
  const text = JSON.stringify(served);
  expect(text.includes(s.idKey)).toBe(false);
  expect(text.includes(idKeyFromSeed(s.seed))).toBe(false);
  expect(text.includes("transcripts/")).toBe(false);
  for (const p of s.planted ?? []) expect([p, text.includes(p)]).toEqual([p, false]);
  const keys = keysOf(JSON.parse(text), new Set());
  for (const k of keys) {
    // The wall-clock keys of the log and side lines (`wallStart` is served as the match's start).
    const wall = k === "wallMs" || k === "wallEnd";
    expect([k, k === "seed" || k === "idKey" || wall]).toEqual([k, false]);
  }
}
