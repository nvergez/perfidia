import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../lib/cn.ts";
import type { PlayerId } from "../lib/ids.ts";
import { OpenTurnButton } from "../turns/open-turn.tsx";
import { LazyTurnReasoning } from "./lazy.ts";

// The "Reasoning" expander under an agent's thought: the turn's reasoning (`turn-reasoning.tsx`,
// loaded on demand) opens under it; "Turn detail" beside it opens the turn's sheet (Pass C).

/** A "Reasoning" toggle that shows the turn's reasoning under it. */
export function ReasoningToggle({
  seat,
  turn,
  className,
  label = "Reasoning",
}: {
  readonly seat: PlayerId;
  readonly turn: number;
  readonly className?: string;
  readonly label?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          className="text-primary hover:text-primary/80 flex w-fit items-center gap-1 text-xs font-medium"
        >
          {open ? (
            <ChevronDown className="size-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3" aria-hidden="true" />
          )}
          <Brain className="size-3" aria-hidden="true" /> {label}
        </button>
        <OpenTurnButton seat={seat} turn={turn} />
      </div>
      {open ? (
        <div id={id} className="border-primary/40 ml-1 border-l-2 pl-3">
          <LazyTurnReasoning seat={seat} turn={turn} />
        </div>
      ) : null}
    </div>
  );
}
