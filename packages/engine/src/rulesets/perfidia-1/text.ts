import { fmtDuration, fmtTime } from "@perfidia/engine/core";
import type { DeepReadonly } from "@perfidia/protocol";
import type { Quad } from "./schema.ts";

// Text helpers of the perfidia-1 cheat sheets (§0): the 12-column labels, per-mille numbers,
// quadratics and game times as every version renders them.

export const INDENT = " ".repeat(12);

export function label(name: string): string {
  return name.padEnd(12, " ");
}

/** `v` per mille as a decimal without trailing zeros: 1500 → "1.5", 1250 → "1.25", 1000 → "1". */
export function perMilleDecimal(pm: number): string {
  const whole = Math.floor(pm / 1000);
  const frac = String(pm % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}.${frac}`;
}

/** `v` per mille as a percentage: 50 → "5", 25 → "2.5", 700 → "70". */
export function perMillePercent(pm: number): string {
  const whole = Math.floor(pm / 10);
  const frac = pm % 10;
  return frac === 0 ? String(whole) : `${whole}.${frac}`;
}

/** `v` per mille as a reduced fraction: 250 → "1/4", 1000 → "all", 0 → "0". */
export function perMilleFraction(pm: number): string {
  if (pm === 0) return "0";
  if (pm === 1000) return "all";
  let a = pm;
  let b = 1000;
  while (b !== 0) [a, b] = [b, a % b];
  return `${pm / a}/${1000 / a}`;
}

/**
 * `a·x² + b·x + c` as text, zero terms omitted and unit coefficients dropped: ascending
 * "50 + 20L + 5L²", descending "60L² + 280L + 660". `sep` goes between a coefficient and a word
 * variable ("20·hall").
 */
export function quadText(
  q: DeepReadonly<Quad>,
  v: string,
  order: "asc" | "desc",
  sep = "",
): string {
  const term = (coef: number, power: "" | "²"): string | null => {
    if (coef === 0) return null;
    if (power === "" && v === "") return String(coef);
    return `${coef === 1 ? "" : `${coef}${sep}`}${v}${power}`;
  };
  const constant = q.c === 0 ? null : String(q.c);
  const parts = [constant, term(q.b, ""), term(q.a, "²")].filter((p): p is string => p !== null);
  if (order === "desc") parts.reverse();
  return parts.length === 0 ? "0" : parts.join(" + ");
}

/** A duration in whole hours when it is one ("6 h", "24 h"), otherwise as `fmtDuration`. */
export function hours(s: number): string {
  return s % 3600 === 0 ? `${s / 3600} h` : fmtDuration(s);
}

/** "day 3" for the start of a game day, otherwise the full game time. */
export function dayStart(t: number, day: number): string {
  return t % day === 0 ? `day ${t / day + 1}` : fmtTime(t);
}

/** A time of the first day as "HH:MM", otherwise the full game time. */
export function clock(t: number, day: number): string {
  return t < day ? fmtTime(t).slice(3) : fmtTime(t);
}

export function dayCount(s: number, day: number): string {
  if (s % day !== 0) return fmtDuration(s);
  const n = s / day;
  return `${n} day${n === 1 ? "" : "s"}`;
}

export function matchEndText(t: number, day: number): string {
  return t % day === 0 ? `at the end of day ${t / day}` : `at ${fmtTime(t)}`;
}

export function perPlayerText(n: number): string {
  if (n === 0) return "0";
  return n === 1 ? "N" : `${n}N`;
}
