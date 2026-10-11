import type { Ctx, StepInfo } from "@perfidia/engine/contracts";
import { ceilDiv, fmtTime } from "@perfidia/engine/core";
import {
  compareIds,
  type DeepReadonly,
  type GameState,
  type JsonObject,
  type MatchResult,
  type PlayerId,
  type ScheduledEvent,
} from "@perfidia/protocol";
import type { SandboxConfig } from "./config.ts";
import type { SandboxExt } from "./ext.ts";
import { compareRows, scoreRows, timeResult, winnerResult } from "./scoring.ts";

// Victory (docs/architecture.md §3.8). The world timer `hill_open` (t = 172800 with the defaults)
// sets `ext.hillOpen`; from then on `afterStep` declares the winner, reason `hill`, as soon as one
// player owns ≥ the hill threshold of all cities. A player who already qualifies when the timer
// fires wins at that event, since `afterStep` also runs after events (§3.1: the flag, never a
// comparison of `now` with 172800). The last player standing wins at once. Otherwise the highest
// score wins at `matchEnd` (`finish`).

type State = DeepReadonly<GameState>;

/** How many players `hill_status` and `publicMatch` list. */
export const HILL_LEADERS = 3;

/** Cities a player needs to win on the hill: `max(hillMinCities, ceilDiv(total × hillPm, 1000))`. */
export function hillThreshold(config: DeepReadonly<SandboxConfig>, totalCities: number): number {
  return Math.max(config.victory.hillMinCities, ceilDiv(totalCities * config.victory.hillPm, 1000));
}

/** Cities owned by each player who owns one, most first, then by player number. */
function cityCounts(state: State): { player: PlayerId; cities: number }[] {
  const counts = new Map<PlayerId, number>();
  for (const c of Object.values(state.cities)) {
    if (c.owner !== null) counts.set(c.owner, (counts.get(c.owner) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([player, cities]) => ({ player, cities }))
    .toSorted((a, b) => b.cities - a.cities || compareIds(a.player, b.player));
}

/**
 * The hill status, from public data only (city owners, the flag, the config): whether it is open,
 * when it opens, the threshold, the total number of cities and the `HILL_LEADERS` players owning
 * the most cities (ties by player number). Shared by the `hill_status` tool and `publicMatch`.
 */
export function hillStatus(
  config: DeepReadonly<SandboxConfig>,
  state: State,
  ext: DeepReadonly<SandboxExt>,
): JsonObject {
  const total = Object.keys(state.cities).length;
  const opensAt = config.time.hillOpen;
  return {
    open: ext.hillOpen,
    opensAt: [opensAt, fmtTime(opensAt)],
    threshold: hillThreshold(config, total),
    totalCities: total,
    leaders: cityCounts(state)
      .slice(0, HILL_LEADERS)
      .map((x) => ({ player: x.player, cities: x.cities })),
  };
}

/**
 * The hill winner, or null: among the living players owning at least the threshold, the one with
 * the most cities, then the highest score, then the lowest player number (two players can both
 * hold half of the cities).
 */
export function hillWinner(config: DeepReadonly<SandboxConfig>, state: State): PlayerId | null {
  const threshold = hillThreshold(config, Object.keys(state.cities).length);
  const best = scoreRows(config, state)
    .filter((row) => row.alive && row.cities >= threshold)
    .toSorted((a, b) => b.cities - a.cities || compareRows(a, b));
  return best[0]?.player ?? null;
}

/** `hooks.on.hill_open`: opens the hill; `afterStep` evaluates it right after this event. */
export function onHillOpen(ctx: Ctx<SandboxConfig, SandboxExt>, _ev: ScheduledEvent): void {
  ctx.state.ext = { ...ctx.ext(), hillOpen: true };
}

/** The players still alive, in player order. */
function alivePlayers(state: State): PlayerId[] {
  return Object.values(state.players)
    .filter((p) => p.alive)
    .map((p) => p.id)
    .toSorted(compareIds);
}

/** `hooks.afterStep`: last standing first, then the hill once it is open. */
export function afterStep(ctx: Ctx<SandboxConfig, SandboxExt>, _step: StepInfo): void {
  const r = ctx.read();
  const alive = alivePlayers(r.state);
  const last = alive[0];
  if (alive.length === 1 && last !== undefined) {
    ctx.endMatch(winnerResult(r.config, r.state, ctx.now, "last_standing", last));
    return;
  }
  if (!ctx.ext().hillOpen) return;
  const winner = hillWinner(r.config, r.state);
  if (winner !== null) ctx.endMatch(winnerResult(r.config, r.state, ctx.now, "hill", winner));
}

/** `hooks.finish`, at `matchEnd`. */
export function finish(ctx: Ctx<SandboxConfig, SandboxExt>): MatchResult {
  const r = ctx.read();
  return timeResult(r.config, r.state, ctx.now);
}
