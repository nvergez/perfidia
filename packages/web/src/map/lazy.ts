import { lazyComponent } from "../common/lazy.tsx";
import { uiActions } from "../store/ui.ts";

// The map's panels load on demand (docs/phase3.md §16): the city popover once a city is selected,
// the battle report once a report is, the map key once it is opened.

export const LazyCityPopover = lazyComponent(
  () => import("./city-popover.tsx").then((m) => m.CityPopover),
  { what: "the city's details", overlay: true, onClose: () => uiActions.selectCity(null) },
);

export const LazyReportDialog = lazyComponent(
  () => import("./report-dialog.tsx").then((m) => m.ReportDialog),
  { what: "the battle report", overlay: true, onClose: () => uiActions.selectReport(null) },
);

export const LazyMapKey = lazyComponent(() => import("./map-key.tsx").then((m) => m.MapKey), {
  what: "the map key",
  skeletonClassName: "h-40 w-56",
});
