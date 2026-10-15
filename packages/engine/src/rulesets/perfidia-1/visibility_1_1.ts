import type { Visibility } from "@perfidia/engine/contracts";
import { defaultVisibility, sortedIds } from "@perfidia/engine/std";
import type { CityId, JsonObject, MovementId, PlayerId } from "@perfidia/protocol";
import { cityOf, own, timePair } from "./common.ts";
import { OLYMPUS_TAG, type Perfidia11Config } from "./config_1_1.ts";
import { blocsOf } from "./domination.ts";
import {
  blocHold,
  type DominationNeed,
  type Hold,
  holdByOwner,
  holdOf,
  totalSlots,
} from "./domination_1_1.ts";
import { siegeOf, tiebreakPosition } from "./ext.ts";
import { conquestOf, isTaken, type Perfidia11Ext } from "./ext_1_1.ts";
import { cityPoints11 } from "./scoring_1_1.ts";
import { need11, type PRead11 } from "./victory_1_1.ts";

// Fog of war of perfidia-1@1.1.0 (docs/rulesets/perfidia-1.md §12): 1.0.0's public extras, plus what
// follows from public conquests: whether a city is taken, its former owners, each player's taken
// cities, and every bloc's cities and taken cities next to the threshold (§13.2).

/** Every running countdown with the bloc's cities and taken cities against the threshold. */
function countdowns(r: PRead11, byOwner: ReadonlyMap<PlayerId, Hold>, need: DominationNeed) {
  return r.ext().domination.countdowns.map((c) => {
    const have = blocHold(byOwner, c.members);
    return {
      key: c.bloc,
      members: [...c.members],
      cities: have.cities,
      taken: have.taken,
      need: need.cities,
      needTaken: need.taken,
      ends: timePair(c.endsAt),
    };
  });
}

/**
 * The public extras of a city: its points, the Olympus flag, whether its owner took it and who
 * owned it before (a conquered city), and its siege with the end time.
 */
function publicCity(r: PRead11, _viewer: PlayerId, city: CityId): JsonObject {
  const c = cityOf(r.state, city);
  const x = r.ext();
  const out: JsonObject = { points: cityPoints11(r.config, c) };
  if (c.tag === OLYMPUS_TAG) out["olympus"] = true;
  if (isTaken(x, city, c.owner)) out["taken"] = true;
  const record = conquestOf(x, city);
  if (record !== null && record.former.length > 0) out["former"] = [...record.former];
  const siege = siegeOf(x, city);
  if (siege !== null) out["siege"] = { by: siege.by, ends: timePair(siege.endsAt) };
  return out;
}

/** The public extras of a player: its tie-break position (1 = best) and its taken cities. */
function publicPlayer(r: PRead11, p: PlayerId): JsonObject {
  const x = r.ext();
  return {
    tiebreak: tiebreakPosition(x, p) + 1,
    taken: holdOf(holdByOwner(r.state, x), p).taken,
  };
}

/**
 * The public extras of the match: the tie-break order and the domination state, with the threshold,
 * the map's city slots, every bloc's cities and taken cities, and the running countdowns.
 */
function publicMatch(r: PRead11): JsonObject {
  const x = r.ext();
  const need = need11(r);
  const byOwner = holdByOwner(r.state, x);
  const blocs = blocsOf(r.state).map((b) => {
    const have = blocHold(byOwner, b.members);
    return { key: b.key, members: [...b.members], cities: have.cities, taken: have.taken };
  });
  return {
    tiebreak: [...x.tiebreak],
    domination: {
      open: x.domination.open,
      need: need.cities,
      needTaken: need.taken,
      slots: totalSlots(r.state),
      blocs,
      countdowns: countdowns(r, byOwner, need),
    },
  };
}

/**
 * The seat's briefing extras (§8.2): the sieges it holds, every running countdown, and its own
 * bloc's cities and taken cities against the threshold.
 */
function briefing(r: PRead11, viewer: PlayerId): JsonObject {
  const x = r.ext();
  const sieges = x.sieges;
  const holding = sortedIds(sieges).flatMap((city) => {
    const siege = own(sieges, city);
    if (siege === undefined || siege.by !== viewer) return [];
    return [{ city, owner: cityOf(r.state, city).owner, ends: timePair(siege.endsAt) }];
  });
  const need = need11(r);
  const byOwner = holdByOwner(r.state, x);
  const out: JsonObject = { holding, countdowns: countdowns(r, byOwner, need) };
  const bloc = blocsOf(r.state).find((b) => b.members.includes(viewer));
  if (bloc !== undefined) {
    const have = blocHold(byOwner, bloc.members);
    out["bloc"] = {
      key: bloc.key,
      members: [...bloc.members],
      cities: have.cities,
      taken: have.taken,
      need: need.cities,
      needTaken: need.taken,
    };
  }
  return out;
}

/** `hooks.visibility` of perfidia-1@1.1.0. */
export const perfidia11Visibility: Visibility<Perfidia11Config, Perfidia11Ext> = Object.freeze({
  cityAccess(r: PRead11, viewer: PlayerId, city: CityId): "full" | "public" {
    return defaultVisibility.cityAccess(r, viewer, city);
  },
  movementAccess(r: PRead11, viewer: PlayerId, m: MovementId): "own" | "full" | "incoming" | null {
    return defaultVisibility.movementAccess(r, viewer, m);
  },
  publicCity,
  publicPlayer,
  publicMatch,
  briefing,
});
