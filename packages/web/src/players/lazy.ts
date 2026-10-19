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
