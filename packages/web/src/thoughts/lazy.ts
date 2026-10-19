import { lazyComponent } from "../common/lazy.tsx";

// The Thoughts column and a turn's reasoning load on demand (docs/phase3.md §16): neither is on
// screen on arrival (the Feed tab is). `LazyLiveReasoning` is Pass C's live per-round reasoning
// (`live.tsx`, agent T), shown in the Thoughts column while a seat is in a turn.

export const LazyThoughtsPanel = lazyComponent(
  () => import("./thoughts-panel.tsx").then((m) => m.ThoughtsPanel),
  { what: "the thoughts", skeletonClassName: "h-64" },
);

export const LazyTurnReasoning = lazyComponent(
  () => import("./turn-reasoning.tsx").then((m) => m.TurnReasoning),
  { what: "the reasoning", skeletonClassName: "h-12" },
);

export const LazyLiveReasoning = lazyComponent(
  () => import("./live.tsx").then((m) => m.LiveReasoning),
  { what: "the live reasoning", fallback: null },
);
