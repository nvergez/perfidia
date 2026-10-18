import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";

// A light hover panel for the player card and the leaderboard's explanations: it opens after a
// short delay on pointer hover or keyboard focus of its trigger, stays open while the pointer is
// over it, and closes on Escape. It is shown in the browser's top layer (the `popover` attribute),
// so no scrolling column clips it and nothing paints over it, at fixed coordinates: below the
// trigger, or above it when there is no room, kept inside the viewport. It replaces Radix's hover
// card and tooltip here, whose positioning library would cost about 13 KB gzipped of the 200 KB
// budget.

const GAP = 6;
const MARGIN = 8;

export function HoverPanel({
  children,
  content,
  delay = 300,
  role,
  className,
  testId,
}: {
  /** The trigger (its first element is measured). */
  readonly children: ReactNode;
  /** Rendered only while open. */
  readonly content: ReactNode;
  readonly delay?: number;
  readonly role?: "tooltip";
  readonly className?: string;
  readonly testId?: string;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const id = useId();

  const later = (value: boolean, ms: number): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOpen(value);
    }, ms);
  };
  const show = (): void => later(true, delay);
  const hide = (): void => later(false, 120);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || el === null) return undefined;
    if (typeof el.showPopover === "function" && !el.matches(":popover-open")) el.showPopover();
    const place = (): void => {
      const box = anchor.current?.firstElementChild ?? anchor.current;
      if (box === null || box === undefined) return;
      const a = box.getBoundingClientRect();
      const p = el.getBoundingClientRect();
      const below = a.bottom + GAP;
      const above = a.top - GAP - p.height;
      const fitsBelow = below + p.height <= window.innerHeight - MARGIN;
      const top =
        fitsBelow || above < MARGIN
          ? Math.max(MARGIN, Math.min(below, window.innerHeight - p.height - MARGIN))
          : above;
      const left = Math.max(MARGIN, Math.min(a.left, window.innerWidth - p.width - MARGIN));
      el.style.top = `${Math.round(top)}px`;
      el.style.left = `${Math.round(left)}px`;
      el.style.visibility = "visible";
    };
    place();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <span
        ref={anchor}
        className="contents"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {open ? (
        <div
          ref={panel}
          id={id}
          popover="manual"
          role={role}
          data-testid={testId}
          onMouseEnter={() => later(true, 0)}
          onMouseLeave={hide}
          style={{ position: "fixed", top: 0, left: 0, visibility: "hidden" }}
          className={cn(
            "bg-popover text-popover-foreground inset-auto z-50 m-0 rounded-md border p-3 text-sm shadow-lg",
            className,
          )}
        >
          {content}
        </div>
      ) : null}
    </>
  );
}
