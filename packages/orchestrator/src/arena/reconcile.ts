import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { UsageError, writeFileAtomic } from "@perfidia/sim";
import {
  ArenaReportSchema,
  LlmLogLineSchema,
  ReconcileFileSchema,
  ReconcileInputSchema,
  type ArenaReport,
  type LlmLogLine,
  type ReconcileFile,
  type ReconcileInput,
} from "../log/schema.ts";
import { formatCents, priceFor, usdToNano } from "../model/prices.ts";
import { exit4Met } from "./report.ts";

// `arena reconcile <run-dir>` (phase-4 design §5.6): the ledger against the provider's usage pages.
// The owner reads, at least 48 hours after the run's wall end (usage graphs can lag a day), the
// pre-tax usage cost of the run's wall window from a dedicated workspace, project or key, and the
// token counts per model where the page shows them, into a `perfidia-reconcile-input/1` file (or
// `--usd provider=12.34`). The check, per provider:
//
// 1. tokens first, within ±2% per model and kind: this separates an accounting bug from a wrong
//    price card;
// 2. then dollars: the provider's figure must lie in `[ledger − estimatedExcess − tol, ledger +
//    tol]`, `tol = max(3%, $0.25)`, where `estimatedExcess` is the conservative part of estimated
//    (broken-stream) lines, their output, which may never have been generated.
//
// Platform fees and taxes are reported apart and left out of the comparison. The ledger is every
// `llm_call` and `preflight` line of the run (a carried earlier run is reconciled on its own).
// It writes `reconcile.json`, fills `exit4.reconciled` in `arena.json`, and exits 0 within tolerance
// or 4 outside it.

export const RECONCILE_FILE = "reconcile.json";
/** The exit code of a reconciliation outside tolerance. */
export const EXIT_RECONCILE = 4;
/** Hours after the run's wall end before usage pages are complete enough. */
export const RECONCILE_AFTER_HOURS = 48;
/** The USD tolerance: 3% of the ledger, at least $0.25. */
export const TOLERANCE_PERMILLE = 30;
export const TOLERANCE_FLOOR_NANO_USD = 250_000_000;
/** Token counts must agree within 2% (per model and kind). */
export const TOKEN_TOLERANCE_PERMILLE = 20;

type Kind = "input" | "cacheWrite" | "cacheRead" | "output";
const KINDS: readonly Kind[] = ["input", "cacheWrite", "cacheRead", "output"];

interface ProviderLedger {
  nanoUsd: number;
  excess: number;
  readonly tokens: Map<string, Record<Kind, number>>;
}

function emptyLedger(): ProviderLedger {
  return { nanoUsd: 0, excess: 0, tokens: new Map<string, Record<Kind, number>>() };
}

/** The ledger of a run per provider: logged costs, the estimated excess, tokens per model. */
export function ledgerOf(lines: readonly LlmLogLine[]): Map<string, ProviderLedger> {
  const out = new Map<string, ProviderLedger>();
  for (const l of lines) {
    if (l.k !== "llm_call" && l.k !== "preflight") continue;
    const p = out.get(l.provider) ?? emptyLedger();
    p.nanoUsd += l.costNanoUsd;
    for (const u of l.usage) {
      const t = p.tokens.get(u.model) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
      t.input += u.input;
      t.cacheWrite += u.cacheWrite5m + u.cacheWrite1h;
      t.cacheRead += u.cacheRead;
      t.output += u.output;
      p.tokens.set(u.model, t);
      if (u.estimated) {
        const price = priceFor({
          model: u.model,
          kind: u.kind,
          tokens: u,
          estimated: true,
        }).price;
        p.excess += u.output * price.output;
      }
    }
    out.set(l.provider, p);
  }
  return out;
}

/** The reconciliation of `lines` against `input` (pure). */
export function reconcileRun(
  lines: readonly LlmLogLine[],
  input: ReconcileInput,
  wall: { readonly start: string | null; readonly end: string | null },
  nowMs: number,
): ReconcileFile {
  const ledger = ledgerOf(lines);
  const given = new Map(input.providers.map((p) => [p.provider, p]));
  const providers = [...new Set([...ledger.keys(), ...given.keys()])].toSorted((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const rows = providers.map((provider): ReconcileFile["providers"][number] => {
    const l = ledger.get(provider) ?? emptyLedger();
    const g = given.get(provider);
    const reported = g === undefined ? 0 : usdToNano(g.usd);
    const fees = g?.feesUsd === undefined ? 0 : usdToNano(g.feesUsd);
    const tol = Math.max(
      Math.ceil((l.nanoUsd * TOLERANCE_PERMILLE) / 1000),
      TOLERANCE_FLOOR_NANO_USD,
    );
    const low = Math.max(0, l.nanoUsd - l.excess - tol);
    const high = l.nanoUsd + tol;
    const usdOk = reported >= low && reported <= high;
    const tokens: ReconcileFile["providers"][number]["tokens"] = [];
    for (const t of g?.tokens ?? []) {
      const own = l.tokens.get(t.model) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
      for (const kind of KINDS) {
        const r = t[kind];
        if (r === undefined) continue;
        const mine = own[kind];
        tokens.push({
          model: t.model,
          kind,
          ledger: mine,
          reported: r,
          ok: Math.abs(r - mine) * 1000 <= TOKEN_TOLERANCE_PERMILLE * mine,
        });
      }
    }
    const tokensOk = tokens.length === 0 ? null : tokens.every((t) => t.ok);
    return {
      provider,
      ledgerNanoUsd: l.nanoUsd,
      estimatedExcessNanoUsd: l.excess,
      reportedNanoUsd: reported,
      feesNanoUsd: fees,
      toleranceNanoUsd: tol,
      lowNanoUsd: low,
      highNanoUsd: high,
      usdOk,
      tokens,
      tokensOk,
      ok: usdOk && tokensOk !== false,
    };
  });
  const endMs = wall.end === null ? Number.NaN : Date.parse(wall.end);
  const hours = Number.isFinite(endMs) ? Math.round(((nowMs - endMs) / 3_600_000) * 10) / 10 : null;
  return ReconcileFileSchema.parse({
    format: "perfidia-reconcile/1",
    wall: { start: wall.start, end: wall.end },
    hoursAfterEnd: hours,
    early: hours !== null && hours < RECONCILE_AFTER_HOURS,
    providers: rows,
    ok: rows.every((r) => r.ok),
  });
}

/** The provider figures of `--usd anthropic=12.34 …`. */
export function inputFromFlags(usd: readonly string[]): ReconcileInput {
  const providers = usd.map((text) => {
    const m = /^([a-z][a-z0-9-]*)=([0-9]+(?:\.[0-9]+)?)$/.exec(text.trim());
    if (m?.[1] === undefined || m[2] === undefined) {
      throw new UsageError(`--usd ${text}: write provider=usd, such as anthropic=12.34`);
    }
    return { provider: m[1], usd: m[2] };
  });
  const parsed = ReconcileInputSchema.safeParse({
    format: "perfidia-reconcile-input/1",
    providers,
  });
  if (!parsed.success) {
    throw new UsageError(`--usd: ${parsed.error.issues[0]?.message ?? "invalid amounts"}`);
  }
  return parsed.data;
}

/** Reads a `perfidia-reconcile-input/1` file. */
export function readInput(path: string): ReconcileInput {
  if (!existsSync(path)) throw new UsageError(`--input ${path}: no such file`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UsageError(`--input ${path}: not JSON`);
  }
  const parsed = ReconcileInputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UsageError(
      `--input ${path}: not a perfidia-reconcile-input/1 file: ${issue?.path.map(String).join(".") ?? ""} ${issue?.message ?? ""}`,
    );
  }
  return parsed.data;
}

function runFiles(dir: string): { lines: LlmLogLine[]; arena: ArenaReport; arenaPath: string } {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new UsageError(`${dir}: not a run directory`);
  }
  const callsPath = join(dir, "llm_calls.jsonl");
  const arenaPath = join(dir, "arena.json");
  if (!existsSync(callsPath) || !existsSync(arenaPath)) {
    throw new UsageError(`${dir}: no llm_calls.jsonl or arena.json (not an arena run directory)`);
  }
  const lines = readFileSync(callsPath, "utf8")
    .split("\n")
    .filter((r) => r !== "")
    .map((r, i) => {
      const parsed = LlmLogLineSchema.safeParse(JSON.parse(r));
      if (!parsed.success)
        throw new UsageError(`${callsPath}: line ${i + 1} is not an LLM log line`);
      return parsed.data;
    });
  const raw: unknown = JSON.parse(readFileSync(arenaPath, "utf8"));
  const parsed = ArenaReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `${arenaPath}: not a perfidia-arena/2 report (a run from before phase 4 has no budget to reconcile)`,
    );
  }
  return { lines, arena: parsed.data, arenaPath };
}

/** The reconciliation as text. */
export function formatReconcile(r: ReconcileFile): string {
  const out: string[] = [];
  for (const p of r.providers) {
    out.push(
      `${p.provider}: ledger ${formatCents(p.ledgerNanoUsd)} (estimated excess ${formatCents(p.estimatedExcessNanoUsd)}), reported ${formatCents(p.reportedNanoUsd)}${p.feesNanoUsd > 0 ? ` (+ fees ${formatCents(p.feesNanoUsd)}, left out)` : ""}, accepted ${formatCents(p.lowNanoUsd)}–${formatCents(p.highNanoUsd)}: ${p.usdOk ? "ok" : "OUTSIDE"}`,
    );
    for (const t of p.tokens) {
      out.push(
        `  ${t.model} ${t.kind}: ledger ${t.ledger}, reported ${t.reported}: ${t.ok ? "ok" : "OFF by more than 2%"}`,
      );
    }
  }
  out.push(`reconciled: ${r.ok ? "within tolerance" : "OUTSIDE tolerance (exit 4)"}`);
  return `${out.join("\n")}\n`;
}

/**
 * Reconciles the run in `dir`: writes `reconcile.json`, fills `exit4.reconciled` (and `met`) in
 * `arena.json`, and returns the file. `nowMs`: the wall clock (the 48-hour check).
 */
export function reconcileDir(dir: string, input: ReconcileInput, nowMs: number): ReconcileFile {
  const { lines, arena, arenaPath } = runFiles(dir);
  const file = reconcileRun(lines, input, arena.budget.wall, nowMs);
  writeFileAtomic(join(dir, RECONCILE_FILE), `${JSON.stringify(file, null, 2)}\n`);
  const parts = { ...arena.exit4, reconciled: file.ok };
  const updated: ArenaReport = ArenaReportSchema.parse({
    ...arena,
    exit4: { ...parts, met: exit4Met(parts) },
  });
  writeFileAtomic(arenaPath, `${JSON.stringify(updated, null, 2)}\n`);
  return file;
}
