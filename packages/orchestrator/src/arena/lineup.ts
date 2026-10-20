import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "@perfidia/sim";
import { LineupSchema, type Lineup } from "../log/schema.ts";
import { FALLBACK_CAPABLE } from "../model/anthropic.ts";

// Lineups (phase-4 design §4.1, §3.9): a `perfidia-lineup/1` file names every seat (model, effort,
// profile, or bot) with the lineup-wide limits and the match budget. `--lineup <name>` reads a
// preset from `packages/orchestrator/lineups/<name>.json`; anything with a `/` or a `.json` suffix
// is a path. Pass 1a ships the Claude presets (`claude-duo`, the exit lineup of the Claude form, and
// `claude-family`); Pass 1b the cross-provider ones: `budget-mix` (the exit lineup of the
// cross-provider form), `mid-tier` (the first comparison), `mid-tier-flash` and `frontier`, all
// with the owner's comparison defaults (medium effort, fallbacks off, ZDR, 32,768 output tokens,
// last-round reminders, a 15-minute attempt timeout). Their non-Anthropic seats run on `--fake`
// until Pass 2's adapters.
//
// The defaults of §3.9, for lineup seats without their own values:
// - seat cap = 2 × the seat's predicted high, at least $5 (the sum of the caps may exceed the
//   budget: the match budget is the guarantee);
// - wake cap = 20 × the model's central wake cost, at least $0.10;
// - fallbacks: `off` for Claude Sonnet 5.5 (its fallback, Claude Sonnet 5, rejects the operator
//   entries), `default` for Claude Opus 5.5; models without server-side fallbacks record `off`.

/** Where the presets live. */
export const LINEUPS_DIR = join(import.meta.dir, "..", "..", "lineups");

/** The presets shipped with this build. */
export const PRESETS: readonly string[] = Object.freeze([
  "claude-duo",
  "claude-family",
  "budget-mix",
  "mid-tier",
  "mid-tier-flash",
  "frontier",
]);

/** The floor of a lineup seat's default cap: $5. */
export const MIN_SEAT_CAP_NANO_USD = 5_000_000_000;
/** The floor of a lineup seat's default wake cap: $0.10. */
export const MIN_WAKE_CAP_NANO_USD = 100_000_000;

/** §3.9: twice the seat's predicted high, at least $5. */
export const defaultSeatCap = (highNanoUsd: number): number =>
  Math.max(2 * highNanoUsd, MIN_SEAT_CAP_NANO_USD);

/** §3.9: twenty times the model's central wake cost, at least $0.10. */
export const defaultWakeCap = (centralWakeNanoUsd: number): number =>
  Math.max(20 * centralWakeNanoUsd, MIN_WAKE_CAP_NANO_USD);

/** A seat's fallbacks when neither its lineup seat nor the lineup's defaults say. */
export function defaultFallbacks(model: string): "default" | "off" {
  return model === "claude-opus-5-5" ? "default" : "off";
}

/**
 * A seat's fallbacks: the seat's own, then the lineup default (ignored for a model without
 * server-side fallbacks), then `defaultFallbacks`. An explicit `default` on a model without them is
 * refused.
 */
export function fallbacksFor(
  seat: string,
  model: string,
  own: "default" | "off" | undefined,
  lineupDefault: "default" | "off" | undefined,
): "default" | "off" {
  const capable = FALLBACK_CAPABLE.has(model);
  if (own === "default" && !capable) {
    throw new UsageError(
      `${seat}: ${model} has no server-side refusal fallback: set its fallbacks to "off" (or leave them out)`,
    );
  }
  if (!capable) return "off";
  return own ?? lineupDefault ?? defaultFallbacks(model);
}

/** The path a `--lineup` value names: a preset name, or a file path. */
export function lineupPath(ref: string): string {
  if (ref.includes("/") || ref.includes("\\") || ref.endsWith(".json")) return ref;
  return join(LINEUPS_DIR, `${ref}.json`);
}

/** Reads and validates a lineup; a missing file or a bad one is a `UsageError` (exit 3). */
export function loadLineup(ref: string): Lineup {
  const path = lineupPath(ref);
  if (!existsSync(path)) {
    const named = path === ref ? "" : ` (the presets are ${PRESETS.join(", ")})`;
    throw new UsageError(`--lineup ${ref}: no lineup file at ${path}${named}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UsageError(
      `--lineup ${ref}: ${path} is not JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const parsed = LineupSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path.map(String).join(".") ?? "";
    throw new UsageError(
      `--lineup ${ref}: not a perfidia-lineup/1 file: ${at === "" ? "" : `${at}: `}${issue?.message ?? "invalid"}`,
    );
  }
  const lineup = parsed.data;
  const seen = new Set<string>();
  for (const s of lineup.seats) {
    if (seen.has(s.seat)) throw new UsageError(`--lineup ${ref}: ${s.seat} is listed twice`);
    seen.add(s.seat);
  }
  for (let i = 1; i <= lineup.seats.length; i += 1) {
    if (!seen.has(`p${i}`)) {
      throw new UsageError(
        `--lineup ${ref}: the seats must be p1..p${lineup.seats.length}; p${i} is missing`,
      );
    }
  }
  return lineup;
}
