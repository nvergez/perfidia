import type { AnyRuleset } from "@perfidia/engine";
import type { Json } from "@perfidia/protocol";
import { UsageError } from "../args.ts";
import { checkOverrides, overridesFrom, playerRange, rulesetFor } from "../run/index.ts";

// Batch variants (docs/architecture.md §12.1): `--variant "<label>: <ref> [key=value ...]"`, the
// label optional. Each variant is a ruleset of the registry with its overrides, checked like a
// `run`'s (schema and config checks) before any match starts. Unlike `run`, `batch` takes test
// rulesets such as `sandbox-1` without `--allow-test` (§12.1 lists no such flag for `batch`, and
// the batch table of §12.2 compares `sandbox-1` with `perfidia-1`); the command notes them.

export interface Variant {
  /** The `--variant` text, whitespace-normalised: the variant's name in tables and JSON. */
  readonly text: string;
  readonly label: string | null;
  readonly ruleset: AnyRuleset;
  /** Its overrides, `--days` included as `time.matchEnd`. */
  readonly overrides: Readonly<Record<string, Json>>;
  readonly players: { readonly min: number; readonly max: number };
}

const LABELLED = /^([^:=\s][^:=]*?)\s*:\s+(\S.*)$/s;

/**
 * Parses one `--variant`: an optional `label:` (no `=` or `:` in it, a space after the colon), a
 * ruleset ref or id, then `key=value` overrides separated by spaces (values cannot hold spaces).
 */
export function parseVariant(raw: string, o: { readonly days?: number | undefined } = {}): Variant {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed === "")
    throw new UsageError('--variant is empty: write "<label>: <ref> [key=value ...]"');
  const m = LABELLED.exec(trimmed);
  const label = m?.[1] ?? null;
  const body = m?.[2] ?? trimmed;
  const [ref, ...overrideTexts] = body.split(" ");
  if (ref === undefined || ref === "" || ref.includes("=")) {
    throw new UsageError(
      `--variant "${raw}": write "<label>: <ref> [key=value ...]", the ref first`,
    );
  }
  const ruleset = rulesetFor(ref, true);
  const overrides = overridesFrom(overrideTexts, o.days);
  const config = checkOverrides(ruleset, overrides, ` (variant "${trimmed}")`);
  return { text: trimmed, label, ruleset, overrides, players: playerRange(ruleset, config) };
}

/** Parses every variant; names must be distinct, and each must allow `players` seats. */
export function parseVariants(
  raws: readonly string[],
  o: { readonly days?: number | undefined; readonly players?: number | undefined } = {},
): { readonly variants: Variant[]; readonly players: number } {
  if (raws.length === 0) {
    throw new UsageError('batch needs at least one --variant "<label>: <ref> [key=value ...]"');
  }
  const variants = raws.map((r) => parseVariant(r, o));
  const seen = new Set<string>();
  for (const v of variants) {
    if (seen.has(v.text)) throw new UsageError(`--variant "${v.text}" is given twice`);
    seen.add(v.text);
  }
  const players = o.players ?? variants[0]?.players.min ?? 1;
  const excluded = variants.filter((v) => players < v.players.min || players > v.players.max);
  if (excluded.length > 0) {
    throw new UsageError(
      `--players ${players} is outside the player range of:\n${excluded
        .map((v) => `  ${v.text}: ${v.players.min}..${v.players.max}`)
        .join("\n")}`,
    );
  }
  return { variants, players };
}
