import { useEffect, useState, type RefObject } from "react";

// An element's rendered size in CSS pixels, kept up to date by a ResizeObserver.

export interface Size {
  readonly width: number;
  readonly height: number;
}

export function useElementSize(ref: RefObject<Element | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (el === null) return () => undefined;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box === undefined) return;
      setSize((cur) =>
        cur.width === box.width && cur.height === box.height
          ? cur
          : { width: box.width, height: box.height },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
