import { useEffect, useRef, useState } from "react";
import { useMatch, useMomentsSoFar, useUi } from "../store/hooks.ts";
import { announce, type AnnounceState } from "./announce.ts";

// A polite live region for key moments (importance 3) as the playhead passes them (phase-3 design
// §4.5): at most one announcement every 5 seconds, the newest moment once the window ends; nothing
// for what is past on arrival, for a seek backwards, or while the reel's captions speak.

export function MomentAnnouncer() {
  const moments = useMomentsSoFar();
  const ready = useMatch((s) => s.phase === "ready" && s.frame !== null);
  const quiet = useUi((s) => s.reelActive);
  const [text, setText] = useState("");
  const state = useRef<AnnounceState | null>(null);
  const newest = moments.findLast((x) => x.importance >= 3) ?? null;
  const seq = newest?.seq ?? -1;
  const title = newest?.title ?? "";
  useEffect(() => {
    let timer: number | null = null;
    const step = (): void => {
      timer = null;
      const r = announce(state.current, {
        newest: seq < 0 ? null : { seq, title },
        ready,
        quiet,
        now: performance.now(),
      });
      state.current = r.state;
      if (r.action.kind === "say") setText(r.action.text);
      else if (r.action.kind === "later") timer = window.setTimeout(step, r.action.ms);
    };
    step();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [seq, title, ready, quiet]);
  return (
    <output aria-live="polite" className="sr-only">
      {text}
    </output>
  );
}
