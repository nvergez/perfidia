import type { Visibility } from "@perfidia/engine/contracts";
import { defaultVisibility, sortedIds } from "@perfidia/engine/std";
import type { CityId, JsonObject, MovementId, PlayerId } from "@perfidia/protocol";
import { cityOf, own, type PRead100, timePair } from "./common.ts";
import { BUILDING_IDS, CROWN_TAG, type PerfidiaConfig } from "./config.ts";
import { blocCities, dominationThreshold, totalCities } from "./domination.ts";
import { type PerfidiaExt, siegeOf, tiebreakPosition } from "./ext.ts";
import { cityPoints } from "./scoring.ts";

// Fog of war (perfidia-1 §12). City and movement access are the `std` defaults, which already show
// a return heading into a besieged city to its besieger; the extras below are public data only:
// city points, the Crown, sieges, the tie-break order and the domination countdowns. Raw battle
// points never appear (only the capped battle score, through the standings).

/** Every running countdown with the bloc's cities against the threshold (§13.2). */
function countdowns(r: PRead100): JsonObject[] {
  const need = dominationThreshold(r.config, r.rules.players, totalCities(r.state));
  return r.ext().domination.countdowns.map((c) => ({
    key: c.bloc,
    members: [...c.members],
    cities: blocCities(r.state, c.members),
    need,
    ends: timePair(c.endsAt),
  }));
}

/** The public extras of a city: its points, the Crown flag, and its siege with the end time. */
function publicCity(r: PRead100, _viewer: PlayerId, city: CityId): JsonObject {
  const c = cityOf(r.state, city);
  let levels = 0;
  for (const b of BUILDING_IDS) levels += c.buildings[b] ?? 0;
  const crown = c.tag === CROWN_TAG;
  const out: JsonObject = { points: cityPoints(r.config, levels, crown) };
  if (crown) out["crown"] = true;
  const siege = siegeOf(r.ext(), city);
  if (siege !== null) out["siege"] = { by: siege.by, ends: timePair(siege.endsAt) };
  return out;
}

/** The public extras of a player: its position in the public tie-break order (1 = best). */
function publicPlayer(r: PRead100, p: PlayerId): JsonObject {
  return { tiebreak: tiebreakPosition(r.ext(), p) + 1 };
}

/** The public extras of the match: the tie-break order and the domination state. */
function publicMatch(r: PRead100): JsonObject {
  const x = r.ext();
  return {
    tiebreak: [...x.tiebreak],
    domination: {
      open: x.domination.open,
      need: dominationThreshold(r.config, r.rules.players, totalCities(r.state)),
      countdowns: countdowns(r),
    },
  };
}

/**
 * The seat's briefing extras (§8.2): the sieges it holds (city, owner, end) and every running
 * domination countdown. Its own besieged cities show their siege through `publicCity`.
 */
function briefing(r: PRead100, viewer: PlayerId): JsonObject {
  const sieges = r.ext().sieges;
  const holding = sortedIds(sieges).flatMap((city) => {
    const siege = own(sieges, city);
    if (siege === undefined || siege.by !== viewer) return [];
    return [{ city, owner: cityOf(r.state, city).owner, ends: timePair(siege.endsAt) }];
  });
  return { holding, countdowns: countdowns(r) };
}

/** `hooks.visibility` of perfidia-1. */
export const perfidiaVisibility: Visibility<PerfidiaConfig, PerfidiaExt> = Object.freeze({
  cityAccess(r: PRead100, viewer: PlayerId, city: CityId): "full" | "public" {
    return defaultVisibility.cityAccess(r, viewer, city);
  },
  movementAccess(r: PRead100, viewer: PlayerId, m: MovementId): "own" | "full" | "incoming" | null {
    return defaultVisibility.movementAccess(r, viewer, m);
  },
  publicCity,
  publicPlayer,
  publicMatch,
  briefing,
});
