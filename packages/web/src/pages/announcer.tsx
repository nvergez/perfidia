import { useEffect, useRef, useState } from "react";
import { useMomentsSoFar } from "../store/hooks.ts";

// A polite live region for key moments (importance 3) as the playhead passes them (phase-3 design
// §4.5), throttled to one announcement every 5 seconds.

const EVERY_MS = 5_000;

export function MomentAnnouncer() {
  const moments = useMomentsSoFar();
  const [text, setText] = useState("");
  const last = useRef<{ item: string | null; at: number } | null>(null);
  useEffect(() => {
    const m = moments.findLast((x) => x.importance >= 3);
    if (last.current === null) {
      // What was already past on arrival is not news.
      last.current = { item: m?.item ?? null, at: 0 };
      return;
    }
    if (m === undefined || m.item === last.current.item) return;
    const now = performance.now();
    if (now - last.current.at < EVERY_MS && last.current.item !== null) return;
    last.current = { item: m.item, at: now };
    setText(m.title);
  }, [moments]);
  return (
    <output aria-live="polite" className="sr-only">
      {text}
    </output>
  );
}
