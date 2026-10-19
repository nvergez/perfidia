import { useCallback, useLayoutEffect, useRef } from "react";

// Focus back to what opened a dialog or a sheet. Radix gives it back to the dialog's `Trigger`, and
// this app opens its sheets and dialogs from the stores (a leaderboard name, "Turn detail", a
// report link), with no Trigger: the focus fell to the body on close. `RememberOpener`, rendered
// inside the content, reports the element focused when the content mounts (its layout effect runs
// before Radix moves the focus in); `useReturnFocus` focuses it again on close when it is still in
// the page, else leaves Radix's default.
//
// A sheet can be opened from inside another one that then closes (the turn detail's "Dossier"
// button closes the turn sheet and opens the dossier): its opener is gone when it closes. So each
// dialog keeps a chain, its opener first and then the chain of the dialog that opener sat in, and
// the focus goes back to the first element of the chain still in the page.

/** The chain of each open dialog's content element (its opener, then that one's dialog's chain). */
const chains = new WeakMap<Element, readonly Element[]>();

const DIALOG = '[role="dialog"], [role="alertdialog"]';

/** Reports the chain of openers when it mounts (render it inside the dialog's content). */
export function RememberOpener({
  onMount,
}: {
  readonly onMount: (chain: readonly Element[]) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = document.activeElement;
    const host = el?.closest(DIALOG) ?? null;
    const chain =
      el === null || el === document.body
        ? []
        : [el, ...(host === null ? [] : (chains.get(host) ?? []))];
    const own = ref.current?.closest(DIALOG) ?? null;
    if (own !== null) chains.set(own, chain);
    onMount(chain);
  }, [onMount]);
  return <span hidden ref={ref} />;
}

/**
 * `RememberOpener`'s callback, and the `onCloseAutoFocus` that focuses the first remembered element
 * still in the page (after the caller's own handler).
 */
export function useReturnFocus(
  own?: (e: Event) => void,
): readonly [(chain: readonly Element[]) => void, (e: Event) => void] {
  const opener = useRef<readonly Element[]>([]);
  const remember = useCallback((chain: readonly Element[]) => {
    opener.current = chain;
  }, []);
  const onCloseAutoFocus = useCallback(
    (e: Event) => {
      own?.(e);
      const chain = opener.current;
      opener.current = [];
      if (e.defaultPrevented) return;
      const el = chain.find((x) => x !== document.body && x.isConnected);
      if (el instanceof HTMLElement || el instanceof SVGElement) {
        e.preventDefault();
        el.focus({ preventScroll: true });
      }
    },
    [own],
  );
  return [remember, onCloseAutoFocus] as const;
}
