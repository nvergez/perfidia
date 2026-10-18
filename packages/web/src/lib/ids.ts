import type {
  CityEnt,
  FeedItem,
  MatchMeta,
  MovementEnt,
  PlayerEnt,
  SeatInfo,
} from "@perfidia/protocol/spectator";

// Id types as the spectator schemas carry them (the protocol's root barrel stays out of the web
// bundle, so they are taken from the spectator types), and narrowing for ids read from a URL.

export type PlayerId = SeatInfo["seat"];
export type CityId = CityEnt["id"];
export type IslandId = CityEnt["island"];
export type MovementId = MovementEnt["id"];
export type AllianceId = NonNullable<PlayerEnt["alliance"]>;
export type MatchId = MatchMeta["id"];
export type FeedItemId = FeedItem["id"];

const PLAYER_ID = /^p[1-9][0-9]*$/;
const CITY_ID = /^c[1-9][0-9]*$/;

export function isPlayerId(s: string): s is PlayerId {
  return PLAYER_ID.test(s);
}

export function isCityId(s: string): s is CityId {
  return CITY_ID.test(s);
}

/** Player ids in their natural order (`p2` before `p10`). */
export function comparePlayerIds(a: string, b: string): number {
  return Number(a.slice(1)) - Number(b.slice(1));
}
