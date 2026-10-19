import { fmtTime } from "../lib/time.ts";

// A game time, `D3 14:02` (the engine's format), as a <time> element.

export function GameTime({ t, className }: { readonly t: number; readonly className?: string }) {
  return (
    <time className={className} data-t={t}>
      {fmtTime(t)}
    </time>
  );
}
