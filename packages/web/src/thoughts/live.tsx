import type { PlayerId } from "../lib/ids.ts";

// The live per-round reasoning in the Thoughts column (phase-3 design §4.2 Pass C, C3): while
// `seat` is in turn `turn` of a live match, the rounds of that turn as the WebSocket's `annot`
// messages bring them (`useLiveAnnots(seat, turn)` in `store/hooks.ts`: arrival order, a resent
// round replaced in place), newest round last, with `prefers-reduced-motion` respected, and the
// "not published" line when `usePublished().reasoning` is false. A stub made at step C0 (an empty
// marker): agent T fills it (docs/phase3.md §16.4). The export name and the props stay;
// `thoughts-panel.tsx` mounts it through `LazyLiveReasoning` for an agent in a turn.

export interface LiveReasoningProps {
  readonly seat: PlayerId;
  readonly turn: number;
}

export function LiveReasoning({ seat, turn }: LiveReasoningProps) {
  return <span hidden data-live-reasoning={`${seat}:${turn}`} />;
}
