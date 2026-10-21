import { lazyComponent } from "../common/lazy.tsx";
import { uiActions } from "../store/ui.ts";

// The dossier sheet loads on demand (docs/phase3.md §16): it is not needed on arrival. The page
// mounts it once a player is selected (`uiStore.selectedPlayer`) and keeps it mounted after.

export const LazyPlayerSheet = lazyComponent(
  () => import("./player-sheet.tsx").then((m) => m.PlayerSheet),
  { what: "the dossier", overlay: true, onClose: () => uiActions.closePlayer() },
);

// The Players tab is not on screen on arrival (the Feed tab is).
export const LazyPlayersPanel = lazyComponent(
  () => import("./players-panel.tsx").then((m) => m.PlayersPanel),
  { what: "the players", skeletonClassName: "h-64" },
);

// The dossier's model block (phase 4 Pass 3): the seat's model, effort, reasoning kind, spend and
// incidents from the match's statistics, in a chunk of its own.
export const LazyModelBlock = lazyComponent(
  () => import("./model-block.tsx").then((m) => m.ModelBlock),
  { what: "the model block", skeletonClassName: "h-28" },
);
