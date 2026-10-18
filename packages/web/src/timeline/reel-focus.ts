import { create } from "zustand";

// What the key moments reel points at while a caption shows: the moment's cities (ringed on the
// map) and players (the map dims the others). Written by the reel, read by the map.

export interface ReelFocus {
  readonly cities: readonly string[];
  readonly players: readonly string[];
}

const NONE: ReelFocus = Object.freeze({ cities: Object.freeze([]), players: Object.freeze([]) });

export const useReelFocus = create<ReelFocus>()(() => NONE);

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export function setReelFocus(cities: readonly string[], players: readonly string[]): void {
  const cur = useReelFocus.getState();
  if (same(cur.cities, cities) && same(cur.players, players)) return;
  useReelFocus.setState({ cities, players });
}

export function clearReelFocus(): void {
  useReelFocus.setState(NONE);
}
