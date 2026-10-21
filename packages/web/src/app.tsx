import { useRoute } from "./lib/router.ts";
import { LazyModelsPage } from "./models/lazy.ts";
import { ListPage } from "./pages/list.tsx";
import { MatchPage } from "./pages/match.tsx";
import { NotFoundPage } from "./pages/not-found.tsx";
import { TurnLink } from "./turns/link.tsx";

// The app: one route at a time (`lib/router.ts`); beside a match, its turn detail's deep link. The
// model statistics (`/models`) are a page loaded on demand.

export function App() {
  const route = useRoute();
  return (
    <>
      {route.page === "list" ? (
        <ListPage />
      ) : route.page === "match" ? (
        <>
          <MatchPage
            key={route.id}
            id={route.id}
            pair={route.pair}
            reel={route.reel}
            start={route.start}
            linkedTurn={route.turn !== null}
          />
          <TurnLink key={`turn:${route.id}`} id={route.id} />
        </>
      ) : route.page === "models" || route.page === "model" ? (
        <LazyModelsPage id={route.page === "model" ? route.id : null} />
      ) : (
        <NotFoundPage path={route.path} />
      )}
    </>
  );
}
