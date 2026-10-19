import { lazyComponent } from "../common/lazy.tsx";
import { uiActions } from "../store/ui.ts";

// "How to watch" loads on demand (docs/phase3.md §16): on a first visit it opens as soon as the
// match is ready; a viewer who has seen it loads it only from the header's button.

export const LazyHowToWatch = lazyComponent(
  () => import("./how-to-watch.tsx").then((m) => m.HowToWatch),
  { what: "“How to watch”", overlay: true, onClose: () => uiActions.closeHowToWatch() },
);
