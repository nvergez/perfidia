// P9 (docs/architecture.md §6.5, §13.2), through the harness for both rulesets: a 1-game-day bot run
// is snapshotted mid-run; the snapshot is loaded twice, and in one copy the insertion order of every
// record of the live state (every object, nested ones included) is shuffled. Both copies then
// continue with the logged actions and times: every step's results, events and checkpoints, and the
// final hash, are the same, and equal the log's. A state loaded from a snapshot has sorted keys,
// so the shuffle is done in place on the loaded state (`testStep`), not on the snapshot.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { canonicalJson, shuffle, streamRng, type Rng } from "@perfidia/engine/core";
import type { Match } from "@perfidia/engine/kernel";
import { testStep } from "@perfidia/engine/testing";
import type { LogLine, Snapshot } from "@perfidia/protocol";
import { LOCKSTEP, REFS, cachedRun, daySpec, loadChecked, snapshotAt } from "./kit.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Re-inserts the keys of every object reachable from `value` in a random order; arrays keep theirs. */
function shuffleKeys(value: unknown, rng: Rng): void {
  if (Array.isArray(value)) {
    for (const v of value) shuffleKeys(v, rng);
    return;
  }
  if (!isRecord(value)) return;
  const record = value;
  const entries = shuffle(rng, Object.entries(record));
  for (const [k] of entries) delete record[k];
  for (const [k, v] of entries) {
    record[k] = v;
    shuffleKeys(v, rng);
  }
}

/** The key order of every record of the state, as text. */
function keyOrder(m: Match): string {
  const s = m.read().state;
  return JSON.stringify([
    Object.keys(s.players),
    Object.keys(s.cities),
    Object.keys(s.movements),
    Object.keys(s.proposals),
    Object.keys(s.alliances),
    Object.keys(s.ledger),
    Object.keys(s.ids.own),
    Object.values(s.cities).map((c) => Object.keys(c.buildings)),
  ]);
}

/**
 * Continues `a` and `b` with the log lines after the `ckpt` line of the snapshot's hour: each time
 * advance and each act line on both, comparing their outputs; returns the events of `a`.
 */
function continueBoth(lines: readonly LogLine[], snap: Snapshot, a: Match, b: Match): string[] {
  const from = lines.findIndex((l) => l.k === "ckpt" && l.hour === snap.hour);
  expect(from).toBeGreaterThan(0);
  const events: string[] = [];
  const step = (t: number): void => {
    if (a.ended || t <= a.now) return;
    const x = a.advanceTo(t);
    const y = b.advanceTo(t);
    expect(canonicalJson(y)).toBe(canonicalJson(x));
    expect(b.hash()).toBe(a.hash());
    events.push(...x.events.map((e) => canonicalJson(e)));
  };
  for (const line of lines.slice(from + 1)) {
    if (line.k === "header") continue;
    step(line.t);
    if (line.k === "act") {
      const x = a.apply(line.seat, line.a);
      const y = b.apply(line.seat, line.a);
      expect(canonicalJson(y)).toBe(canonicalJson(x));
      expect(canonicalJson({ ok: x.ok, ...(x.ok ? {} : { code: x.violation.code }) })).toBe(
        canonicalJson(line.r),
      );
      if (x.ok) events.push(...x.events.map((e) => canonicalJson(e)));
    } else if (line.k === "end") {
      expect(a.hash()).toBe(line.h);
      expect(b.hash()).toBe(line.h);
    }
  }
  return events;
}

describe("P9: the insertion order of records changes nothing", () => {
  for (const ref of REFS) {
    test(`${ref}: shuffled mid-run states continue exactly like the log`, async () => {
      const run = await cachedRun({ ...daySpec(ref, LOCKSTEP, 9), snapshotEvery: 6 });
      const logged = (snap: Snapshot): string[] => {
        const from = run.lines.findIndex((l) => l.k === "ckpt" && l.hour === snap.hour);
        return run.lines.slice(from + 1).flatMap((l) => (l.k === "ev" ? [canonicalJson(l.e)] : []));
      };
      let reordered = 0;
      for (const hour of [6, 12, 18]) {
        const snap = snapshotAt(run, hour);
        fc.assert(
          fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
            const plain = loadChecked(snap);
            const shuffled = loadChecked(snap);
            testStep(plain, () => undefined);
            testStep(shuffled, (ctx) => shuffleKeys(ctx.state, streamRng(seed, "p9")));
            // The shuffle changes no value (and the identity step changes nothing either).
            expect(plain.hash()).toBe(snap.hash);
            expect(shuffled.hash()).toBe(snap.hash);
            if (keyOrder(shuffled) !== keyOrder(plain)) reordered += 1;
            const events = continueBoth(run.lines, snap, plain, shuffled);
            expect(events).toEqual(logged(snap));
          }),
          { numRuns: 4 },
        );
      }
      // Not vacuous: the record orders really differed.
      expect(reordered).toBeGreaterThan(6);
    }, 60000);
  }
});
