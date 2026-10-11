import { canonicalJson, sha256Hex } from "@perfidia/engine/core";
import type { LogLine, Sha256 } from "@perfidia/protocol";

// Normalised logs (docs/architecture.md §10.2, §12.1): `wall*` keys are informational, present only
// when the host has a wall source, and excluded from every byte-for-byte comparison (Level G, the
// coexistence and two-run determinism tests, batch rows).

/**
 * `lines` without their `wall*` keys (shallow copies). The log schema's lines are strict objects
 * whose only `wall*` keys are the header's `wallStart` and the turn line's `wallMs`, both optional.
 */
export function normaliseLog(lines: readonly LogLine[]): LogLine[] {
  return lines.map((line): LogLine => {
    if (line.k === "header") {
      const { wallStart: _wallStart, ...rest } = line;
      return rest;
    }
    if (line.k === "turn") {
      const { wallMs: _wallMs, ...rest } = line;
      return rest;
    }
    return { ...line };
  });
}

/** The canonical JSONL text of the normalised log. */
export function normalisedText(lines: readonly LogLine[]): string {
  return normaliseLog(lines)
    .map((l) => `${canonicalJson(l)}\n`)
    .join("");
}

/** SHA-256 of the normalised text: equal hashes mean byte-identical normalised logs. */
export function normalisedHash(lines: readonly LogLine[]): Sha256 {
  return sha256Hex(normalisedText(lines));
}
