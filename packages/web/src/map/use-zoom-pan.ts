import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Pt } from "./geometry.ts";
import {
  IDENTITY,
  isIdentity,
  panBy,
  viewTransform,
  wheelFactor,
  zoomAt,
  type View,
} from "./zoom.ts";

// Zoom and pan of the map's SVG: the wheel (always on the desktop layout, with Ctrl elsewhere so
// the page still scrolls), a two-finger pinch, a drag once zoomed in, a double click, and buttons.
// The view is written straight into the content group's `transform`: no React render per pointer
// move. A drag swallows the click that ends it, so a city under the pointer does not open.

const DRAG_PX = 4;

interface Pointer {
  readonly id: number;
  x: number;
  y: number;
}

export interface ZoomPan {
  /** Zoomed in (the reset button shows; a drag pans instead of scrolling the page). */
  readonly zoomed: boolean;
  readonly zoomBy: (factor: number) => void;
  readonly reset: () => void;
  /** True right after a drag or pinch: the click that ends it is not a click. */
  readonly wasDrag: () => boolean;
}

export function useZoomPan(
  svgRef: RefObject<SVGSVGElement | null>,
  groupRef: RefObject<SVGGElement | null>,
  width: number,
  height: number,
  wheelAlways: boolean,
): ZoomPan {
  const view = useRef<View>(IDENTITY);
  const [zoomed, setZoomed] = useState(false);
  const dragged = useRef(false);

  const apply = useCallback(
    (v: View) => {
      view.current = v;
      groupRef.current?.setAttribute("transform", viewTransform(v));
      setZoomed(!isIdentity(v));
    },
    [groupRef],
  );

  /** A client point in view-box units. */
  const toBox = useCallback(
    (x: number, y: number): Pt | null => {
      const ctm = svgRef.current?.getScreenCTM();
      if (ctm === null || ctm === undefined) return null;
      const p = new DOMPoint(x, y).matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    },
    [svgRef],
  );

  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return () => undefined;
    const pointers: Pointer[] = [];
    let start: { x: number; y: number } | null = null;
    let pinch: { d: number; mid: Pt; view: View } | null = null;
    let moved = false;

    const midAndDistance = (): { mid: Pt; d: number } | null => {
      const [a, b] = pointers;
      if (a === undefined || b === undefined) return null;
      const pa = toBox(a.x, a.y);
      const pb = toBox(b.x, b.y);
      if (pa === null || pb === null) return null;
      return {
        mid: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 },
        d: Math.hypot(pb.x - pa.x, pb.y - pa.y),
      };
    };

    const onDown = (e: PointerEvent): void => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointers.push({ id: e.pointerId, x: e.clientX, y: e.clientY });
      if (pointers.length === 1) {
        start = { x: e.clientX, y: e.clientY };
        moved = false;
      } else if (pointers.length === 2) {
        const m = midAndDistance();
        pinch = m === null || m.d === 0 ? null : { d: m.d, mid: m.mid, view: view.current };
        moved = true;
      }
    };

    const onMove = (e: PointerEvent): void => {
      const p = pointers.find((x) => x.id === e.pointerId);
      if (p === undefined) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pinch !== null && pointers.length >= 2) {
        const m = midAndDistance();
        if (m === null) return;
        const z = zoomAt(pinch.view, m.d / pinch.d, pinch.mid, width, height);
        apply(panBy(z, m.mid.x - pinch.mid.x, m.mid.y - pinch.mid.y, width, height));
        return;
      }
      if (start === null || isIdentity(view.current)) return;
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_PX) return;
      if (!moved) {
        moved = true;
        svg.setPointerCapture(e.pointerId);
      }
      const ctm = svg.getScreenCTM();
      const scale = ctm === null || ctm.a === 0 ? 1 : 1 / ctm.a;
      apply(panBy(view.current, dx * scale, dy * scale, width, height));
    };

    const onUp = (e: PointerEvent): void => {
      const i = pointers.findIndex((x) => x.id === e.pointerId);
      if (i >= 0) pointers.splice(i, 1);
      if (pointers.length < 2) pinch = null;
      if (pointers.length === 0) {
        if (moved) {
          dragged.current = true;
          window.setTimeout(() => {
            dragged.current = false;
          }, 0);
        }
        start = null;
        moved = false;
      }
    };

    const onWheel = (e: WheelEvent): void => {
      if (!wheelAlways && !e.ctrlKey) return;
      const at = toBox(e.clientX, e.clientY);
      if (at === null) return;
      e.preventDefault();
      apply(zoomAt(view.current, wheelFactor(e.deltaY), at, width, height));
    };

    const onDouble = (e: MouseEvent): void => {
      const at = toBox(e.clientX, e.clientY);
      if (at !== null) apply(zoomAt(view.current, e.shiftKey ? 0.5 : 2, at, width, height));
    };

    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("dblclick", onDouble);
    return () => {
      svg.removeEventListener("pointerdown", onDown);
      svg.removeEventListener("pointermove", onMove);
      svg.removeEventListener("pointerup", onUp);
      svg.removeEventListener("pointercancel", onUp);
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("dblclick", onDouble);
    };
  }, [svgRef, toBox, apply, width, height, wheelAlways]);

  const zoomBy = useCallback(
    (factor: number) =>
      apply(zoomAt(view.current, factor, { x: width / 2, y: height / 2 }, width, height)),
    [apply, width, height],
  );
  const reset = useCallback(() => apply(IDENTITY), [apply]);
  const wasDrag = useCallback(() => dragged.current, []);
  return { zoomed, zoomBy, reset, wasDrag };
}
