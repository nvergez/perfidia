import { fmtTime } from "../lib/time.ts";
import { useFeed } from "../store/hooks.ts";
import { controls } from "../store/session.ts";

// STUB (owned by view agent B, phase-3 design §4.3 "Feed"): the last feed items up to the playhead,
// newest first, as plain lines. Agent B replaces this file; the export name and the no-props
// signature stay.

export function FeedPanel() {
  const feed = useFeed();
  const shown = feed
    .filter((e) => e.item.importance >= 1)
    .slice(-40)
    .toReversed();
  return (
    <ol data-stub="feed" aria-label="Feed" className="flex flex-col gap-1 text-sm">
      {shown.map((e) => (
        <li key={e.item.id}>
          <button
            type="button"
            className="hover:bg-accent w-full rounded px-1 text-left"
            onClick={() => controls.seekSeq(e.seq, e.item.t)}
          >
            <span className="text-muted-foreground font-mono">{fmtTime(e.item.t)}</span> {e.item.k}
          </button>
        </li>
      ))}
    </ol>
  );
}
