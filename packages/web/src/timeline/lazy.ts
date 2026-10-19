import { lazyComponent } from "../common/lazy.tsx";
import { uiActions } from "../store/ui.ts";

// The key moments reel loads on demand (docs/phase3.md §16), when it first starts.

export const LazyKeyMomentsReel = lazyComponent(
  () => import("./key-moments-reel.tsx").then((m) => m.KeyMomentsReel),
  { what: "the key moments reel", overlay: true, onClose: () => uiActions.stopReel() },
);
