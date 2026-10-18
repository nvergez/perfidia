import type { DominationBloc, DominationCountdown, DominationView } from "../skins/index.ts";

// Pure pieces of the leaderboard and the bloc progress (phase-3 design §4.3): a score's parts in
// words and as bar segments, the blocs in the order a reader wants them (closest to a win first),
// the taken-city pips, and a countdown's progress.

/** A score part's key in words: `cityPoints` → "City points", `battle_score` → "Battle score". */
export function partLabel(key: string): string {
  const words = key
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.length === 0 ? key : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export interface Segment {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  /** Width in percent of the bar (the leader's score is the full bar). */
  readonly pct: number;
}

/** A score's positive parts as bar segments, largest first, scaled on `max`. */
export function scoreSegments(parts: Readonly<Record<string, number>>, max: number): Segment[] {
  const scale = max > 0 ? 100 / max : 0;
  return Object.entries(parts)
    .filter(([, v]) => v > 0)
    .toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => ({ key, label: partLabel(key), value, pct: value * scale }));
}

/** Blocs closest to a domination win first: most cities, then most taken, then by key. */
export function sortBlocs(blocs: readonly DominationBloc[]): DominationBloc[] {
  return blocs.toSorted(
    (a, b) =>
      b.cities - a.cities || b.taken - a.taken || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/** `needTaken` pips, the first `taken` of them filled (extra taken cities beyond the need: none). */
export function takenPips(taken: number, needTaken: number | null): boolean[] {
  if (needTaken === null || needTaken <= 0) return [];
  return Array.from({ length: needTaken }, (_, i) => i < taken);
}

/** How far a countdown has run, 0–1 (null when its end or the hold is unknown). */
export function countdownProgress(
  c: DominationCountdown,
  hold: number | null,
  t: number,
): number | null {
  if (c.endsAt === null || hold === null || hold <= 0) return null;
  const start = c.endsAt - hold;
  return Math.min(1, Math.max(0, (t - start) / hold));
}

/** The countdown of a bloc, when one runs. */
export function countdownOf(d: DominationView, key: string): DominationCountdown | null {
  return d.countdowns.find((c) => c.key === key) ?? null;
}

/** A bloc's cities as a share of the need, 0–1. */
export function cityShare(cities: number, need: number | null): number {
  if (need === null || need <= 0) return 0;
  return Math.min(1, cities / need);
}
