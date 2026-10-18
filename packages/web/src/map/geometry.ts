// The map's geometry (phase-3 design §4.3 "Map"), pure: everything in map tiles, the units of the
// view box `[0, width] × [0, height]`. Islands are circles of the cosmetic radius `8 + 4·slots`;
// cities sit around their island by slot; a movement is a quadratic curve from city to city (bent
// to its right, so the two directions of a route do not overlap) with a marker interpolated by
// `(t − departAt) / (arriveAt − departAt)`; a recalled movement comes home from the point where it
// turned back (`turnedAt`).

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export interface Curve {
  readonly p0: Pt;
  readonly c: Pt;
  readonly p1: Pt;
}

/** A city marker's radius. */
export const CITY_R = 6;

/** How far a route bends, as a share of its length. */
const BEND = 0.16;

const round2 = (v: number): number => Math.round(v * 100) / 100;
/** A coordinate for a path: two decimals at most. */
const num = (v: number): string => String(round2(v));

export function islandRadius(slots: number): number {
  return 8 + 4 * Math.max(0, slots);
}

/**
 * Where slot `slot` of an island with `slots` slots sits, from the island's centre: the centre for a
 * one-slot island, else evenly on a ring of half the island's radius, slot 0 to the west, then
 * clockwise (as drawn, y pointing down).
 */
export function slotOffset(slots: number, slot: number): Pt {
  if (slots <= 1) return { x: 0, y: 0 };
  const r = islandRadius(slots) / 2;
  const i = ((slot % slots) + slots) % slots;
  const a = Math.PI + (2 * Math.PI * i) / slots;
  return { x: round2(r * Math.cos(a)) + 0, y: round2(r * Math.sin(a)) + 0 };
}

/** What the geometry reads of an island and a city. */
export interface IslandPos {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly slots: number;
}

export interface CityPos {
  readonly island: string;
  readonly slot: number;
}

/** Islands by id. */
export type IslandIndex<I extends IslandPos = IslandPos> = ReadonlyMap<string, I>;

export function indexIslands<I extends IslandPos>(islands: readonly I[]): IslandIndex<I> {
  return new Map(islands.map((i) => [i.id, i]));
}

/** Cities by id (a frame's `cities`). */
export type CityIndex = Readonly<Partial<Record<string, CityPos>>>;

export function islandPoint(islands: IslandIndex, id: string): Pt | null {
  const i = islands.get(id);
  return i === undefined ? null : { x: i.x, y: i.y };
}

/** A city's position: its island's centre plus its slot's offset (null: its island is unknown). */
export function cityPoint(islands: IslandIndex, city: CityPos): Pt | null {
  const i = islands.get(city.island);
  if (i === undefined) return null;
  const o = slotOffset(i.slots, city.slot);
  return { x: i.x + o.x, y: i.y + o.y };
}

/** A curve from `a` to `b`, bent to the right of the direction of travel. */
export function curveBetween(a: Pt, b: Pt, bend: number = BEND): Curve {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return { p0: a, c: { x: (a.x + b.x) / 2 - dy * bend, y: (a.y + b.y) / 2 + dx * bend }, p1: b };
}

export function pointAt(q: Curve, s: number): Pt {
  const u = 1 - s;
  return {
    x: u * u * q.p0.x + 2 * u * s * q.c.x + s * s * q.p1.x,
    y: u * u * q.p0.y + 2 * u * s * q.c.y + s * s * q.p1.y,
  };
}

/** The direction of travel at `s` (not normalised). */
export function tangentAt(q: Curve, s: number): Pt {
  return {
    x: 2 * (1 - s) * (q.c.x - q.p0.x) + 2 * s * (q.p1.x - q.c.x),
    y: 2 * (1 - s) * (q.c.y - q.p0.y) + 2 * s * (q.p1.y - q.c.y),
  };
}

/** The part of a curve between `s0` and `s1`, itself a quadratic curve. */
export function subCurve(q: Curve, s0: number, s1: number): Curve {
  const p0 = pointAt(q, s0);
  const d = tangentAt(q, s0);
  const h = (s1 - s0) / 2;
  return { p0, c: { x: p0.x + d.x * h, y: p0.y + d.y * h }, p1: pointAt(q, s1) };
}

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** `M x y Q cx cy x y`, two decimals. */
export function curvePath(q: Curve): string {
  return `M${num(q.p0.x)} ${num(q.p0.y)}Q${num(q.c.x)} ${num(q.c.y)} ${num(q.p1.x)} ${num(q.p1.y)}`;
}

/** How far along its trip a movement is at `t`, in [0, 1]. */
export function progress(departAt: number, arriveAt: number, t: number): number {
  if (arriveAt <= departAt) return t >= arriveAt ? 1 : 0;
  return Math.min(1, Math.max(0, (t - departAt) / (arriveAt - departAt)));
}

/** A movement's route on the map. */
export interface Route {
  /** The whole route, from the start point to the target's centre. */
  readonly curve: Curve;
  /** What is drawn: trimmed so it ends at the target marker's edge (room for the arrowhead). */
  readonly drawn: Curve;
  /** The trimmed end's parameter on `curve`. */
  readonly end: number;
}

/**
 * Where a movement starts: the point where it turned back for a recalled return, else its origin
 * city (its island's centre when the city is unknown).
 */
export function movementStart(
  islands: IslandIndex,
  cities: CityIndex,
  m: {
    readonly from: string;
    readonly fromIsland: string;
    readonly turnedAt: { readonly x: number; readonly y: number } | null;
  },
): Pt | null {
  if (m.turnedAt !== null) return { x: m.turnedAt.x, y: m.turnedAt.y };
  const c = cities[m.from];
  return (c === undefined ? null : cityPoint(islands, c)) ?? islandPoint(islands, m.fromIsland);
}

/** Where a movement ends: its target city, else the target island's centre (a founding). */
export function movementEnd(
  islands: IslandIndex,
  cities: CityIndex,
  m: { readonly to: string | null; readonly toIsland: string },
): Pt | null {
  const c = m.to === null ? undefined : cities[m.to];
  return (c === undefined ? null : cityPoint(islands, c)) ?? islandPoint(islands, m.toIsland);
}

/** The route from `a` to `b`, its drawn part stopping `gap` tiles short of `b`. */
export function routeBetween(a: Pt, b: Pt, gap: number = CITY_R + 1.5): Route {
  const curve = curveBetween(a, b);
  const len = distance(a, b);
  const end = len <= gap * 2 ? 1 : Math.max(0.5, 1 - gap / len);
  return { curve, drawn: subCurve(curve, 0, end), end };
}

/** A movement's marker at `t`: on the curve, by its share of the trip. */
export function markerAt(route: Route, departAt: number, arriveAt: number, t: number): Pt {
  return pointAt(route.curve, progress(departAt, arriveAt, t) * route.end);
}

/** A marker's radius from the number of units it carries (log2), between 2.6 and 8 tiles. */
export function markerRadius(units: number): number {
  if (units <= 0) return 2.2;
  return round2(Math.min(8, 2 + 0.7 * Math.log2(1 + units)));
}

/** A small arrowhead at `tip`, pointing along `dir`. */
export function arrowHead(tip: Pt, dir: Pt, size = 4): string {
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len;
  const uy = dir.y / len;
  const bx = tip.x - ux * size;
  const by = tip.y - uy * size;
  const w = size * 0.55;
  return `M${num(tip.x)} ${num(tip.y)}L${num(bx - uy * w)} ${num(by + ux * w)}L${num(bx + uy * w)} ${num(by - ux * w)}Z`;
}

/**
 * An arc around `(cx, cy)` of radius `r` covering `fraction` of the circle, clockwise from twelve
 * o'clock (a countdown: the part still to run). Empty for 0; a full circle from 1.
 */
export function arcPath(cx: number, cy: number, r: number, fraction: number): string {
  const f = Math.min(1, Math.max(0, fraction));
  const n = num;
  if (f <= 0) return "";
  if (f >= 0.9999) {
    return `M${n(cx)} ${n(cy - r)}A${n(r)} ${n(r)} 0 1 1 ${n(cx)} ${n(cy + r)}A${n(r)} ${n(r)} 0 1 1 ${n(cx)} ${n(cy - r)}`;
  }
  const a = 2 * Math.PI * f;
  const x = cx + r * Math.sin(a);
  const y = cy - r * Math.cos(a);
  return `M${n(cx)} ${n(cy - r)}A${n(r)} ${n(r)} 0 ${f > 0.5 ? 1 : 0} 1 ${n(x)} ${n(y)}`;
}

/** A star outline with `points` points, outer radius `R`, inner `r`, first point up. */
export function starPath(cx: number, cy: number, R: number, r: number, points = 5): string {
  const parts: string[] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const rad = i % 2 === 0 ? R : r;
    const a = (Math.PI * i) / points - Math.PI / 2;
    parts.push(`${round2(cx + rad * Math.cos(a))} ${round2(cy + rad * Math.sin(a))}`);
  }
  return `M${parts.join("L")}Z`;
}

/** A small temple (the prize island's glyph) centred on `(cx, cy)`, `s` tiles wide each side. */
export function templePath(cx: number, cy: number, s: number): string {
  const n = num;
  const roof = `M${n(cx - s)} ${n(cy - 0.3 * s)}L${n(cx)} ${n(cy - s)}L${n(cx + s)} ${n(cy - 0.3 * s)}Z`;
  const columns = [-0.8, -0.1, 0.6]
    .map(
      (dx) => `M${n(cx + dx * s)} ${n(cy - 0.2 * s)}h${n(0.2 * s)}v${n(0.75 * s)}h${n(-0.2 * s)}Z`,
    )
    .join("");
  const base = `M${n(cx - s)} ${n(cy + 0.6 * s)}h${n(2 * s)}v${n(0.3 * s)}h${n(-2 * s)}Z`;
  return roof + columns + base;
}

/** A burst (a battle's flash): `points` spikes between radii `r` and `R`. */
export function burstPath(cx: number, cy: number, R: number, r: number, points = 8): string {
  return starPath(cx, cy, R, r, points);
}

/** Units carried by a movement. */
export function unitCount(units: Readonly<Record<string, number>>): number {
  let n = 0;
  for (const v of Object.values(units)) n += v;
  return n;
}
