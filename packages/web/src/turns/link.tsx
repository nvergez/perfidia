import { useEffect, useRef } from "react";
import { matchHref, navigate, parseRoute, useRoute, type TurnRef } from "../lib/router.ts";
import { useMatch } from "../store/hooks.ts";
import { uiActions, useUiStore, type OpenTurn } from "../store/ui.ts";

// The turn detail's deep link (`/m/:id?turn=p2.48`, docs/phase3.md §16.7): once the match is
// ready, the URL's turn opens the sheet; opening or closing the sheet writes the URL (replacing the
// history entry, as the pair filter does), and the back and forward buttons follow. Mounted beside
// the match page (`app.tsx`); part of the initial load, so it stays small.

const same = (a: OpenTurn | null, b: TurnRef | null): boolean =>
  a === null || b === null ? a === b : a.seat === b.seat && a.turn === b.turn;

export function TurnLink({ id }: { readonly id: string }) {
  const route = useRoute();
  const turn = route.page === "match" && route.id === id ? route.turn : null;
  const ready = useMatch((s) => s.id === id && s.phase === "ready");
  // The URL's turn has been read: from then on, the store writes the URL.
  const synced = useRef(false);
  const seat = turn?.seat ?? null;
  const n = turn?.turn ?? null;

  useEffect(() => {
    if (!ready) return;
    synced.current = true;
    const want = seat === null || n === null ? null : { seat, turn: n };
    if (same(useUiStore.getState().openTurn, want)) return;
    if (want === null) uiActions.closeTurn();
    else uiActions.openTurn(want.seat, want.turn);
  }, [ready, seat, n]);

  useEffect(
    () =>
      useUiStore.subscribe((s, prev) => {
        if (!synced.current || s.openTurn === prev.openTurn) return;
        const r = parseRoute(window.location.pathname, window.location.search);
        if (r.page !== "match" || r.id !== id || same(s.openTurn, r.turn)) return;
        navigate(matchHref(id, { ...r, turn: s.openTurn }), { replace: true });
      }),
    [id],
  );
  return null;
}
