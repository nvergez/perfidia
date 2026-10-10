import type { ReadCtx, Visibility } from "@perfidia/engine/contracts";
import { defaultVisibility, relation } from "@perfidia/engine/std";
import type { CityId, JsonObject, MovementId, PlayerId } from "@perfidia/protocol";
import type { SandboxConfig } from "./config.ts";
import type { SandboxExt } from "./ext.ts";
import { hillStatus } from "./hill.ts";

// Fog of war (docs/architecture.md §3.8): std's defaults, except that allies see each other's
// movements in full (every kind, spies and founders included; perfidia-1 shows them none), the
// player-chosen name of every city in `publicCity`, and the hill status in `publicMatch` (which the
// briefing shows too, as sandbox-1 has no `briefing` hook).

type R = ReadCtx<SandboxConfig, SandboxExt>;

/** `movementAccess`: `own` for the mover, `full` for its allies, std's default otherwise. */
export function movementAccess(
  r: R,
  viewer: PlayerId,
  m: MovementId,
): "own" | "full" | "incoming" | null {
  const mv = Object.hasOwn(r.state.movements, m) ? r.state.movements[m] : undefined;
  if (mv === undefined) return null;
  if (mv.owner === viewer) return "own";
  if (relation(r, viewer, mv.owner) === "ally") return "full";
  return defaultVisibility.movementAccess(r, viewer, m);
}

/** `publicCity`: the city's name (its id until its owner renames it). */
export function publicCity(r: R, _viewer: PlayerId, city: CityId): JsonObject {
  const c = Object.hasOwn(r.state.cities, city) ? r.state.cities[city] : undefined;
  return c === undefined ? {} : { name: c.name };
}

/** `publicMatch`: the hill status. */
export function publicMatch(r: R): JsonObject {
  return { hill: hillStatus(r.config, r.state, r.ext()) };
}

/** `hooks.visibility`: the parts that differ from std's defaults. */
export const SANDBOX_VISIBILITY: Partial<Visibility<SandboxConfig, SandboxExt>> = Object.freeze({
  movementAccess,
  publicCity,
  publicMatch,
});
