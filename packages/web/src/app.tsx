import { useRoute } from "./lib/router.ts";
import { ListPage } from "./pages/list.tsx";
import { MatchPage } from "./pages/match.tsx";
import { NotFoundPage } from "./pages/not-found.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

// The app: one route at a time (`lib/router.ts`).

export function App() {
  const route = useRoute();
  return (
    <TooltipProvider delayDuration={300}>
      {route.page === "list" ? (
        <ListPage />
      ) : route.page === "match" ? (
        <MatchPage
          key={route.id}
          id={route.id}
          pair={route.pair}
          reel={route.reel}
          start={route.start}
        />
      ) : (
        <NotFoundPage path={route.path} />
      )}
    </TooltipProvider>
  );
}
