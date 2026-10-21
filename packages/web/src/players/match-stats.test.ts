// The dossier's statistics are fetched again when they no longer describe the match (review fix):
// a match that was loading or running has ended, a failure (a 503 LOADING among them), or a running
// match's older than ten seconds. Pure: `statsStale` decides.

import { expect, test } from "bun:test";
import type { MatchStatus } from "@perfidia/protocol/spectator";
import { statsStale } from "./match-stats.ts";

const ok = (status: MatchStatus) => ({ status: "ok", value: { status } }) as const;

test("statistics are fetched again when the match's status moved on, or a live match's are old", () => {
  expect(statsStale(undefined, "ended", 0)).toBe(true);
  // A fetch in flight is never stale.
  expect(statsStale({ at: 0, state: { status: "loading" } }, "ended", 99_999)).toBe(false);
  // A failure, LOADING included, is asked again.
  const loading = { status: "error" } as const;
  expect(statsStale({ at: 0, state: loading }, "loading", 1)).toBe(true);
  // An ended match's statistics stay.
  expect(statsStale({ at: 0, state: ok("ended") }, "ended", 10 ** 9)).toBe(false);
  // Statistics made while the match loaded, or ran, are stale once it has ended.
  expect(statsStale({ at: 0, state: ok("loading") }, "ended", 1)).toBe(true);
  expect(statsStale({ at: 0, state: ok("live") }, "ended", 1)).toBe(true);
  // A running match's: fresh for ten seconds, then fetched again.
  expect(statsStale({ at: 0, state: ok("live") }, "live", 10_000)).toBe(false);
  expect(statsStale({ at: 0, state: ok("live") }, "live", 10_001)).toBe(true);
  // Status not known yet: keep what is held.
  expect(statsStale({ at: 0, state: ok("ended") }, null, 1)).toBe(false);
});
