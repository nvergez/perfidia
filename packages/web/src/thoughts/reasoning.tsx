import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../lib/cn.ts";
import type { PlayerId } from "../lib/ids.ts";
import { reasoningKindWords, seatReasoningKind } from "../lib/models.ts";
import { useSeat } from "../store/hooks.ts";
import { OpenTurnButton } from "../turns/open-turn.tsx";
import { LazyTurnReasoning } from "./lazy.ts";

// The "Reasoning" expander under an agent's thought: the turn's reasoning (`turn-reasoning.tsx`,
// loaded on demand) opens under it; "Turn detail" beside it opens the turn's sheet (Pass C). Its
// label says what the seat's reasoning is (phase 4): "Reasoning (summary)" for a provider's
// summary, "Reasoning (raw chain of thought)" for an open model's own text.

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
  const info = useSeat(seat);
  const kind = info === null ? null : seatReasoningKind(info);
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
          {kind === null ? null : (
            <span
              className={cn("font-normal", kind === "raw" ? "text-gold" : "text-muted-foreground")}
            >
              ({reasoningKindWords(kind)})
            </span>
          )}
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
