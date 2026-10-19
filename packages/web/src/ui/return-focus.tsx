import { useCallback, useLayoutEffect, useRef } from "react";

// Focus back to what opened a dialog or a sheet. Radix gives it back to the dialog's `Trigger`, and
// this app opens its sheets and dialogs from the stores (a leaderboard name, "Turn detail", a
// report link), with no Trigger: the focus fell to the body on close. `RememberOpener`, rendered
// inside the content, reports the element focused when the content mounts (its layout effect runs
// before Radix moves the focus in); `useReturnFocus` focuses it again on close when it is still in
// the page, else leaves Radix's default.

/** Reports the focused element when it mounts (render it inside the dialog's content). */
export function RememberOpener({ onMount }: { readonly onMount: (el: Element | null) => void }) {
  useLayoutEffect(() => {
    onMount(document.activeElement);
  }, [onMount]);
  return null;
}

/**
 * `RememberOpener`'s callback, and the `onCloseAutoFocus` that focuses the remembered element again
 * (after the caller's own handler).
 */
export function useReturnFocus(
  own?: (e: Event) => void,
): readonly [(el: Element | null) => void, (e: Event) => void] {
  const opener = useRef<Element | null>(null);
  const remember = useCallback((el: Element | null) => {
    opener.current = el;
  }, []);
  const onCloseAutoFocus = useCallback(
    (e: Event) => {
      own?.(e);
      const el = opener.current;
      opener.current = null;
      if (e.defaultPrevented || el === null || el === document.body || !el.isConnected) return;
      if (el instanceof HTMLElement || el instanceof SVGElement) {
        e.preventDefault();
        el.focus({ preventScroll: true });
      }
    },
    [own],
  );
  return [remember, onCloseAutoFocus] as const;
}
