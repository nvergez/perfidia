import { lazyComponent } from "../common/lazy.tsx";
import { uiActions } from "../store/ui.ts";

// The turn detail sheet (Pass C, C1: `turn-sheet.tsx`, agent T) loads on demand
// (docs/phase3.md §16). The page mounts it once a turn is opened (`uiStore.openTurn`, through
// `uiActions.openTurn(seat, turn)` or `OpenTurnButton`) and keeps it mounted after.

export const LazyTurnSheet = lazyComponent(
  () => import("./turn-sheet.tsx").then((m) => m.TurnSheet),
  { what: "the turn detail", overlay: true, onClose: () => uiActions.closeTurn() },
);
