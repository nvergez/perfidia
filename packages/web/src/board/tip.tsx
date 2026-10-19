import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { HoverPanel } from "../players/hover-panel.tsx";

// A small value with an explanation on hover and keyboard focus: a button, announced with its
// label (which says what the explanation says). Off the tab order with `focusable={false}` where a
// row repeats it many times (the leaderboard: its name button describes the row instead).

export function Tip({
  label,
  tip,
  className,
  focusable = true,
  children,
}: {
  /** What a screen reader announces. */
  readonly label: string;
  readonly tip: ReactNode;
  readonly className?: string;
  readonly focusable?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <HoverPanel delay={150} role="tooltip" className="max-w-64 px-2.5 py-1.5 text-xs" content={tip}>
      <button
        type="button"
        aria-label={label}
        tabIndex={focusable ? undefined : -1}
        className={cn(
          "inline-flex items-center gap-0.5 rounded-sm tabular-nums outline-none focus-visible:ring-2",
          className,
        )}
      >
        {children}
      </button>
    </HoverPanel>
  );
}
