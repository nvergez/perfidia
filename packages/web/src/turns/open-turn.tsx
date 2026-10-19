import { ScrollText } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import type { PlayerId } from "../lib/ids.ts";
import { uiActions } from "../store/ui.ts";
import { LazyTurnSheet } from "./lazy.ts";

// "Turn detail": opens a turn's detail sheet (Pass C, C1). Part of the initial load (it sits under
// thoughts in the feed, the Thoughts column and the dossier), so it stays small; the sheet itself
// loads on demand, and starts loading as soon as the pointer or the focus reaches this button.

export function OpenTurnButton({
  seat,
  turn,
  className,
  children,
}: {
  readonly seat: PlayerId;
  readonly turn: number;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <button
      type="button"
      data-open-turn={`${seat}:${turn}`}
      onPointerEnter={() => LazyTurnSheet.preload()}
      onFocus={() => LazyTurnSheet.preload()}
      onClick={(e) => {
        e.stopPropagation();
        uiActions.openTurn(seat, turn);
      }}
      className={cn(
        "text-primary hover:text-primary/80 flex w-fit items-center gap-1 text-xs font-medium",
        className,
      )}
    >
      <ScrollText className="size-3" aria-hidden="true" /> {children ?? "Turn detail"}
    </button>
  );
}
