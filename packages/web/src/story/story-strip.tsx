import { fmtInt } from "../lib/format.ts";
import { fmtClock } from "../lib/time.ts";
import { useMatch, useMomentsSoFar, useStandings } from "../store/hooks.ts";
import { labelOf } from "../store/selectors.ts";

// STUB (owned by view agent B, phase-3 design §4.3 "Story strip"): the day, the leader and the last
// moment. Agent B replaces this file; the export name and the no-props signature stay.

export function StoryStrip() {
  const meta = useMatch((s) => s.meta);
  const playhead = useMatch((s) => s.playhead);
  const standings = useStandings();
  const moments = useMomentsSoFar();
  const leader = standings[0];
  const last = moments.at(-1);
  return (
    <p data-stub="story" className="bg-card rounded-xl border px-3 py-2 text-sm">
      <span className="font-mono">{fmtClock(playhead)}</span>
      {leader === undefined ? null : (
        <>
          {" · "}
          {labelOf(meta, leader.player)} leads with {fmtInt(leader.score)}
        </>
      )}
      {last === undefined ? null : <> · {last.title}</>}
    </p>
  );
}
