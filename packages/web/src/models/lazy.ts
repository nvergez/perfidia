import { lazyComponent } from "../common/lazy.tsx";

// The model statistics (`/models`, `/models/:id`; phase 4 Pass 3) load on demand: a chunk of their
// own, never part of the initial load.

export const LazyModelsPage = lazyComponent(
  () => import("./models-page.tsx").then((m) => m.ModelsPage),
  { what: "the model statistics", skeletonClassName: "mx-auto mt-24 h-64 max-w-6xl rounded-xl" },
);
