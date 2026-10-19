import type { Pt } from "./geometry.ts";

// Zoom and pan of the map, pure: a view `{k, x, y}` draws a map point `p` at `p·k + (x, y)`, in the
// units of the view box `[0, w] × [0, h]`. The map always covers the view box (no zooming out past
// the whole map, no panning it out of sight); zooming keeps the point under the pointer still.

export interface View {
  readonly k: number;
  readonly x: number;
  readonly y: number;
}

export const IDENTITY: View = Object.freeze({ k: 1, x: 0, y: 0 });
export const MAX_ZOOM = 8;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The view kept within bounds: `k` in [1, MAX_ZOOM], the map covering the view box. */
export function clampView(v: View, w: number, h: number): View {
  const k = clamp(v.k, 1, MAX_ZOOM);
  return { k, x: clamp(v.x, w * (1 - k), 0) + 0, y: clamp(v.y, h * (1 - k), 0) + 0 };
}

/** Zoom by `factor` keeping the view-box point `at` still. */
export function zoomAt(v: View, factor: number, at: Pt, w: number, h: number): View {
  const k = clamp(v.k * factor, 1, MAX_ZOOM);
  const f = k / v.k;
  return clampView({ k, x: at.x - (at.x - v.x) * f, y: at.y - (at.y - v.y) * f }, w, h);
}

/** Pan by `(dx, dy)` view-box units. */
export function panBy(v: View, dx: number, dy: number, w: number, h: number): View {
  return clampView({ k: v.k, x: v.x + dx, y: v.y + dy }, w, h);
}

/** The map point drawn at view-box point `p`. */
export function toMap(v: View, p: Pt): Pt {
  return { x: (p.x - v.x) / v.k, y: (p.y - v.y) / v.k };
}

/** Centre the view on map point `p` at zoom `k`. */
export function centreOn(p: Pt, k: number, w: number, h: number): View {
  return clampView({ k, x: w / 2 - p.x * k, y: h / 2 - p.y * k }, w, h);
}

export function isIdentity(v: View): boolean {
  return v.k === 1 && v.x === 0 && v.y === 0;
}

/** `translate(x y) scale(k)`. */
export function viewTransform(v: View): string {
  return `translate(${v.x} ${v.y}) scale(${v.k})`;
}

/** The wheel's zoom factor for a `deltaY` (pixels): a notch of 100 px zooms by about 1.2. */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-clamp(deltaY, -300, 300) * 0.0018);
}
