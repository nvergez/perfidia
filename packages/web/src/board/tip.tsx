import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { HoverPanel } from "../players/hover-panel.tsx";

// A small value with an explanation on hover and keyboard focus: a button, so it is reachable by
// keyboard, and announced with its label (which says what the explanation says).

export function Tip({
  label,
  tip,
  className,
  children,
}: {
  /** What a screen reader announces. */
  readonly label: string;
  readonly tip: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <HoverPanel delay={150} role="tooltip" className="max-w-64 px-2.5 py-1.5 text-xs" content={tip}>
      <button
        type="button"
        aria-label={label}
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
